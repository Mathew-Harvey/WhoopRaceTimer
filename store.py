"""Persistence. Everything the app knows survives a restart.

This exists because an early version kept pilot channels in memory only: a
server restart silently reset them to defaults, and the next config write
pushed those defaults onto the timer, overwriting the real race frequencies.
Anything that can be written to the hardware is persisted here first.
"""
import json, os, time, threading

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
LOCK = threading.Lock()

DEFAULTS = {
    "pilots": {},        # slot -> {name, channel, enabled, colour}
    "roster": [],        # [{name, channel, colour}] reusable pilot list
    "rf": {},            # slot -> {gain, threshold}
    "settings": {
        "mode": "laps", "targetLaps": 5, "targetSeconds": 120,
        "minLap": 3.0, "holeshot": False, "countdown": 5,
        "bestConsecutive": 3, "sigThreshold": 500.0, "autoDetect": False,
        "voice": True, "timerMinLapMs": 3000,
    },
    "history": [],       # completed races
}


def _path(name):
    os.makedirs(DIR, exist_ok=True)
    return os.path.join(DIR, name + ".json")


def load(name):
    try:
        with open(_path(name)) as f:
            return json.load(f)
    except Exception:
        d = DEFAULTS.get(name)
        return json.loads(json.dumps(d)) if d is not None else None


def save(name, obj):
    with LOCK:
        p = _path(name)
        tmp = p + ".tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f, indent=2)
        os.replace(tmp, p)      # atomic: never leave a half-written config
    return obj


def append_history(entry, cap=200):
    h = load("history") or []
    entry["savedAt"] = time.time()
    h.append(entry)
    return save("history", h[-cap:])
