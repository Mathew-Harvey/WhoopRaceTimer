"""LapRF device layer.

Owns the serial port on a background thread and turns whatever the timer emits
into a single stream of events. The timer may be in either of two modes:

  binary  - the real LapRF protocol: passing records, rfSetup, status, rssi.
            Full control: frequencies, gain, threshold, min-lap-time.
  ascii   - a debug console that only prints periodic noise/voltage lines and
            accepts no commands. Read-only; no lap detection.

Callers get the same event shapes either way; `mode` says which is live and
`can_control` says whether config writes will actually do anything.
"""
import threading, time, re, queue, glob, sys
import laprf

try:
    import serial
    from serial.tools import list_ports
    HAVE_SERIAL = True
except Exception:                       # pyserial is optional - BLE is the real transport
    serial = None
    list_ports = None
    HAVE_SERIAL = False

# ImmersionRC USB-to-UART bridge (a Microchip CDC part)
LAPRF_VID, LAPRF_PID = 0x04D8, 0x000A


def find_port():
    """Locate the timer's serial port on any machine.

    Prefers a USB VID/PID match so it works regardless of which /dev node or COM
    number the OS assigned, then falls back to plausible device names per
    platform. Returns None when nothing looks like a LapRF - that is fine, since
    Bluetooth is the primary transport and USB is only a fallback signal source.
    """
    if list_ports is not None:
        ports = list(list_ports.comports())
        for p in ports:
            if (p.vid, p.pid) == (LAPRF_VID, LAPRF_PID):
                return p.device
        for p in ports:                 # some drivers do not expose vid/pid
            blob = " ".join(str(x) for x in (p.description, p.manufacturer, p.product))
            if "immersion" in blob.lower():
                return p.device
    if sys.platform.startswith("win"):
        return None                     # without pyserial we cannot guess a COM port
    for pattern in ("/dev/serial/by-id/*ImmersionRC*", "/dev/ttyACM*",
                    "/dev/tty.usbmodem*", "/dev/cu.usbmodem*"):
        hits = sorted(glob.glob(pattern))
        if hits:
            return hits[0]
    return None

# [199376] status - voltage: 4.091162	noise:	963.00 (0/199)	962.00 (0/199) ...
ASCII_STATUS = re.compile(r"\[(\d+)\]\s*status\s*-\s*voltage:\s*([\d.]+)\s*noise:\s*(.*)")
ASCII_SLOT = re.compile(r"([\d.]+)\s*\((\d+)/(\d+)\)")


