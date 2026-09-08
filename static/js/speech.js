/* Spoken callouts.
 *
 * Uses the browser's own voices, so nothing is downloaded and it works at a
 * track with no internet — except on Linux, where browsers route the Web Speech
 * API through speech-dispatcher and, without it, speechSynthesis fails
 * *silently*. A silent failure in the one feature a solo pilot is relying on is
 * worse than no feature, so `available` is surfaced in the UI as a real state.
 */
'use strict';

export class Voice {
  constructor(prefs) {
    this.prefs = prefs;
    this.voices = [];
    this.available = false;
    this.armed = false;
    this.spoken = false;
    this.onChange = () => {};
    this._reload();
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener?.('voiceschanged', () => this._reload());
    }
  }

  _reload() {
    try { this.voices = speechSynthesis.getVoices() || []; } catch (e) { this.voices = []; }
    const was = this.available;
    this.available = this.voices.length > 0;
    if (was !== this.available) this.onChange();
  }

  /* A track has no internet. Chrome's default English voices are network
   * voices that simply say nothing offline, so a voice that lives on the
   * device wins over a nicer one that does not. */
  _rank(v) {
    return (v.localService ? 0 : 2) + (/en[-_]?(GB|AU|US|NZ)/i.test(v.lang) ? 0 : 1);
  }

  get voice() {
    const named = this.voices.find(v => v.name === this.prefs.voiceName);
    if (named) return named;
    /* Memoised: a Linux browser wired to speech-dispatcher offers close to
     * fifteen thousand voices, and this used to be re-sorted for every single
     * callout — during a race, on the lap that just finished. */
    const key = this.voices.length + '|' + (this.prefs.voiceName || '');
    if (this._bestKey !== key) {
      this._bestKey = key;
      const en = this.voices.filter(v => /^en/i.test(v.lang));
      this._best = en.sort((a, b) => this._rank(a) - this._rank(b))[0] || this.voices[0] || null;
    }
    return this._best;
  }

  /**
   * The voices worth putting in a picker.
   *
   * speech-dispatcher hands a Linux browser every language espeak-ng can
   * synthesise crossed with every variant — 14,805 of them on a stock Arch box.
   * One <option> each is a sheet that takes seconds to open and cannot be
   * scrolled on a phone. English first, because the callouts are English, and
   * whatever is selected now is always in the list even if it is neither.
   */
  pickable(limit = 60) {
    const en = this.voices.filter(v => /^en/i.test(v.lang));
    const pool = (en.length ? en : this.voices).slice()
      .sort((a, b) => this._rank(a) - this._rank(b) || a.name.localeCompare(b.name));
    const out = pool.slice(0, limit);
    const cur = this.voice;
    if (cur && !out.includes(cur)) out.unshift(cur);
    return out;
  }

  /* Browsers refuse to speak before a gesture, so the first tap primes it.
   * Without this the very first callout of a session is swallowed.
   * Deliberately does not notify: nothing on screen reads `armed`, and a
   * re-render triggered from a pointerdown detaches the element being pressed,
   * which swallows the tap that triggered it. */
  arm(explicit = false) {
    if (this.armed && !explicit) return;
    this.armed = true;
    if (explicit) this.say('Voice ready', { force: true });
  }

  say(text, { priority = false, force = false } = {}) {
    if (!force && (!this.prefs.voiceOn || this.prefs.announce === 'off')) return;
    try {
      if (priority) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voice;
      if (v) u.voice = v;
      u.rate = Number(this.prefs.rate) || 1.1;
      u.onstart = () => { if (!this.spoken) { this.spoken = true; this.onChange(); } };
      u.onerror = e => {
        /* A network voice with no network fails here, not at getVoices(). */
        if (e.error === 'network' || e.error === 'synthesis-failed' || e.error === 'synthesis-unavailable') {
          this.lastError = e.error;
          this.onChange();
        }
      };
      speechSynthesis.speak(u);
    } catch (e) { this.available = false; this.onChange(); }
  }

  cancel() { try { speechSynthesis.cancel(); } catch (e) {} }

  /** Shorten a callout to the style the pilot picked. */
  phrase(text, { lapTime } = {}) {
    if (this.prefs.announce === 'time' && lapTime != null) {
      return lapTime.toFixed(1).replace(/\.0$/, '');
    }
    return text;
  }
}

/**
 * A short tone the instant the timer says a quad crossed the gate.
 *
 * The point is verification, not decoration: stand at the gate, fly through it,
 * and if the beep lands with the quad rather than after it, the lap times can
 * be trusted. That only works if the sound is immediate, which is why this is
 * an oscillator and not the announcer — speech is synthesised and queued, and a
 * callout that arrives a beat late says nothing about when the pass happened.
 *
 * One pitch per slot, a major chord across the four, so a four-up race is still
 * legible by ear when two quads cross together.
 */
const SLOT_PITCH = [880, 1046.5, 1318.5, 1568];      // A5 C6 E6 G6

export class Beeper {
  constructor(prefs) {
    this.prefs = prefs;
    this.ctx = null;
  }

  /** Browsers refuse audio before a gesture; the first tap builds the context.
   *  Cheap and idempotent, so it can hang off anything the pilot touches. */
  arm() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
  }

  get available() { return !!this.ctx; }

  ping(slot = 1, { force = false } = {}) {
    if (!force && !this.prefs.gateBeep) return;
    this.arm();
    if (!this.ctx) return;
    try {
      const t = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = SLOT_PITCH[(slot - 1) % SLOT_PITCH.length];
      /* Ramped rather than switched: a square wave started and stopped at full
       * amplitude clicks, and a click is exactly as loud as the beep. */
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.28, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 0.09);
    } catch (e) { /* a beep is never worth an exception */ }
  }
}

/** Keep the screen on during a session — a phone locking mid-race is a lost race. */
export class Wake {
  constructor() { this.lock = null; }
  async request() {
    if (!('wakeLock' in navigator)) return false;
    try { this.lock = await navigator.wakeLock.request('screen'); return true; }
    catch (e) { return false; }
  }
  release() { try { this.lock?.release(); } catch (e) {} this.lock = null; }
}
