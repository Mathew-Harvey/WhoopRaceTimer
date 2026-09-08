/* Race state machine: pilots, laps, formats, callouts.
 *
 * Port of race.py, now running in the browser so the app needs no server.
 *
 * Lap timing rule: whoops normally launch from behind the gate, so the FIRST
 * gate crossing after the start ends lap 1 — it is not a separate holeshot. Set
 * holeshot if you launch on the far side and want the first crossing to only
 * start the clock.
 *
 * A minimum lap time is enforced here regardless of the timer's own setting,
 * because a whoop hovering in the gate will otherwise register a burst of
 * passes.
 */
'use strict';

export const COLORS = ['#00d1e0', '#4d7cff', '#ff4fb8', '#c9f036'];
export const MODES = ['practice', 'laps', 'time', 'consecutive'];
export const DEFAULT_CHANNELS = ['R1', 'R3', 'R6', 'R7'];

const now = () => performance.now() / 1000;
const round3 = v => Math.round(v * 1000) / 1000;

export class Pilot {
  constructor(slot, { name = '', channel = 'R1', enabled = true, colour = null } = {}) {
    this.slot = slot;
    this.name = name || `Pilot ${slot}`;
    this.channel = channel;
    this.enabled = enabled;
    this.color = colour || COLORS[(slot - 1) % COLORS.length];
    this.reset();
  }

  reset() { this.laps = []; this.lastPass = null; this.started = false; }

  get lapCount() { return this.laps.length; }
  get best() { return this.laps.length ? Math.min(...this.laps.map(l => l.time)) : null; }
  get last() { return this.laps.length ? this.laps[this.laps.length - 1].time : null; }
  get total() { return this.laps.reduce((a, l) => a + l.time, 0); }

  /** Fastest n back-to-back laps — the standard whoop/drone race metric. */
  bestConsecutive(n = 3) {
    if (this.laps.length < n) return null;
    const t = this.laps.map(l => l.time);
    let best = Infinity;
    for (let i = 0; i + n <= t.length; i++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += t[i + k];
      best = Math.min(best, s);
    }
    return round3(best);
  }
}

export class Race {
  constructor(opts = {}) {
    this.pilots = new Map();
    for (let i = 1; i <= 4; i++) this.pilots.set(i, new Pilot(i, { channel: DEFAULT_CHANNELS[i - 1] }));
    this.state = 'idle';              // idle | staging | running | finished
    this.mode = 'practice';
    this.targetLaps = 5;
    this.targetSeconds = 120;
    this.consecN = 3;
    this.minLap = 3.0;
    this.holeshot = false;
    this.countdown = 5;
    this.startedAt = null;
    this.finishedAt = null;
    this.stagingUntil = null;
    this.name = '';
    this.log = [];
    this._announcedLastLap = new Set();
    this.onCallout = opts.onCallout || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onFinish = opts.onFinish || (() => {});
    this.onLap = opts.onLap || (() => {});
  }

  /* ---- config ---- */
  setPilot(slot, patch) {
    const p = this.pilots.get(slot);
    if (!p) return;
    for (const k of ['name', 'channel', 'enabled']) if (patch[k] != null) p[k] = patch[k];
    if (patch.colour != null) p.color = patch.colour;
    this.onChange();
  }

  configure(patch) {
    for (const k of ['mode', 'targetLaps', 'targetSeconds', 'consecN', 'minLap',
                     'holeshot', 'countdown', 'name']) {
      if (patch[k] != null) this[k] = patch[k];
    }
    this.onChange();
  }

  get racing() { return [...this.pilots.values()].filter(p => p.enabled); }

  /** True when a single whoop is flying.
   *  Practising on your own and hearing your own name every lap is noise, so
   *  callouts drop the name and read just the lap and time. */
  get solo() { return this.racing.length === 1; }

  get open() { return this.mode === 'practice'; }

  /* ---- control ---- */
  arm(countdown) {
    this._clear();
    this.state = 'staging';
    this.stagingUntil = now() + (countdown ?? this.countdown);
    this.onCallout(this.solo ? 'Arm your quad' : 'Arm your quads');
    this.onChange();
  }

  startNow() { this._clear(); this._begin(); }

  _clear() {
    for (const p of this.pilots.values()) p.reset();
    this.log = [];
    this._announcedLastLap = new Set();
    this.finishedAt = null;
    this.startedAt = null;
  }

