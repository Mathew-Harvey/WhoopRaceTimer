/* Gate sensitivity: measurement, threshold derivation, and plain-English verdicts.
 *
 * The timer reports a lap when a receiver's RSSI rises above its threshold. Set
 * it below the noise floor and the timer believes a craft is permanently in the
 * gate, so it never sees a crossing and never reports a lap — which is exactly
 * how the unit this was written for was configured (threshold 700, floor 963).
 * It had never reported a lap, and nothing said why.
 *
 * Correct placement is between the two:
 *
 *     noise floor  ....  threshold  ....  peak of a real pass
 *
 * Each receiver is on its own frequency, so every slot has its own pair. On a
 * tiny track that matters most: every quad is near the gate all the time and
 * neighbouring video bleeds across channels.
 */
'use strict';
import * as laprf from './laprf.js';

export const PRESETS = {
  tiny:   { fraction: 0.62, label: 'Tiny track', hint: 'quads are never far from the gate' },
  small:  { fraction: 0.50, label: 'Small indoor', hint: 'a hall or a garage' },
  normal: { fraction: 0.42, label: 'Normal', hint: 'the usual choice' },
  open:   { fraction: 0.32, label: 'Open / outdoor', hint: 'weak or distant passes' },
};
export const DEFAULT_PRESET = 'normal';
export const MIN_SPAN = 120.0;

/** Place a threshold between a slot's lower and upper bound. */
export function derive(floor, ceiling, fraction = 0.42) {
  if (floor == null || ceiling == null) return null;
  const span = ceiling - floor;
  if (span <= MIN_SPAN) return null;
  return Math.round((floor + span * fraction) * 10) / 10;
}

/** How separable is a pass from the noise? Drives the advice the UI gives. */
export function quality(floor, ceiling) {
  if (floor == null || ceiling == null) return { verdict: 'unknown', span: null, ratio: 0 };
  const span = ceiling - floor;
  const ratio = floor ? ceiling / floor : 0;
  const verdict = span < MIN_SPAN ? 'too weak' : span < 400 ? 'marginal' : 'good';
  return { verdict, span, ratio: Math.round(ratio * 100) / 100 };
}

/* -------------------------------------------------------------- verdicts --- */

/**
 * The single most useful sentence about a slot, and whether it is fatal.
 *
 * `fatal` means this slot physically cannot report a lap as configured. The UI
 * must never let that state sit quietly on screen, because it looks identical
 * to "nobody has flown yet".
 */
export function gateHealth({ threshold, floor, ceiling, live, enabled = true }) {
  if (!enabled) return { level: 'off', title: 'Not racing', detail: 'This slot is switched off.' };
  const known = floor ?? live;
  if (threshold == null) {
    return { level: 'unknown', title: 'Not measured',
             detail: 'The timer has not told us this slot’s threshold yet.' };
  }
  if (known != null && threshold <= known) {
    return {
      level: 'fatal', fatal: true, title: 'Cannot ever detect a lap',
      detail: `The trigger level (${fmt(threshold)}) sits at or below this slot’s quiet ` +
              `signal (${fmt(known)}), so the timer thinks a quad is permanently in the ` +
              `gate and never sees a crossing. Tune this gate.`,
      action: 'tune',
    };
  }
  if (floor != null && ceiling != null) {
    const q = quality(floor, ceiling);
    if (q.verdict === 'too weak') {
      return { level: 'bad', title: 'Pass is too weak to separate',
               detail: `A real pass only lifted this slot ${Math.round(q.span)} counts above ` +
                       `quiet. Move the timer closer to the gate, or raise this slot’s gain.`,
               action: 'tune' };
    }
    const margin = threshold - floor;
    const head = ceiling - threshold;
    if (head < 80) {
      return { level: 'warn', title: 'Trigger is close to the peak',
               detail: 'Only just below the strongest pass measured — a slightly weaker ' +
                       'lap will be missed. Re-tune, or pick a more open track preset.',
               action: 'tune' };
    }
    if (margin < 60) {
      return { level: 'warn', title: 'Trigger is close to the noise',
               detail: 'Close enough to quiet that a hovering quad may add phantom laps. ' +
                       'Pick a tighter track preset and re-apply.', action: 'tune' };
    }
    return { level: 'good', title: q.verdict === 'marginal' ? 'Workable' : 'Tuned',
             detail: `Quiet ${fmt(floor)} · trigger ${fmt(threshold)} · pass peak ${fmt(ceiling)}.` };
  }
  return { level: 'untuned', title: 'Never tuned',
           detail: 'Trigger level came from the timer and has not been measured against ' +
                   'this track. Two minutes here saves a night of missed laps.',
           action: 'tune' };
}

