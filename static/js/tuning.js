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
  const verdict = span <= MIN_SPAN ? 'too weak' : span < 400 ? 'marginal' : 'good';
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
  /* The quiet level is whichever is higher: what was measured, or what the
   * receiver reports right now. A gate tuned in an empty room and then run
   * with three other quads powered up has a louder floor than it was tuned at. */
  const known = (floor == null && live == null) ? null : Math.max(floor ?? -Infinity, live ?? -Infinity);
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
    if (head <= 0) {
      return { level: 'bad', title: 'Trigger is above the strongest pass',
               detail: `The measured pass peaked at ${fmt(ceiling)}, below the trigger (${fmt(threshold)}), ` +
                       `so a lap like that one is never counted. Re-apply the wizard, or lower the trigger.`,
               action: 'tune' };
    }
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
  /* Nothing has been measured here yet, and that is not a chore anyone needs to
   * be handed. The first laps flown supply the evidence and the trigger moves
   * itself; the only correct instruction is "fly". */
  return { level: 'learning', title: 'Calibrating',
           detail: 'The first few laps set this receiver’s trigger. Just fly.' };
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
    this._win = {};             // slot -> {a,b} highest and second-highest
  }

  beginNoise(slots) {
    this.phase = 'noise';
    this.floor = {}; this.ceiling = {}; this.counts = {}; this._win = {};
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
    this.counts = {}; this._win = {};
    this._samples = Object.fromEntries(slots.map(s => [s, []]));
  }

  feed(slot, value) {
    if (this.phase !== 'noise' && this.phase !== 'pass') return;
    if (!(slot in this._samples)) return;
    this._samples[slot].push(value);
    this.counts[slot] = (this.counts[slot] || 0) + 1;
    /* The ceiling is the peak of a real pass, and it used to be the raw maximum
     * — while the floor beside it was deliberately a median, because a stray
     * spike must not move it. The asymmetry cost laps: one spurious sample
     * raised the ceiling, which raised the derived trigger, which made the gate
     * less sensitive than was asked for, silently and in the direction that
     * loses passes.
     *
     * So: the second-highest reading, not the highest. It is the same idiom the
     * channel scanner already uses to stop one transient electing a channel. A
     * lone spike is always the highest and never the second, so it is ignored
     * outright; two consecutive high samples are a signal rather than a glitch
     * and are believed. Smoothing was the wrong tool here — at the rate status
     * records arrive, a genuine peak is often a single sample, and a median
     * would have clipped every one of them and dragged triggers the other way.
     *
     * On one flown lap this reads the shoulder rather than the tip, an
     * under-read of a few percent that errs toward a more sensitive gate. Over
     * the several laps the wizard asks for, the second-highest is another lap's
     * peak, and the error goes away. */
    if (this.phase === 'pass') {
      const t = (this._win[slot] ||= { a: -Infinity, b: -Infinity });
      if (value > t.a) { t.b = t.a; t.a = value; }
      else if (value > t.b) { t.b = value; }
      this.ceiling[slot] = isFinite(t.b) ? t.b : t.a;
    }
  }

  finish() { this.phase = 'done'; return this.results(); }
  cancel() { this.phase = 'idle'; this._samples = {}; this.counts = {}; this._win = {}; }

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
    this.passes = [];       // recent excursions, judged against the trigger
    this._pass = null;      // the excursion in progress, if any
  }

  add(value, t) {
    t = t ?? Date.now() / 1000;
    this.value = value;
    this.lastAt = t;
    this.history.push({ t, v: value });
    const cut = t - HISTORY_S;
    while (this.history.length && this.history[0].t < cut) this.history.shift();
  }

  /** The recent quiet level: the median of the last `windowS` seconds. Unlike
   *  the instantaneous value, a quad passing the gate does not move it — which
   *  matters, because a verdict that says "can never detect a lap" every time a
   *  lap is actually detected is worse than no verdict. */
  quiet(windowS = 10) {
    const cut = (this.lastAt || Date.now() / 1000) - windowS;
    const vals = this.history.filter(h => h.t >= cut).map(h => h.v).sort((a, b) => a - b);
    if (!vals.length) return null;
    return vals[Math.floor(vals.length / 2)];
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

  /* ---------------------------------------------------- pass observation --- */

  /**
   * Watch the live signal for excursions and remember each one.
   *
   * This is not lap timing — the LapRF does that in its own firmware, far
   * faster than status records arrive here. It exists so the tuning screen can
   * answer the only question that matters while someone is standing at a gate
   * with a quad in their hand: *would that pass have counted?*
   *
   * The trick is to watch from lower down than the trigger. An excursion is
   * tracked from a little above the quiet floor, so a pass that peaked just
   * under the trigger is still seen and still measured — and a gate set too
   * high stops being an absence of laps, which looks exactly like not having
   * flown yet, and becomes "that one missed by 62".
   *
   * Hysteresis on the way out is PhobosLT's: closing on the same level that
   * opened would let a signal sitting on the line rattle out a dozen passes.
   */
  observe(threshold, floor, t) {
    const v = this.value;
    if (v == null || threshold == null) return null;
    const quiet = floor ?? this.quiet() ?? this.baseline;
    if (quiet == null) return null;
    /* lastAt starts at 0, which is a number and so survives ?? — a fresh slot
     * would stamp every excursion at the epoch and the de-duplication below
     * would fold them all into one. */
    t = t ?? (this.lastAt || Date.now() / 1000);

    /* Watch from a third of the way up to the trigger, with a floor under it so
     * a quiet slot does not trip on its own jitter. */
    const rise = Math.max(WATCH_MIN_RISE, (threshold - quiet) * WATCH_FRACTION);
    const enter = quiet + rise;
    const exit = quiet + rise * PASS_EXIT_FRACTION;

    if (!this._pass) {
      if (v >= enter) this._pass = { peak: v, at: t, start: t };
      return null;
    }
    if (v > this._pass.peak) { this._pass.peak = v; this._pass.at = t; }
    if (v >= exit) return null;

    /* The excursion is over: judge it against the trigger as it stands. */
    const done = this._pass;
    this._pass = null;
    if (done.peak < enter) return null;
    const pass = { peak: done.peak, at: done.at, quiet,
                   counted: done.peak >= threshold,
                   margin: Math.round((done.peak - threshold) * 10) / 10 };
    this.passes.push(pass);
    while (this.passes.length > PASS_HISTORY) this.passes.shift();
    return pass;
  }

  /**
   * A pass the timer itself reported, with the peak height it measured.
   *
   * This is better evidence than anything sampled here: the LapRF measures the
   * peak in firmware at its own rate, while status records arrive a few times a
   * second and may miss the tip of a fast pass entirely. It only ever describes
   * passes that already cleared the trigger — the timer says nothing about the
   * ones that missed — so it complements the watcher rather than replacing it.
   */
  recordHardwarePass(peak, threshold, floor, t) {
    if (peak == null || threshold == null) return null;
    const quiet = floor ?? this.quiet() ?? this.baseline;
    /* A peak below the quiet level is not a peak; some units report 0 when they
     * have nothing to say, and believing that would invent a fragile gate. */
    if (quiet == null || peak <= quiet) return null;
    /* The excursion in flight is this same pass seen through the slow sampler.
     * Keeping both would count one crossing twice. */
    this._pass = null;
    const at = t ?? (this.lastAt || Date.now() / 1000);
    const last = this.passes[this.passes.length - 1];
    if (last && last.source === 'timer' && Math.abs(at - last.at) < 0.5) return null;
    const pass = { peak, at, quiet, counted: true,
                   margin: Math.round((peak - threshold) * 10) / 10, source: 'timer' };
    this.passes.push(pass);
    while (this.passes.length > PASS_HISTORY) this.passes.shift();
    return pass;
  }

  /** Forget what was seen — a new trigger deserves a fresh verdict. */
  clearPasses() { this.passes = []; this._pass = null; }
}

