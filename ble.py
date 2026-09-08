"""LapRF Bluetooth LE transport.

The LapRF exposes a Nordic UART Service. Commands are written to the control
point in 20-byte chunks without response; everything the timer sends arrives as
notifications on the stream characteristic.

This layer is deliberately dumb: it moves bytes and knows nothing about the
protocol. The browser holds the protocol, the race and the config — see
static/js/. That split is what lets the same app run with no Python at all,
over Web Bluetooth, and lets this file exist only for browsers that have none.

Observed on the unit this was written against: it advertises only for a window
after power-on, so the scanner runs continuously and connects the moment it
appears.
"""
import asyncio, os, sys, time

from bleak import BleakClient, BleakScanner

SVC  = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
CTRL = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
STRM = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
DEFAULT_NAME = "CrabLake"

CHUNK, CHUNK_GAP, MSG_GAP = 20, 0.03, 0.05


class LapRFBle:
    def __init__(self, name=DEFAULT_NAME, address=None, on_raw=None, on_log=None):
        self.name, self.address = name, address
        self.on_raw = on_raw or (lambda b: None)
        self.on_log = on_log or (lambda m: print(m, flush=True))
        self.connected = False
        self.detail = ""
        self.client = None
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

    async def send(self, data):
        await self._txq.put(data)

    async def _pump(self):
        while self.connected and not self._stop:
            try:
                data = await asyncio.wait_for(self._txq.get(), 0.5)
            except asyncio.TimeoutError:
                continue
            for i in range(0, len(data), CHUNK):
                await self.client.write_gatt_char(CTRL, data[i:i + CHUNK], response=False)
                await asyncio.sleep(CHUNK_GAP)
            await asyncio.sleep(MSG_GAP)

    async def run(self):
        """Connect, hold the link, reconnect until stopped."""
        while not self._stop:
            self.on_log("scanning for a LapRF…")
            dev = await self._find()
            if not dev:
                continue
            self.on_log(f"found {dev.name} @ {dev.address} — connecting")
            try:
                async with BleakClient(dev, timeout=20.0) as c:
                    self.client, self.connected = c, True
                    self.detail = dev.name or dev.address
                    self.on_log("CONNECTED")
                    await c.start_notify(STRM, lambda _, data: self.on_raw(bytes(data)))
                    pump = asyncio.create_task(self._pump())
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
    # Standalone sniffer: decode and print everything the timer says. Useful when
    # a unit behaves unlike the one this was written against.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import laprf

    buf = bytearray()
    counts = {}

    def log(m):
        print(f"{time.strftime('%H:%M:%S')} {m}", flush=True)

    def raw(data):
        buf.extend(data)
        recs, rest = laprf.split_records(bytes(buf))
        buf[:] = rest
        for r in recs:
            rec = laprf.decode_record(r)
            if not rec:
                continue
            t = rec.get("type")
            counts[t] = counts.get(t, 0) + 1
            if t in ("passing", "rfSetup", "settings", "time", "descriptor", "crc_error"):
                log(f"RECORD {rec}")
            elif counts[t] <= 3 or counts[t] % 20 == 0:
                log(f"RECORD[{counts[t]}] {rec}")

    b = LapRFBle(on_raw=raw, on_log=log)
    try:
        asyncio.run(b.run())
    except KeyboardInterrupt:
        pass
