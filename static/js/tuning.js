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
import { STATUS_INTERVAL_MS } from './link.js';

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
export function gateHealth({ threshold, floor, ceiling, live, enabled = true, cal = {} }) {
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
  /* What the flown laps say, which outranks anything the manual wizard measured
   * on some earlier day. Judging a self-calibrated gate on wizard bounds alone
   * left every one of them reading "still calibrating" forever — and judging a
   * re-tuned gate on *stale* bounds made it read "trigger is above the strongest
   * pass" seconds after the app had said out loud that it was calibrated. */
  /* Ready, or counting every pass on enough evidence to mean it. A single
   * lucky lap is not a calibrated gate, and saying so on one pass would be the
   * same over-claim in the other direction. */
  if (cal.ready || (cal.verdict === 'good' && cal.seen >= MIN_PASSES)) {
    return { level: 'good', title: cal.ready ? 'Calibrated' : 'Detecting every pass',
             detail: `Trigger ${fmt(threshold)}, set from flown laps.` };
  }
  /* Evidence exists and it is not good. Falling through to "calibrating" here
   * hid a gate that had stopped counting laps behind a reassuring word, and the
   * gate screen suppresses that level entirely. */
  if (cal.seen >= MIN_PASSES && cal.verdict && cal.verdict !== 'none') {
    if (cal.verdict === 'all missed' || cal.verdict === 'below noise') {
      return { level: 'bad', fatal: cal.verdict === 'below noise',
               title: 'No laps detected',
               detail: `${cal.seen} passes, none detected. Trigger correcting — keep flying.` };
    }
    if (cal.verdict === 'fragile') {
      /* Every pass counted. Calling that "missing some passes" tells a pilot
       * whose gate is working that it is not. */
      return { level: 'warn', title: 'Margin is small',
               detail: 'All passes detected, but only just. A weaker one would miss.' };
    }
    if (cal.verdict === 'some missed') {
      return { level: 'warn', title: 'Missing passes',
               detail: 'Not every crossing is detected. More laps needed.' };
    }
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
           detail: 'The first laps set this receiver’s trigger. Fly the gate.' };
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
    if (v == null) return null;
    const quiet = floor ?? this.quiet() ?? this.baseline;
    if (quiet == null) return null;
    /* lastAt starts at 0, which is a number and so survives ?? — a fresh slot
     * would stamp every excursion at the epoch and the de-duplication below
     * would fold them all into one. */
    t = t ?? (this.lastAt || Date.now() / 1000);

    /* Watch from a third of the way up to the trigger, with a floor under it so
     * a quiet slot does not trip on its own jitter.
     *
     * A trigger of null is a real state, not a missing argument: some units
     * answer a setup query with band, channel and frequency and no threshold at
     * all. That used to stop the watcher dead, so the one case that most needs
     * calibrating — a receiver nobody has ever set a level on — was the one case
     * that could not calibrate. With nothing to measure against, watch from a
     * separable distance above quiet and let the evidence choose the level. */
    const rise = threshold == null ? MIN_SPAN
               : Math.max(WATCH_MIN_RISE, (threshold - quiet) * WATCH_FRACTION);
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
                   /* Unknown, not false: there is no trigger to have cleared. */
                   counted: threshold == null ? null : done.peak >= threshold,
                   margin: threshold == null ? null
                         : Math.round((done.peak - threshold) * 10) / 10 };
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

  /**
   * Re-judge the passes already seen against a new trigger.
   *
   * Moving the trigger does not un-fly the laps. A peak is a physical
   * measurement of how strong a pass was and stays true whatever the trigger
   * is set to; only "would this have counted" and "by how much" are relative to
   * it. Throwing the evidence away on every adjustment is what made calibration
   * unable to finish: self-tuning would move the trigger at three passes, reset
   * the count to zero, and the count could never reach three again.
   */
  rejudge(threshold) {
    if (threshold == null) return;
    for (const p of this.passes) {
      p.counted = p.peak >= threshold;
      p.margin = Math.round((p.peak - threshold) * 10) / 10;
    }
  }

  /** Forget one pass — used when a stronger receiver shows it was really that
   *  quad's signal bleeding across, not a crossing on this channel. */
  dropPass(pass) {
    const i = this.passes.indexOf(pass);
    if (i >= 0) this.passes.splice(i, 1);
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
export function passReport(passes, threshold, fraction = PRESETS[DEFAULT_PRESET].fraction) {
  const seen = passes.length;
  if (!seen) return { seen: 0, counted: 0, missed: 0, verdict: 'none' };
  /* No trigger yet: every pass is evidence and none of them can be judged.
   * The only useful answer is where the level belongs. */
  if (threshold == null) {
    const q = Math.max(...passes.map(p => p.quiet));
    const low = Math.min(...passes.map(p => p.peak));
    const first = low - q > MIN_SPAN ? Math.round((q + (low - q) * fraction) * 10) / 10 : null;
    return { seen, counted: 0, missed: 0, worstMiss: 0, weakest: low, suggest: first,
             verdict: 'no trigger', thinnest: null, worthIt: first != null };
  }
  const counted = passes.filter(p => p.counted).length;
  const missed = seen - counted;
  const peaks = passes.map(p => p.peak).sort((a, b) => a - b);
  /* Not the weakest pass ever flown — the weakest one worth designing for.
   *
   * Taking the true minimum makes the gate chase its own tail. Every lap on a
   * micro track is flown a little differently, so there is always a new worst
   * pass: it lands under the trigger, self-tuning lowers the trigger to catch
   * it, and the next lap produces a weaker one still. The gate improves forever
   * and never arrives — which is exactly what "the pickups kept getting better
   * but it never said calibrated" is. It also sinks the trigger toward the
   * noise, which on a small track is how a hovering quad starts inventing laps.
   *
   * So once there is enough evidence to tell a bad lap from a bad gate, the
   * single worst pass stops defining the gate. */
  const drop = seen >= OUTLIER_MIN_PASSES ? 1 : 0;
  const weakest = peaks[drop];
  const outliers = passes.filter(p => p.peak < weakest).length;
  /* The suggestion has to clear the noise as well as sit under the weakest
   * pass, so it is placed between the two rather than just below the peak. A
   * trigger a hair under the weakest pass ever seen counts that pass and
   * nothing else — the next slightly weaker one is lost. */
  const quiet = Math.max(...passes.map(p => p.quiet));
  /* Where between quiet and the weakest pass the trigger belongs is a property
   * of the track, not of the arithmetic. On a micro track — a RaceGOW-sized
   * room — every quad is near the gate all the time, so the risk that matters
   * is a phantom lap from a quad hovering nearby, and the trigger sits high. In
   * an open field the risk is the opposite. That is exactly what the track
   * preset already says, so it says it here too. */
  const suggest = weakest - quiet > MIN_SPAN
    ? Math.round((quiet + (weakest - quiet) * fraction) * 10) / 10
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
  /* A pass that missed, but which was weaker than anything the gate is being
   * designed for, is a bad lap rather than a bad gate. Counting it as a failure
   * is what kept calibration running forever. */
  const realMissed = passes.filter(p => !p.counted && p.peak >= weakest).length;
  const fragile = realMissed === 0 && thinnest != null && span > 0 &&
                  thinnest < span * FRAGILE_FRACTION;
  const verdict = realMissed === 0 ? (fragile ? 'fragile' : 'good')
                : counted === 0 ? 'all missed' : 'some missed';
  return { seen, counted, missed, realMissed, outliers, worstMiss, weakest, suggest, verdict, thinnest,
           /* Whether the suggestion is worth making at all: an adjustment
            * smaller than this is noise, and rewriting the timer for it would
            * be churn the pilot has to think about for nothing. */
           worthIt: suggest != null && span > 0 &&
                    Math.abs(suggest - threshold) > span * WORTH_FRACTION };
}

/**
 * Is this receiver calibrated, and if not, how much more flying is needed?
 *
 * Three clean passes settle a gate where every lap looks like the last one. A
 * micro track is not that: the same quad takes the same gate at a different
 * height and angle every lap, and three passes that happen to agree can be
 * three passes that agree by luck. So the evidence required grows with how much
 * the passes disagree — which always terminates, unlike demanding that they
 * agree, and which asks for nothing extra on a track where they already do.
 */
export function readiness(passes, threshold, fraction) {
  const rep = passReport(passes, threshold, fraction);
  if (!rep.seen) return { ...rep, ready: false, need: MIN_PASSES, spread: null };
  /* Judged on the passes the gate is designed for, not on the freak laps it has
   * already decided to ignore. Letting one outlier widen the spread would raise
   * the evidence bar precisely because a lap was discounted — the same tail
   * chasing, one step further back. */
  const peaks = passes.map(p => p.peak).filter(v => v >= (rep.weakest ?? -Infinity));
  const quiet = Math.max(...passes.map(p => p.quiet));
  const mid = [...peaks].sort((a, b) => a - b)[Math.floor(peaks.length / 2)];
  const height = mid - quiet;
  /* How far apart the passes are, as a share of how far above quiet they sit. */
  const spread = height > 0 ? (Math.max(...peaks) - Math.min(...peaks)) / height : 1;
  const need = spread > SPREAD_WIDE ? MAX_PASSES : MIN_PASSES;
  return { ...rep, spread: Math.round(spread * 100) / 100, need,
           ready: rep.seen >= need && rep.verdict === 'good' };
}

/* An analog 5.8 GHz video signal is about this wide, so channels this close
 * together cannot be told apart by an RSSI sweep. */
const VIDEO_BW_MHZ = 20;
/* Within this share of the winner's lift is a tie, not a runner-up. */
const TIE_MARGIN = 0.25;
/* Which label to prefer when the radio genuinely cannot tell. */
const BAND_PREFERENCE = ['R', 'F', 'E', 'A', 'B'];
/* How far above the noise a reading has to stand before it is a transmitter
 * rather than a quiet channel having a good day. */
const SIGNAL_LIFT = 150;

/* Below this many passes there is no way to tell an unusual lap from a badly
 * placed gate, so every pass counts. At or above it, the single worst one stops
 * setting the level for all the others. */
const OUTLIER_MIN_PASSES = 5;

/* A sweep wants readings as fast as they come; racing wants them fast enough to
 * catch a peak. They happen to be the same number, but they are not the same
 * decision. */
const SCAN_STATUS_MS = 200;
/* A sweep has to put *something* in the trigger and gain fields of every record
 * it writes — the receiver takes a whole setup or none of it. These are used
 * only while sweeping, and only when the slot has no real values of its own;
 * whatever was there before is written back when the sweep ends. */
const SCAN_THRESHOLD = 1600, SCAN_GAIN = 58;

export const MIN_PASSES = 3, MAX_PASSES = 6;
/* Peaks varying by more than this share of their own height above quiet is a
 * track that needs more evidence before anyone calls it calibrated. */
const SPREAD_WIDE = 0.35;

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
  /* Long enough to cover a whole status interval after the retune lands, so the
   * first reading accepted is one the timer took on the new frequency rather
   * than the last one it had already prepared on the old. */
  constructor({ link, rfFor, sample, settleMs = 260, maxWaitMs = 2400 }) {
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

  async run(slot, onProgress, channels = null) {
    if (this.active) return this.results;
    this.active = true;
    this.slot = slot;
    this.results = [];
    this.index = 0;
    this.lost = false;
    const cfg = this.rfFor(slot) || {};
    /* Where this receiver was before the sweep moved it. Putting it back is
     * this method's responsibility and cannot be delegated: the app's own
     * config write declines to act on a slot whose trigger nobody knows, which
     * is exactly the slot a sweep is most likely to be run on — so relying on
     * it left the receiver parked wherever the sweep ended, which for a raw
     * frequency sweep is not even a channel. */
    const before = { ...cfg };
    /* Ask for readings quickly while sweeping; a unit that ignores the request
     * still works, just slower, because each channel waits for real samples. */
    this.link.send(laprf.setStatusInterval(SCAN_STATUS_MS));
    try {
      const points = channels || laprf.ALL_CHANNELS;
      for (let i = 0; i < points.length && this.active; i++) {
        if (!this.link.alive) { this.lost = true; break; }
        const ch = points[i];
        /* A named channel carries a band and channel index; a raw frequency
         * point does not, and the receiver tunes by frequency either way. */
        const named = ch.name && laprf.BANDS[ch.name[0]] ? laprf.channelByName(ch.name) : null;
        /* Awaited: the settle clock has to start when the receiver was actually
         * retuned, not when the instruction joined a queue. Starting it early
         * lets a reading taken on the *previous* frequency count as this one's,
         * and since the rule below deliberately takes the lower of two, a stale
         * reading from a quiet neighbour actively wins. That is not noise — it
         * biases whole regions of the sweep by whatever preceded them, which is
         * how a quad sitting on 5917 came to read a thousand counts stronger at
         * 5925, eight megahertz away: the channel before 5925 was near the
         * signal and the channel before 5917 was nowhere near it. */
        await this.link.send(laprf.setRfSetup({
          slot, band: named?.band ?? 1, channel: named?.channel ?? 1,
          frequency: named?.frequency ?? ch.freq,
          threshold: cfg.threshold ?? SCAN_THRESHOLD, gain: cfg.gain ?? SCAN_GAIN,
          enabled: true }));
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
          if (!this.link.alive) { this.lost = true; break; }
          const s = this.sample(slot);
          if (s && s.t > sentAt && s.t !== lastT) { lastT = s.t; fresh.push(s.v); }
        }
        if (this.lost) break;
        fresh.sort((a, b) => b - a);
        const peak = fresh.length >= 2 ? fresh[1] : (fresh[0] ?? 0);
        this.results.push({ ...ch, peak: Math.round(peak * 10) / 10, samples: fresh.length });
        onProgress?.({ index: i, total: points.length, results: this.results });
      }
    } finally {
      this.active = false;
      /* Back to the rate the app runs at, not to a slower one plucked from
       * nowhere. Restoring 1000 ms here quietly crippled everything that came
       * after: calibration measures the peak of a pass, and a peak lasts less
       * than a second, so one use of "find my channel" left every later lap
       * being stepped over — on a gate that was working perfectly before. */
      if (this.link.alive) {
        if (before.frequency) {
          this.link.send(laprf.setRfSetup({
            slot, band: before.band, channel: before.channel, frequency: before.frequency,
            threshold: before.threshold ?? SCAN_THRESHOLD, gain: before.gain ?? SCAN_GAIN,
            /* Whatever it was, not whatever the sweep left it as. The sweep
             * switches every channel on to measure it, so this is the only
             * write that can put a deliberately disabled receiver back — and a
             * slot switched off in solo practice that comes back on can report
             * passings for a pilot who is not racing. */
            enabled: before.enabled ?? true }));
        }
        this.link.send(laprf.setStatusInterval(STATUS_INTERVAL_MS));
      }
    }
    return this.results;
  }

  stop() { this.active = false; }

  /**
   * Sweep a raw frequency range rather than the channel table.
   *
   * The forty named channels are not a spectrum: R8 is 5917 and E7 is 5925, and
   * between them there is nothing to look at, so a channel sweep cannot say
   * whether a signal is centred on one, centred on the other, or sitting
   * somewhere between them and lighting up both. A receiver takes any frequency
   * it is given, so ask it for the gaps too and the actual shape appears.
   *
   * This is a diagnostic, not part of racing: it answers "where is the video
   * really" when a label and a measurement disagree.
   */
  async sweepRange(slot, from, to, step = 2, onProgress) {
    const points = [];
    for (let f = from; f <= to; f += step) points.push(f);
    return this.run(slot, onProgress, points.map(f => ({ name: String(f), freq: f })));
  }

  /**
   * The channel a quad is most likely transmitting on.
   *
   * Video is wide enough to light up neighbours, so the winner has to stand
   * clear of the *median* channel, not merely be the maximum — otherwise a flat
   * scan with no quad powered on still returns a confident-looking answer.
   */
  /**
   * Which channel the quad is on, and which channels are indistinguishable
   * from it.
   *
   * A scan cannot simply take the strongest reading. An analog 5.8 GHz
   * transmitter is around 20 MHz wide, and the channel tables overlap far more
   * finely than that: R8 is 5917 and E7 is 5925, eight megahertz apart, so a
   * quad on R8 lights up both and either can come out on top on the day. The
   * strongest reading is therefore evidence of roughly where the video is, not
   * of which label the pilot's goggles show.
   *
   * So everything within a video bandwidth of the winner, reading within a
   * quarter of its lift, is a genuine tie. Ties are broken toward Raceband and
   * then Fatshark, because that is what whoop and HDZero pilots actually fly
   * and therefore what their goggles will be displaying — and every tied
   * channel is handed back so the screen can offer them rather than quietly
   * deciding on the pilot's behalf.
   */
  /**
   * Every distinct transmitter the sweep can see, strongest first.
   *
   * The sweep used to answer "which channel read loudest", which is only the
   * right question when there is one thing transmitting. Put a second quad, or
   * anyone else's video, in the same room and the loudest reading is whichever
   * happened to be nearer — a real sweep had 5740 beating the pilot's own quad
   * at 5917 by thirty-eight counts, and reported a channel 177 MHz from the one
   * their goggles showed.
   *
   * So: find everything standing clear of the noise, group readings that are
   * within a video bandwidth of each other into one signal, and hand back all
   * of them. Two transmitters is not an error to be resolved by arithmetic, it
   * is a question only the pilot can answer.
   */
  static signals(results) {
    const seen = results.filter(r => (r.samples ?? 2) >= 1);
    if (!seen.length) return [];
    const peaks = seen.map(r => r.peak).sort((a, b) => a - b);
    const median = peaks[Math.floor(peaks.length / 2)];
    const loud = seen.filter(r => r.peak - median > SIGNAL_LIFT)
                     .sort((a, b) => a.freq - b.freq);
    const groups = [];
    for (const r of loud) {
      const g = groups[groups.length - 1];
      if (g && r.freq - g[g.length - 1].freq <= VIDEO_BW_MHZ) g.push(r);
      else groups.push([r]);
    }
    const rank = r => { const i = BAND_PREFERENCE.indexOf(r.band ?? r.name[0]); return i < 0 ? 99 : i; };
    return groups.map(g => {
      const top = [...g].sort((a, b) => b.peak - a.peak)[0];
      /* Within one signal the label is a choice, not a measurement: pick the
       * one a pilot's goggles are likely to show. */
      const near = g.filter(r => top.peak - r.peak <= (top.peak - median) * TIE_MARGIN);
      const pick = [...near].sort((a, b) => rank(a) - rank(b) || b.peak - a.peak)[0] || top;
      return { ...pick, peak: top.peak, median, lift: top.peak - median,
               alsoCalled: g.filter(r => r.name !== pick.name),
               span: [g[0].freq, g[g.length - 1].freq] };
    }).sort((a, b) => b.peak - a.peak);
  }

  static best(results) {
    const seen = results.filter(r => (r.samples ?? 2) >= 1);
    if (!seen.length) return null;
    const sorted = [...seen].sort((a, b) => b.peak - a.peak);
    const peaks = seen.map(r => r.peak).sort((a, b) => a - b);
    const median = peaks[Math.floor(peaks.length / 2)];
    const top = sorted[0];
    const lift = top.peak - median;

    const tied = seen.filter(r => Math.abs(r.freq - top.freq) <= VIDEO_BW_MHZ &&
                                  top.peak - r.peak <= lift * TIE_MARGIN);
    const rank = r => BAND_PREFERENCE.indexOf(r.band ?? r.name[0]);
    const pick = [...tied].sort((a, b) => {
      const d = (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b));
      return d || b.peak - a.peak;
    })[0] || top;

    return { ...pick, median, lift, confident: lift > 150 && (top.samples ?? 2) >= 2,
             /* Same signal, different label: what the goggles might call it. */
             alsoCalled: tied.filter(r => r.name !== pick.name),
             runnerUp: sorted.find(r => Math.abs(r.freq - top.freq) > VIDEO_BW_MHZ) || null };
  }
}
