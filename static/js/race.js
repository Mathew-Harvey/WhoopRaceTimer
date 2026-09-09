/* Race state machine: pilots, laps, formats, callouts.
 *
 * Runs in the browser so the app needs no server.
 *
 * Lap timing rule: whoops normally launch from behind the gate, so the FIRST
 * gate crossing after the start ends lap 1 — it is not a separate holeshot. Set
 * holeshot if you launch on the far side and want the first crossing to only
 * start the clock.
 *
 * A minimum lap time is enforced here regardless of the timer's own setting,
 * because a whoop hovering in the gate will otherwise register a burst of
 * passes. It applies to the first crossing too: a quad lifting off a metre
 * behind the gate can trip the receiver as it rises, and a 0.4 s "lap 1" that
 * then stands as the session's best all night is worse than a missed first lap.
 *
 * Lap times prefer the timer's own clock. Each passing record carries the
 * timer's millisecond timestamp; the browser only sees when the notification
 * *arrived*, which over Bluetooth or a wifi bridge can lag by tens of
 * milliseconds and can bunch two crossings into one delivery. The timer's
 * clock decides lap lengths and who crossed first; browser time is only the
 * reference for the very first crossing after the start.
 */
'use strict';

export const COLORS = ['#00d1e0', '#4d7cff', '#ff4fb8', '#c9f036'];
export const MODES = ['practice', 'laps', 'time', 'consecutive'];
export const DEFAULT_CHANNELS = ['R1', 'R3', 'R6', 'R7'];

const now = () => performance.now() / 1000;
const round3 = v => Math.round(v * 1000) / 1000;
/* A timer-clock lap that disagrees with wall-clock by more than this is a
 * clock reset (power-cycle mid-race), not a better measurement. */
const RTC_TRUST_S = 2.0;

export class Pilot {
  constructor(slot, { name = '', channel = 'R1', enabled = true, colour = null } = {}) {
    this.slot = slot;
    this.name = name || `Pilot ${slot}`;
    this.channel = channel;
    this.enabled = enabled;
    this.color = colour || COLORS[(slot - 1) % COLORS.length];
    this.reset();
  }

  reset() {
    this.laps = [];
    this.lastPass = null;     // browser time of the last counted crossing (or the away crossing)
    this.lastRtc = null;      // timer clock (ms) at that crossing, when known
    this.started = false;
    this.awayAt = null;       // holeshot: browser time of the crossing that started the clock
    this.awayRtc = null;
    this.doneAt = null;       // laps mode: when the target lap was crossed
  }

  get lapCount() { return this.laps.length; }
  get best() { return this.laps.length ? Math.min(...this.laps.map(l => l.time)) : null; }
  get last() { return this.laps.length ? this.laps[this.laps.length - 1].time : null; }
  get total() { return this.laps.reduce((a, l) => a + l.time, 0); }
  /** Browser time of the most recent counted lap; Infinity when there is none. */
  get lastAt() { return this.laps.length ? this.laps[this.laps.length - 1].at : Infinity; }

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

let runCounter = 0;

export class Race {
  constructor(opts = {}) {
    this.pilots = new Map();
    for (let i = 1; i <= 4; i++) this.pilots.set(i, new Pilot(i, { channel: DEFAULT_CHANNELS[i - 1] }));
    this.state = 'idle';              // idle | staging | running | finished
    this.mode = 'practice';
    this.targetLaps = 5;
    this.targetSeconds = 120;
    this.consecN = 3;
    this.minLap = 1.0;      // see DEFAULT_SETTINGS.minLap
    this.holeshot = false;
    this.countdown = 5;
    this.startedAt = null;
    this.finishedAt = null;
    this.finishedBy = null;           // 'auto' (format reached its end) | 'manual' (Stop)
    this.stagingUntil = null;
    this.name = '';
    this.runId = null;                // identifies one race across a finish/undo/refinish
    this.log = [];
    this._announcedLastLap = new Set();
    this._leader = null;
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

  /** A session is in progress: config that changes what the timer is doing
   *  must wait. */
  get active() { return this.state === 'running' || this.state === 'staging'; }

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
    this._leader = null;
    this.finishedAt = null;
    this.finishedBy = null;
    this.startedAt = null;
    this.runId = `${Math.floor(Date.now() / 1000)}-${++runCounter}`;
  }

  /** `at` is the moment the clock should read zero. A countdown that ends
   *  while the tab is throttled is noticed late; the race still started when
   *  the count reached zero, not when the browser got round to looking. */
  _begin(at) {
    this.state = 'running';
    this.startedAt = at ?? now();
    this.stagingUntil = null;
    this.onCallout('Go!', { priority: true });
    this._log('Race started');
    this.onChange();
  }

