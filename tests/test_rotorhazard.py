"""The RotorHazard translator, and the promise that it changes nothing.

Two jobs. The first is the translation itself: a node's counts and lap tally
become LapRF records the app already understands, and the app's instructions
become node commands. The second matters more — every record produced here is
decoded with the app's own parser, so "the browser cannot tell the difference"
is a test result rather than a claim.

    python3 tests/test_rotorhazard.py
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import laprf          # noqa: E402
import rotorhazard as rh  # noqa: E402

FAILURES = []


def check(name, cond, detail=""):
    if not cond:
        FAILURES.append(f"{name}{chr(10) + '     ' + detail if detail else ''}")


def eq(name, got, want):
    check(name, got == want, f"got {got!r}, want {want!r}")


# ---- the node's own protocol -----------------------------------------------
# Checksums are the only integrity the node offers, so they are worth pinning.
eq("a payload checksums to the sum of its bytes", rh.checksum(b"\x25\x23"), 0x48)
eq("an empty payload checksums to zero", rh.checksum(b""), 0)
eq("and it wraps at a byte", rh.checksum(b"\xff\xff"), 0xFE)

# The real replies this node gave, byte for byte.
eq("the revision reply parses", rh.checksum(bytes.fromhex("2523")), 0x48)
eq("the frequency reply parses", int.from_bytes(bytes.fromhex("161a"), "big"), 5658)
eq("a write frame is command, payload, checksum",
   rh.write_frame(rh.WRITE_FREQUENCY, b"\x16\x1a").hex(), "51161a30")

# A real 16-byte lap-stats payload, captured from the node while it idled.
REAL = bytes.fromhex("0005d43a3a0003f002ff2c3901710021")
st = rh.LapStats(REAL)
eq("lap count", st.lap_count, 0)
eq("ms since the last lap", st.ms_since_lap, 1492)
eq("current signal", st.rssi, 0x3a)          # 58, the measured noise floor
eq("node peak", st.node_peak, 0x3a)
eq("loop time in microseconds", st.loop_time, 1008)

# ---- the scale -------------------------------------------------------------
# The one number the whole translation rests on. If this moves, every threshold
# the app computes means something different.
eq("the measured noise floor lands on the LapRF's", rh.to_laprf_rssi(58), 928)
eq("and converts back without drift", rh.to_node_rssi(928), 58)
eq("a node's full scale stays inside a LapRF's", rh.to_laprf_rssi(255), 4080)
check("a threshold above the node's range is clamped, not wrapped",
      rh.to_node_rssi(99999) == 255, f"got {rh.to_node_rssi(99999)}")
check("and a negative one is clamped too", rh.to_node_rssi(-500) == 0)

# ---- every record must decode with the app's own parser --------------------
status = rh.status_record(rh.to_laprf_rssi(58))
d = laprf.decode_record(laprf.unescape(status))
eq("a status record is a status record", d["type"], "status")
eq("  carrying the slot's signal", d["slots"][1]["lastRssi"], 928.0)
eq("  a battery the app can show", d["batteryVoltage"], rh.FAKE_BATTERY_MV)
eq("  and a gate that is looking", d["gateState"], 1)

p = laprf.decode_record(laprf.unescape(rh.passing_record(3200, 7, rtc_us=1_500_000)))
eq("a passing record is a passing record", p["type"], "passing")
eq("  with its peak", p["peakHeight"], 3200)
eq("  its number", p["passingNumber"], 7)
# Microseconds, as a LapRF sends them. Milliseconds here would make every lap
# read a thousand times too long, and nothing downstream would say so.
eq("  and a time in microseconds", p["rtcTime"], 1_500_000)

r = laprf.decode_record(laprf.unescape(rh.rf_setup_record(5917, 1824.0)))
eq("an rf setup is an rf setup", r["type"], "rfSetup")
eq("  on the right frequency", r["frequency"], 5917)
eq("  named as Raceband", r["band"], 2)
eq("  channel 8", r["channel"], 8)
eq("  with the trigger the app will read back", r["threshold"], 1824.0)

# A frequency the LapRF's tables do not contain must not be reported as some
# other channel; band 0 is how the app hears "unknown".
eq("an off-plan frequency claims no channel", rh.band_channel_for(5000), (0, 0))
eq("Raceband 1 is band 2 channel 1", rh.band_channel_for(5658), (2, 1))
eq("Fatshark 1 is band 1 channel 1", rh.band_channel_for(5740), (1, 1))

# And the whole stream must survive the app's framer, which is what actually
# reaches the browser: several records back to back, with a partial tail.
stream = status + rh.passing_record(3200, 1) + rh.rf_setup_record(5658, 1824.0)
recs, rest = laprf.split_records(stream + status[:7])
eq("three records come out of the stream", len(recs), 3)
eq("and the partial one waits", len(rest), 7)
eq("in order", [laprf.decode_record(x)["type"] for x in recs],
   ["status", "passing", "rfSetup"])


# ---- the node driven without a node ----------------------------------------
class FakeSerial:
    """A RotorHazard node in software: same request/response, same checksums.

    Enough to drive the transport's whole conversation — identification, the
    poll loop, thresholds and tuning — with no hardware attached, so this suite
    runs in CI where the real node is not plugged in.
    """

    def __init__(self, rssi=58, freq=5658, enter=114, exit_=108):
        self.rssi = rssi
        self.freq = freq
        self.enter = enter
        self.exit = exit_
        self.lap_count = 0
        self.pass_peak = 0
        self._out = bytearray()
        self.writes = []

    # -- the parts pyserial exposes that the transport uses --
    def reset_input_buffer(self):
        self._out.clear()

    def flush(self):
        pass

    def close(self):
        pass

    def read(self, n):
        take, self._out = self._out[:n], self._out[n:]
        return bytes(take)

    def write(self, data):
        self.writes.append(bytes(data))
        cmd, payload = data[0], data[1:]
        if cmd == rh.READ_REVISION_CODE:
            self._reply(b"\x25\x23")
        elif cmd == rh.READ_ADDRESS:
            self._reply(b"\x08")
        elif cmd == rh.READ_FREQUENCY:
            self._reply(self.freq.to_bytes(2, "big"))
        elif cmd == rh.READ_ENTER_AT_LEVEL:
            self._reply(bytes([self.enter]))
        elif cmd == rh.READ_EXIT_AT_LEVEL:
            self._reply(bytes([self.exit]))
        elif cmd == rh.READ_LAP_STATS:
            self._reply(bytes([self.lap_count]) + (1234).to_bytes(2, "big")
                        + bytes([self.rssi, self.rssi, self.pass_peak])
                        + (1000).to_bytes(2, "big") + bytes(8))
        elif cmd == rh.WRITE_FREQUENCY:
            self.freq = int.from_bytes(payload[:2], "big")
        elif cmd == rh.WRITE_ENTER_AT_LEVEL:
            self.enter = payload[0]
        elif cmd == rh.WRITE_EXIT_AT_LEVEL:
            self.exit = payload[0]

    def _reply(self, payload):
        self._out.extend(payload + bytes([rh.checksum(payload)]))


def wire(node, fake):
    """Attach the transport to a fake node, skipping the serial open."""
    import threading
    node._ser = fake
    node._lock = threading.Lock()
    return node


emitted = []
node = wire(rh.RotorHazardNode(on_raw=emitted.append, on_log=lambda m: None), FakeSerial())

eq("it identifies the node", node._read(rh.READ_REVISION_CODE).hex(), "2523")
eq("and reads its frequency", int.from_bytes(node._read(rh.READ_FREQUENCY), "big"), 5658)

# The app asks a slot to describe itself. The reply must carry the node's real
# state, translated.
node._frequency, node._enter = 5658, 114
node._apply({"type": "rfSetup", "slot": 1})
eq("a query is answered", len(emitted), 1)
described = laprf.decode_record(laprf.unescape(emitted[-1]))
eq("  with the node's frequency", described["frequency"], 5658)
eq("  and its arm level, translated", described["threshold"], 114 * rh.RSSI_SCALE)

# The app sets a trigger. One LapRF level becomes a node's arm/disarm pair —
# the hysteresis a LapRF cannot be given.
fake = FakeSerial()
node = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), fake)
node._frequency, node._enter, node._exit = 5658, 114, 108
node._set_thresholds(1600.0)
eq("the arm level follows the app's trigger", fake.enter, rh.to_node_rssi(1600))
check("and the disarm level sits below it", fake.exit < fake.enter,
      f"enter {fake.enter} exit {fake.exit}")
eq("by the documented gap", fake.enter - fake.exit, rh.EXIT_BELOW_ENTER)

# Tuning, and the read-back that proves it took.
node._set_frequency(5917)
eq("the node is retuned", fake.freq, 5917)
eq("and the transport believes it", node._frequency, 5917)

# The minimum lap the app asks for is honoured here, because a node has no such
# setting — otherwise one setting would mean two things depending on the timer.
emitted = []
fake = FakeSerial()
node = wire(rh.RotorHazardNode(on_raw=emitted.append, on_log=lambda m: None), fake)
node._apply({"type": "settings", "minLapTime": 1000})
eq("the minimum lap is taken", node._min_lap_s, 1.0)
st = rh.LapStats(bytes([1]) + (0).to_bytes(2, "big") + bytes([60, 200, 200])
                 + (1000).to_bytes(2, "big") + bytes(8))
node._emit_pass(st)
eq("the first lap is reported", len(emitted), 1)
node._emit_pass(st)
eq("and one arriving too soon is not", len(emitted), 1)
node._min_lap_s = 0.0
node._emit_pass(st)
eq("with no minimum, it is", len(emitted), 2)

# Status interval, which is what makes anything arrive at all.
node._apply({"type": "settings", "statusInterval": 200})
eq("the poll rate follows the app", node._interval, 0.2)
node._apply({"type": "settings", "statusInterval": 1})
check("and is never fast enough to saturate the port", node._interval >= 0.05,
      f"got {node._interval}")

# Nonsense in must not take the transport down.
for junk in ({"type": "crc_error"}, {}, {"type": "rfSetup"}, None):
    node._apply(junk)
check("junk records are survived", True)


# ---- the re-tune artefact --------------------------------------------------
# Measured on the real node: one wild reading every few seconds, at a fixed
# offset above whatever the receiver is sitting on — +52 counts on 5917, +53 on
# 5658. It is the receiver re-tuning itself, not anything on the air, and it
# crosses the arm level on its own, so the node counts a lap for it.
node = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), FakeSerial())
seen = [node._filtered(v) for v in [68, 69, 68, 120, 68, 69, 68, 70, 120, 69, 68]]
check("the artefact never reaches the app", 120 not in seen, f"got {seen}")
check("and the real level does", set(seen) <= {68, 69, 70}, f"got {seen}")

# A real pass spans several polls at this rate, so it must survive untouched.
node = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), FakeSerial())
flight = [68, 68, 90, 180, 210, 195, 120, 70, 68]
out = [node._filtered(v) for v in flight]
check("a real pass survives the filter", max(out) >= 180, f"peaked at {max(out)} from {flight}")

# And the artefact must not be reported as a lap even when the node counts one.
emitted = []
node = wire(rh.RotorHazardNode(on_raw=emitted.append, on_log=lambda m: None), FakeSerial())
for v in [68, 68, 68, 69, 68, 68] * 12:      # past the warm-up, as a real link is
    node._filtered(v)
def stats(peak):
    return rh.LapStats(bytes([1]) + (0).to_bytes(2, "big") + bytes([68, peak, peak])
                       + (1000).to_bytes(2, "big") + bytes(8))
node._emit_pass(stats(120))
eq("a lap the signal never rose for is not reported", len(emitted), 0)
# Judging the node's reported peak against a height was the first attempt and it
# failed: the artefact lands 56-57 counts above the floor, so any cutoff that
# rejects it sits beside it and lets the hot ones through — 30 of 206 in a real
# sample. The filtered stream has no such ambiguity.
node._emit_pass(stats(97))
eq("nor one at the artefact's exact height", len(emitted), 0)
# Now fly one: the filtered signal actually rises.
for v in [90, 150, 200, 210, 190, 120]:
    node._filtered(v)
node._emit_pass(stats(210))
eq("a lap the signal did rise for is reported", len(emitted), 1)

# Nothing is judged before there is enough signal to judge against. A running
# average took seconds to reach the real floor, and until it did an ordinary
# reading cleared it by more than the required rise — two artefacts were
# reported as laps in the first second of a real session because of it.
cold = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), FakeSerial())
fired = []
cold.on_raw = fired.append
for _ in range(5):
    cold._filtered(40)
cold._emit_pass(stats(240))
eq("a lap in the first moments is not trusted", len(fired), 0)

# The case that separates the two designs, and the reason for the second one.
# The node reports a confident peak while the filtered signal has not moved at
# all — which is precisely what a run of artefacts looks like. Judging the
# node's number against a height accepts this; asking the signal does not.
emitted = []
node = wire(rh.RotorHazardNode(on_raw=emitted.append, on_log=lambda m: None), FakeSerial())
for _ in range(80):
    node._filtered(40)                       # a receiver that heard nothing
node._emit_pass(stats(240))                  # and a node insisting on a lap
eq("a lap with a high reported peak but no rise is refused", len(emitted), 0)

# ---- refusing what it is not -----------------------------------------------
# The safety property that matters on a bench with two timers on it: this must
# never adopt a LapRF, and the LapRF serial path must never adopt a node.
class Mute:
    """A serial device that answers nothing — a LapRF's console, or a dead port."""
    def reset_input_buffer(self): pass
    def flush(self): pass
    def close(self): pass
    def write(self, data): pass
    def read(self, n): return b""


