"""The RotorHazard translator, and the promise that it changes nothing.

Two jobs. The first is the translation itself: a node's counts and lap tally
become LapRF records the app already understands, and the app's instructions
become node commands. The second matters more — every record produced here is
decoded with the app's own parser, so "the browser cannot tell the difference"
is a test result rather than a claim.

Time is injected rather than waited on. Nearly everything the translator refuses
to do, it refuses on the strength of how much signal it has seen and how long
ago the last lap was, so a suite that cannot move the clock cannot reach any of
it — and one that primes a window by calling in a tight loop is testing at ten
thousand samples a second, which is not a rate any link runs at.

    python3 tests/test_rotorhazard.py
"""
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import laprf          # noqa: E402
import rotorhazard as rh  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
# Byte 5 is zero on this frame, which is the whole reason nothing downstream may
# treat a pass peak as a truthy value: `pass_peak or node_peak` picks the wrong
# byte on the project's own reference capture.
eq("and its pass peak is genuinely zero", st.pass_peak, 0)

# ---- the scale -------------------------------------------------------------
# The one number the whole translation rests on. If this moves, every threshold
# the app computes means something different.
eq("the measured noise floor lands on the LapRF's", rh.to_laprf_rssi(58), 928)
eq("and converts back without drift", rh.to_node_rssi(928), 58)
eq("a node's full scale stays inside a LapRF's", rh.to_laprf_rssi(255), 4080)
check("a threshold above the node's range is clamped, not wrapped",
      rh.to_node_rssi(99999) == 255, f"got {rh.to_node_rssi(99999)}")
check("and a negative one is clamped too", rh.to_node_rssi(-500) == 0)

# The veto on an invented lap is the app's own minimum rise, converted — not a
# second, coarser trigger chosen here. A veto above what the app calibrates to
# silently overrules it: the node arms where it was asked, counts every real
# lap, and this throws them away — and since the app lowers its trigger from the
# evidence in reported passes, suppressing the pass destroys the evidence.
check("the rise a lap must show is the app's own, converted",
      rh.MIN_PASS_RISE * rh.RSSI_SCALE <= 120,      # tuning.js MIN_SPAN
      f"{rh.MIN_PASS_RISE} node counts is {rh.MIN_PASS_RISE * rh.RSSI_SCALE} LapRF "
      f"counts, coarser than the span the app calls a usable gate")
eq("stated in the app's terms", rh.MIN_PASS_RISE_LAPRF, 60)   # tuning.js WATCH_MIN_RISE

# ---- every record must decode with the app's own parser --------------------
status = rh.status_record(rh.to_laprf_rssi(58))
d = laprf.decode_record(laprf.unescape(status))
eq("a status record is a status record", d["type"], "status")
eq("  carrying the slot's signal", d["slots"][1]["lastRssi"], 928.0)
eq("  a battery the app can show", d["batteryVoltage"], rh.FAKE_BATTERY_MV)
eq("  and a gate that is looking", d["gateState"], 1)

p = laprf.decode_record(laprf.unescape(rh.passing_record(3200, 7, rtc_ms=1_500_000)))
eq("a passing record is a passing record", p["type"], "passing")
eq("  with its peak", p["peakHeight"], 3200)
eq("  its number", p["passingNumber"], 7)
# MILLISECONDS. race.js takes the difference between two of these, divides by a
# thousand, and compares the result in seconds against the lap it measured from
# browser arrival times — trusting the hardware clock only when the two agree
# within two seconds. Microseconds make that comparison fail by a factor of a
# thousand on every lap, so every lap silently falls back to arrival time and
# keeps exactly the jitter this field exists to remove.
eq("  and a time in milliseconds, as race.js reads it", p["rtcTime"], 1_500_000)

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
# 5880 is both R7 and F8 — the same carrier under two names, and the only such
# collision in the tables. Taking the first table that contains it answers F8 to
# everyone, including a pilot who chose R7; the app trusts a reported band over
# a frequency lookup, so it would write F8 into that pilot's saved channel and
# keep it there into later sessions on a real LapRF.
eq("a frequency with two names claims neither on its own",
   rh.band_channel_for(5880), (0, 0))
r = laprf.decode_record(laprf.unescape(rh.rf_setup_record(5880, 1600.0)))
eq("  so the app is told band 0 and decides for itself", r["band"], 0)

