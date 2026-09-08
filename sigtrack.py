"""Signal tracking: turn per-slot RSSI/noise readings into visible, thresholded
gate detections.

Why this exists: the timer's ASCII debug stream only reports every ~2.4s, and a
whoop moves the reading by a few counts rather than the huge spike a properly
tuned gate produces. So rather than show the raw number, we hold a per-slot
baseline (the quiet noise floor) and work in *delta above baseline*, which makes
a small real change obvious. A detection fires when the delta crosses a
threshold, and clears once it falls back below a hysteresis fraction of it.
"""
import time
from collections import deque

HISTORY_S = 90.0


class SlotSignal:
    def __init__(self, slot):
        self.slot = slot
        self.history = deque()       # (t, value)
        self.baseline = None
        self.peak_delta = 0.0
        self.value = 0.0
        self.armed = True            # False while a detection is in progress
        self.detections = 0
        self._cal = []

    def add(self, value, t=None):
        t = t or time.time()
        self.value = value
        self.history.append((t, value))
        cutoff = t - HISTORY_S
        while self.history and self.history[0][0] < cutoff:
            self.history.popleft()
        if self._cal is not None and len(self._cal) < 400:
            self._cal.append(value)

    def calibrate(self):
        """Freeze the current quiet level as the baseline."""
        vals = [v for _, v in self.history] or [self.value]
        vals = sorted(vals)
        self.baseline = vals[len(vals) // 2]      # median: ignores a stray spike
        self.peak_delta = 0.0
        return self.baseline

    @property
    def delta(self):
        if self.baseline is None:
            return 0.0
        return self.value - self.baseline

    def check(self, threshold, hysteresis=0.5):
        """Returns True exactly once per crossing of `threshold`."""
        d = self.delta
        self.peak_delta = max(self.peak_delta, d)
        if self.armed and d >= threshold:
            self.armed = False
            self.detections += 1
            return True
        if not self.armed and d < threshold * hysteresis:
            self.armed = True
        return False

    def series(self, n=120):
        """Recent deltas for the UI strip chart."""
        base = self.baseline
        pts = list(self.history)[-n:]
        return [round(v - base, 2) if base is not None else 0.0 for _, v in pts]

    def to_dict(self):
        return {"slot": self.slot, "value": round(self.value, 1),
                "baseline": round(self.baseline, 1) if self.baseline is not None else None,
                "delta": round(self.delta, 2), "peak": round(self.peak_delta, 2),
                "detections": self.detections, "series": self.series()}


class SignalBank:
    def __init__(self, slots=(1, 2, 3, 4)):
        self.slots = {s: SlotSignal(s) for s in slots}
        self.threshold = 500.0      # counts above baseline; a real pass is ~1700
        self.auto_detect = False

    def add(self, slot, value, t=None):
        if slot not in self.slots:
            self.slots[slot] = SlotSignal(slot)
        self.slots[slot].add(value, t)

    def calibrate(self):
        return {s: sig.calibrate() for s, sig in self.slots.items()}

    def check_all(self):
        """Slots whose signal just crossed the threshold."""
        return [s for s, sig in self.slots.items() if sig.check(self.threshold)]

    def to_dict(self):
        return {"threshold": self.threshold, "autoDetect": self.auto_detect,
                "slots": {str(s): sig.to_dict() for s, sig in self.slots.items()}}