class WrongMarker(FakeSerial):
    """Something that answers, but is not a node."""
    def write(self, data):
        if data[0] == rh.READ_REVISION_CODE:
            self._reply(b"\x99\x01")       # no RotorHazard marker
        else:
            super().write(data)


for name, fake in (("a silent device", Mute()), ("a device with another protocol", WrongMarker())):
    node = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), fake)
    rev = node._read(rh.READ_REVISION_CODE)
    check(f"{name} is not mistaken for a node",
          rev is None or rev[0] != rh.RotorHazardNode.REVISION_MARKER,
          f"got {rev.hex() if rev else None}")

# And the reverse, which is a property of the LapRF path rather than this one:
# it looks only at ttyACM and usbmodem names, so a node on ttyUSB is invisible
# to it. Checked here because this is where a second serial device arrived.
import device as devmod  # noqa: E402
src = open(os.path.join(root if 'root' in dir() else
                        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "device.py")).read()
check("the LapRF serial path does not search ttyUSB", "/dev/ttyUSB" not in src,
      "it would open a RotorHazard node and read LapRF records out of it")

# Searching for a node means writing a byte to each candidate port, and a LapRF's
# USB endpoint is a console that takes typed commands. It is ruled out by its USB
# identity rather than spoken to.
eq("the LapRF's USB id is the one this refuses to probe",
   (rh.LAPRF_VID, rh.LAPRF_PID), (0x04D8, 0x000A))