# And the whole stream must survive the app's framer, which is what actually
# reaches the browser: several records back to back, with a partial tail.
stream = status + rh.passing_record(3200, 1) + rh.rf_setup_record(5658, 1824.0)
recs, rest = laprf.split_records(stream + status[:7])
eq("three records come out of the stream", len(recs), 3)
eq("and the partial one waits", len(rest), 7)
eq("in order", [laprf.decode_record(x)["type"] for x in recs],
   ["status", "passing", "rfSetup"])


# ---- the node driven without a node ----------------------------------------
class Clock:
    """Monotonic time under the test's control.

    Every refusal in the translator is a judgement about elapsed time, so the
    suite has to be able to move it. Starting well above zero because a real
    monotonic clock does, and code that only works near an origin of zero is
    code that only works on a freshly booted machine.
    """

    def __init__(self, t=48_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def tick(self, dt=rh.POLL_INTERVAL):
        self.t += dt
        return self.t


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
        self.ms_since_lap = 1234
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
            self._reply(bytes([self.lap_count]) + self.ms_since_lap.to_bytes(2, "big")
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


def wire(fake=None, on_raw=None, clock=None):
    """A transport attached to a fake node, skipping the serial open."""
    clock = clock or Clock()
    node = rh.RotorHazardNode(on_raw=on_raw or (lambda b: None),
                              on_log=lambda m: None, clock=clock)
    node._ser = fake if fake is not None else FakeSerial()
    return node, node._ser, clock


def prime(node, clock, value=40, seconds=rh.WARMUP_S + 1.0):
    """Feed the filter a quiet signal at the real poll rate, for real time."""
    for _ in range(int(seconds / rh.POLL_INTERVAL)):
        clock.tick()
        node._filtered(value)


def fly(node, clock, values):
    """Feed a crossing through, one poll apart."""
    for v in values:
        clock.tick()
        node._filtered(v)


def stats(peak, lap=1, ms_since=0):
    return rh.LapStats(bytes([lap]) + ms_since.to_bytes(2, "big")
                       + bytes([68, peak, peak]) + (1000).to_bytes(2, "big") + bytes(8))


def laps(frames):
    """Only the passings — describing a slot emits a record too."""
    return [laprf.decode_record(laprf.unescape(f)) for f in frames
            if laprf.decode_record(laprf.unescape(f))["type"] == "passing"]


node, fake, clock = wire()
eq("it identifies the node", node._read(rh.READ_REVISION_CODE).hex(), "2523")
eq("and reads its frequency", int.from_bytes(node._read(rh.READ_FREQUENCY), "big"), 5658)

# The app asks a slot to describe itself. The reply must carry the node's real
# state, translated.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter = 5658, 114
node._apply({"type": "rfSetup", "slot": 1})
eq("a query is answered", len(emitted), 1)
described = laprf.decode_record(laprf.unescape(emitted[-1]))
eq("  with the node's frequency", described["frequency"], 5658)
eq("  and its arm level, translated", described["threshold"], 114 * rh.RSSI_SCALE)

# The app sets a trigger. One LapRF level becomes a node's arm/disarm pair —
# the hysteresis a LapRF cannot be given.
node, fake, clock = wire()
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

# A retune throws the signal window away, because a receiver that has moved has
# not been listening to this frequency at all. Found on the bench: 5658 and 5917
# had ambient levels twenty counts apart, and a window straddling the change
# takes its quiet level — a low percentile — from the lower of the two, so every
# ordinary reading on the higher one cleared it by more than the rise a lap has
# to show. It counted a lap a second until the old readings aged out.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter, node._exit = 5658, 114, 108
prime(node, clock, value=100)                # quiet, on the frequency it was on
node._set_frequency(5917)
fly(node, clock, [120, 121, 120, 121, 120])  # ordinary noise on the new one
node._emit_pass(stats(121))
eq("a retune does not leave the old frequency's noise floor behind",
   len(laps(emitted)), 0)
# And once there is a window of the new frequency, it works as before.
prime(node, clock, value=120)
node._emit_pass(stats(121))
eq("  ordinary noise on the new frequency is still not a lap", len(laps(emitted)), 0)
fly(node, clock, [150, 200, 210, 205, 190])
node._emit_pass(stats(210))
eq("  and a real crossing on it still is", len(laps(emitted)), 1)


# ---- the threshold the app reads back --------------------------------------
# The app compares what a slot reports against what it wrote, within half a
# count, and rewrites the slot when they differ — three times, then it tells the
# user the timer would not accept the setup. A node holds its arm level as a
# whole byte, so echoing the re-quantised value fails that comparison for every
# threshold that is not an exact multiple of the scale — which is every level
# the app ever tunes to itself, since those carry a decimal.
THRESHOLD_EPSILON = 0.5                 # app.js
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter, node._exit = 5917, 114, 108
node._apply({"type": "rfSetup", "slot": 1, "frequency": 5917, "threshold": 1417.3})
back = laprf.decode_record(laprf.unescape(emitted[-1]))
check("a self-tuned threshold reads back as the app wrote it",
      abs(back["threshold"] - 1417.3) <= THRESHOLD_EPSILON,
      f"wrote 1417.3, read back {back['threshold']} — the app would call this refused, "
      f"rewrite the slot three times, and then tell the user the timer said no")
eq("  while the node holds the byte it can hold", fake.enter, rh.to_node_rssi(1417.3))

# But only while that is still true. A level the node did not accept must be
# reported as what the node is actually armed at, not as what was asked for —
# that misreport is the exact failure the app's comparison exists to catch.
node._enter = 60                        # as if the write had not taken
back = node._echo_threshold()
eq("a level the node did not take is reported honestly", back, 60 * rh.RSSI_SCALE)

# And a level nobody asked for — read off the node at connect — is its own.
node, fake, clock = wire()
node._frequency, node._enter = 5658, 114
eq("an untouched node reports the level it holds",
   node._echo_threshold(), 114 * rh.RSSI_SCALE)


# ---- the band the pilot meant ----------------------------------------------
# 5880 is R7 and F8. When the app says which it means, that is remembered and
# echoed; the alternative is telling a pilot who chose R7 that their timer is on
# F8, which the app then saves over their choice.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter = 5658, 114
node._apply({"type": "rfSetup", "slot": 1, "frequency": 5880,
             "band": 2, "channel": 7, "threshold": 1600.0})
back = laprf.decode_record(laprf.unescape(emitted[-1]))
eq("the band the app wrote is the band it hears back", (back["band"], back["channel"]), (2, 7))
eq("  on the frequency they both mean", back["frequency"], 5880)
# And a tune that did not take must not leave the app's pair pointing at a
# frequency the receiver never moved to.
class Stuck(FakeSerial):
    """A node that accepts a tune command and stays where it was."""
    def write(self, data):
        if data[0] == rh.WRITE_FREQUENCY:
            self.writes.append(bytes(data))
            return
        super().write(data)


emitted = []
node, fake, clock = wire(Stuck(freq=5658), on_raw=emitted.append)
node._frequency, node._enter, node._exit = 5658, 114, 108
node._apply({"type": "rfSetup", "slot": 1, "frequency": 5880,
             "band": 2, "channel": 7, "threshold": 1600.0})
back = laprf.decode_record(laprf.unescape(emitted[-1]))
eq("a tune that did not take reports the frequency the node is really on",
   back["frequency"], 5658)
eq("  named as what that frequency is, not as the channel it refused to move to",
   (back["band"], back["channel"]), rh.band_channel_for(5658))

# A pair that does not name the frequency is not evidence of anything.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter, node._exit = 5658, 114, 108
node._band_channel = None
node._apply({"type": "rfSetup", "slot": 1, "frequency": 5880,
             "band": 2, "channel": 1, "threshold": 1600.0})     # R1 is not 5880
back = laprf.decode_record(laprf.unescape(emitted[-1]))
eq("a pair that does not match the frequency is not believed", back["band"], 0)


# ---- the minimum lap and the warm-up ---------------------------------------
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._apply({"type": "settings", "minLapTime": 1000})
eq("the minimum lap is taken", node._min_lap_s, 1.0)
prime(node, clock, value=60)
fly(node, clock, [90, 150, 200, 210, 190])
node._emit_pass(stats(200))
eq("the first lap is reported", len(laps(emitted)), 1)
node._emit_pass(stats(200))
eq("and one arriving too soon is not", len(laps(emitted)), 1)
clock.tick(1.5)
fly(node, clock, [90, 150, 200, 210, 190])
node._emit_pass(stats(200))
eq("but one arriving after the minimum is", len(laps(emitted)), 2)

# Status interval, which is what makes anything arrive at all.
node._apply({"type": "settings", "statusInterval": 200})
eq("the poll rate follows the app", node._interval, 0.2)
node._apply({"type": "settings", "statusInterval": 1})
check("and is never fast enough to saturate the port", node._interval >= 0.05,
      f"got {node._interval}")

# Nonsense in must not take the transport down, and must change nothing.
node, fake, clock = wire()
node._frequency, node._enter, node._exit = 5658, 114, 108
before = (fake.freq, fake.enter, fake.exit, node._interval, node._min_lap_s)
for junk in ({"type": "crc_error"}, {}, {"type": "rfSetup"}, None,
             {"type": "settings"}, {"type": "stateControl"}, {"type": "unheard-of"}):
    node._apply(junk)
eq("junk records change nothing",
   (fake.freq, fake.enter, fake.exit, node._interval, node._min_lap_s), before)


# ---- the re-tune artefact --------------------------------------------------
# Measured on the real node: one wild reading every few seconds, at a fixed
# offset above whatever the receiver is sitting on — +52 counts on 5917, +53 on
# 5658. It is the receiver re-tuning itself, not anything on the air, and it
# crosses the arm level on its own, so the node counts a lap for it.
node, fake, clock = wire()
seen = [node._filtered(v, at=clock.tick())
        for v in [68, 69, 68, 120, 68, 69, 68, 70, 120, 69, 68]]
check("the artefact never reaches the app", 120 not in seen, f"got {seen}")
check("and the real level does", set(seen) <= {68, 69, 70}, f"got {seen}")

# A real pass spans several polls at this rate, so it must survive untouched.
node, fake, clock = wire()
flight = [68, 68, 90, 180, 210, 195, 120, 70, 68]
out = [node._filtered(v, at=clock.tick()) for v in flight]
check("a real pass survives the filter", max(out) >= 180, f"peaked at {max(out)} from {flight}")

# And the artefact must not be reported as a lap even when the node counts one.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
prime(node, clock, value=68)
node._emit_pass(stats(120))
eq("a lap the signal never rose for is not reported", len(laps(emitted)), 0)
# Judging the node's reported peak against a height was the first attempt and it
# failed: the artefact lands 56-57 counts above the floor, so any cutoff that
# rejects it sits beside it and lets the hot ones through — 30 of 206 in a real
# sample. The filtered stream has no such ambiguity.
node._emit_pass(stats(97))
eq("nor one at the artefact's exact height", len(laps(emitted)), 0)
# Now fly one: the filtered signal actually rises.
fly(node, clock, [90, 150, 200, 210, 190, 120])
node._emit_pass(stats(210))
eq("a lap the signal did rise for is reported", len(laps(emitted)), 1)
# And its peak comes from the signal, not from the node's byte. `pass_peak` is
# zero on real frames and `node_peak` ratchets upward across a session, so the
# obvious fallback chain reports a session maximum as this lap's peak — which
# the app takes as the one fully trustworthy peak it ever sees and tunes to.
peak_seen = max(v for t, v in node._filtered_log if t >= clock() - rh.PASS_LOOKBACK_S)
eq("  reporting the peak this lap's signal actually reached",
   laps(emitted)[-1]["peakHeight"], rh.to_laprf_rssi(peak_seen))
# The distinguishing case: the node's own byte says one thing and the signal
# says another. `node_peak` ratchets upward across a session, so a fallback onto
# it reports a session maximum as this lap's peak — and the app takes that as
# the one fully trustworthy peak it ever sees and tunes the gate to it.
emitted.clear()
clock.tick(3.0)
fly(node, clock, [90, 150, 200, 210, 190])
node._min_lap_s = 0.0
node._emit_pass(stats(255))                  # a session ratchet, and no pass peak
check("and never the node's own ratcheting byte",
      laps(emitted)[-1]["peakHeight"] < rh.to_laprf_rssi(255),
      f'got {laps(emitted)[-1]["peakHeight"]}, which is the session maximum, '
      f"not this lap's")

# Nothing is judged before there is enough signal to judge against. A running
# average took seconds to reach the real floor, and until it did an ordinary
# reading cleared it by more than the required rise — two artefacts were
# reported as laps in the first second of a real session because of it.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
for _ in range(5):
    node._filtered(40, at=clock.tick())
node._emit_pass(stats(240))
eq("a lap in the first moments is not trusted", len(laps(emitted)), 0)

# The warm-up is a span of time, not a count of samples. The window is pruned by
# the clock, so a count is really a demand that the poll loop sustain a rate: a
# marginal cable that halves it never reaches the count at any point in a
# session, and every lap of the meeting is refused while the page shows a
# healthy link with live signal on it.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
for _ in range(int(rh.WARMUP_S / 0.4) + 2):      # a slow link: 2.5 readings a second
    node._filtered(60, at=clock.tick(0.4))
fly(node, clock, [90, 150, 200, 210, 190])
node._emit_pass(stats(210))
eq("a slow link still calibrates and still counts laps", len(laps(emitted)), 1)

# The case that separates the two designs, and the reason for the second one.
# The node reports a confident peak while the filtered signal has not moved at
# all — which is precisely what a run of artefacts looks like. Judging the
# node's number against a height accepts this; asking the signal does not.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
prime(node, clock, value=40)
node._emit_pass(stats(240))
eq("a lap with a high reported peak but no rise is refused", len(laps(emitted)), 0)


# ---- when the crossing actually happened -----------------------------------
# The node says how long ago it was. Using it takes poll jitter, and any serial
# work done for a config write, out of the lap interval instead of leaving it in.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
prime(node, clock, value=60)
fly(node, clock, [90, 150, 200, 210, 190])
at = clock()
node._emit_pass(stats(210, ms_since=400), at=at)
eq("the pass is timed to when the node saw it, not when the loop noticed",
   laps(emitted)[-1]["rtcTime"], int((at - 0.4) * 1000))
# Bounded, because a figure reaching further back than the window this was
# judged against is not something to back-date by.
emitted.clear()
clock.tick(5.0)
fly(node, clock, [90, 150, 200, 210, 190])
at = clock()
node._emit_pass(stats(210, ms_since=60000), at=at)
eq("an implausible age is clamped, not believed",
   laps(emitted)[-1]["rtcTime"], int((at - rh.PASS_LOOKBACK_S) * 1000))


# ---- a clock that steps ----------------------------------------------------
# A laptop or a Pi taken to a track boots offline and steps its wall clock when
# it joins track wifi — backwards as often as forwards, and by hours on a machine
# with no battery-backed clock. Against a wall clock a backward step makes every
# interval negative, which reads as "too soon after the last lap", so every lap
# is discarded until the clock catches up.
check("durations are measured monotonically", rh.RotorHazardNode().now is __import__(
    "time").monotonic, "a wall clock here loses laps whenever the machine syncs time")
src = open(os.path.join(ROOT, "rotorhazard.py")).read()
body = src.split('"""', 2)[2]            # past the module docstring
check("and time.time() is not used to measure anything", "time.time()" not in body,
      "a wall clock crept back into the translator")


# ---- one node is one receiver ----------------------------------------------
# The app asks all four raced slots to describe themselves. Answering for more
# than the one that exists claims receivers that do not — the app would show
# four gates on a single frequency — and a write aimed at the fourth would
# retune the first, so a pilot choosing their own channel moves somebody else's.
seen = []
node, fake, clock = wire(on_raw=seen.append)
node._frequency, node._enter = 5658, 114
for slot in (1, 2, 3, 4):
    node._apply({"type": "rfSetup", "slot": slot})
eq("only the slot that exists is described", len(seen), 1)
eq("and it is the first", laprf.decode_record(laprf.unescape(seen[0]))["slot"], 1)

# A write aimed at a slot that is not there must not move the one that is.
node, fake, clock = wire()
node._frequency, node._enter, node._exit = 5658, 114, 108
node._apply({"type": "rfSetup", "slot": 3, "frequency": 5917, "threshold": 1600.0})
eq("a write to a slot that does not exist changes nothing", fake.freq, 5658)
node._apply({"type": "rfSetup", "slot": 1, "frequency": 5917, "threshold": 1600.0})
eq("and a write to the one that does, does", fake.freq, 5917)

# A receiver the app has switched off must stop producing laps. A node has no
# such switch, so it is honoured here — otherwise a pilot who is not racing
# collects laps.
emitted = []
node, fake, clock = wire(on_raw=emitted.append)
node._frequency, node._enter, node._exit = 5658, 114, 108
prime(node, clock, value=40)
fly(node, clock, [90, 150, 200, 210, 190])
emitted.clear()
node._apply({"type": "rfSetup", "slot": 1, "enabled": 0})
off = laprf.decode_record(laprf.unescape(
    [f for f in emitted if laprf.decode_record(laprf.unescape(f))["type"] == "rfSetup"][0]))
eq("the app is told the slot is off", off["enabled"], 0)
emitted.clear()
node._emit_pass(stats(210))
eq("a switched-off receiver reports no laps", len(laps(emitted)), 0)
node._apply({"type": "rfSetup", "slot": 1, "enabled": 1})
node._min_lap_s = 0.0
node._emit_pass(stats(210))
eq("and a switched-on one does", len(laps(emitted)), 1)


# ---- a burst of config is one round trip -----------------------------------
# Config arrives in bursts — a calibration sweep, a slider, a retry. Each rfSetup
# is two writes and two read-backs on a port the poll loop has to stop using, so
# applied one at a time a burst stalls the loop for multiples of that: the signal
# window develops a hole, the page's trace flat-lines, and a lap crossed during
# the stall is only noticed afterwards.
node, fake, clock = wire()
node._frequency, node._enter, node._exit = 5658, 114, 108
fake.writes.clear()
described = []
node.on_raw = described.append
# Through the inbound path the browser actually uses, so that coalescing is
# tested where it happens rather than at the method that happens to do it.
for thr in (1600.0, 1700.0, 1760.0):
    node.send(laprf.set_rf_setup(1, 2, 8, 5917, threshold=thr, gain=rh.FAKE_GAIN))
node._drain_pending()
eq("a burst of thresholds is written once",
   len([w for w in fake.writes if w[0] == rh.WRITE_ENTER_AT_LEVEL]), 1)
eq("and it is the last one the app asked for", fake.enter, rh.to_node_rssi(1760.0))
eq("the frequency likewise", fake.freq, 5917)
eq("written once too", len([w for w in fake.writes if w[0] == rh.WRITE_FREQUENCY]), 1)
eq("and the app is described once, not three times", len(described), 1)

# Gain is the one field a node cannot honour. Silently dropping it let the tuning
# screen offer a control that did nothing while the app threw away its measured
# passes believing it had changed something.
said = []
node, fake, clock = wire()
node.on_log = said.append
node._frequency, node._enter = 5658, 114
node._apply({"type": "rfSetup", "slot": 1, "gain": 20})
check("a gain the node cannot set is said out loud",
      any("gain" in m for m in said), f"log said {said}")


# ---- inbound that never resolves -------------------------------------------
# A page sending something malformed, or a frame truncated by a dropped
# connection, leaves bytes that will never form a record. Held forever they
# accumulate for the life of the session while yielding nothing.
node, fake, clock = wire()
node.send(b"\x5a" * 20000)          # a frame start that never ends
node._drain_pending()
check("unresolved inbound is bounded", len(node._pending) <= rh.MAX_PENDING,
      f"holding {len(node._pending)} bytes")
# And a real frame arriving in two pieces still assembles.
seen = []
node, fake, clock = wire(on_raw=seen.append)
node._frequency, node._enter = 5658, 114
frame = laprf.get_rf_setup(1)
node.send(frame[:6]); node._drain_pending()
eq("half a frame does nothing yet", len(seen), 0)
node.send(frame[6:]); node._drain_pending()
eq("and the other half completes it", len(seen), 1)


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


for name, f in (("a silent device", Mute()), ("a device with another protocol", WrongMarker())):
    node, _, _ = wire(f)
    rev = node._read(rh.READ_REVISION_CODE)
    check(f"{name} is not mistaken for a node",
          rev is None or rev[0] != rh.RotorHazardNode.REVISION_MARKER,
          f"got {rev.hex() if rev else None}")

# And the reverse, which is a property of the LapRF path rather than this one:
# it looks only at ttyACM and usbmodem names, so a node on ttyUSB is invisible
# to it. Checked here because this is where a second serial device arrived.
device_src = open(os.path.join(ROOT, "device.py")).read()
check("the LapRF serial path does not search ttyUSB", "/dev/ttyUSB" not in device_src,
      "it would open a RotorHazard node and read LapRF records out of it")

# Searching for a node means writing a byte to each candidate port, and a LapRF's
# USB endpoint is a console that takes typed commands. It is ruled out by its USB
# identity rather than spoken to and judged on its reply.
eq("the LapRF's USB id is the one this refuses to probe",
   (rh.LAPRF_VID, rh.LAPRF_PID), (0x04D8, 0x000A))
check("and device.py agrees on it", "0x04D8" in device_src or "0x04d8" in device_src,
      "the two files disagree about what a LapRF is")

# Probing opens a port, which asserts DTR and reboots an Arduino-class board — a
# flight controller included. Unavoidable if a node is to be found without being
# told where it is, but it must not be done silently on a tight loop.
check("the search backs off rather than resetting a bench every second",
      rh.RETRY_MAX_S >= 20.0 and rh.RETRY_MIN_S >= 1.0,
      f"retries from {rh.RETRY_MIN_S}s to {rh.RETRY_MAX_S}s")
# Not called here: running the search would open, and so reset, whatever is
# actually plugged into the machine running the tests. What can be checked
# without touching hardware is that a refusal carries a reason — the bare
# `except: return False` it replaced made a port refused for want of dialout
# membership and a port with a flight controller behind it the same silent no.
ok, why = rh.probe_port("/dev/definitely-not-a-port")
check("a port that cannot be opened says why", ok is False and why,
      f"got {(ok, why)}")
src_find = src.split("def find_node_port")[1].split("def probe_port")[0]
check("and the search names every port it touches", "say(f\"probing" in src_find,
      "a search that resets a bench without saying so leaves no way to tell "
      "which board it just rebooted")


# ---- a node that will not say what it is -----------------------------------
# Reporting a threshold of zero is worse than failing to connect: the app adopts
# it, judges every pass as clearing it by a mile, calls the gate calibrated, and
# in solo mode starts the race on a gate whose level was never read.
node, fake, clock = wire()
node._frequency, node._enter = 5917, None
said = []
node.on_log = said.append
node.on_raw = lambda b: FAILURES.append("a threshold of zero reached the app")
node._describe(1)
check("a node that never gave an arm level is not described as being on zero",
      any("arm level" in m for m in said), f"log said {said}")


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


f = Dies()
node, _, _ = wire(f)
node.connected = True
f.alive = False
raised = False
try:
    node._poll_forever()
except OSError:
    raised = True
check("a node that stops answering ends the connection", raised,
      "the poll loop carried on against a dead port")


# ---- and comes back on a different port ------------------------------------
# A knocked cable is the reason the retry loop exists, and a node that
# re-enumerates comes back on the next port along. Pinning the path found by the
# search means every retry for the life of the process opens a port nothing is
# on, while the node sits working one along.
node = rh.RotorHazardNode()
check("a port that was found is not pinned", not node.pinned)
node = rh.RotorHazardNode(port="/dev/ttyUSB0")
check("a port that was given is", node.pinned)


# ---- opening, and re-opening -----------------------------------------------
# The open is where the DTR reset happens, so it is where the node's own lap
# counter goes back to zero. It is also where a node that half-answers has to be
# refused. Neither was reachable from a test until the bootloader wait became a
# constant this can zero out.
rh.BOOT_WAIT_S = 0.0


class FakeSerialModule:
    """Just enough of pyserial for _open to run against software."""

    def __init__(self, device):
        self.device = device
        self.opened = []

    def Serial(self, port, baud, timeout=None):
        self.opened.append(port)
        if self.device is None:
            raise OSError(f"could not open {port}")
        return self.device


def with_fake_serial(mod, fn):
    import sys as _sys
    saved = _sys.modules.get("serial")
    _sys.modules["serial"] = mod
    try:
        return fn()
    finally:
        if saved is None:
            _sys.modules.pop("serial", None)
        else:
            _sys.modules["serial"] = saved


f = FakeSerial(freq=5917, enter=114, exit_=108)
node = rh.RotorHazardNode(port="/dev/fake0", clock=Clock())
node._lap_count = 7                        # a session's worth of state
node._filtered_log = [(0.0, 200)] * 40
node._recent = [200] * 5
node._last_pass_at = 10.0
node._threshold_laprf = 1417.3
with_fake_serial(FakeSerialModule(f), node._open)
check("the open connects", node.connected)
eq("  and reads the node's frequency", node._frequency, 5917)
eq("  and its arm level", node._enter, 114)
# Opening rebooted the node, so its lap counter is back at zero. Carrying the
# old count across means the first reading after any reconnect differs from it
# and is taken for a lap that never happened — judged against a signal window
# that also survived the outage, so a quad anywhere near the gate when the link
# returns puts a phantom lap into saved history.
eq("a reconnect does not carry the old lap count", node._lap_count, None)
eq("nor the old signal window", node._filtered_log, [])
eq("nor the median's contents", node._recent, [])
eq("nor a threshold nobody has asked for yet", node._threshold_laprf, None)


class Deaf(FakeSerial):
    """A node that identifies itself and then will not say what it is set to."""
    def write(self, data):
        if data[0] in (rh.READ_ENTER_AT_LEVEL, rh.READ_EXIT_AT_LEVEL):
            return
        super().write(data)


node = rh.RotorHazardNode(port="/dev/fake0", clock=Clock())
refused = None
try:
    with_fake_serial(FakeSerialModule(Deaf()), node._open)
except OSError as e:
    refused = str(e)
check("a node that will not report its arm level is refused, not adopted", refused,
      "it would be described to the app as armed at zero, which the app adopts, "
      "calls calibrated, and in solo mode starts the race on")
check("  and the refusal says which reading was missing",
      refused and "enter level" in refused, f"said {refused!r}")
check("  and it is not left looking connected", not node.connected)

# A failed connect must be said out loud. The page falls back to the bridge's
# generic reason otherwise, which is about a LapRF's advertising window and its
# battery — every word of it about hardware the user has said they are not using.
said = []
node = rh.RotorHazardNode(port="/dev/fake0", clock=Clock(), on_log=said.append)
node._fault("could not open /dev/fake0", rh.RETRY_MIN_S)
check("a connect failure is logged even though it never connected", said,
      "the retry loop used to log only if it had connected once, so a node that "
      "never came up said nothing at all, forever")
before = len(said)
node._fault("could not open /dev/fake0", rh.RETRY_MIN_S)
eq("  and is not repeated on every retry", len(said), before)

# ---- the promise -----------------------------------------------------------
# The LapRF path is not modified by any of this, and that is checkable — by
# content, not by asking git what changed. `git diff --name-only HEAD` is empty
# on every clean checkout, which is what CI runs on, so the guarantee this file
# opens with was wired to a check that could not fail.
LAPRF_FILES = {
    "laprf.py":
        "b2ad6ff78e3ba7a1cee486dc31c2ab766f519decaeba5e6cb4ff7b014019504f",
    "static/js/laprf.js":
        "7add9f6086074c34cac6b27b2a1dfc92f8b58a25a5f960dd78d701b9e906c237",
    "static/js/link.js":
        "05c4214ea84694820e00336414f4ee44a15b39988b10e954a1112e959d62b56b",
    "static/js/tuning.js":
        "78e94382613991b1fdefeab03edb2a66679609f23147e63ef922653549af739a",
    "static/js/app.js":
        "e70cb53abed950f4c0e62ed5ad22026241ae148857a11ce8103e7384cab95432",
    "static/js/race.js":
        "2698f494653bfc9a22f4def321067db6e3cb6b0c96bea6c958f4d4dfc5379c08",
    "static/js/screens.js":
        "e6363a9fa3c7acf8661db0f0e1cfdf2cb2505e06a8abc0857de511e71204afbb",
}
for name, want in LAPRF_FILES.items():
    got = hashlib.sha256(open(os.path.join(ROOT, name), "rb").read()).hexdigest()
    check(f"the LapRF implementation is untouched: {name}", got == want,
          f"{name} has changed.\n     If that was deliberate, re-run the app against a "
          f"real LapRF, then update this hash to {got}")

if FAILURES:
    print(f"{len(FAILURES)} failure(s):\n")
    for f in FAILURES:
        print("  FAIL " + f)
    sys.exit(1)
print("rotorhazard translator: all scenarios pass")
