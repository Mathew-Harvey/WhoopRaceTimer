"""Every LapRF byte sequence the app has ever sent, pinned.

This exists to make one promise checkable rather than merely stated: adding a
translator for a different timer must not change what a LapRF is told or how
what it says is understood. The parity suite already pins laprf.py against
laprf.js; this pins laprf.py against itself, so a change to shared encoding is a
failing test rather than something noticed on a track.

Every constant below was produced by the working implementation and confirmed
against real hardware — these are the exact frames a LapRF has accepted.

    python3 tests/test_laprf_golden.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import laprf  # noqa: E402

FAILURES = []


def check(name, got, want):
    if got != want:
        FAILURES.append(f"{name}\n     got  {got}\n     want {want}")


# ---- what the app sends -----------------------------------------------------
# The connect handshake: one read-only query per raced slot, then a request for
# the signal stream without which nothing downstream has anything to measure.
for slot, want in enumerate([
    "5a0b00195c9a02da0101015b",
    "5a0b0019aa02da0101025b",
    "5a0b00183a02da0101035b",
    "5a0b001a0a02da0101045b",
], start=1):
    check(f"getRfSetup(slot {slot})", laprf.get_rf_setup(slot).hex(), want)

check("setStatusInterval(200)", laprf.set_status_interval(200).hex(),
      "5a0c00bbc807da2202c8005b")

# The minimum lap time, which was three seconds and threw away most of a micro
# track's laps. Both values are pinned: the old one because a LapRF accepted it,
# the new one because it is what ships.
check("setMinLapTime(3000)", laprf.set_min_lap_time(3000).hex(),
      "5a0e00424507da2604b80b00005b")
check("setMinLapTime(1000)", laprf.set_min_lap_time(1000).hex(),
      "5a0e00802907da2604e80300005b")

# A full RF setup, in the form flushConfig writes. Raceband 8 is 5917: the
# channel that took several flights to establish, so it is worth pinning.
check("setRfSetup(R8)", laprf.set_rf_setup(1, 2, 8, 5917, threshold=1600.0,
                                           gain=58, enabled=True).hex(),
      "5a2500d8e102da01010120020100210208002202020023040000c84424023a0025021d175b")

check("setGateState(active)", laprf.set_gate_state(True).hex(),
      "5a0b00130004da2001015b")

# ---- what the app understands ----------------------------------------------
# A real status record, captured from the puck. Everything the gate reasons
# about comes out of records shaped like this one.
STATUS = ("5a61008f1a0ada2102c10f230101240400000000010101220400806f4401010222040000"
          "0000010103220400000000010104220400c06f4401010522040000000001010622040000"
          "0000010107220400000000010108220400000000030200005b")
rec = laprf.decode_record(laprf.unescape(bytes.fromhex(STATUS)))
check("a real status record decodes", rec.get("type"), "status")
check("  its battery", rec.get("batteryVoltage"), 4033)
check("  its gate state", rec.get("gateState"), 1)
check("  slot 1 signal", rec["slots"][1]["lastRssi"], 958)
check("  slot 4 signal", rec["slots"][4]["lastRssi"], 959)

# A passing record built from the exact fields the puck reported on the flight
# where laps finally arrived — slot 1, peak 2915, the first lap of the session.
PASSING = laprf.encode(laprf.RT_PASSING, [
    (laprf.PS_SLOT, "u8", 1),
    (laprf.PS_PASSING_NUMBER, "u32", 1),
    (laprf.PS_PEAK_HEIGHT, "u16", 2915),
])
check("a passing record encodes to the same bytes", PASSING.hex(),
      "5a150037a409da0101012104010000002202630b5b")
p = laprf.decode_record(laprf.unescape(PASSING))
check("and decodes back", p.get("type"), "passing")
check("  its slot", p.get("slot"), 1)
check("  its peak", p.get("peakHeight"), 2915)

# Framing survives a stream with junk in front, records back to back, and a
# record cut in half — which is what arrives over a real radio.
stream = b"\x00\x11" + bytes.fromhex(STATUS) + bytes.fromhex(STATUS)[:9]
recs, rest = laprf.split_records(stream)
check("a framed stream yields its records", len(recs), 1)
check("and keeps the partial tail", len(rest), 9)

# ---- the pieces a translator will reuse ------------------------------------
# Nothing below may change, because a second timer is about to be described in
# exactly these terms.
check("CRC of an empty buffer", laprf.crc16(b""), 0)
check("escaping leaves the ends alone",
      laprf.escape(bytes([0x5a, 0x5b, 0x5c, 0x5b])).hex(), "5a5c9b5c9c5b")
check("and unescaping undoes it",
      laprf.unescape(bytes.fromhex("5a5c9b5c9c5b")).hex(), "5a5b5c5b")

if FAILURES:
    print(f"{len(FAILURES)} golden mismatch(es) — the LapRF wire format has moved:\n")
    for f in FAILURES:
        print("  FAIL " + f)
    sys.exit(1)
print("laprf golden: the wire format is unchanged")
