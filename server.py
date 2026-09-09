#!/usr/bin/env python3
"""WhoopTimer — local host and timer bridge.

WhoopTimer runs in the browser: the page owns the LapRF protocol, the race, the
config it writes to the timer, and the saved history. On Chrome or Edge it talks
to the timer directly over Web Bluetooth, so you can just open
https://whooptimer.webfpv.org and nothing here is needed at all.

This program exists for the two cases the browser cannot cover:

  1. Firefox and Safari have no Web Bluetooth and no Web Serial. Run this on the
     same machine and it holds the radio link, relaying raw frames to the page.
  2. A phone or tablet on the track's wifi. Run this with --lan and open the
     address it prints: the page is served from here, so it is same-origin with
     the bridge and no browser Bluetooth support is required on the device.

It is a byte pipe and a file server, nothing more. It does not decode the
protocol, does not know what a lap is, and holds no state worth losing.

    python3 server.py [--port 8080] [--lan] [--device /dev/ttyACM0]
"""
import argparse, asyncio, base64, json, mimetypes, os, queue, signal, socket, sys
import threading, time
import http.server, socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
sys.path.insert(0, HERE)

import device as devmod                                  # noqa: E402
try:
    import rotorhazard as rhmod
except Exception as _e:                                 # pragma: no cover
    rhmod = None
    RH_ERROR = str(_e)
try:
    import ble as blemod
    BLE_ERROR = None
except Exception as _e:                                  # bleak missing or no stack
    blemod = None
    BLE_ERROR = str(_e)


def lan_addresses():
    """Best-effort list of this machine's LAN IPs, for the phone-friendly URL."""
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))       # no traffic sent; just picks the route
        out.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in out:
                out.append(ip)
    except Exception:
        pass
    return out