  /**
   * End the race. `by: 'auto'` means the format reached its own end (every
   * pilot done, or time up); anything else is the director pressing Stop.
   * The distinction matters for undo: a race that ended itself can resume
   * when the finishing lap is taken back; a race someone stopped stays stopped.
   */
  stop({ at = null, by = 'manual' } = {}) {
    const wasRunning = this.state === 'running';
    if (wasRunning) {
      this.finishedAt = at ?? now();
      this.finishedBy = by;
    }
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

  /** Time-limit reached. The end is stamped at exactly the limit, however late
   *  the tick that noticed it — a backgrounded tab must not stretch a race. */
  _timeUp() {
    this.stop({ at: this.startedAt + this.targetSeconds, by: 'auto' });
  }

  tick() {
    if (this.state === 'staging' && this.stagingUntil) {
      if (this.stagingUntil - now() <= 0) this._begin(this.stagingUntil);
      return;
    }
    if (this.state === 'running' && this.mode === 'time' && this.elapsed >= this.targetSeconds) {
      this._timeUp();
    }
  }

  /* ---- standings ---- */
  /**
   * Race order. Most laps first; among equal lap counts, whoever reached that
   * count first. That is what "who is winning" means at a gate — and it is
   * the only ordering that agrees with the winner the room was told about.
   * (Summing lap times looked equivalent but is not: with a holeshot start
   * the run-up to the first crossing is excluded, so a pilot who crossed the
   * line second could still show the smaller sum.)
   */
  standings() {
    const ps = [...this.racing];
    if (this.mode === 'consecutive') {
      return ps.sort((a, b) => {
        const ca = a.bestConsecutive(this.consecN), cb = b.bestConsecutive(this.consecN);
        return (ca ?? 1e9) - (cb ?? 1e9);
      });
    }
    return ps.sort((a, b) => (b.lapCount - a.lapCount) || (a.lastAt - b.lastAt));
  }

  /* ---- the hot path ---- */
  /**
   * A gate crossing. `at` is browser time (defaults to now); `rtc` is the
   * timer's own millisecond clock from the passing record, when the transport
   * carries one. Returns true when a lap was counted.
   */
  onPassing(slot, at, rtc = null) {
    const p = this.pilots.get(slot);
    if (!p || !p.enabled) return false;
    if (this.state !== 'running') return false;
    const t = at ?? now();

    /* A time limit is a wall. A crossing after it ends the race at the limit
     * and does not count, so a backgrounded tab cannot let late laps in. */
    if (this.mode === 'time' && (t - this.startedAt) >= this.targetSeconds) {
      this._timeUp();
      return false;
    }
    /* A pilot who has finished a laps race is finished. Cool-down laps must not
     * out-rank the announced winner. */
    if (this.mode === 'laps' && p.lapCount >= this.targetLaps) return false;

    if (this.holeshot && !p.started) {
      p.started = true;
      p.lastPass = t;
      p.lastRtc = rtc;
      p.awayAt = t;
      p.awayRtc = rtc;
      this._log(`${p.name} away`);
      this.onCallout(this.solo ? 'Away' : `${p.name} away`);
      this.onChange();
      return false;
    }

    const ref = p.lastPass ?? this.startedAt;
    if ((t - ref) < this.minLap) return false;

    let lapTime = t - ref;
    if (rtc != null && p.lastRtc != null) {
      const d = (rtc - p.lastRtc) / 1000;
      if (d > 0 && Math.abs(d - lapTime) < RTC_TRUST_S) lapTime = d;
    }
    p.lastPass = t;
    p.lastRtc = rtc;
    p.started = true;
    const n = p.laps.length + 1;
    const prevBest = p.best;
    p.laps.push({ n, time: round3(lapTime), at: t, rtc });

    const isPb = n > 1 && prevBest !== null && lapTime < prevBest;
    this._log(`${p.name} lap ${n}: ${lapTime.toFixed(2)}s${isPb ? '  PB' : ''}`);
    /* onLap first: the screen should already know about the lap by the time the
     * callout is spoken, because the callout can be shortened to just the
     * number and needs that number to hand. */
    this.onLap({ pilot: p, n, time: round3(lapTime), isPb });
    this.onCallout(this._calloutText(p, n, lapTime, isPb), { lapTime: round3(lapTime) });

    this._checkFinish(p, n, t);
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
    /* Rewind the reference point so the NEXT pass times from the right place.
     * With a holeshot start, taking back lap 1 lands on the away crossing —
     * the quad is still out there, and the next crossing is a lap, not a
     * second "away". */
    const last = p.laps[p.laps.length - 1];
    p.lastPass = last ? last.at : (this.holeshot ? p.awayAt : null);
    p.lastRtc = last ? (last.rtc ?? null) : (this.holeshot ? p.awayRtc : null);
    p.started = !!last || (this.holeshot && p.awayAt != null);
    p.doneAt = null;
    this._announcedLastLap.delete(slot);
    let resumed = false;
    if (this.state === 'finished' && this.finishedBy === 'auto' && this.mode === 'laps' &&
        this.racing.some(q => q.lapCount < this.targetLaps)) {
      /* The race ended itself on this lap; without it, it is still on. A race
       * the director stopped stays stopped — Stop meant Stop. */
      this.state = 'running';
      this.finishedAt = null;
      this.finishedBy = null;
      resumed = true;
    }
    this._log(`${p.name} lap ${removed.n} removed (${removed.time.toFixed(2)}s)`);
    this.onChange();
    return { ok: true, name: p.name, n: removed.n, resumed,
             message: resumed ? `Removed ${p.name}’s lap ${removed.n} — racing again`
                              : `Removed ${p.name}’s lap ${removed.n}` };
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

  _checkFinish(p, n, t) {
    if (this.mode === 'laps') {
      if (n === this.targetLaps - 1 && !this._announcedLastLap.has(p.slot)) {
        this._announcedLastLap.add(p.slot);
        this.onCallout(this.solo ? 'Last lap' : `${p.name}, last lap`);
      }
      if (n >= this.targetLaps) {
        p.doneAt = t;
        const done = this.racing.filter(q => q.lapCount >= this.targetLaps);
        if (done.length === 1 && !this.solo) {
          this.onCallout(`${p.name} wins!`, { priority: true });
          this._log(`${p.name} wins`);
        }
        if (this.racing.every(q => q.lapCount >= this.targetLaps)) this.stop({ at: t, by: 'auto' });
      }
    } else if (this.mode === 'consecutive') {
      const leader = this.standings()[0];
      const c = leader?.bestConsecutive(this.consecN);
      if (leader && c != null && leader !== this._leader) {
        this._leader = leader;
        if (!this.solo) this.onCallout(`${leader.name} leads, ${c.toFixed(1)}`);
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
      runId: this.runId,
      name: this.name || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      at: Date.now() / 1000,
      mode: this.mode,
      targetLaps: this.targetLaps,
      targetSeconds: this.targetSeconds,
      consecN: this.consecN,
      duration: Math.round(this.elapsed * 100) / 100,
      finishedBy: this.finishedBy,
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

  /* ---- checkpoint: a race must survive a reload ----------------------------
   * Everything is kept relative to the start, and the start is stored as wall
   * clock, because performance.now() restarts with the page. */
  toCheckpoint() {
    if (!this.startedAt) return null;
    const off = t => (t == null ? null : t - this.startedAt);
    return {
      v: 1, runId: this.runId, state: this.state, mode: this.mode, name: this.name,
      targetLaps: this.targetLaps, targetSeconds: this.targetSeconds, consecN: this.consecN,
      minLap: this.minLap, holeshot: this.holeshot,
      startedAtEpoch: Date.now() / 1000 - (now() - this.startedAt),
      finishedOff: off(this.finishedAt), finishedBy: this.finishedBy,
      savedAtEpoch: Date.now() / 1000,
      announced: [...this._announcedLastLap],
      pilots: [...this.pilots.values()].map(p => ({
        slot: p.slot, started: p.started, lastRtc: p.lastRtc,
        awayOff: off(p.awayAt), awayRtc: p.awayRtc, doneOff: off(p.doneAt),
        laps: p.laps.map(l => ({ n: l.n, time: l.time, off: l.at - this.startedAt, rtc: l.rtc ?? null })),
      })),
    };
  }

  /** Rebuild a race from a checkpoint. Returns false if it cannot be trusted. */
  restore(cp) {
    if (!cp || cp.v !== 1 || !cp.startedAtEpoch || !Array.isArray(cp.pilots)) return false;
    this._clear();
    this.runId = cp.runId || this.runId;
    for (const k of ['mode', 'name', 'targetLaps', 'targetSeconds', 'consecN', 'minLap', 'holeshot']) {
      if (cp[k] != null) this[k] = cp[k];
    }
    this.startedAt = now() - (Date.now() / 1000 - cp.startedAtEpoch);
    const at = off => (off == null ? null : this.startedAt + off);
    for (const c of cp.pilots) {
      const p = this.pilots.get(c.slot);
      if (!p) continue;
      p.laps = (c.laps || []).map(l => ({ n: l.n, time: l.time, at: this.startedAt + l.off, rtc: l.rtc ?? null }));
      p.started = !!c.started; p.lastRtc = c.lastRtc ?? null;
      p.awayAt = at(c.awayOff); p.awayRtc = c.awayRtc ?? null; p.doneAt = at(c.doneOff);
      const last = p.laps[p.laps.length - 1];
      p.lastPass = last ? last.at : (this.holeshot ? p.awayAt : null);
    }
    this._announcedLastLap = new Set(cp.announced || []);
    this.state = cp.state === 'running' ? 'running' : 'finished';
    this.finishedAt = at(cp.finishedOff);
    this.finishedBy = cp.finishedBy || null;
    this._log('Race restored after a reload');
    this.onChange();
    return true;
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