/* How far above quiet an excursion has to rise before it is worth watching,
 * as a fraction of the gap to the trigger, and never less than this in raw
 * counts. Low enough to catch a pass that missed; high enough to ignore noise. */
const WATCH_FRACTION = 0.34, WATCH_MIN_RISE = 60;
/* Close an excursion well below where it opened, or a signal resting on the
 * line reports a pass on every sample. */
const PASS_EXIT_FRACTION = 0.7;
const PASS_HISTORY = 12;

/**
 * What the passes seen so far say about a trigger, in one sentence and one
 * number. This is the whole point of watching: not to time a lap, but to tell
 * someone whether the level they are about to fly a race on is right.
 */
export function passReport(passes, threshold) {
  const seen = passes.length;
  if (!seen) return { seen: 0, counted: 0, missed: 0, verdict: 'none' };
  const counted = passes.filter(p => p.counted).length;
  const missed = seen - counted;
  const peaks = passes.map(p => p.peak).sort((a, b) => a - b);
  const weakest = peaks[0];
  /* The suggestion has to clear the noise as well as sit under the weakest
   * pass, so it is placed between the two rather than just below the peak. A
   * trigger a hair under the weakest pass ever seen counts that pass and
   * nothing else — the next slightly weaker one is lost. */
  const quiet = Math.max(...passes.map(p => p.quiet));
  const suggest = weakest - quiet > MIN_SPAN
    ? Math.round((quiet + (weakest - quiet) * 0.55) * 10) / 10
    : null;
  const worstMiss = missed
    ? Math.round(Math.min(...passes.filter(p => !p.counted).map(p => threshold - p.peak)) * 10) / 10
    : 0;
  /* A gate can count every pass and still be wrong. A trigger sitting just
   * under the weakest peak counts today and misses tomorrow, when the battery
   * is lower or the quad takes the gate a foot wider — and the failure, when it
   * comes, is the silent kind. So a thin margin is reported as its own verdict
   * rather than being rounded up to "fine". */
  /* A trigger at or below the quiet level can never fire: the timer believes a
   * quad is permanently in the gate and so never sees a crossing. Every pass
   * "clears" it, which is why this has to be caught before the margins are
   * looked at — by that arithmetic the most broken gate there is reads as the
   * healthiest one. */
  if (threshold <= quiet) {
    return { seen, counted, missed: 0, worstMiss: 0, weakest, suggest,
             verdict: 'below noise', thinnest: null, worthIt: suggest != null };
  }
  const margins = passes.filter(p => p.counted).map(p => p.peak - threshold);
  const thinnest = margins.length ? Math.round(Math.min(...margins) * 10) / 10 : null;
  const span = weakest - quiet;
  const fragile = missed === 0 && thinnest != null && span > 0 &&
                  thinnest < span * FRAGILE_FRACTION;
  const verdict = missed === 0 ? (fragile ? 'fragile' : 'good')
                : counted === 0 ? 'all missed' : 'some missed';
  return { seen, counted, missed, worstMiss, weakest, suggest, verdict, thinnest,
           /* Whether the suggestion is worth making at all: an adjustment
            * smaller than this is noise, and rewriting the timer for it would
            * be churn the pilot has to think about for nothing. */
           worthIt: suggest != null && span > 0 &&
                    Math.abs(suggest - threshold) > span * WORTH_FRACTION };
}

