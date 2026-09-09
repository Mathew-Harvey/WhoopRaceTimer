"""A RotorHazard node, presented to the app as a LapRF.

The browser speaks one protocol and one only. Rather than teach it a second —
which would mean touching the transport layer, the gate maths and every constant
tuned to a LapRF's signal scale — this translates. A RotorHazard node goes in,
LapRF records come out, and nothing above the bridge can tell the difference.
That is the whole point: the LapRF implementation is not modified, so it cannot
break.

Two protocols meet here.

  RotorHazard   one command byte out, a fixed-size payload back, one checksum
                byte that is the sum of the payload. Request/response only: the
                node never speaks unprompted. Everything is polled.

  LapRF         SOR-framed records with a CRC and escaping, pushed continuously.
                See laprf.py, which this module uses and does not alter.

WHAT WAS MEASURED, on a home-built node (API level 35, address 8):

  READ_REVISION      2 bytes   0x2523 — 0x25 marker, API level 0x23
  READ_FREQUENCY     2 bytes   5658, i.e. Raceband 1
  READ_ENTER_AT      1 byte    114
  READ_EXIT_AT       1 byte    108
  READ_LAP_STATS    16 bytes   see LapStats below; offsets confirmed by watching
                               which bytes move — ms_since_lap climbs
                               monotonically, loop_time sits near 1000 us, and
                               byte 3 tracks the receiver

  Sizes were discovered by reading generously and finding the prefix whose next
  byte equals its own checksum, rather than trusting a documented table. Note
  that an all-zero payload checksums to zero, so a short read can look valid;
  sizes here are the ones that survived repeated probing.

THE SIGNAL SCALE. A RotorHazard node reports RSSI in 0-255; a LapRF reports
roughly 900 quiet to 3000 at a close pass, and every threshold, span and preset
in the app is tuned to that. Measured noise floor on this node is 58, and 58*16
is 928 — against a LapRF's measured 935-960. So a factor of sixteen lines the
two floors up and leaves the app's constants meaning exactly what they meant.
It is one number, here, and nothing above it needs to know.

THE CLOCK. Everything this file measures durations with is monotonic. A laptop
or a Pi taken to a track boots offline and steps its wall clock when it joins
track wifi — seconds, backwards as often as forwards, and hours on a machine
with no battery-backed clock. A backward step against a wall clock makes every
interval since the step negative, which reads as "too soon after the last lap"
and silently discards laps until the clock catches up. Durations are monotonic;
only the timestamp the app is handed needs a stable origin, and that is a
counter from this process's own start.
"""
import struct
import threading
import time

import laprf

# ---- node protocol ---------------------------------------------------------

READ_ADDRESS = 0x00
READ_FREQUENCY = 0x03
READ_LAP_STATS = 0x05
READ_REVISION_CODE = 0x22
READ_ENTER_AT_LEVEL = 0x31
READ_EXIT_AT_LEVEL = 0x32
WRITE_FREQUENCY = 0x51
WRITE_ENTER_AT_LEVEL = 0x71
WRITE_EXIT_AT_LEVEL = 0x72

# Payload sizes, discovered against real hardware rather than assumed.
SIZES = {
    READ_ADDRESS: 1,
    READ_FREQUENCY: 2,
    READ_LAP_STATS: 16,
    READ_REVISION_CODE: 2,
    READ_ENTER_AT_LEVEL: 1,
    READ_EXIT_AT_LEVEL: 1,
}

#: One node is one receiver, and it is the first slot. A LapRF has eight and the
#: app asks all four it races about themselves; answering for any but this one
#: claims receivers that do not exist — the app would show four gates on one
#: frequency, and a write aimed at the fourth would retune the first, so a pilot
#: choosing their own channel would move somebody else's.
NODE_SLOT = 1

#: RotorHazard RSSI (0-255) to LapRF counts. See the module docstring: this is
#: measured, not chosen — it puts the two noise floors on top of each other.
RSSI_SCALE = 16

#: A single wild reading, every few seconds, at a fixed offset above whatever
#: the receiver is actually sitting on — measured at +52 counts on 5917 and +53
#: on 5658, which is a periodic re-tune of the receiver rather than anything on
#: the air. One sample wide, so a median erases it; a real pass spans several
#: polls and survives. Without this it crosses the arm level on its own and the
#: node counts a lap for it.
#: Measured at twenty-two samples a second: eleven artefacts in twenty seconds,
#: every one of them exactly one sample wide, peaking 95-97 against a baseline
#: of 40. A pass at that rate lasts about half a second — some eleven samples —
#: so a window of five sits comfortably between the two: wide enough that a
#: second artefact landing nearby cannot outvote it, narrow enough that it
#: cannot blunt a real crossing.
MEDIAN_WINDOW = 5