  _begin() {
    this.state = 'running';
    this.startedAt = now();
    this.stagingUntil = null;
    this.onCallout('Go!', { priority: true });
    this._log('Race started');
    this.onChange();
  }

  stop() {
    const wasRunning = this.state === 'running';
    if (wasRunning) this.finishedAt = now();
    this.state = 'finished';
    this.stagingUntil = null;
    this._log(this.open ? 'Session ended' : 'Race complete');
    this.onCallout(this.open ? 'Session ended' : 'Race complete');
    if (wasRunning) this.onFinish(this.results());
    this.onChange();
  }

  reset() {
    this._clear();
    this.state = 'idle';
    this.stagingUntil = null;
    this.onChange();
  }

  get elapsed() {
    if (!this.startedAt) return 0;
    return (this.finishedAt ?? now()) - this.startedAt;
  }

  /** Seconds left, for a timed race. */
  get remaining() {
    if (this.mode !== 'time' || !this.startedAt) return null;
    return Math.max(0, this.targetSeconds - this.elapsed);
  }

  get countdownLeft() {
    return this.stagingUntil ? Math.max(0, this.stagingUntil - now()) : null;
  }

  tick() {
    if (this.state === 'staging' && this.stagingUntil) {
      if (this.stagingUntil - now() <= 0) this._begin();
      return;
    }
    if (this.state === 'running' && this.mode === 'time' && this.elapsed >= this.targetSeconds) {
      this.stop();
    }
  }

  /* ---- standings ---- */
  standings() {
    const ps = [...this.racing];
    if (this.mode === 'consecutive') {
      return ps.sort((a, b) => {
        const ca = a.bestConsecutive(this.consecN), cb = b.bestConsecutive(this.consecN);
        return (ca ?? 1e9) - (cb ?? 1e9);
      });
    }
    return ps.sort((a, b) => (b.lapCount - a.lapCount) ||
                             ((a.lapCount ? a.total : 1e9) - (b.lapCount ? b.total : 1e9)));
  }

  /* ---- the hot path ---- */
  onPassing(slot, at) {
    const p = this.pilots.get(slot);
    if (!p || !p.enabled) return false;
    if (this.state !== 'running') return false;
    const t = at ?? now();

    const ref = p.lastPass ?? this.startedAt;
    if (p.lastPass !== null && (t - p.lastPass) < this.minLap) return false;

    if (this.holeshot && !p.started) {
      p.started = true;
      p.lastPass = t;
      this._log(`${p.name} away`);
      this.onCallout(this.solo ? 'Away' : `${p.name} away`);
      this.onChange();
      return false;
    }

    const lapTime = t - (ref ?? t);
    p.lastPass = t;
    p.started = true;
    const n = p.laps.length + 1;
    const prevBest = p.best;
    p.laps.push({ n, time: round3(lapTime), at: t });

    const isPb = n > 1 && prevBest !== null && lapTime < prevBest;
    this._log(`${p.name} lap ${n}: ${lapTime.toFixed(2)}s${isPb ? '  PB' : ''}`);
    /* onLap first: the screen should already know about the lap by the time the
     * callout is spoken, because the callout can be shortened to just the
     * number and needs that number to hand. */
    this.onLap({ pilot: p, n, time: round3(lapTime), isPb });
    this.onCallout(this._calloutText(p, n, lapTime, isPb), { lapTime: round3(lapTime) });

    this._checkFinish(p, n);
    this.onChange();
    return true;
  }

  /** Remove a pilot's most recent lap. Manual gate triggers and a bouncing quad
   *  both produce laps that should not count, and a race that cannot be
   *  corrected is a race people stop trusting. */
  undoLap(slot) {
    const p = this.pilots.get(slot);
    if (!p || !p.laps.length) return { ok: false, message: 'no lap to undo' };
    const removed = p.laps.pop();
    /* rewind the reference point so the NEXT pass times from the right place */
    p.lastPass = p.laps.length ? p.laps[p.laps.length - 1].at : null;
    p.started = p.laps.length > 0;
    this._announcedLastLap.delete(slot);
    if (this.state === 'finished' && this.mode === 'laps' &&
        this.racing.some(q => q.lapCount < this.targetLaps)) {
      this.state = 'running';           // undoing the winning lap resumes the race
      this.finishedAt = null;
    }
    this._log(`${p.name} lap ${removed.n} removed (${removed.time.toFixed(2)}s)`);
    this.onChange();
    return { ok: true, message: `removed lap ${removed.n}` };
  }

