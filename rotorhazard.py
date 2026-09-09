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
"""
import struct
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

#: RotorHazard RSSI (0-255) to LapRF counts. See the module docstring: this is
#: measured, not chosen — it puts the two noise floors on top of each other.
RSSI_SCALE = 16

#: A single wild reading, every few seconds, at a fixed offset above whatever
#: the receiver is actually sitting on — measured at +52 counts on 5917 and +53
#: on 5658, which is a periodic re-tune of the receiver rather than anything on
#: the air. One sample wide, so a median of three erases it; a real pass spans
#: several polls and survives. Without this it crosses the arm level on its own
#: and the node counts a lap for it.
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
#: reports to be a real crossing.
#:
#: Judging the node's own reported peak against a height was the obvious thing
#: and it was wrong: the artefact reaches 56 or 57 counts above the floor, so
#: any cutoff that rejects it sits within a couple of counts of it and lets
#: through whichever ones run slightly hot — 176 caught and 30 missed, in one
#: twenty-five second sample. The filter already tells the two apart perfectly,
#: because the artefact is one sample wide and a pass is eleven, so ask the
#: filtered stream instead. An artefact leaves no trace there at all, which lets
#: this number be modest and unfussy.
MIN_PASS_RISE = 25

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

#: No lap is judged until there is enough of that window to judge against.
#: Counted in samples rather than seconds so it means the same thing however
#: the poll rate is set, and so a test can reach it without waiting.
WARMUP_SAMPLES = 50

#: A LapRF reports its own battery; a node has none. The app only shows this,
#: and a plausible constant is better than a missing field it would render as a
#: dash forever.
FAKE_BATTERY_MV = 4000

#: A node has no gain control of the kind a LapRF exposes. Reported so the app's
#: RF-setup echo is complete, ignored on the way in.
FAKE_GAIN = 58


def checksum(payload):
    return sum(payload) & 0xFF


def read_frame(cmd, payload):
    """The bytes a node sends back for a read: payload then its checksum."""
    return bytes(payload) + bytes([checksum(payload)])


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

def status_record(rssi, *, slot=1, battery_mv=FAKE_BATTERY_MV, gate_active=True):
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


def passing_record(peak, number, *, slot=1, rtc_us=None):
    """A LapRF passing record for a lap the node reported.

    rtcTime is in microseconds, as the puck sends it — the app divides by a
    million to get lap intervals, and feeding it milliseconds would make every
    lap read a thousand times too long.
    """
    if rtc_us is None:
        rtc_us = int(time.time() * 1e6)
    return laprf.encode(laprf.RT_PASSING, [
        (laprf.PS_SLOT, "u8", slot),
        (laprf.PS_RTC_TIME, "u64", int(rtc_us)),
        (laprf.PS_PASSING_NUMBER, "u32", number),
        (laprf.PS_PEAK_HEIGHT, "u16", min(0xFFFF, int(peak))),
    ])


def rf_setup_record(frequency, threshold, *, slot=1, enabled=True, gain=FAKE_GAIN):
    """What the app is told when it asks a slot to describe itself."""
    band, channel = band_channel_for(frequency)
    return laprf.encode(laprf.RT_RF_SETUP, [
        (laprf.RF_SLOT, "u8", slot),
        (laprf.RF_ENABLED, "u16", 1 if enabled else 0),
        (laprf.RF_CHANNEL, "u16", channel),
        (laprf.RF_BAND, "u16", band),
        (laprf.RF_THRESHOLD, "f32", float(threshold)),
        (laprf.RF_GAIN, "u16", gain),
        (laprf.RF_FREQ, "u16", frequency),
    ])


def band_channel_for(frequency):
    """The band and channel indexes a LapRF would use for this frequency.

    A node knows only a frequency. The app prefers a band and channel when it
    has them — R7 and F8 are both 5880, and a pilot who set R7 should see R7 —
    so give it the pair the frequency belongs to, in the LapRF's own FREBA
    ordering. Anything off-plan reports as band 0, which the app reads as
    unknown rather than as a wrong channel.
    """
    for band_index, letter in enumerate(laprf.BAND_ORDER, start=1):
        table = laprf.BANDS[letter]
        if frequency in table:
            return band_index, table.index(frequency) + 1
    return 0, 0


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

    def __init__(self, port=None, on_raw=None, on_log=None):
        self.port = port or ""
        self.on_raw = on_raw or (lambda b: None)
        self.on_log = on_log or (lambda m: None)
        self.connected = False
        self.detail = ""
        self.api_level = None
        self.node_address = None

        self._ser = None
        self._stop = False
        self._interval = 0.2            # until the app says otherwise
        self._min_lap_s = 0.0
        self._last_pass_at = 0.0
        self._lap_count = None
        self._passing_number = 0
        self._frequency = None
        self._enter = None
        self._exit = None
        self._pending = bytearray()     # inbound LapRF bytes from the browser
        self._lock = None
        self._recent = []               # last few raw readings, for the median
        self._baseline = None           # settled noise, for judging a reported lap
        self._filtered_log = []         # (when, filtered value), recent only

    # ---- lifecycle ----
    def start(self):
        import threading
        self._lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        self._stop = True

    def _run(self):
        while not self._stop:
            try:
                self._open()
                self._poll_forever()
            except Exception as e:
                if self.connected:
                    self.on_log(f"node error: {type(e).__name__}: {e}")
                self.connected = False
                try:
                    if self._ser:
                        self._ser.close()
                except Exception:
                    pass
                self._ser = None
                time.sleep(1.5)

    def _open(self):
        import serial
        port = self.port or find_node_port()
        if not port:
            raise OSError("no RotorHazard node found")
        self._ser = serial.Serial(port, 115200, timeout=0.4)
        # Opening asserts DTR, which resets an Arduino. Nothing it says before
        # the bootloader has finished is worth reading.
        time.sleep(2.4)
        self._ser.reset_input_buffer()

        rev = self._read(READ_REVISION_CODE)
        if not rev or rev[0] != self.REVISION_MARKER:
            raise OSError(f"not a RotorHazard node on {port} "
                          f"(revision {rev.hex() if rev else 'unreadable'})")
        self.api_level = rev[1]
        addr = self._read(READ_ADDRESS)
        self.node_address = addr[0] if addr else None
        freq = self._read(READ_FREQUENCY)
        self._frequency = int.from_bytes(freq, "big") if freq else None
        ent = self._read(READ_ENTER_AT_LEVEL)
        ext = self._read(READ_EXIT_AT_LEVEL)
        self._enter = ent[0] if ent else None
        self._exit = ext[0] if ext else None

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
        last_report = 0.0
        while not self._stop and self._ser:
            started = time.time()
            self._drain_pending()

            raw = self._read(READ_LAP_STATS)
            if raw is None:
                # A node that will not answer is not a node any more.
                raise OSError("node stopped answering")
            st = LapStats(raw)
            rssi = self._filtered(st.rssi)

            # Read often, speak when asked. Every reading feeds the filter; only
            # some of them become records, at whatever rate the app set.
            if started - last_report >= self._interval:
                last_report = started
                self.on_raw(status_record(to_laprf_rssi(rssi)))

            if self._lap_count is None:
                self._lap_count = st.lap_count          # first reading is a baseline
            elif st.lap_count != self._lap_count:
                self._lap_count = st.lap_count
                self._emit_pass(st)

            slept = time.time() - started
            time.sleep(max(0.005, POLL_INTERVAL - slept))

    def _filtered(self, raw_rssi):
        """The receiver's reading with its re-tune artefact taken out.

        A median rather than an average: the artefact is a single sample far
        from its neighbours, which a median discards outright and a mean would
        merely dilute. A pass is several samples and comes through untouched.
        """
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
        now = time.time()
        self._filtered_log.append((now, value))
        while self._filtered_log and self._filtered_log[0][0] < now - BASELINE_WINDOW_S:
            self._filtered_log.pop(0)
        vals = sorted(v for _, v in self._filtered_log)
        self._baseline = vals[int((len(vals) - 1) * BASELINE_QUANTILE)]
        return value

    def _emit_pass(self, st):
        """A lap the node counted, with the minimum lap the app asked for.

        A LapRF discards a crossing that arrives too soon after the last and the
        app writes that setting; a node has no such control, so it is honoured
        here instead. Anything else would make the same setting mean two
        different things depending on which timer is plugged in.
        """
        now = time.time()
        peak = st.pass_peak or st.node_peak or st.rssi
        # The node counts a lap for its own re-tune artefact, because the
        # artefact crosses the arm level exactly as a quad would. It is the one
        # thing here that can invent a lap out of nothing, so it is caught
        # before it reaches the app as a passing record — by asking whether the
        # filtered signal actually moved, which an artefact never makes it do.
        if self._filtered_log:
            if len(self._filtered_log) < WARMUP_SAMPLES:
                self.on_log(f"lap ignored: only {len(self._filtered_log)} readings so far, "
                            f"too soon to tell a crossing from noise")
                return
            recent = now - PASS_LOOKBACK_S
            rose = max(v for t, v in self._filtered_log if t >= recent)
            if rose < self._baseline + MIN_PASS_RISE:
                self.on_log(f"lap ignored: the signal never rose — {rose:.0f} against a "
                            f"floor of {self._baseline:.0f} (node reported peak {peak})")
                return
        if self._min_lap_s and (now - self._last_pass_at) < self._min_lap_s:
            self.on_log(f"lap discarded: {now - self._last_pass_at:.2f}s since the last, "
                        f"minimum is {self._min_lap_s:.2f}s")
            return
        self._last_pass_at = now
        self._passing_number += 1
        self.on_raw(passing_record(to_laprf_rssi(peak), self._passing_number,
                                   rtc_us=int(now * 1e6)))
        self.on_log(f"lap {self._passing_number}, peak {peak} (node)")

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
        for r in records:
            try:
                self._apply(laprf.decode_record(r))
            except Exception as e:
                self.on_log(f"could not apply a record: {type(e).__name__}: {e}")

    def _apply(self, rec):
        if not rec or rec.get("type") == "crc_error":
            return
        kind = rec.get("type")

        if kind == "rfSetup":
            if rec.get("frequency"):
                self._set_frequency(int(rec["frequency"]))
            if rec.get("threshold") is not None:
                self._set_thresholds(float(rec["threshold"]))
            # Whether it was a query or a write, the app is owed a description.
            self._describe(rec.get("slot", 1))

        elif kind == "settings":
            if rec.get("statusInterval"):
                self._interval = max(0.05, int(rec["statusInterval"]) / 1000.0)
                self.on_log(f"reporting every {self._interval * 1000:.0f} ms")
            if rec.get("minLapTime") is not None:
                self._min_lap_s = int(rec["minLapTime"]) / 1000.0
                self.on_log(f"minimum lap {self._min_lap_s:.2f}s")

        elif kind == "stateControl":
            # A node is always looking. Nothing to arm, and the app is told so
            # by every status record.
            pass

    def _describe(self, slot):
        if self._frequency is None:
            return
        thr = to_laprf_rssi(self._enter if self._enter is not None else 0)
        self.on_raw(rf_setup_record(self._frequency, thr, slot=slot))

    def _set_frequency(self, mhz):
        if mhz == self._frequency:
            return
        self._write(WRITE_FREQUENCY, struct.pack(">H", mhz))
        back = self._read(READ_FREQUENCY)
        got = int.from_bytes(back, "big") if back else None
        if got == mhz:
            self._frequency = mhz
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


#: How far below the arm level the disarm level sits, in node counts. Six is
#: roughly the gap the node shipped with (114/108) and is about a tenth of the
#: measured noise floor — enough that a signal resting on the line cannot
#: chatter, small enough not to swallow a fast pass.
EXIT_BELOW_ENTER = 6


#: The LapRF's own USB identity, from device.py. A port with this behind it is
#: never probed: probing means writing a byte, and the byte would land in a
#: LapRF's ASCII console.
LAPRF_VID, LAPRF_PID = 0x04D8, 0x000A


def find_node_port():
    """A serial port with a RotorHazard node behind it.

    Deliberately does not guess a node from its USB id — a CH340 is on every
    third hobby board — but does use the id to rule one device out. Searching
    means writing a command byte to each candidate, and a LapRF's USB endpoint
    is a console that takes typed commands, so it is skipped by identity rather
    than spoken to and judged on its reply.
    """
    try:
        from serial.tools import list_ports
    except Exception:
        return None
    for p in list_ports.comports():
        if (p.vid, p.pid) == (LAPRF_VID, LAPRF_PID):
            continue
        if probe_port(p.device):
            return p.device
    return None


def probe_port(device):
    """Is there a RotorHazard node on this port? Read-only, and safe to run
    against anything — it writes one command byte and reads three."""
    try:
        import serial
        with serial.Serial(device, 115200, timeout=0.4) as s:
            time.sleep(2.4)
            s.reset_input_buffer()
            s.write(bytes([READ_REVISION_CODE]))
            s.flush()
            r = s.read(3)
            return (len(r) == 3 and checksum(r[:2]) == r[2]
                    and r[0] == RotorHazardNode.REVISION_MARKER)
    except Exception:
        return False