/* Below this share of the pass's own height above quiet, a margin is thin
 * enough to call fragile rather than good. */
const FRAGILE_FRACTION = 0.15;
/* And a suggested move smaller than this share of the same span is not worth
 * making. */
const WORTH_FRACTION = 0.05;

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

  /** Recent quiet level for a slot, or null if it has gone silent. */
  quiet(slot) {
    return this.live(slot) ? this.slots.get(slot).quiet() : null;
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
  /**
   * link     the timer link
   * rfFor    slot -> {gain, threshold} to keep the receiver at while sweeping
   * sample   slot -> {v, t} the latest reading and when it arrived
   * settleMs how long after a retune the first reading is distrusted
   * maxWaitMs give up on a channel after this long without two fresh samples
   */
  constructor({ link, rfFor, sample, settleMs = 120, maxWaitMs = 1800 }) {
    this.link = link;
    this.rfFor = rfFor;
    this.sample = sample;
    this.settleMs = settleMs;
    this.maxWaitMs = maxWaitMs;
    this.active = false;
    this.lost = false;                // the link dropped mid-sweep
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
    this.lost = false;
    const cfg = this.rfFor(slot) || {};
    /* Ask for readings quickly while sweeping; a unit that ignores the request
     * still works, just slower, because each channel waits for real samples. */
    this.link.send(laprf.setStatusInterval(200));
    try {
      for (let i = 0; i < laprf.ALL_CHANNELS.length && this.active; i++) {
        if (!this.link.connected) { this.lost = true; break; }
        const ch = laprf.ALL_CHANNELS[i];
        const { band, channel, frequency } = laprf.channelByName(ch.name);
        this.link.send(laprf.setRfSetup({
          slot, band, channel, frequency,
          threshold: cfg.threshold ?? 1600, gain: cfg.gain ?? 58, enabled: true }));
        this.index = i;
        /* Only readings that arrived after the retune say anything about this
         * channel; the previous one's value is still in the register until then.
         * Two fresh readings are needed, and the lower of the top two is the
         * answer, so one transient from a quad passing the gate cannot elect a
         * channel on its own. */
        const sentAt = Date.now() / 1000 + this.settleMs / 1000;
        const deadline = performance.now() + this.maxWaitMs;
        const fresh = [];
        let lastT = 0;
        while (performance.now() < deadline && this.active && fresh.length < 2) {
          await new Promise(r => setTimeout(r, 40));
          if (!this.link.connected) { this.lost = true; break; }
          const s = this.sample(slot);
          if (s && s.t > sentAt && s.t !== lastT) { lastT = s.t; fresh.push(s.v); }
        }
        if (this.lost) break;
        fresh.sort((a, b) => b - a);
        const peak = fresh.length >= 2 ? fresh[1] : (fresh[0] ?? 0);
        this.results.push({ ...ch, peak: Math.round(peak * 10) / 10, samples: fresh.length });
        onProgress?.({ index: i, total: laprf.ALL_CHANNELS.length, results: this.results });
      }
    } finally {
      this.active = false;
      if (this.link.connected) this.link.send(laprf.setStatusInterval(1000));
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
    const seen = results.filter(r => (r.samples ?? 2) >= 1);
    if (!seen.length) return null;
    const sorted = [...seen].sort((a, b) => b.peak - a.peak);
    const peaks = seen.map(r => r.peak).sort((a, b) => a - b);
    const median = peaks[Math.floor(peaks.length / 2)];
    const top = sorted[0];
    const lift = top.peak - median;
    /* Confidence needs a clear lift AND two readings behind it. */
    return { ...top, median, lift, confident: lift > 150 && (top.samples ?? 2) >= 2,
             runnerUp: sorted.find(r => Math.abs(r.freq - top.freq) > 20) || sorted[1] || null };
  }
}