class Bridge:
    """Holds whichever transport is available and fans raw bytes out to pages.

    Bluetooth is the real control channel and wins when both are up; USB on the
    unit this was written against is a read-only ASCII console, so it is only
    ever a fallback. Whichever is live, the browser gets the same raw stream and
    decides what it means.
    """

    def __init__(self, port=None, use_ble=True, use_usb=True, rh_port=None):
        self.clients = []
        self.lock = threading.Lock()
        self.ble = None
        self._ble_loop = None
        self.usb = None
        self.rh = None
        self.log_lines = []

        # A RotorHazard node, translated into LapRF records so the page needs no
        # knowledge of it. Opt-in and exclusive: it owns a serial port, and the
        # LapRF serial transport would otherwise open the same one and read a
        # different protocol out of it.
        if rh_port and rhmod:
            self.rh = rhmod.RotorHazardNode(port=None if rh_port == "auto" else rh_port,
                                            on_raw=self.on_raw,
                                            on_log=lambda m: self.log(f"[node] {m}"))
            self.rh.start()
            # Exclusive against BOTH LapRF paths, not just the serial one. They
            # share a fan-out and the page cannot tell two timers apart: every
            # crossing would be counted twice, on one slot, at two different
            # signal scales, and the handshake would go to whichever transport
            # ranks higher — so the node would never be told the app's threshold
            # or minimum lap and would keep its own.
            use_usb = use_ble = False
        elif rh_port:
            self.log(f"[node] unavailable: {RH_ERROR}")

        if use_usb:
            self.usb = devmod.LapRFSerial(port=port, on_raw=self.on_raw,
                                          on_log=lambda m: self.log(f"[usb] {m}"))
            self.usb.start()
        if use_ble and blemod:
            self._start_ble()
        elif use_ble:
            self.log(f"[ble] unavailable: {BLE_ERROR or 'bleak not installed'}")

    # ---- transports ----
    def _start_ble(self):
        def runner():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._ble_loop = loop
            self.ble = blemod.LapRFBle(on_raw=self.on_raw,
                                       on_log=lambda m: self.log(f"[ble] {m}"))
            loop.run_until_complete(self.ble.run())
        threading.Thread(target=runner, daemon=True).start()

    @property
    def transport(self):
        # The node first, because it is only ever present when it was explicitly
        # asked for. Bluetooth is switched off in that case, but ranking it above
        # the node as well means no ordering accident can route the handshake to
        # a LapRF that happens to be powered on in the same room.
        if self.rh and self.rh.connected:
            return "rotorhazard"
        if self.ble and self.ble.connected:
            return "bluetooth"
        if self.usb and self.usb.connected:
            return "usb"
        return None

    @property
    def detail(self):
        if self.rh and self.rh.connected:
            return self.rh.detail
        if self.ble and self.ble.connected:
            return f"{self.ble.detail or 'LapRF'} over Bluetooth"
        if self.usb and self.usb.connected:
            return f"{self.usb.detail} over USB"
        return ""

    def status(self):
        t = self.transport
        return {
            "available": t is not None,
            "transport": t,
            "detail": self.detail,
            "mode": ("binary" if t in ("bluetooth", "rotorhazard")
                     else "ascii" if t == "usb" else None),
            "reason": None if t else self._reason(),
        }

    def _reason(self):
        """Why there is no timer — about the hardware actually being used.

        A node is opt-in and exclusive, so when one was asked for there is no
        LapRF in the picture at all, and telling someone to check a LapRF's
        advertising window or its battery is advice about equipment they have
        said they are not using.
        """
        if self.rh:
            return ("No RotorHazard node. Check it is plugged in and powered, and that "
                    "this user is in the dialout group. The bridge log names every port "
                    "it tried and why each was refused.")
        if not blemod:
            return f"Bluetooth is unavailable here ({BLE_ERROR}); install bleak."
        return ("No timer. Switch it on — a LapRF only advertises for about a minute "
                "after power-on.")

    # ---- fan-out ----
    def subscribe(self):
        q = queue.Queue(maxsize=600)
        with self.lock:
            self.clients.append(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def broadcast(self, obj):
        data = json.dumps(obj)
        with self.lock:
            dead = []
            for q in self.clients:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self.clients.remove(q)
                # Removing it from the list is not enough: its handler is still
                # blocked on the queue and will go on sending keep-alives to a
                # subscription that can never deliver another record. The page
                # sees an EventSource that never errors, so it reports a healthy
                # link and flies a whole session on it. Wake the handler so it
                # closes the response instead.
                try:
                    q.get_nowait()          # make room for the sentinel
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(None)      # _sse breaks out on None
                except queue.Full:
                    pass

    def on_raw(self, data):
        self.broadcast({"type": "rx", "b64": base64.b64encode(data).decode()})

    def log(self, text):
        line = f"{time.strftime('%H:%M:%S')} {text}"
        self.log_lines = (self.log_lines + [line])[-200:]
        print(line, flush=True)
        self.broadcast({"type": "log", "text": text})

    # ---- transmit ----
    def send(self, data):
        if self.rh and self.rh.connected:
            self.rh.send(data)
            return True
        if self.ble and self.ble.connected and self._ble_loop:
            asyncio.run_coroutine_threadsafe(self.ble.send(data), self._ble_loop)
            return True
        if self.usb and self.usb.connected:
            self.usb.send(data)
            return True
        return False

    def watch(self):
        """Tell pages when the link comes and goes, so the UI can react."""
        last = None
        while True:
            cur = self.transport
            if cur != last:
                last = cur
                self.broadcast({"type": "link", "connected": cur is not None,
                                "transport": cur, "detail": self.detail})
            time.sleep(0.4)

    def shutdown(self):
        """Close the BLE link cleanly. An abrupt kill leaves the timer believing
        it is still connected, and it will not advertise again until it is
        power-cycled — so always take the link down properly."""
        try:
            if self.ble:
                self.ble.stop()
                for _ in range(30):
                    if not self.ble.connected:
                        break
                    time.sleep(0.1)
        except Exception:
            pass
        try:
            if self.usb:
                self.usb.stop()
        except Exception:
            pass
        try:
            if self.rh:
                self.rh.stop()
        except Exception:
            pass


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    bridge = None

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # ---- GET ----
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/bridge/status":
            return self._send(200, self.bridge.status(), extra={"Cache-Control": "no-store"})
        if path == "/bridge/events":
            return self._sse()
        return self._static(path)

    def _static(self, path):
        rel = "index.html" if path == "/" else path.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        elif full.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if ctype.startswith("text/") or "javascript" in ctype or "json" in ctype:
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        # The app is edited far more often than it is deployed; never let a stale
        # copy of the UI hide a fix at a track.
        return self._send(200, body, ctype, {"Cache-Control": "no-cache"})

    def _sse(self):
        q = self.bridge.subscribe()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            st = self.bridge.status()
            self.wfile.write(f"data: {json.dumps({'type': 'link', 'connected': st['available'], 'transport': st['transport'], 'detail': st['detail']})}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=15)
                    # None is the sentinel broadcast() leaves when it has given
                    # up on this client. Closing here is the only way the page
                    # learns: an EventSource that is merely unsubscribed keeps
                    # receiving keep-alives and never fires onerror.
                    if item is None:
                        break
                    self.wfile.write(f"data: {item}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except Exception:
            pass
        finally:
            self.bridge.unsubscribe(q)

    # ---- POST ----
    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        if path == "/bridge/tx":
            try:
                data = base64.b64decode(body.get("b64", ""))
            except Exception:
                return self._send(400, {"ok": False, "error": "bad payload"})
            ok = self.bridge.send(data)
            return self._send(200 if ok else 409,
                              {"ok": ok, "error": None if ok else "no timer link"})
        return self._send(404, {"error": "not found"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="WhoopTimer — local host and timer bridge")
    ap.add_argument("--port", type=int, default=int(os.environ.get("WHOOPTIMER_PORT", 8080)))
    ap.add_argument("--device", default=None,
                    help="serial port override; auto-detected by USB id otherwise")
    ap.add_argument("--host", default=None, help="bind address (default 127.0.0.1)")
    ap.add_argument("--lan", action="store_true",
                    help="bind all interfaces so a phone or tablet on the same "
                         "network can open it")
    ap.add_argument("--no-ble", action="store_true", help="do not hold a Bluetooth link")
    ap.add_argument("--no-usb", action="store_true", help="do not open the serial port")
    ap.add_argument("--rotorhazard", nargs="?", const="auto", default=None,
                    metavar="PORT",
                    help="use a RotorHazard node instead of a LapRF, translated so "
                         "the page sees a LapRF. Give a port, or nothing to search "
                         "for one. Exclusive: both LapRF transports are switched "
                         "off, because the page cannot tell two timers apart and "
                         "would count every crossing twice.")
    ap.add_argument("--open", action="store_true", help="open a browser on start")
    a = ap.parse_args()
    host = a.host or ("0.0.0.0" if a.lan else "127.0.0.1")

    bridge = Bridge(port=a.device, use_ble=not a.no_ble, use_usb=not a.no_usb,
                    rh_port=a.rotorhazard)
    Handler.bridge = bridge
    threading.Thread(target=bridge.watch, daemon=True).start()

    try:
        srv = Server((host, a.port), Handler)
    except OSError as e:
        print(f"cannot bind {host}:{a.port} — {e}")
        print("another copy may already be running; try --port 8081")
        sys.exit(1)

    def shutdown(*_):
        print("\nshutting down: closing the timer link…", flush=True)
        bridge.shutdown()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"WhoopTimer -> http://127.0.0.1:{a.port}")
    if host == "0.0.0.0":
        for ip in lan_addresses():
            print(f"            on this network: http://{ip}:{a.port}")
        print("  (bound to all interfaces — anyone on your network can control the race)")
    if not blemod and not a.no_ble:
        print(f"  ! bluetooth unavailable ({BLE_ERROR}); install 'bleak'")
    if not devmod.HAVE_SERIAL and not a.no_usb:
        print("  ! pyserial not installed; USB fallback disabled")
    if a.open:
        threading.Thread(target=lambda: (time.sleep(1.0), __import__("webbrowser")
                         .open(f"http://127.0.0.1:{a.port}")), daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