#: How often the node is actually asked, regardless of how often the app wants
#: telling. The two are separate on purpose: a median can only discard an
#: artefact that its neighbours outvote, and at the rate the app reports —
#: five times a second — a re-tune spanning a couple of hundred milliseconds
#: covers two samples of three and wins. Asked twenty-five times a second it
#: covers one or two of a much denser stream and loses, while a real pass, which
#: lasts about half a second, covers a dozen. The node's own loop runs in about
#: a millisecond, so it has no trouble keeping up.
POLL_INTERVAL = 0.04

#: How far the *filtered* signal must have risen, recently, for a lap the node
#: reports to be a real crossing — stated in LapRF counts, because it is the
#: app's own number.
#:
#: Judging the node's own reported peak against a height was the obvious thing
#: and it was wrong: the artefact reaches 56 or 57 counts above the floor, so
#: any cutoff that rejects it sits within a couple of counts of it and lets
#: through whichever ones run slightly hot — 176 caught and 30 missed, in one
#: twenty-five second sample. The filter already tells the two apart perfectly,
#: because the artefact is one sample wide and a pass is eleven, so ask the
#: filtered stream instead. An artefact leaves no trace there at all.
#:
#: Which is why this is small, and why it must stay tied to the app's own
#: WATCH_MIN_RISE rather than being chosen here. A veto set higher than the app
#: calibrates to is a second, coarser trigger that silently overrules it: the
#: node arms where the app asked, counts every real lap, and this throws them
#: away — and because the app lowers its trigger from the evidence in reported
#: passes, suppressing the passing destroys the evidence that would have fixed
#: the gate. It deadlocks, on a gate the app is still calling healthy.
MIN_PASS_RISE_LAPRF = 60                                    # tuning.js WATCH_MIN_RISE
MIN_PASS_RISE = (MIN_PASS_RISE_LAPRF + RSSI_SCALE - 1) // RSSI_SCALE

#: How far back to look for that rise. A pass lasts about half a second and the
#: node reports its lap at the end of one, so a second and a half covers it
#: without reaching back to the lap before.
PASS_LOOKBACK_S = 1.5

#: The window the noise floor is taken from, and where in it.
#:
#: A running average converged too slowly to be trusted at the start: for the
#: first seconds after connecting it sat well below the real floor, so an
#: ordinary reading cleared it by more than the required rise and two artefacts
#: were reported as laps before it caught up. A low percentile over a window
#: settles within a couple of seconds instead, and cannot be dragged up by a
#: pass — which is the same reason the app takes its own quiet level this way.
BASELINE_WINDOW_S = 10.0
BASELINE_QUANTILE = 0.2

#: How much unresolved inbound can wait for its tail before it is thrown away,
#: and how much of it to keep when that happens. The same shape as the app's own
#: reader: enough to hold any real frame several times over, bounded so that
#: bytes which will never form a record cannot accumulate for a whole session.
MAX_PENDING, KEEP_PENDING = 4096, 1024

#: No lap is judged until the window it would be judged against covers this much
#: time. In seconds, not samples: the window is pruned by the clock, so a count
#: is not a warm-up at all — it is a hidden demand that the poll loop sustain a
#: particular rate, and a link slow enough to miss it never reaches the count at
#: any point in the session. Every lap is then refused for the rest of the
#: meeting while the page shows a healthy link with live signal on it.
WARMUP_S = 2.0

#: A LapRF reports its own battery; a node has none. The app only shows this,
#: and a plausible constant is better than a missing field it would render as a
#: dash forever.
FAKE_BATTERY_MV = 4000

#: A node has no gain control of the kind a LapRF exposes. Reported so the app's
#: RF-setup echo is complete, and said out loud when the app tries to set it,
#: rather than being dropped on the floor.
FAKE_GAIN = 58

#: How far below the arm level the disarm level sits, in node counts. Six is
#: roughly the gap the node shipped with (114/108) and is about a tenth of the
#: measured noise floor — enough that a signal resting on the line cannot
#: chatter, small enough not to swallow a fast pass.
EXIT_BELOW_ENTER = 6

#: How long to wait before trying a port again, and how far that grows. It grows
#: because looking for a node means opening a port, which asserts DTR and reboots
#: any Arduino-class board behind it: a bench with a flight controller on it
#: should not be reset every second and a half for the life of the process.
RETRY_MIN_S, RETRY_MAX_S = 1.5, 30.0

#: How long an Arduino-class board takes to get through its bootloader after the
#: DTR assert that opening the port causes. Nothing it says before then is worth
#: reading. A constant rather than a literal so a test can drive an open without
#: sitting through it — the open is where the state reset and the refusal to
#: adopt a half-answering node live, and neither was reachable from a test.
BOOT_WAIT_S = 2.4

