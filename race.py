"""Race state machine: pilots, laps, formats, callouts.

Lap timing rule: whoops normally launch from behind the gate, so the FIRST gate
crossing after the start ends lap 1 - it is not a separate holeshot. Set
holeshot=True if you launch on the far side and want the first crossing to only
start the clock.

A minimum lap time is enforced in software regardless of the timer's own
setting, because a whoop hovering in the gate will otherwise register a burst
of passes.
"""
import time

COLORS = ["#e5484d", "#3e9dd8", "#46a758", "#f0a12b"]
MODES = ("laps", "time", "consecutive")


class Pilot:
    def __init__(self, slot, name="", channel="R1", enabled=True, colour=None):
        self.slot = slot
        self.name = name or f"Pilot {slot}"
        self.channel = channel
        self.enabled = enabled
        self.color = colour or COLORS[(slot - 1) % len(COLORS)]
        self.reset()

    def reset(self):
        self.laps = []
        self.last_pass = None
        self.started = False

    @property
    def lap_count(self):
        return len(self.laps)

    @property
    def best(self):
        return min((l["time_s"] for l in self.laps), default=None)

    @property
    def last(self):
        return self.laps[-1]["time_s"] if self.laps else None

    @property
    def total(self):
        return sum(l["time_s"] for l in self.laps)

    def best_consecutive(self, n=3):
        """Fastest n back-to-back laps - the standard whoop/drone race metric."""
        if len(self.laps) < n:
            return None
        times = [l["time_s"] for l in self.laps]
        return round(min(sum(times[i:i + n]) for i in range(len(times) - n + 1)), 3)

    def to_dict(self, consec=3):
        return {"slot": self.slot, "name": self.name, "channel": self.channel,
                "enabled": self.enabled, "color": self.color,
                "laps": self.laps, "lapCount": self.lap_count,
                "best": self.best, "last": self.last, "total": round(self.total, 3),
                "consec": self.best_consecutive(consec)}