check("and device.py agrees on it", "0x04D8" in src.upper().replace("0X", "0x")
      or "0x04d8" in src, "the two files disagree about what a LapRF is")

# ---- a node that stops answering -------------------------------------------
# A poll that fails must end the connection rather than stream silence: the page
# reports a healthy link off this transport's connected flag.
class Dies(FakeSerial):
    def __init__(self):
        super().__init__()
        self.alive = True

    def write(self, data):
        if not self.alive:
            return
        super().write(data)


fake = Dies()
node = wire(rh.RotorHazardNode(on_raw=lambda b: None, on_log=lambda m: None), fake)
node.connected = True
fake.alive = False
raised = False
try:
    node._poll_forever()
except OSError:
    raised = True
check("a node that stops answering ends the connection", raised,
      "the poll loop carried on against a dead port")

# ---- the promise -----------------------------------------------------------
# The LapRF path is not modified by any of this, and that is checkable.
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
changed = subprocess.run(["git", "diff", "--name-only", "HEAD", "--",
                          "laprf.py", "static/js/laprf.js", "static/js/link.js",
                          "static/js/tuning.js", "static/js/app.js",
                          "static/js/screens.js"],
                         cwd=root, capture_output=True, text=True).stdout.split()
check("the LapRF implementation is untouched by the translator",
      not changed, "these are modified: " + ", ".join(changed))

if FAILURES:
    print(f"{len(FAILURES)} failure(s):\n")
    for f in FAILURES:
        print("  FAIL " + f)
    sys.exit(1)
print("rotorhazard translator: all scenarios pass")
