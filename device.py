"""LapRF USB serial transport.

Like ble.py, this only moves bytes: it finds the port, holds it open on a
background thread, and hands raw reads to a callback. Whatever the timer is
emitting — the binary protocol or the ASCII debug console — is decoded in the
browser, which is the only place that decoding now lives.
"""
import glob, queue, sys, threading, time

try:
    import serial
    from serial.tools import list_ports
    HAVE_SERIAL = True
except Exception:                       # pyserial is optional — BLE is the real transport
    serial = None
    list_ports = None
    HAVE_SERIAL = False

# ImmersionRC USB-to-UART bridge (a Microchip CDC part)
LAPRF_VID, LAPRF_PID = 0x04D8, 0x000A


def find_port():
    """Locate the timer's serial port on any machine.

    Prefers a USB VID/PID match so it works regardless of which /dev node or COM
    number the OS assigned, then falls back to plausible device names per
    platform. Returns None when nothing looks like a LapRF, which is fine —
    Bluetooth is the primary transport.
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


class LapRFSerial:
    def __init__(self, port=None, on_raw=None, on_log=None):
        self.port = port or ""
        self.on_raw = on_raw or (lambda b: None)
        self.on_log = on_log or (lambda m: None)
        self.connected = False
        self.detail = ""
        self.last_rx = 0.0
        self._ser = None
        self._txq = queue.Queue()
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def stop(self):
        self._stop.set()

    def send(self, data):
        """Queue raw bytes. Paced in the IO loop: the LapRF drops messages that
        arrive too fast."""
        self._txq.put(data)

    def _run(self):
        if not HAVE_SERIAL:
            self.on_log("pyserial not installed; USB transport disabled")
            return
        while not self._stop.is_set():
            try:
                self.port = self.port or find_port() or ""
                if not self.port:
                    raise OSError("no LapRF serial port found")
                self._ser = serial.Serial(self.port, 115200, timeout=0.15)
                self._ser.dtr = True
                self._ser.rts = True
            except Exception as e:
                if self.connected:
                    self.connected = False
                    self.on_log(f"USB disconnected: {e}")
                self.port = ""
                time.sleep(1.5)
                continue
            self.connected = True
            self.detail = self._ser.port
            self.on_log(f"USB open on {self._ser.port}")
            try:
                self._io_loop()
            except Exception as e:
                self.on_log(f"USB error: {e}")
            finally:
                try:
                    self._ser.close()
                except Exception:
                    pass
                self.connected = False
                self.on_log("USB closed")
                time.sleep(0.5)

    def _io_loop(self):
        last_tx = 0.0
        while not self._stop.is_set():
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
                self.on_raw(data)
