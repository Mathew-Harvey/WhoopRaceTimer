"""Gate sensitivity calibration.

The timer reports a lap when a receiver's RSSI rises above its threshold. Set it
below the noise floor and the timer believes a craft is permanently in the gate,
so it never sees a crossing and never reports a lap - which is exactly how Mat's
unit was configured (threshold 700, noise floor 963).

Correct placement is between the two:

    noise floor  ....  threshold  ....  peak of a real pass

`suggest` puts it at `fraction` of the way from noise to peak. Lower fraction =
more sensitive (catches distant/weak passes, risks false laps from a quad
hovering nearby). Higher = stricter, which is what a tiny track needs, because
there every quad is close to the gate all the time and the "away" signal is
already high.
"""

PRESETS = {
    # fraction of the noise->peak span at which to place the threshold
    "tiny":   {"fraction": 0.62, "label": "Tiny track (quads always near gate)"},
    "small":  {"fraction": 0.50, "label": "Small indoor track"},
    "normal": {"fraction": 0.42, "label": "Normal track"},
    "open":   {"fraction": 0.32, "label": "Open/outdoor (weak passes)"},
}
DEFAULT_PRESET = "normal"


MIN_SPAN = 120.0


def derive(floor, ceiling, fraction=0.42):
    """Place a threshold between a slot's lower and upper bound.

    Each receiver sits on its own frequency and therefore has its own noise
    floor and its own achievable peak - on a tiny track especially, where other
    quads' video bleeds into neighbouring channels. So bounds are per slot, never
    global.
    """
    if floor is None or ceiling is None:
        return None
    span = ceiling - floor
    if span <= MIN_SPAN:
        return None
    return round(floor + span * fraction, 1)


def suggest(noise, peak, fraction=0.42, floor_margin=MIN_SPAN):
    """Back-compat alias: noise is the lower bound, peak the upper."""
    return derive(noise, peak, fraction)


def quality(noise, peak):
    """How separable is a pass from the noise? Drives the UI's advice."""
    if noise is None or peak is None:
        return "unknown", 0.0
    span = peak - noise
    ratio = (peak / noise) if noise else 0
    if span < 120:
        return "too weak", ratio
    if span < 400:
        return "marginal", ratio
    return "good", ratio


class Calibration:
    """Two-phase measurement: quiet floor, then a real pass."""

    def __init__(self):
        self.phase = "idle"      # idle | noise | pass | done
        self.noise = {}          # slot -> measured floor
        self.peak = {}           # slot -> measured peak
        self.preset = DEFAULT_PRESET
        self.started = 0.0
        self._samples = {}

    def begin_noise(self, slots):
        self.phase = "noise"
        self._samples = {s: [] for s in slots}
        self.noise, self.peak = {}, {}

    def begin_pass(self, slots):
        for s, vals in self._samples.items():
            if vals:
                vals.sort()
                self.noise[s] = vals[len(vals) // 2]     # median floor
        self.phase = "pass"
        self._samples = {s: [] for s in slots}

    def feed(self, slot, value):
        if self.phase in ("noise", "pass") and slot in self._samples:
            self._samples[slot].append(value)
            if self.phase == "pass":
                self.peak[slot] = max(self.peak.get(slot, 0), value)

    def finish(self):
        self.phase = "done"
        return self.results()

    def results(self):
        frac = PRESETS.get(self.preset, PRESETS[DEFAULT_PRESET])["fraction"]
        out = {}
        for s in set(list(self.noise) + list(self.peak)):
            n, p = self.noise.get(s), self.peak.get(s)
            q, ratio = quality(n, p)
            out[s] = {"noise": n, "peak": p,
                      "suggested": suggest(n, p, frac),
                      "quality": q, "ratio": round(ratio, 2)}
        return out

    def to_dict(self):
        return {"phase": self.phase, "preset": self.preset,
                "presets": {k: v["label"] for k, v in PRESETS.items()},
                "results": {str(k): v for k, v in self.results().items()}}