#: The LapRF's own USB identity, from device.py. A port with this behind it is
#: never probed: probing means writing a byte, and the byte would land in a
#: LapRF's ASCII console.
LAPRF_VID, LAPRF_PID = 0x04D8, 0x000A


def checksum(payload):
    return sum(payload) & 0xFF


def write_frame(cmd, payload):
    """The bytes to send for a write: command, payload, checksum of the payload."""
    return bytes([cmd]) + bytes(payload) + bytes([checksum(payload)])


class LapStats:
    """One READ_LAP_STATS payload, named.

    Offsets were established by observation, not documentation: bytes 1-2 climb
    monotonically between laps, bytes 6-7 hold steady near a thousand
    microseconds, and byte 3 moves with the receiver while byte 4 ratchets
    upward as a peak does.
    """

    __slots__ = ("lap_count", "ms_since_lap", "rssi", "node_peak",
                 "pass_peak", "loop_time", "flags", "raw")

    def __init__(self, raw):
        self.raw = bytes(raw)
        self.lap_count = raw[0]
        self.ms_since_lap = int.from_bytes(raw[1:3], "big")
        self.rssi = raw[3]
        self.node_peak = raw[4]
        self.pass_peak = raw[5]
        self.loop_time = int.from_bytes(raw[6:8], "big")
        self.flags = raw[8] if len(raw) > 8 else 0

    def __repr__(self):
        return (f"LapStats(lap={self.lap_count} ms_since={self.ms_since_lap} "
                f"rssi={self.rssi} peak={self.node_peak} pass_peak={self.pass_peak} "
                f"loop={self.loop_time}us)")


# ---- translation to LapRF records ------------------------------------------

def status_record(rssi, *, slot=NODE_SLOT, battery_mv=FAKE_BATTERY_MV, gate_active=True):
    """A LapRF status record carrying one node's signal.

    The app reads exactly three things out of these — the slot's last RSSI, the
    battery, and whether the gate is doing anything — so exactly three go in.
    """
    return laprf.encode(laprf.RT_STATUS, [
        (laprf.ST_SLOT, "u8", slot),
        (laprf.ST_LAST_RSSI, "f32", float(rssi)),
        (laprf.ST_BATTERY, "u16", battery_mv),
        (laprf.ST_GATE_STATE, "u8", 1 if gate_active else 0),
    ])


def passing_record(peak, number, *, slot=NODE_SLOT, rtc_ms=0):
    """A LapRF passing record for a lap the node reported.

    rtcTime is in MILLIseconds. That is what a LapRF sends and, more to the
    point, what the only consumer expects: race.js divides the difference
    between two of these by a thousand and compares the result, in seconds,
    against the lap it measured from browser arrival times. Microseconds here
    make that comparison fail by a factor of a thousand on every lap, so the
    hardware clock is discarded and every lap falls back to arrival time —
    which is exactly the jitter this field exists to remove, and it fails
    silently, looking like nothing more than a slightly noisy timer.
    """
    return laprf.encode(laprf.RT_PASSING, [
        (laprf.PS_SLOT, "u8", slot),
        (laprf.PS_RTC_TIME, "u64", max(0, int(rtc_ms))),
        (laprf.PS_PASSING_NUMBER, "u32", number),
        (laprf.PS_PEAK_HEIGHT, "u16", min(0xFFFF, max(0, int(peak)))),
    ])


def rf_setup_record(frequency, threshold, *, slot=NODE_SLOT, enabled=True,
                    gain=FAKE_GAIN, band_channel=None):
    """What the app is told when it asks a slot to describe itself.

    `band_channel` is the pair the app itself last wrote for this frequency, if
    it wrote one. See band_channel_for for why that is worth remembering.
    """
    band, channel = band_channel or band_channel_for(frequency)
    return laprf.set_rf_setup(slot, band, channel, frequency,
                              threshold=float(threshold), gain=gain, enabled=enabled)


def band_channel_for(frequency):
    """The band and channel indexes a LapRF would use for this frequency.

    A node knows only a frequency, and a frequency is not always enough: 5880 is
    both R7 and F8, and the two are the same carrier under two names. Scanning
    the band tables in order and taking the first hit would answer F8 to every
    such query, including for a pilot who chose R7 — and the app trusts a
    reported band over a frequency lookup, so it would write F8 into that
    pilot's saved channel and keep it there into later sessions on a real LapRF.

    So an ambiguous frequency claims no band at all. Band 0 is how the app hears
    "this timer did not say", which is the truth: what a node holds is 5880, and
    which of its two names the pilot meant is not something it knows. What the
    app itself wrote is remembered separately, by the caller, and that does
    answer the question.
    """
    hits = [(i, table.index(frequency) + 1)
            for i, letter in enumerate(laprf.BAND_ORDER, start=1)
            for table in [laprf.BANDS[letter]] if frequency in table]
    return hits[0] if len(hits) == 1 else (0, 0)