  /** The most recent lap across everyone, for a one-tap undo. */
  lastLapSlot() {
    let best = null;
    for (const p of this.racing) {
      const l = p.laps[p.laps.length - 1];
      if (l && (!best || l.at > best.at)) best = { at: l.at, slot: p.slot };
    }
    return best ? best.slot : null;
  }

  _checkFinish(p, n) {
    if (this.mode === 'laps') {
      if (n === this.targetLaps - 1 && !this._announcedLastLap.has(p.slot)) {
        this._announcedLastLap.add(p.slot);
        this.onCallout(this.solo ? 'Last lap' : `${p.name}, last lap`);
      }
      if (n >= this.targetLaps) {
        const done = this.racing.filter(q => q.lapCount >= this.targetLaps);
        if (done.length === 1 && !this.solo) {
          this.onCallout(`${p.name} wins!`, { priority: true });
          this._log(`${p.name} wins`);
        }
        if (this.racing.every(q => q.lapCount >= this.targetLaps)) this.stop();
      }
    } else if (this.mode === 'consecutive') {
      const c = p.bestConsecutive(this.consecN);
      if (c !== null && n >= this.consecN) {
        const leader = this.standings()[0];
        if (leader === p && n === this.consecN && !this.solo) {
          this.onCallout(`${p.name} leads, ${c.toFixed(1)}`);
        }
      }
    }
  }

  _calloutText(pilot, n, lapTime, isPb) {
    const secs = lapTime.toFixed(1).replace(/\.0$/, '');
    let s = this.solo ? `lap ${n}, ${secs}` : `${pilot.name}, lap ${n}, ${secs}`;
    if (isPb) s += ', personal best';
    return s[0].toUpperCase() + s.slice(1);
  }

  _log(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 120) this.log = this.log.slice(-120);
  }

  /* ---- results ---- */
  results() {
    const order = this.standings();
    return {
      name: this.name || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      at: Date.now() / 1000,
      mode: this.mode,
      targetLaps: this.targetLaps,
      targetSeconds: this.targetSeconds,
      consecN: this.consecN,
      duration: Math.round(this.elapsed * 100) / 100,
      results: order.map((p, i) => ({
        pos: i + 1, slot: p.slot, name: p.name, channel: p.channel,
        laps: p.lapCount, best: p.best, consec: p.bestConsecutive(this.consecN),
        total: round3(p.total), lapTimes: p.laps.map(l => l.time),
      })),
    };
  }

  /** A plain snapshot, for rendering and for spectator screens. */
  snapshot() {
    return {
      state: this.state, mode: this.mode, name: this.name,
      targetLaps: this.targetLaps, targetSeconds: this.targetSeconds,
      consecN: this.consecN, minLap: this.minLap, holeshot: this.holeshot,
      elapsed: Math.round(this.elapsed * 100) / 100,
      remaining: this.remaining,
      countdown: this.countdownLeft,
      solo: this.solo,
      pilots: [...this.pilots.values()].map(p => ({
        slot: p.slot, name: p.name, channel: p.channel, enabled: p.enabled,
        color: p.color, laps: p.laps, lapCount: p.lapCount, best: p.best,
        last: p.last, total: round3(p.total), consec: p.bestConsecutive(this.consecN),
      })),
      standings: this.standings().map(p => p.slot),
      log: this.log.slice(-30),
    };
  }

  /** Plain-English description of the format, for the UI to show verbatim. */
  formatLine() {
    const bits = [];
    if (this.mode === 'practice') bits.push('Open practice');
    else if (this.mode === 'laps') bits.push(`First to ${this.targetLaps} laps`);
    else if (this.mode === 'time') bits.push(`${fmtDuration(this.targetSeconds)} race`);
    else bits.push(`Best ${this.consecN} consecutive`);
    bits.push(`min lap ${this.minLap.toFixed(1)}s`);
    if (this.holeshot) bits.push('holeshot start');
    return bits.join(' · ');
  }
}

export function fmtDuration(s) {
  s = Math.round(s);
  if (s % 60 === 0) return `${s / 60} min`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