const fmt = v => v == null ? '—' : Math.round(v);

/* ----------------------------------------------------------- calibration --- */

/** Two-phase measurement: quiet floor, then one real pass. */
export class Calibration {
  constructor() {
    this.phase = 'idle';        // idle | noise | pass | done
    this.preset = DEFAULT_PRESET;
    this.floor = {};            // slot -> measured quiet level
    this.ceiling = {};          // slot -> measured pass peak
    this.counts = {};           // slot -> samples seen this phase
    this._samples = {};
  }

  beginNoise(slots) {
    this.phase = 'noise';
    this.floor = {}; this.ceiling = {}; this.counts = {};
    this._samples = Object.fromEntries(slots.map(s => [s, []]));
  }

  beginPass(slots) {
    for (const [s, vals] of Object.entries(this._samples)) {
      if (vals.length) {
        vals.sort((a, b) => a - b);
        this.floor[s] = vals[Math.floor(vals.length / 2)];     // median floor
      }
    }
    this.phase = 'pass';
    this.counts = {};
    this._samples = Object.fromEntries(slots.map(s => [s, []]));
  }

  feed(slot, value) {
    if (this.phase !== 'noise' && this.phase !== 'pass') return;
    if (!(slot in this._samples)) return;
    this._samples[slot].push(value);
    this.counts[slot] = (this.counts[slot] || 0) + 1;
    if (this.phase === 'pass') this.ceiling[slot] = Math.max(this.ceiling[slot] || 0, value);
  }

  finish() { this.phase = 'done'; return this.results(); }
  cancel() { this.phase = 'idle'; this._samples = {}; this.counts = {}; }

  results() {
    const frac = (PRESETS[this.preset] || PRESETS[DEFAULT_PRESET]).fraction;
    const slots = new Set([...Object.keys(this.floor), ...Object.keys(this.ceiling)]);
    const out = {};
    for (const s of slots) {
      const f = this.floor[s] ?? null, c = this.ceiling[s] ?? null;
      out[s] = { floor: f, ceiling: c, suggested: derive(f, c, frac), ...quality(f, c) };
    }
    return out;
  }

  /** Slots with enough evidence to be worth applying. */
  usable() {
    const r = this.results();
    return Object.entries(r).filter(([, v]) => v.suggested != null)
                            .map(([s, v]) => ({ slot: Number(s), ...v }));
  }
}

/* ------------------------------------------------------- signal tracking --- */

const HISTORY_S = 90;

/** Per-slot RSSI history, held in *delta above a measured baseline* so a small
 *  real change is visible. Also the software fallback detector, for a unit that
 *  only exposes its ASCII console. */
export class SlotSignal {
  constructor(slot) {
    this.slot = slot;
    this.history = [];      // {t, v}
    this.baseline = null;
    this.peakDelta = 0;
    this.value = 0;
    this.armed = true;
    this.detections = 0;
    this.lastAt = 0;
  }

  add(value, t) {
    t = t ?? Date.now() / 1000;
    this.value = value;
    this.lastAt = t;
    this.history.push({ t, v: value });
    const cut = t - HISTORY_S;
    while (this.history.length && this.history[0].t < cut) this.history.shift();
  }

  /** Freeze the current quiet level as the baseline. Median ignores a stray spike. */
  calibrate() {
    const vals = (this.history.length ? this.history.map(h => h.v) : [this.value]).sort((a, b) => a - b);
    this.baseline = vals[Math.floor(vals.length / 2)];
    this.peakDelta = 0;
    return this.baseline;
  }

