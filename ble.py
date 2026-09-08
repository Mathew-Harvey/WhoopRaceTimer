"""LapRF Bluetooth LE transport.

The LapRF exposes a Nordic UART Service. Commands are written to the control
point in 20-byte chunks without response; everything the timer sends arrives as
notifications on the stream characteristic, in the same binary record format
used over USB.

Observed on Mat's unit: it advertises only for a window after power-on, so the
scanner runs continuously and connects the moment it appears.
"""
import asyncio, time, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import laprf
from bleak import BleakClient, BleakScanner

SVC  = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
CTRL = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
STRM = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEFAULT_NAME = "CrabLake"


class LapRFBle:
    def __init__(self, name=DEFAULT_NAME, address=None, on_record=None, on_log=None):
        self.name, self.address = name, address
        self.on_record = on_record or (lambda r: None)
        self.on_log = on_log or (lambda m: print(m, flush=True))
        self.connected = False
        self.client = None
        self._buf = b""
        self._txq = asyncio.Queue()
        self._stop = False

    def matches(self, d, adv):
        if self.address and d.address.upper() == self.address.upper():
            return True
        if self.name and (d.name or "") == self.name:
            return True
        return SVC in [u.lower() for u in (adv.service_uuids or [])]

    async def _find(self, timeout=None):
        fut = asyncio.get_running_loop().create_future()
        def cb(d, adv):
            if not fut.done() and self.matches(d, adv):
                fut.set_result(d)
        sc = BleakScanner(detection_callback=cb)
        await sc.start()
        try:
            return await asyncio.wait_for(fut, timeout) if timeout else await fut
        except asyncio.TimeoutError:
            return None
        finally:
            await sc.stop()

    def _notify(self, _, data):
        self._buf += bytes(data)
        recs, self._buf = laprf.split_records(self._buf)
        for r in recs:
            rec = laprf.decode_record(r)
            if rec:
                self.on_record(rec)
        if len(self._buf) > 4096:
            self._buf = self._buf[-1024:]

    async def send(self, data):
        await self._txq.put(data)

    async def _pump(self):
        while self.connected and not self._stop:
            try:
                data = await asyncio.wait_for(self._txq.get(), 0.5)
            except asyncio.TimeoutError:
                continue
            for i in range(0, len(data), 20):
                await self.client.write_gatt_char(CTRL, data[i:i+20], response=False)
                await asyncio.sleep(0.03)
            await asyncio.sleep(0.05)

    async def run(self):
        """Connect, hold the link, reconnect until stopped."""
        while not self._stop:
            self.on_log("scanning for LapRF…")
            dev = await self._find()
            if not dev:
                continue
            self.on_log(f"found {dev.name} @ {dev.address} — connecting")
            try:
                async with BleakClient(dev, timeout=20.0) as c:
                    self.client, self.connected, self._buf = c, True, b""
                    self.on_log("CONNECTED")
                    await c.start_notify(STRM, self._notify)
                    pump = asyncio.create_task(self._pump())
                    # introduce ourselves: ask for config and clock
                    await self.send(laprf.get_rf_setup())
                    await self.send(laprf.encode(laprf.RT_SETTINGS,
                                                 [(laprf.SET_MIN_LAP, "u32", 0)]))
                    await self.send(laprf.get_rtc_time())
                    while c.is_connected and not self._stop:
                        await asyncio.sleep(0.2)
                    pump.cancel()
                    try:
                        await c.stop_notify(STRM)
                    except Exception:
                        pass
                    # leaving the async-with disconnects cleanly, which is what
                    # lets the timer advertise again without a power cycle
            except Exception as e:
                self.on_log(f"connection failed/lost: {type(e).__name__}: {e}")
            finally:
                self.connected = False
                self.client = None
                self.on_log("disconnected")
                await asyncio.sleep(1.0)

    def stop(self):
        self._stop = True


if __name__ == "__main__":
    LOG = "/tmp/claude-1000/-home-mat-Work/9e6aadae-93ec-44ce-a474-ceb5d53e6126/scratchpad/ble.log"
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    f = open(LOG, "a", buffering=1)
    def log(m):
        line = f"{time.strftime('%H:%M:%S')} {m}"
        print(line, flush=True); f.write(line + "\n")
    counts = {}
    def rec(r):
        t = r.get("type")
        counts[t] = counts.get(t, 0) + 1
        # print every non-repetitive record in full; summarise the noisy ones
        if t in ("passing", "rfSetup", "settings", "time", "descriptor", "crc_error"):
            log(f"RECORD {r}")
        elif counts[t] <= 3 or counts[t] % 20 == 0:
            log(f"RECORD[{counts[t]}] {r}")
    b = LapRFBle(on_record=rec, on_log=log)
    try:
        asyncio.run(b.run())
    except KeyboardInterrupt:
        pass