class Race:
    def __init__(self, on_callout=None, on_change=None, on_finish=None):
        self.pilots = {i: Pilot(i, channel=c) for i, c in
                       zip(range(1, 5), ["R1", "R3", "R6", "R7"])}
        self.state = "idle"           # idle | staging | running | finished
        self.mode = "laps"
        self.target_laps = 5
        self.target_seconds = 120
        self.consec_n = 3
        self.min_lap_s = 3.0
        self.holeshot = False
        self.countdown_s = 5
        self.started_at = None
        self.finished_at = None
        self.staging_until = None
        self.name = ""
        self.on_callout = on_callout or (lambda *a, **k: None)
        self.on_change = on_change or (lambda: None)
        self.on_finish = on_finish or (lambda r: None)
        self.log = []
        self._announced_last_lap = set()

    # ---- config ----
    def set_pilot(self, slot, **kw):
        p = self.pilots[slot]
        for k, attr in (("name", "name"), ("channel", "channel"),
                        ("enabled", "enabled"), ("colour", "color")):
            if k in kw and kw[k] is not None:
                setattr(p, attr, kw[k])
        self.on_change()

    @property
    def racing(self):
        return [p for p in self.pilots.values() if p.enabled]

    @property
    def solo(self):
        """True when a single whoop is flying.

        Practice on your own and hearing your own name every lap is noise, so
        callouts drop the name and read just the lap and time."""
        return len(self.racing) == 1

    # ---- control ----
    def arm(self, countdown=None):
        for p in self.pilots.values():
            p.reset()
        self.log = []
        self._announced_last_lap = set()
        self.finished_at = None
        self.state = "staging"
        self.staging_until = time.monotonic() + (countdown or self.countdown_s)
        self.started_at = None
        self.on_callout("Arm your quads")
        self.on_change()

    def _begin(self):
        self.state = "running"
        self.started_at = time.monotonic()
        self.staging_until = None
        self.on_callout("Go!", priority=True)
        self._log("Race started")
        self.on_change()

    def start_now(self):
        for p in self.pilots.values():
            p.reset()
        self.log = []
        self._announced_last_lap = set()
        self.finished_at = None
        self._begin()

    def stop(self):
        was_running = self.state == "running"
        if was_running:
            self.finished_at = time.monotonic()
        self.state = "finished"
        self.staging_until = None
        self._log("Race complete")
        self.on_callout("Race complete")
        if was_running:
            self.on_finish(self.results())
        self.on_change()

    def reset(self):
        for p in self.pilots.values():
            p.reset()
        self.state = "idle"
        self.started_at = self.finished_at = self.staging_until = None
        self.log = []
        self._announced_last_lap = set()
        self.on_change()

    @property
    def elapsed(self):
        if not self.started_at:
            return 0.0
        return (self.finished_at or time.monotonic()) - self.started_at

    def tick(self):
        if self.state == "staging" and self.staging_until:
            if self.staging_until - time.monotonic() <= 0:
                self._begin()
            return
        if self.state == "running" and self.mode == "time":
            if self.elapsed >= self.target_seconds:
                self.stop()

    # ---- standings ----
    def standings(self):
        ps = list(self.racing)
        if self.mode == "consecutive":
            def key(p):
                c = p.best_consecutive(self.consec_n)
                return (0, c) if c is not None else (1, 1e9)
        else:
            def key(p):
                return (-p.lap_count, p.total if p.lap_count else 1e9)
        return sorted(ps, key=key)

    # ---- the hot path ----
    def on_passing(self, slot, at=None):
        p = self.pilots.get(slot)
        if p is None or not p.enabled:
            return False
        now = at if at is not None else time.monotonic()
        if self.state != "running":
            return False

        ref = p.last_pass if p.last_pass is not None else self.started_at
        if p.last_pass is not None and (now - p.last_pass) < self.min_lap_s:
            return False

        if self.holeshot and not p.started:
            p.started = True
            p.last_pass = now
            self._log(f"{p.name} away")
            self.on_callout("Away" if self.solo else f"{p.name} away")
            self.on_change()
            return False

        lap_time = now - (ref or now)
        p.last_pass = now
        p.started = True
        n = len(p.laps) + 1
        p.laps.append({"n": n, "time_s": round(lap_time, 3), "at": now})

        is_pb = n > 1 and p.best is not None and abs(lap_time - p.best) < 1e-9
        self._log(f"{p.name} lap {n}: {lap_time:.2f}s" + ("  PB" if is_pb else ""))
        self.on_callout(self._callout(p, n, lap_time, is_pb))

        self._check_finish(p, n)
        self.on_change()
        return True

    def undo_lap(self, slot):
        """Remove a pilot's most recent lap. Manual gate triggers and a bouncing
        quad both produce laps that should not count, and a race that cannot be
        corrected is a race people stop trusting."""
        p = self.pilots.get(slot)
        if p is None or not p.laps:
            return False, "no lap to undo"
        removed = p.laps.pop()
        # rewind the reference point so the NEXT pass times from the right place
        p.last_pass = p.laps[-1]["at"] if p.laps else None
        p.started = bool(p.laps)
        self._announced_last_lap.discard(slot)
        if self.state == "finished" and any(q.lap_count < self.target_laps
                                            for q in self.racing):
            self.state = "running"          # undoing the winning lap resumes the race
            self.finished_at = None
        self._log(f"{p.name} lap {removed['n']} removed ({removed['time_s']:.2f}s)")
        self.on_change()
        return True, f"removed lap {removed['n']}"

    def _check_finish(self, p, n):
        if self.mode == "laps":
            if n == self.target_laps - 1 and p.slot not in self._announced_last_lap:
                self._announced_last_lap.add(p.slot)
                self.on_callout("Last lap" if self.solo else f"{p.name}, last lap")
            if n >= self.target_laps:
                done = [q for q in self.racing if q.lap_count >= self.target_laps]
                if len(done) == 1 and not self.solo:
                    self.on_callout(f"{p.name} wins!", priority=True)
                    self._log(f"{p.name} wins")
                if all(q.lap_count >= self.target_laps for q in self.racing):
                    self.stop()
        elif self.mode == "consecutive":
            c = p.best_consecutive(self.consec_n)
            if c is not None and n >= self.consec_n:
                leader = self.standings()[0] if self.standings() else None
                if leader is p and n == self.consec_n and not self.solo:
                    self.on_callout(f"{p.name} leads, {c:.1f}")

    def _callout(self, pilot, n, lap_time, is_pb):
        secs = f"{lap_time:.1f}".rstrip("0").rstrip(".")
        s = f"lap {n}, {secs}" if self.solo else f"{pilot.name}, lap {n}, {secs}"
        if is_pb:
            s += ", personal best"
        return s[0].upper() + s[1:]

    def _log(self, text):
        self.log.append({"t": time.time(), "text": text})
        self.log = self.log[-120:]

    # ---- results ----
    def results(self):
        order = self.standings()
        return {
            "name": self.name or time.strftime("Race %H:%M"),
            "at": time.time(),
            "mode": self.mode,
            "targetLaps": self.target_laps,
            "targetSeconds": self.target_seconds,
            "consecN": self.consec_n,
            "duration": round(self.elapsed, 2),
            "results": [{
                "pos": i + 1, "slot": p.slot, "name": p.name, "channel": p.channel,
                "laps": p.lap_count, "best": p.best,
                "consec": p.best_consecutive(self.consec_n),
                "total": round(p.total, 3),
                "lapTimes": [l["time_s"] for l in p.laps],
            } for i, p in enumerate(order)],
        }

    def to_dict(self):
        return {
            "state": self.state, "mode": self.mode, "name": self.name,
            "targetLaps": self.target_laps, "targetSeconds": self.target_seconds,
            "consecN": self.consec_n, "countdown_s": self.countdown_s,
            "minLap": self.min_lap_s, "holeshot": self.holeshot,
            "elapsed": round(self.elapsed, 2),
            "countdown": round(self.staging_until - time.monotonic(), 1)
                         if self.staging_until else None,
            "solo": self.solo,
            "pilots": [self.pilots[i].to_dict(self.consec_n) for i in sorted(self.pilots)],
            "standings": [p.slot for p in self.standings()],
            "log": self.log[-30:],
        }