  get delta() { return this.baseline == null ? 0 : this.value - this.baseline; }

  /** True exactly once per crossing of `threshold`. */
  check(threshold, hysteresis = 0.5) {
    const d = this.delta;
    this.peakDelta = Math.max(this.peakDelta, d);
    if (this.armed && d >= threshold) { this.armed = false; this.detections++; return true; }
    if (!this.armed && d < threshold * hysteresis) this.armed = true;
    return false;
  }

  series(n = 160) { return this.history.slice(-n); }
}

export class SignalBank {
  constructor(slots = [1, 2, 3, 4]) {
    this.slots = new Map(slots.map(s => [s, new SlotSignal(s)]));
    this.threshold = 500;
    this.autoDetect = false;
  }

  get(slot) {
    if (!this.slots.has(slot)) this.slots.set(slot, new SlotSignal(slot));
    return this.slots.get(slot);
  }

  add(slot, value, t) { this.get(slot).add(value, t); }
  calibrate() { for (const s of this.slots.values()) s.calibrate(); }
  checkAll() {
    const hits = [];
    for (const [s, sig] of this.slots) if (sig.check(this.threshold)) hits.push(s);
    return hits;
  }

  /** Has this slot produced a reading recently? A silent slot is not a quiet one. */
  live(slot, within = 8) {
    const s = this.slots.get(slot);
    return !!(s && s.lastAt && (Date.now() / 1000 - s.lastAt) < within);
  }
}

/* --------------------------------------------------------- channel scan --- */

/**
 * Sweep a slot across every channel and report the peak signal on each.
 *
 * This is what turns "which channel is my video transmitter on?" — a question
 * plenty of pilots genuinely cannot answer about a whoop they were given — into
 * a button. Power the quad up next to the gate and the strongest channel is the
 * answer.
 */
export class ChannelScanner {
  constructor({ link, rfFor, signalFor, dwellMs = 420 }) {
    this.link = link;
    this.rfFor = rfFor;               // slot -> {gain, threshold}
    this.signalFor = signalFor;       // slot -> current rssi
    this.dwellMs = dwellMs;
    this.active = false;
    this.results = [];
    this.index = 0;
    this.slot = null;
  }

  async run(slot, onProgress) {
    if (this.active) return this.results;
    this.active = true;
    this.slot = slot;
    this.results = [];
    this.index = 0;
    const cfg = this.rfFor(slot) || {};
    try {
      for (let i = 0; i < laprf.ALL_CHANNELS.length && this.active; i++) {
        const ch = laprf.ALL_CHANNELS[i];
        const { band, channel, frequency } = laprf.channelByName(ch.name);
        this.link.send(laprf.setRfSetup({
          slot, band, channel, frequency,
          threshold: cfg.threshold ?? 1600, gain: cfg.gain ?? 58, enabled: true }));
        this.index = i;
        const until = performance.now() + this.dwellMs;
        let peak = 0;
        while (performance.now() < until && this.active) {
          await new Promise(r => setTimeout(r, 40));
          peak = Math.max(peak, this.signalFor(slot) || 0);
        }
        this.results.push({ ...ch, peak: Math.round(peak * 10) / 10 });
        onProgress?.({ index: i, total: laprf.ALL_CHANNELS.length, results: this.results });
      }
    } finally {
      this.active = false;
    }
    return this.results;
  }

  stop() { this.active = false; }

  /**
   * The channel a quad is most likely transmitting on.
   *
   * Video is wide enough to light up neighbours, so the winner has to stand
   * clear of the *median* channel, not merely be the maximum — otherwise a flat
   * scan with no quad powered on still returns a confident-looking answer.
   */
  static best(results) {
    if (!results.length) return null;
    const sorted = [...results].sort((a, b) => b.peak - a.peak);
    const peaks = results.map(r => r.peak).sort((a, b) => a - b);
    const median = peaks[Math.floor(peaks.length / 2)];
    const top = sorted[0];
    const lift = top.peak - median;
    return { ...top, median, lift, confident: lift > 150,
             runnerUp: sorted.find(r => Math.abs(r.freq - top.freq) > 20) || sorted[1] || null };
  }
}
