#!/usr/bin/env python3
"""WhoopTimer - race control for an ImmersionRC LapRF.

Transport: Bluetooth LE is the real control channel (binary protocol, passing
records, config writes). USB is a read-only ASCII debug console on this unit and
is used only as a fallback signal source.

Serves a local web UI. Push updates use Server-Sent Events; commands come back
as plain POSTs. Voice callouts happen in the browser.

    python3 server.py [--port 8080] [--device /dev/ttyACM0]
"""
import argparse, asyncio, csv, io, json, os, signal, sys, threading, time, queue
import http.server, socketserver
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import laprf, device as devmod, race as racemod, sigtrack, store, tuning
try:
    import ble as blemod
except Exception:
    blemod = None

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
FITTED = (1, 2, 3, 4)          # this is a 4-way; slots 5-8 are not populated

clients = []
clients_lock = threading.Lock()


def broadcast(obj):
    data = json.dumps(obj)
    with clients_lock:
        dead = []
        for q in clients:
            try:
                q.put_nowait(data)
            except queue.Full:
                dead.append(q)
        for q in dead:
            clients.remove(q)


class App:
    def __init__(self, port):
        self.settings = store.load("settings")
        self.rf_cfg = {int(k): v for k, v in (store.load("rf") or {}).items()}
        self.roster = store.load("roster") or []
        self.cal = tuning.Calibration()
        self.sig = sigtrack.SignalBank(FITTED)
        self.sig.threshold = float(self.settings.get("sigThreshold", 500.0))
        self.sig.auto_detect = bool(self.settings.get("autoDetect", False))

        # every attribute state() touches must exist before anything can fire a
        # broadcast - restoring pilots triggers on_change, which reads all of these
        self.callouts, self.console, self._seq = [], [], 0
        self.ble, self._ble_loop = None, None
        self.scan = {"active": False, "slot": None, "results": [], "index": 0}
        self.seeded_from_timer = False

        self.dev = devmod.LapRFDevice(port=port, on_event=self.on_device_event)
        self.race = racemod.Race(on_callout=self.callout, on_change=self.push_state,
                                 on_finish=self.on_race_finish)
        self._apply_settings_to_race()
        self._restore_pilots()

        if blemod:
            self.start_ble()

    # ---- persistence ----
    def _apply_settings_to_race(self):
        s, r = self.settings, self.race
        r.mode = s.get("mode", "laps")
        r.target_laps = int(s.get("targetLaps", 5))
        r.target_seconds = int(s.get("targetSeconds", 120))
        r.consec_n = int(s.get("bestConsecutive", 3))
        r.min_lap_s = float(s.get("minLap", 3.0))
        r.holeshot = bool(s.get("holeshot", False))
        r.countdown_s = int(s.get("countdown", 5))

    def _restore_pilots(self):
        saved = store.load("pilots") or {}
        for k, v in saved.items():
            slot = int(k)
            if slot in self.race.pilots:
                self.race.set_pilot(slot, name=v.get("name"), channel=v.get("channel"),
                                    enabled=v.get("enabled"), colour=v.get("colour"))

    def save_pilots(self):
        store.save("pilots", {str(p.slot): {"name": p.name, "channel": p.channel,
                                            "enabled": p.enabled, "colour": p.color}
                              for p in self.race.pilots.values()})

    def save_settings(self, **kw):
        self.settings.update({k: v for k, v in kw.items() if v is not None})
        store.save("settings", self.settings)
        self._apply_settings_to_race()

    def save_rf(self):
        store.save("rf", {str(k): v for k, v in self.rf_cfg.items()})

    # ---- bluetooth ----
    def start_ble(self):
        def runner():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._ble_loop = loop
            self.ble = blemod.LapRFBle(on_record=self.on_ble_record,
                                       on_log=lambda m: self.log_console(f"[ble] {m}"))
            loop.run_until_complete(self.ble.run())
        threading.Thread(target=runner, daemon=True).start()

    def ble_send(self, data):
        if self.ble and self.ble.connected and self._ble_loop:
            asyncio.run_coroutine_threadsafe(self.ble.send(data), self._ble_loop)
            return True
        return False

    def can_control(self):
        return bool(self.ble and self.ble.connected) or self.dev.can_control

    def send_control(self, data):
        if not self.ble_send(data):
            self.dev.send(data)

    # ---- inbound records ----
    def on_ble_record(self, rec):
        t = rec.get("type")
        if t == "passing":
            slot = rec.get("slot")
            if slot:
                self.race.on_passing(slot)
                broadcast({"type": "hit", "slot": slot, "source": "timer"})
        elif t == "status":
            bv = rec.get("batteryVoltage")
            if bv:
                self.dev.battery = bv / 1000.0 if bv > 100 else bv
            for slot, v in (rec.get("slots") or {}).items():
                if "lastRssi" in v:
                    self.dev.slots.setdefault(slot, {})["lastRssi"] = v["lastRssi"]
                    self.ingest_signal(slot, v["lastRssi"])
        elif t == "rssi":
            for slot, v in (rec.get("slots") or {}).items():
                val = v.get("meanRssi") or v.get("maxRssi")
                if val is not None:
                    self.dev.slots.setdefault(slot, {})["lastRssi"] = val
                    self.ingest_signal(slot, val)
        elif t == "rfSetup":
            slot = rec.get("slot")
            if slot:
                self.dev.rf_setup[slot] = {
                    "band": rec.get("band"), "channel": rec.get("channel"),
                    "frequency": rec.get("frequency"), "gain": rec.get("gain"),
                    "threshold": rec.get("threshold"),
                    "enabled": bool(rec.get("enabled"))}
                # adopt the hardware's own values; never invent defaults
                cur = self.rf_cfg.setdefault(slot, {})
                cur.setdefault("gain", rec.get("gain") or 58)
                cur.setdefault("threshold", rec.get("threshold") or 1600.0)
                cur.setdefault("floor", None)      # per-slot noise floor
                cur.setdefault("ceiling", None)    # per-slot pass peak
                self.save_rf()
                self.adopt_channel_from_timer(slot, rec.get("frequency"))
        self.push_state()

    def adopt_channel_from_timer(self, slot, freq):
        """Mirror the timer's actual frequency into the pilot, but only once per
        run and only if we have never been told otherwise. Stops the app from
        ever pushing a default channel over a real race frequency."""
        if not freq or slot not in self.race.pilots:
            return
        if (store.load("pilots") or {}).get(str(slot)):
            return                                  # user config wins
        name = next((n for n, f in laprf.ALL_CHANNELS if f == freq), None)
        if name and self.race.pilots[slot].channel != name:
            self.race.set_pilot(slot, channel=name)
            self.save_pilots()
            self.log_console(f"[cfg] slot {slot} adopted {name} ({freq} MHz) from timer")

    def on_device_event(self, e):
        kind = e["kind"]
        if kind == "passing":
            if e.get("slot"):
                self.race.on_passing(e["slot"])
        elif kind == "console":
            self.log_console(e["text"])
        elif kind == "status":
            for slot, v in (e.get("slots") or {}).items():
                val = v.get("lastRssi", v.get("noise"))
                if val and v.get("present", True) and not (self.ble and self.ble.connected):
                    self.ingest_signal(slot, val)
            self.push_state(light=True)
        elif kind in ("mode", "connected", "disconnected"):
            self.push_state()

    def log_console(self, text):
        self.console.append({"t": time.time(), "text": text})
        self.console = self.console[-300:]
        broadcast({"type": "console", "line": text})

    # ---- signal ----
    def ingest_signal(self, slot, value):
        self.sig.add(slot, value)
        self.cal.feed(slot, value)
        if self.scan["active"] and slot == self.scan["slot"]:
            return
        for s in self.sig.check_all():
            src = "signal" if self.sig.auto_detect else "signal-only"
            broadcast({"type": "hit", "slot": s, "source": src})
            if self.sig.auto_detect:
                self.race.on_passing(s)

    # ---- callouts ----
    def callout(self, text, priority=False):
        self._seq += 1
        item = {"id": self._seq, "text": text, "priority": priority, "t": time.time()}
        self.callouts.append(item)
        self.callouts = self.callouts[-80:]
        broadcast({"type": "say", **item})

    def on_race_finish(self, results):
        store.append_history(results)
        broadcast({"type": "raceFinished", "results": results})

    # ---- hardware config ----
    def apply_rf(self, slots=None):
        """Write channel + gain + threshold for the given slots. Values come
        from persisted per-slot config, never from hardcoded defaults."""
        if not self.can_control():
            return False, "no control link: connect over Bluetooth (power-cycle the timer)"
        for slot in (slots or FITTED):
            p = self.race.pilots.get(slot)
            if not p:
                continue
            band, chan, freq = laprf.channel_by_name(p.channel)
            cfg = self.rf_cfg.get(slot, {})
            self.send_control(laprf.set_rf_setup(
                slot, band, chan, freq,
                threshold=float(cfg.get("threshold", 1600.0)),
                gain=int(cfg.get("gain", 58)),
                enabled=bool(p.enabled)))
        self.send_control(laprf.set_min_lap_time(int(self.settings.get("timerMinLapMs", 3000))))
        self.send_control(laprf.get_rf_setup())
        return True, f"wrote {len(slots or FITTED)} slot(s) to the timer"

    # ---- scanner ----
    def start_scan(self, slot):
        if not self.can_control():
            return False, "scanner needs the Bluetooth link"
        if self.scan["active"]:
            return False, "scan already running"
        def run():
            self.scan.update(active=True, slot=slot, results=[], index=0)
            try:
                for i, (name, freq) in enumerate(laprf.ALL_CHANNELS):
                    if not self.scan["active"]:
                        break
                    band, chan, f = laprf.channel_by_name(name)
                    cfg = self.rf_cfg.get(slot, {})
                    self.send_control(laprf.set_rf_setup(
                        slot, band, chan, f,
                        threshold=float(cfg.get("threshold", 1600.0)),
                        gain=int(cfg.get("gain", 58)), enabled=True))
                    self.scan["index"] = i
                    peak, t0 = 0.0, time.time()
                    while time.time() - t0 < 0.45:
                        v = (self.dev.slots.get(slot) or {}).get("lastRssi", 0) or 0
                        peak = max(peak, v)
                        time.sleep(0.05)
                    self.scan["results"].append({"name": name, "freq": freq,
                                                 "peak": round(peak, 1)})
                    broadcast({"type": "scan", **self.scan})
            finally:
                self.scan["active"] = False
                broadcast({"type": "scan", **self.scan})
                self.apply_rf([slot])       # put the slot back where it belongs
        threading.Thread(target=run, daemon=True).start()
        return True, f"scanning 40 channels on slot {slot}"

    # ---- state ----
    def state(self):
        return {
            "type": "state",
            "device": {
                "connected": self.dev.connected, "mode": self.dev.mode,
                "battery": self.dev.battery,
                "slots": {str(k): v for k, v in self.dev.slots.items()},
                "rfSetup": {str(k): v for k, v in self.dev.rf_setup.items()},
                "port": self.dev.port, "lastRx": self.dev.last_rx,
                "ble": bool(self.ble and self.ble.connected),
                "canControl": self.can_control(),
            },
            "race": self.race.to_dict(),
            "signal": self.sig.to_dict(),
            "rfCfg": {str(k): v for k, v in self.rf_cfg.items()},
            "cal": self.cal.to_dict(),
            "roster": self.roster,
            "settings": self.settings,
            "channels": laprf.ALL_CHANNELS,
            "fitted": list(FITTED),
        }

    def push_state(self, light=False):
        broadcast(self.state())


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    app = None

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ---- GET ----
    def do_GET(self):
        path = self.path.split("?")[0]
        app = self.app
        if path == "/":
            try:
                with open(os.path.join(STATIC, "index.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            except FileNotFoundError:
                return self._send(500, b"index.html missing", "text/plain")
        if path == "/api/state":
            return self._send(200, app.state())
        if path == "/api/console":
            return self._send(200, {"lines": app.console})
        if path == "/api/history":
            return self._send(200, {"races": store.load("history") or []})
        if path == "/api/history.csv":
            return self._send(200, self._history_csv(), "text/csv")
        if path == "/events":
            return self._sse()
        return self._send(404, {"error": "not found"})

    def _history_csv(self):
        out = io.StringIO()
        w = csv.writer(out)
        w.writerow(["race", "when", "mode", "pos", "pilot", "channel",
                    "laps", "best", "best_consec", "total", "lap_times"])
        for r in (store.load("history") or []):
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(r.get("at", 0)))
            for e in r.get("results", []):
                w.writerow([r.get("name"), when, r.get("mode"), e["pos"], e["name"],
                            e.get("channel"), e["laps"], e.get("best"),
                            e.get("consec"), e.get("total"),
                            " ".join(f"{x:.2f}" for x in e.get("lapTimes", []))])
        return out.getvalue()

    def _sse(self):
        q = queue.Queue(maxsize=300)
        with clients_lock:
            clients.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.write(f"data: {json.dumps(self.app.state())}\n\n".encode())
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(f"data: {q.get(timeout=15)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except Exception:
            pass
        finally:
            with clients_lock:
                if q in clients:
                    clients.remove(q)

    # ---- POST ----
    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            body = {}
        app, r = self.app, self.app.race

        if path == "/api/pilot":
            r.set_pilot(int(body["slot"]), name=body.get("name"),
                        channel=body.get("channel"), enabled=body.get("enabled"),
                        colour=body.get("colour"))
            app.save_pilots()
            return self._send(200, {"ok": True})

        if path == "/api/roster":
            app.roster = body.get("roster", app.roster)
            store.save("roster", app.roster)
            app.push_state()
            return self._send(200, {"ok": True, "roster": app.roster})

        if path == "/api/config":
            app.save_settings(**{k: body.get(k) for k in
                                 ("mode", "targetLaps", "targetSeconds", "minLap",
                                  "holeshot", "countdown", "bestConsecutive",
                                  "timerMinLapMs")})
            if body.get("name") is not None:
                r.name = body["name"]
            app.push_state()
            return self._send(200, {"ok": True})

        if path == "/api/race/arm":
            r.arm(body.get("countdown"));  return self._send(200, {"ok": True})
        if path == "/api/race/start":
            r.start_now();                 return self._send(200, {"ok": True})
        if path == "/api/race/stop":
            r.stop();                      return self._send(200, {"ok": True})
        if path == "/api/race/lap/undo":
            slot = body.get("slot")
            if slot is None:
                # no slot given: undo the most recent lap across all pilots
                cand = [(p.laps[-1]["at"], p.slot) for p in r.racing if p.laps]
                if not cand:
                    return self._send(200, {"ok": False, "message": "no lap to undo"})
                slot = max(cand)[1]
            ok, msg = r.undo_lap(int(slot))
            return self._send(200, {"ok": ok, "message": msg, "slot": int(slot)})
        if path == "/api/race/reset":
            r.reset();                     return self._send(200, {"ok": True})

        # ---- gate sensitivity ----
        if path == "/api/rf/tune":
            slots = [int(body["slot"])] if body.get("slot") else list(FITTED)
            for sl in slots:
                c = app.rf_cfg.setdefault(sl, {"gain": 58, "threshold": 1600.0})
                if body.get("threshold") is not None: c["threshold"] = float(body["threshold"])
                if body.get("gain") is not None: c["gain"] = int(body["gain"])
            app.save_rf()
            ok, msg = app.apply_rf(slots)
            return self._send(200 if ok else 409,
                              {"ok": ok, "message": msg,
                               "rfCfg": {str(k): v for k, v in app.rf_cfg.items()}})
        if path == "/api/rf/bounds":
            # set a slot's lower/upper bound and re-derive its threshold from them
            slot = int(body["slot"])
            c = app.rf_cfg.setdefault(slot, {"gain": 58, "threshold": 1600.0})
            if body.get("floor") is not None:   c["floor"] = float(body["floor"])
            if body.get("ceiling") is not None: c["ceiling"] = float(body["ceiling"])
            frac = tuning.PRESETS.get(app.cal.preset,
                                      tuning.PRESETS[tuning.DEFAULT_PRESET])["fraction"]
            der = tuning.derive(c.get("floor"), c.get("ceiling"), frac)
            if der is not None:
                c["threshold"] = der
            app.save_rf()
            ok, msg = (app.apply_rf([slot]) if body.get("write") else
                       (True, "bounds saved" if der else
                        "bounds saved; span too small to derive a threshold"))
            return self._send(200, {"ok": ok, "message": msg,
                                    "threshold": c.get("threshold"),
                                    "derived": der,
                                    "rfCfg": {str(k): v for k, v in app.rf_cfg.items()}})
        if path == "/api/rf/apply":
            ok, msg = app.apply_rf()
            return self._send(200 if ok else 409, {"ok": ok, "message": msg})

        if path == "/api/cal/noise":
            app.cal.preset = body.get("preset", app.cal.preset)
            app.cal.begin_noise(list(FITTED))
            app.push_state()
            return self._send(200, {"ok": True, "phase": "noise"})
        if path == "/api/cal/pass":
            app.cal.begin_pass(list(FITTED))
            app.push_state()
            return self._send(200, {"ok": True, "phase": "pass"})
        if path == "/api/cal/finish":
            res = app.cal.finish()
            app.push_state()
            return self._send(200, {"ok": True, "results": {str(k): v for k, v in res.items()}})
        if path == "/api/cal/apply":
            res = app.cal.results()
            applied = {}
            for slot, v in res.items():
                c = app.rf_cfg.setdefault(slot, {"gain": 58, "threshold": 1600.0})
                # record the measured bounds for this slot even if the span was
                # too small to place a threshold - the UI shows why it declined
                if v.get("noise") is not None:  c["floor"] = v["noise"]
                if v.get("peak") is not None:   c["ceiling"] = v["peak"]
                if v.get("suggested"):
                    c["threshold"] = v["suggested"]
                    applied[slot] = v["suggested"]
            app.save_rf()
            ok, msg = app.apply_rf(list(applied)) if applied else (False, "nothing to apply")
            return self._send(200 if ok else 409,
                              {"ok": ok, "message": msg,
                               "applied": {str(k): v for k, v in applied.items()}})
        if path == "/api/cal/preset":
            app.cal.preset = body.get("preset", app.cal.preset)
            app.push_state()
            return self._send(200, {"ok": True, "preset": app.cal.preset})

        if path == "/api/signal/calibrate":
            return self._send(200, {"ok": True, "baselines": app.sig.calibrate()})
        if path == "/api/signal/config":
            if "threshold" in body:
                app.sig.threshold = float(body["threshold"])
                app.save_settings(sigThreshold=app.sig.threshold)
            if "autoDetect" in body:
                app.sig.auto_detect = bool(body["autoDetect"])
                app.save_settings(autoDetect=app.sig.auto_detect)
            app.push_state()
            return self._send(200, {"ok": True})

        if path == "/api/scan/start":
            ok, msg = app.start_scan(int(body.get("slot", 1)))
            return self._send(200 if ok else 409, {"ok": ok, "message": msg})
        if path == "/api/scan/stop":
            app.scan["active"] = False
            return self._send(200, {"ok": True})

        if path == "/api/history/clear":
            store.save("history", [])
            return self._send(200, {"ok": True})

        if path == "/api/sim/pass":
            slot = int(body.get("slot", 1))
            return self._send(200, {"ok": True, "counted": r.on_passing(slot)})
        return self._send(404, {"error": "not found"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--device", default=None)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()

    app = App(a.device)
    Handler.app = app
    app.dev.start()

    def ticker():
        while True:
            app.race.tick()
            if int(time.time() * 2) % 4 == 0:
                broadcast({"type": "signal", **app.sig.to_dict()})
            if app.race.state in ("running", "staging"):
                broadcast({"type": "tick", "elapsed": round(app.race.elapsed, 2),
                           "countdown": app.race.to_dict()["countdown"],
                           "state": app.race.state})
            time.sleep(0.1)
    threading.Thread(target=ticker, daemon=True).start()

    srv = Server((a.host, a.port), Handler)

    def shutdown(*_):
        """Close the BLE link cleanly. An abrupt kill leaves the timer thinking
        it is still connected, and it will not advertise again until it is
        power-cycled - so always take the link down properly."""
        print("shutting down: closing BLE link…", flush=True)
        try:
            if app.ble:
                app.ble.stop()
                for _ in range(30):
                    if not app.ble.connected:
                        break
                    time.sleep(0.1)
        except Exception:
            pass
        app.dev.stop()
        os._exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    print(f"WhoopTimer -> http://{a.host}:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