class LapRFDevice:
    def __init__(self, port=None, on_event=None):
        self.port = port or find_port() or ""
        self.on_event = on_event or (lambda e: None)
        self.mode = "disconnected"      # disconnected | ascii | binary
        self.connected = False
        self.battery = None
        self.slots = {}                 # slot -> {rssi, noise, detections, ...}
        self.rf_setup = {}              # slot -> {band, channel, frequency, gain, threshold, enabled}
        self.min_lap_time = None
        self.last_rx = 0.0
        self._ser = None
        self._buf = b""
        self._txq = queue.Queue()
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._thread = None

    # ---- lifecycle ----
    def start(self):
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    @property
    def can_control(self):
        return self.mode == "binary"

    def _emit(self, kind, **kw):
        kw["kind"] = kind
        kw["t"] = time.time()
        self.on_event(kw)

    # ---- transmit ----
    def send(self, data):
        """Queue raw bytes for the device. Rate-limited in the IO loop:
        the LapRF drops messages that arrive too fast."""
        self._txq.put(data)

    # ---- IO thread ----
    def _run(self):
        while not self._stop.is_set():
            if not HAVE_SERIAL:
                self.mode = "unavailable"
                return                      # BLE-only install; nothing to poll
            try:
                if not self.port:
                    self.port = find_port() or ""
                    if not self.port:
                        raise OSError("no LapRF serial port found")
                self._ser = serial.Serial(self.port, 115200, timeout=0.15)
                self._ser.dtr = True
                self._ser.rts = True
            except Exception as e0:
                try:
                    alt = find_port()
                    if not alt or alt == self.port:
                        raise e0
                    self.port = alt
                    self._ser = serial.Serial(alt, 115200, timeout=0.15)
                    self._ser.dtr = True
                    self._ser.rts = True
                except Exception as e:
                    if self.connected:
                        self.connected = False
                        self.mode = "disconnected"
                        self._emit("disconnected", error=str(e))
                    time.sleep(1.0)
                    continue
            self.connected = True
            self._buf = b""
            self._emit("connected", port=self._ser.port)
            # Ask the timer to describe itself. Harmless if it is in ASCII mode.
            self.send(laprf.get_rf_setup())
            self.send(laprf.encode(laprf.RT_SETTINGS, [(laprf.SET_MIN_LAP, "u32", 0)]))
            try:
                self._io_loop()
            except Exception as e:
                self._emit("io_error", error=str(e))
            finally:
                try:
                    self._ser.close()
                except Exception:
                    pass
                self.connected = False
                self.mode = "disconnected"
                self._emit("disconnected")
                time.sleep(0.5)

    def _io_loop(self):
        last_tx = 0.0
        while not self._stop.is_set():
            # rate-limited transmit: >=60ms between messages or the LapRF drops them
            now = time.time()
            if not self._txq.empty() and now - last_tx > 0.06:
                try:
                    self._ser.write(self._txq.get_nowait())
                    self._ser.flush()
                    last_tx = now
                except queue.Empty:
                    pass
            data = self._ser.read(1024)
            if data:
                self.last_rx = time.time()
                self._buf += data
                self._consume()
            elif len(self._buf) > 8192:
                self._buf = self._buf[-2048:]

    def _consume(self):
        # Binary records take priority; anything before/between them is ASCII.
        if bytes([laprf.SOR]) in self._buf:
            recs, self._buf = laprf.split_records(self._buf)
            if recs and self.mode != "binary":
                self.mode = "binary"
                self._emit("mode", mode="binary")
            for r in recs:
                rec = laprf.decode_record(r)
                if rec:
                    self._handle_record(rec)
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            text = line.decode("utf8", "replace").strip()
            if text:
                self._handle_ascii(text)

    # ---- binary records ----
    def _handle_record(self, rec):
        t = rec.get("type")
        if t == "passing":
            with self._lock:
                self._emit("passing", slot=rec.get("slot"),
                           rtc_ms=rec.get("rtcTime"),
                           passing_number=rec.get("passingNumber"),
                           peak=rec.get("peakHeight"), flags=rec.get("flags"))
        elif t == "status":
            bv = rec.get("batteryVoltage")
            if bv is not None:
                self.battery = bv / 1000.0 if bv > 100 else bv
            with self._lock:
                for slot, v in (rec.get("slots") or {}).items():
                    self.slots.setdefault(slot, {}).update(v)
            self._emit("status", battery=self.battery, slots=dict(self.slots),
                       gate_state=rec.get("gateState"),
                       detections=rec.get("detectionCount"))
        elif t == "rfSetup":
            slot = rec.get("slot")
            if slot:
                with self._lock:
                    self.rf_setup[slot] = {
                        "band": rec.get("band"), "channel": rec.get("channel"),
                        "frequency": rec.get("frequency"), "gain": rec.get("gain"),
                        "threshold": rec.get("threshold"), "enabled": bool(rec.get("enabled")),
                    }
                self._emit("rf_setup", slot=slot, setup=self.rf_setup[slot])
        elif t == "rssi":
            with self._lock:
                for slot, v in (rec.get("slots") or {}).items():
                    self.slots.setdefault(slot, {}).update(v)
            self._emit("rssi", slots=dict(self.slots))
        elif t == "settings":
            if rec.get("minLapTime") is not None:
                self.min_lap_time = rec["minLapTime"]
                self._emit("settings", min_lap_time=self.min_lap_time)
        elif t == "crc_error":
            self._emit("crc_error")

    # ---- ascii debug console ----
    def _handle_ascii(self, text):
        if self.mode != "binary" and self.mode != "ascii":
            self.mode = "ascii"
            self._emit("mode", mode="ascii")
        m = ASCII_STATUS.match(text)
        if m:
            uptime_ms, voltage, rest = int(m.group(1)), float(m.group(2)), m.group(3)
            self.battery = voltage
            slots = {}
            for i, sm in enumerate(ASCII_SLOT.finditer(rest), start=1):
                noise, det, samples = float(sm.group(1)), int(sm.group(2)), int(sm.group(3))
                slots[i] = {"noise": noise, "detections": det, "samples": samples,
                            "present": samples > 0}
            with self._lock:
                for s, v in slots.items():
                    self.slots.setdefault(s, {}).update(v)
            self._emit("status", battery=voltage, uptime_ms=uptime_ms,
                       slots=dict(self.slots), ascii=True)
        else:
            # Unrecognised console output - surface it rather than swallow it.
            # A boot banner or a detection line would show up here.
            self._emit("console", text=text)
