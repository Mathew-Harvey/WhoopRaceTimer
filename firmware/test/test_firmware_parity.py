"""The firmware's LapRF layer, held against laprf.py byte for byte.

The gate in firmware/whoopgate/ is not a translator: it *is* a LapRF as far as
the browser is concerned, so every frame it emits has to be a frame the app
already understands. That promise is only worth something if it is checkable
without an ESP32, an RX5808 and a quad — otherwise it is checked at a track,
during a race, by nothing happening.

So the protocol and the pass detector are portable C++ with no Arduino headers
in them, this compiles both with g++, and every frame is compared against the
reference implementation the whole project is pinned to.

    python3 firmware/test/test_firmware_parity.py
"""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)

import laprf  # noqa: E402

FAILURES = []


def check(name, got, want):
    if got != want:
        FAILURES.append("{}\n     got  {}\n     want {}".format(name, got, want))


def build_and_run():
    """Compile the firmware's portable half and run its vector dump."""
    sources = [
        os.path.join(HERE, "parity.cpp"),
        os.path.join(ROOT, "firmware", "whoopgate", "laprf.cpp"),
        os.path.join(ROOT, "firmware", "whoopgate", "gate.cpp"),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        binary = os.path.join(tmp, "parity")
        cmd = ["g++", "-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror",
               "-o", binary] + sources
        build = subprocess.run(cmd, capture_output=True, text=True)
        if build.returncode != 0:
            print("the firmware does not compile:\n")
            print(build.stderr)
            sys.exit(1)
        run = subprocess.run([binary], capture_output=True, text=True)
        if run.returncode != 0:
            print("the vector dump crashed:\n")
            print(run.stderr)
            sys.exit(1)

    out = {}
    for line in run.stdout.splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition(" ")
        out[key] = value.strip()
    return out


fw = build_and_run()

# ---- what the encoder produces, against the reference ----------------------
# These are the same frames tests/test_laprf_golden.py pins, which are the ones
# a real puck has accepted. The firmware has to agree with them exactly.
for slot in (1, 2, 3, 4):
    check("getRfSetup(slot %d)" % slot,
          fw.get("getRfSetup%d" % slot), laprf.get_rf_setup(slot).hex())

check("setStatusInterval(200)", fw.get("setStatusInterval200"),
      laprf.set_status_interval(200).hex())
check("setMinLapTime(3000)", fw.get("setMinLap3000"),
      laprf.set_min_lap_time(3000).hex())
check("setMinLapTime(1000)", fw.get("setMinLap1000"),
      laprf.set_min_lap_time(1000).hex())
check("setRfSetup(R8, 1600, gain 58)", fw.get("setRfSetupR8"),
      laprf.set_rf_setup(1, 2, 8, 5917, threshold=1600.0, gain=58,
                         enabled=True).hex())
check("setGateState(active)", fw.get("setGateStateActive"),
      laprf.set_gate_state(True).hex())

# ---- what the firmware actually transmits ----------------------------------
check("a passing record", fw.get("passing"), laprf.encode(laprf.RT_PASSING, [
    (laprf.PS_SLOT, "u8", 1),
    (laprf.PS_PASSING_NUMBER, "u32", 1),
    (laprf.PS_PEAK_HEIGHT, "u16", 2915),
]).hex())

# The status record, byte for byte against the one captured from the puck. Field
# order is part of the wire format here, not a detail: the app binds lastRssi to
# whichever slot field preceded it, so a status record assembled in a different
# order reports every receiver's signal against the wrong receiver.
CAPTURED_STATUS = (
    "5a61008f1a0ada2102c10f230101240400000000010101220400806f4401010222040000"
    "0000010103220400000000010104220400c06f4401010522040000000001010622040000"
    "0000010107220400000000010108220400000000030200005b")
check("a status record, against the one a real puck sent",
      fw.get("status"), CAPTURED_STATUS)

# And that the app's own decoder makes sense of what the firmware built.
rec = laprf.decode_record(laprf.unescape(bytes.fromhex(fw.get("status", ""))))
check("  the reference decodes it as a status", rec.get("type"), "status")
check("  its battery", rec.get("batteryVoltage"), 4033)
check("  its gate state", rec.get("gateState"), 1)
check("  slot 1 signal", rec["slots"][1]["lastRssi"], 958)
check("  slot 4 signal", rec["slots"][4]["lastRssi"], 959)

# ---- primitives ------------------------------------------------------------
check("CRC of an empty buffer", fw.get("crcEmpty"), "%04x" % laprf.crc16(b""))
check("escaping leaves the ends alone", fw.get("escaped"),
      laprf.escape(bytes([0x5a, 0x5b, 0x5c, 0x5b])).hex())

# ---- decoding, fed the way BLE delivers it ---------------------------------
check("the framer accepts a real record", fw.get("decodeOk"), "1")
check("  and names its type", fw.get("decodeType"), "%04x" % laprf.RT_STATUS)
check("  junk in front and a severed tail yield one record",
      fw.get("framedRecords"), "1")
check("  battery out of it", fw.get("decodeBattery"), "4033")
check("  gate state out of it", fw.get("decodeGate"), "1")
check("  slot 1 signal out of it", fw.get("decodeSlot1"), "958")
check("  slot 4 signal out of it", fw.get("decodeSlot4"), "959")
check("a corrupted CRC is refused", fw.get("crcRejected"), "1")

# ---- the gate --------------------------------------------------------------
# Everything below is the decision "a quad went through", with no hardware in it.
check("one crossing is one lap", fw.get("gatePasses"), "1")
check("  reported at the peak the crossing reached", fw.get("gatePeak"), "2900")
check("a second crossing inside the minimum lap is not a lap",
      fw.get("gateMinLapSuppressed"), "1")
check("  and past it, laps count again", fw.get("gateCountsAgain"), "1")
# A LapRF racks up laps for a quad sitting in the gate. This does not: a
# crossing is an edge, and a quad that never leaves has not crossed twice.
check("a quad hovering over the trigger is not a lap per sample",
      fw.get("gateHoverPasses"), "0")
# The failure the whole app exists to explain, from the other side: a trigger
# under the noise floor must produce nothing, not everything.
check("a trigger below the noise floor invents nothing",
      fw.get("gateBelowFloorPasses"), "0")

# Hysteresis, measured on its own with the lap filter switched off — otherwise
# the minimum lap time hides a missing re-arm margin by suppressing the extra
# laps it produces, and the gap only reappears on a track with fast laps.
check("a pass dithering across the trigger is still one lap",
      fw.get("gateDitherPasses"), "1")

check("the median outvotes a single wild sample", fw.get("medianRejectsSpike"), "950")
check("  and leaves a real pass alone", fw.get("medianKeepsPass"), "2900")
check("  and answers from the first sample", fw.get("medianFirstSample"), "950")

if FAILURES:
    print("%d firmware mismatch(es) — this gate would not be understood:\n"
          % len(FAILURES))
    for f in FAILURES:
        print("  FAIL " + f)
    sys.exit(1)
print("firmware parity: %d checks, every frame agrees with laprf.py" % 31)