def to_laprf_rssi(node_rssi):
    """Node counts to LapRF counts. One place, one number."""
    return int(node_rssi) * RSSI_SCALE


def to_node_rssi(laprf_rssi):
    """And back, for a threshold the app has decided on."""
    return max(0, min(255, int(round(float(laprf_rssi) / RSSI_SCALE))))


# ---- the transport --------------------------------------------------------

class RotorHazardNode:
    """A RotorHazard node presented with the interface server.py's Bridge wants.

    Same shape as LapRFBle and LapRFSerial — start(), send(), connected, detail
    — so the bridge holds it without knowing what it is, and the browser
    receives a stream it already understands.

    A node never speaks unprompted, so everything the app expects to be pushed
    at it is produced here on a poll. The rate is whatever the app asked for
    with setStatusInterval, which is the same thing a LapRF is told.
    """

    #: Identify before adopting. A LapRF on the same bench must never be opened
    #: by this, and a node must never be opened by the LapRF serial path.
    REVISION_MARKER = 0x25

    def __init__(self, port=None, on_raw=None, on_log=None, clock=None):
        #: A port given explicitly is pinned; one that was found is not. See
        #: _open: re-finding it is the whole point of the retry loop.
        self.pinned = bool(port)
        self.port = port or ""
        self.on_raw = on_raw or (lambda b: None)
        self.on_log = on_log or (lambda m: None)
        #: Monotonic, and injectable so a test can drive a time-dependent veto
        #: without sleeping through it. See the module docstring for why every
        #: duration here is monotonic rather than wall time.
        self.now = clock or time.monotonic
        self.connected = False
        self.detail = ""
        self.api_level = None
        self.node_address = None

        self._ser = None
        self._stop = False
        self._interval = 0.2            # until the app says otherwise
        self._min_lap_s = 0.0
        self._last_pass_at = None
        self._lap_count = None
        self._passing_number = 0
        self._frequency = None
        self._band_channel = None       # what the app called this frequency, if it said
        self._enter = None
        self._exit = None
        self._threshold_laprf = None    # the exact level the app asked for
        self._enabled = True            # the app can switch a slot off; a node cannot
        self._pending = bytearray()     # inbound LapRF bytes from the browser
        self._recent = []               # last few raw readings, for the median
        self._filtered_log = []         # (when, filtered value), recent only
        self._last_fault = None         # so a retry loop cannot flood the log
        # Built here rather than in start(): send() takes it, and a caller that
        # sends before starting would otherwise meet a None.
        self._lock = threading.Lock()

    # ---- lifecycle ----
    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        self._stop = True
        try:
            if self._ser:
                self._ser.close()
        except Exception:
            pass

    def _run(self):
        delay = RETRY_MIN_S
        while not self._stop:
            try:
                self._open()
                delay = RETRY_MIN_S
                self._poll_forever()
            except Exception as e:
                # Logged whether or not it ever connected. Failing to connect is
                # the case a user most needs told about, and it was the one case
                # this said nothing at all about: the page falls back to the
                # bridge's generic reason, which talks about a LapRF's
                # advertising window and its battery — every word of it about
                # hardware the user has explicitly said they are not using.
                self._fault(f"{type(e).__name__}: {e}", delay)
                self.connected = False
                try:
                    if self._ser:
                        self._ser.close()
                except Exception:
                    pass
                self._ser = None
                if not self.pinned:
                    self.port = ""      # it may come back on a different one
                if self._stop:
                    return
                time.sleep(delay)
                delay = min(RETRY_MAX_S, delay * 2)

    def _fault(self, message, delay):
        """Say what went wrong, without saying it four hundred times.

        A retry loop that logs every attempt buries everything else in the
        bridge log; one that logs none is what this used to do. So: every new
        message, and a repeat only when it has been going on long enough that
        someone reading the log deserves reminding.
        """
        now = self.now()
        last, when = self._last_fault or (None, 0.0)
        if message != last or now - when >= 60.0:
            self._last_fault = (message, now)
            self.on_log(f"node: {message} (retrying in {delay:.0f}s)")

    def _open(self):
        import serial
        port = self.port if self.pinned and self.port else find_node_port(self.on_log)
        if not port:
            raise OSError("no RotorHazard node found on any serial port")
        self._ser = serial.Serial(port, 115200, timeout=0.4)
        # Opening asserts DTR, which resets an Arduino. Nothing it says before
        # the bootloader has finished is worth reading.
        time.sleep(BOOT_WAIT_S)
        self._ser.reset_input_buffer()

        rev = self._read(READ_REVISION_CODE)
        if not rev or rev[0] != self.REVISION_MARKER:
            raise OSError(f"not a RotorHazard node on {port} "
                          f"(revision {rev.hex() if rev else 'unreadable'})")
        self.api_level = rev[1]
        addr = self._read(READ_ADDRESS)
        self.node_address = addr[0] if addr else None

        # Frequency and the arm/disarm pair are not optional. Carrying on
        # without them leaves the app worse off than a failed connection does:
        # a missing frequency means every getRfSetup is answered with silence,
        # so the slot stays blank and unwritable forever with nothing said,
        # while a missing arm level was reported as a trigger of zero — which
        # the app adopts, judges every pass as clearing by a mile, calls the
        # gate calibrated, and in solo mode starts the race on. Better to fail
        # the open and retry, which is visible and recovers.
        freq = self._read(READ_FREQUENCY)
        ent = self._read(READ_ENTER_AT_LEVEL)
        ext = self._read(READ_EXIT_AT_LEVEL)
        if not freq or not ent or not ext:
            missing = ", ".join(n for n, v in (("frequency", freq), ("enter level", ent),
                                               ("exit level", ext)) if not v)
            raise OSError(f"node on {port} would not report its {missing}")

        # A fresh open is a fresh node: the DTR assert above rebooted it, so its
        # own lap counter is back at zero. Carrying the old count across means
        # the first reading after any reconnect differs from it and is taken for
        # a lap that never happened, judged against a signal window that also
        # survived the outage.
        self._lap_count = None
        self._recent = []
        self._filtered_log = []
        self._last_pass_at = None

        self._frequency = int.from_bytes(freq, "big")
        self._band_channel = None       # the app has not said what it calls this
        self._enter, self._exit = ent[0], ext[0]
        self._threshold_laprf = None    # nothing was asked for; report what is held

        self.port = port
        self.connected = True
        self.detail = (f"RotorHazard node (API {self.api_level}, address "
                       f"{self.node_address}) on {port}")
        self.on_log(f"{self.detail}; {self._frequency} MHz, "
                    f"enter {self._enter} exit {self._exit}")

    # ---- node conversation ----
    def _read(self, cmd, size=None):
        """One command, one payload, checksum verified. None if it did not add up."""
        size = SIZES[cmd] if size is None else size
        for _ in range(3):
            self._ser.reset_input_buffer()      # never inherit a stale tail
            self._ser.write(bytes([cmd]))
            self._ser.flush()
            r = self._ser.read(size + 1)
            if len(r) == size + 1 and checksum(r[:-1]) == r[-1]:
                return r[:-1]
            time.sleep(0.02)
        return None

    def _write(self, cmd, payload):
        self._ser.write(write_frame(cmd, payload))
        self._ser.flush()
        time.sleep(0.02)

    # ---- the poll loop ----
    def _poll_forever(self):
        last_report = None
        while not self._stop and self._ser:
            started = self.now()
            self._drain_pending()

            raw = self._read(READ_LAP_STATS)
            if raw is None:
                # A node that will not answer is not a node any more.
                raise OSError("node stopped answering")
            st = LapStats(raw)
            rssi = self._filtered(st.rssi, at=started)

            # Read often, speak when asked. Every reading feeds the filter; only
            # some of them become records, at whatever rate the app set.
            if last_report is None or started - last_report >= self._interval:
                last_report = started
                self.on_raw(status_record(to_laprf_rssi(rssi)))

            if self._lap_count is None:
                self._lap_count = st.lap_count          # first reading is a baseline
            elif st.lap_count != self._lap_count:
                self._lap_count = st.lap_count
                self._emit_pass(st, at=started)

            slept = self.now() - started
            time.sleep(max(0.005, POLL_INTERVAL - slept))

    def _filtered(self, raw_rssi, at=None):
        """The receiver's reading with its re-tune artefact taken out.

        A median rather than an average: the artefact is a single sample far
        from its neighbours, which a median discards outright and a mean would
        merely dilute. A pass is several samples and comes through untouched.
        """
        now = self.now() if at is None else at
        if not self._recent:
            # Primed rather than empty. An unfilled window has to return
            # something, and returning the raw reading means the very first
            # sample after connecting is unfiltered — which is exactly when an
            # artefact would be taken for a signal and reported as one.
            self._recent = [raw_rssi] * MEDIAN_WINDOW
        self._recent.append(raw_rssi)
        if len(self._recent) > MEDIAN_WINDOW:
            self._recent.pop(0)
        value = sorted(self._recent)[MEDIAN_WINDOW // 2]
        self._filtered_log.append((now, value))
        while self._filtered_log and self._filtered_log[0][0] < now - BASELINE_WINDOW_S:
            self._filtered_log.pop(0)
        return value

    def _noise_floor(self):
        """The settled quiet level: a low percentile of the window, taken when
        it is wanted rather than on every reading. A pass cannot drag it up."""
        vals = sorted(v for _, v in self._filtered_log)
        if not vals:
            return None
        return vals[int((len(vals) - 1) * BASELINE_QUANTILE)]

    def _covered_s(self):
        """How much time the signal window actually spans."""
        if len(self._filtered_log) < 2:
            return 0.0
        return self._filtered_log[-1][0] - self._filtered_log[0][0]

    def _emit_pass(self, st, at=None):
        """A lap the node counted, with the minimum lap the app asked for.

        A LapRF discards a crossing that arrives too soon after the last and the
        app writes that setting; a node has no such control, so it is honoured
        here instead. Anything else would make the same setting mean two
        different things depending on which timer is plugged in.
        """
        if not self._enabled:
            return
        now = self.now() if at is None else at

        # The node counts a lap for its own re-tune artefact, because the
        # artefact crosses the arm level exactly as a quad would. It is the one
        # thing here that can invent a lap out of nothing, so it is caught
        # before it reaches the app as a passing record — by asking whether the
        # filtered signal actually moved, which an artefact never makes it do.
        covered = self._covered_s()
        if covered < WARMUP_S:
            self.on_log(f"lap ignored: only {covered:.1f}s of signal so far, "
                        f"too soon to tell a crossing from noise")
            return
        floor = self._noise_floor()
        recent = [v for t, v in self._filtered_log if t >= now - PASS_LOOKBACK_S]
        rose = max(recent) if recent else floor
        if rose < floor + MIN_PASS_RISE:
            self.on_log(f"lap ignored: the signal never rose — {rose:.0f} against a "
                        f"floor of {floor:.0f} (node reported peak {st.pass_peak})")
            return

        if self._last_pass_at is not None and self._min_lap_s \
                and (now - self._last_pass_at) < self._min_lap_s:
            self.on_log(f"lap discarded: {now - self._last_pass_at:.2f}s since the last, "
                        f"minimum is {self._min_lap_s:.2f}s")
            return
        self._last_pass_at = now
        self._passing_number += 1

        # The node says how long ago the crossing was, so use it: the poll loop
        # can be a beat late, and any serial work done for a config write puts
        # that whole delay straight into the lap interval. Bounded, because a
        # figure larger than the window this was judged against is not something
        # to back-date by.
        ago = min(max(0.0, st.ms_since_lap / 1000.0), PASS_LOOKBACK_S)
        self.on_raw(passing_record(to_laprf_rssi(rose), self._passing_number,
                                   rtc_ms=int((now - ago) * 1000.0)))
        self.on_log(f"lap {self._passing_number}, peak {rose} (filtered), "
                    f"{ago * 1000:.0f} ms ago")

    # ---- what the browser sends ----
    def send(self, data):
        """Queue LapRF bytes from the page. Acted on inside the poll loop, so
        the serial port has exactly one user."""
        with self._lock:
            self._pending.extend(data)

    def _drain_pending(self):
        with self._lock:
            if not self._pending:
                return
            buf = bytes(self._pending)
            self._pending.clear()
        records, rest = laprf.split_records(buf)
        if rest:
            # A partial frame waits for its tail — but only so long. Bytes that
            # never resolve into a record would otherwise accumulate for the
            # life of the session: a page sending something malformed, or a
            # frame truncated by a dropped connection, and this grows without
            # limit while never yielding anything. The app's own reader caps its
            # buffer for the same reason.
            if len(rest) > MAX_PENDING:
                self.on_log(f"discarding {len(rest)} bytes that never formed a record")
                rest = rest[-KEEP_PENDING:]
            with self._lock:
                self._pending[:0] = rest
        decoded = []
        for r in records:
            try:
                decoded.append(laprf.decode_record(r))
            except Exception as e:
                self.on_log(f"could not apply a record: {type(e).__name__}: {e}")
        self._apply_all(decoded)

    def _apply_all(self, records):
        """Act on a batch, doing the serial work once.

        Config arrives in bursts — a calibration sweep, a slider, a retry — and
        each rfSetup means two writes and two read-backs on a port the poll loop
        has to stop using. Applied one at a time, a burst stalls the loop for
        multiples of that: no readings, so the signal window develops a hole and
        the page's trace flat-lines, and a lap crossed during the stall is only
        noticed afterwards. Only the last value in a burst is the one the app
        wants, so only the last one is written.
        """
        want_freq = want_thr = want_enabled = None
        describe_for = None
        for rec in records:
            if not rec or rec.get("type") == "crc_error":
                continue
            kind = rec.get("type")

            if kind == "rfSetup":
                if rec.get("slot", NODE_SLOT) != NODE_SLOT:
                    continue            # there is no such receiver here
                if rec.get("enabled") is not None:
                    want_enabled = bool(rec["enabled"])
                if rec.get("frequency"):
                    want_freq = int(rec["frequency"])
                    # What the app calls this frequency. Worth keeping: 5880 is
                    # both R7 and F8, and only the app knows which it meant.
                    want_bc = (rec.get("band"), rec.get("channel"))
                    self._band_channel = want_bc if self._names(want_bc, want_freq) else None
                if rec.get("threshold") is not None:
                    want_thr = float(rec["threshold"])
                if rec.get("gain") is not None and int(rec["gain"]) != FAKE_GAIN:
                    self.on_log(f"gain {rec['gain']} ignored: a node has no gain control, "
                                f"so nothing here changes it")
                # Whether it was a query or a write, the app is owed a description.
                describe_for = rec.get("slot", NODE_SLOT)

            elif kind == "settings":
                if rec.get("statusInterval"):
                    self._interval = max(0.05, int(rec["statusInterval"]) / 1000.0)
                    self.on_log(f"reporting every {self._interval * 1000:.0f} ms")
                if rec.get("minLapTime") is not None:
                    self._min_lap_s = int(rec["minLapTime"]) / 1000.0
                    self.on_log(f"minimum lap {self._min_lap_s:.2f}s")

            elif kind == "stateControl":
                # A node is always looking. Nothing to arm, and the app is told
                # so by every status record.
                pass

        if want_enabled is not None:
            # A node has no switch, so honour it here: a receiver the app has
            # turned off must stop producing laps, or a pilot who is not racing
            # collects them.
            self._enabled = want_enabled
        if want_freq is not None:
            self._set_frequency(want_freq)
        if want_thr is not None:
            self._set_thresholds(want_thr)
        if describe_for is not None:
            self._describe(describe_for)

    def _apply(self, rec):
        """One record. Kept because a single record is the ordinary case and
        reads better at the call site; the batch is what the poll loop uses."""
        self._apply_all([rec])

    @staticmethod
    def _names(band_channel, frequency):
        """Does this band and channel pair really mean this frequency?"""
        band, channel = band_channel
        try:
            return laprf.BANDS[laprf.BAND_ORDER[int(band) - 1]][int(channel) - 1] == frequency
        except Exception:
            return False

    def _describe(self, slot):
        if self._frequency is None or self._enter is None:
            # Unreachable once open — _open refuses a node that would not say —
            # but silence here was how a blank, unwritable slot happened, so it
            # says something rather than nothing.
            self.on_log("cannot describe the receiver: the node never reported "
                        "its frequency or arm level")
            return
        # Only if it still names what the node actually holds: a tune that did
        # not take leaves the app's chosen pair pointing at a frequency the
        # receiver never moved to.
        bc = self._band_channel if self._names(self._band_channel or (0, 0),
                                               self._frequency) else None
        self.on_raw(rf_setup_record(self._frequency, self._echo_threshold(), slot=slot,
                                    enabled=self._enabled, band_channel=bc))

    def _echo_threshold(self):
        """The trigger to report back, in LapRF counts.

        The app compares what it reads back against what it wrote, within half a
        count, and rewrites the slot when they differ — three times, then it
        gives up and tells the user the timer would not accept the setup. A node
        holds its arm level as a whole byte, so a self-tuned trigger of 1417.3
        comes back as 1424 and every single write is judged refused, on a gate
        that is in fact armed exactly where it was asked to be.

        So when the level the app asked for still lands on the byte the node is
        holding, the app's own number is what comes back: the write did take,
        and saying so in the app's own terms is the honest answer. A level read
        off the node with nothing asked for is reported as what it is.
        """
        if self._threshold_laprf is not None \
                and to_node_rssi(self._threshold_laprf) == self._enter:
            return self._threshold_laprf
        return to_laprf_rssi(self._enter)

    def _set_frequency(self, mhz):
        if mhz == self._frequency:
            return
        self._write(WRITE_FREQUENCY, struct.pack(">H", mhz))
        back = self._read(READ_FREQUENCY)
        got = int.from_bytes(back, "big") if back else None
        if got == mhz:
            self._frequency = mhz
            # The receiver has moved, so nothing measured before this is about
            # the frequency it is on now. Keeping the window across a retune
            # mixes two noise floors: the quiet level is taken as a low
            # percentile, so it settles on the lower of the two, and every
            # ordinary reading on the higher frequency then clears it by more
            # than the rise a lap has to show. Measured on the bench — retuning
            # 5658 to 5917 with a flat ambient signal produced a lap per second
            # until the old readings aged out. Dropping them also means the
            # warm-up runs again, so nothing is judged until there is a window
            # of this frequency to judge it against.
            self._recent = []
            self._filtered_log = []
            self.on_log(f"tuned to {mhz} MHz")
        else:
            self.on_log(f"tune to {mhz} MHz did not take (node says {got})")

    def _set_thresholds(self, laprf_threshold):
        """One LapRF trigger becomes a node's enter and exit pair.

        This is the direction the translation gains something. A LapRF has a
        single level; a node arms above one and disarms below another, so a
        signal sitting on the line cannot chatter. The app's trigger becomes the
        enter level, and exit sits just under it — the same hysteresis a LapRF
        cannot be given.
        """
        enter = to_node_rssi(laprf_threshold)
        exit_ = max(0, enter - EXIT_BELOW_ENTER)
        self._threshold_laprf = laprf_threshold
        if enter == self._enter and exit_ == self._exit:
            return
        self._write(WRITE_ENTER_AT_LEVEL, bytes([enter]))
        self._write(WRITE_EXIT_AT_LEVEL, bytes([exit_]))
        back_e = self._read(READ_ENTER_AT_LEVEL)
        back_x = self._read(READ_EXIT_AT_LEVEL)
        self._enter = back_e[0] if back_e else self._enter
        self._exit = back_x[0] if back_x else self._exit
        if self._enter != enter:
            self.on_log(f"enter level {enter} did not take (node says {self._enter})")
        else:
            self.on_log(f"enter {self._enter} exit {self._exit} (node counts)")


def find_node_port(on_log=None):
    """A serial port with a RotorHazard node behind it.

    Deliberately does not guess a node from its USB id — a CH340 is on every
    third hobby board — but does use the id to rule one device out. Searching
    means writing a command byte to each candidate, and a LapRF's USB endpoint
    is a console that takes typed commands, so it is skipped by identity rather
    than spoken to and judged on its reply.

    Everything else on the bench is opened, and opening a port asserts DTR,
    which resets an Arduino-class board — a flight controller included. That is
    unavoidable if a node is to be found without being told where it is, but it
    is not something to do quietly: every port tried is named, and the caller
    backs off so a bench is not reset on a loop.
    """
    say = on_log or (lambda m: None)
    try:
        from serial.tools import list_ports
    except Exception as e:
        say(f"cannot search for a node: pyserial is not installed ({e})")
        return None
    ports = list(list_ports.comports())
    if not any(p.vid is not None for p in ports):
        say("no USB serial device attached — is the node plugged in? "
            "(name the port to use one on a board's own UART)")
        return None
    for p in ports:
        if (p.vid, p.pid) == (LAPRF_VID, LAPRF_PID):
            say(f"skipping {p.device}: that is a LapRF, not a node")
            continue
        if p.vid is None:
            # A legacy 16550 UART, not a USB device. A node is plugged into USB,
            # and this machine reports thirty-two of these — probing them all
            # costs over a minute of bootloader waits before the search even
            # reaches the port the node is on. A node on a board's own UART is
            # reachable by naming the port.
            continue
        say(f"probing {p.device} ({p.description}) — this resets a board that "
            f"reboots on DTR")
        ok, why = probe_port(p.device)
        if ok:
            return p.device
        say(f"  {p.device}: {why}")
    return None


def probe_port(device):
    """Is there a RotorHazard node on this port?

    Returns (found, reason). The reason matters: a port refused for want of
    dialout membership and a port with a flight controller behind it are the
    same silent False otherwise, and the first is one command to fix.
    """
    try:
        import serial
    except Exception as e:
        return False, f"pyserial is not installed ({e})"
    try:
        with serial.Serial(device, 115200, timeout=0.4) as s:
            time.sleep(BOOT_WAIT_S)
            s.reset_input_buffer()
            s.write(bytes([READ_REVISION_CODE]))
            s.flush()
            r = s.read(3)
            if len(r) != 3:
                return False, f"no reply ({len(r)} bytes)"
            if checksum(r[:2]) != r[2]:
                return False, f"reply {r.hex()} does not checksum — another protocol"
            if r[0] != RotorHazardNode.REVISION_MARKER:
                return False, f"reply {r.hex()} is not a RotorHazard revision"
            return True, "a node"
    except PermissionError as e:
        return False, f"permission denied ({e}) — add yourself to the dialout group"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
