/* WhoopTimer — application controller.
 *
 * The browser owns everything: the radio link, the race, the config written to
 * the timer, the saved history. That is what lets this be a page you open
 * rather than software you install, and it is why the connect screen is the
 * front door rather than a settings panel.
 *
 * Design rule for the whole UI: there is exactly one next thing to do at any
 * moment, and the app says what it is. See `coach()`.
 */
'use strict';
import * as laprf from './laprf.js';
import * as store from './store.js';
import * as tuning from './tuning.js';
import { Race } from './race.js';
import { BleLink, SerialLink, BridgeLink, DemoLink, capabilities, probeBridge } from './link.js';
import { Voice, Wake } from './speech.js';
import { toast, mount, closeSheet, sheetOpen } from './ui.js';
import { SCREENS } from './screens.js';

export const SLOTS = [1, 2, 3, 4];

class App {
  constructor() {
    this.caps = capabilities();
    this.settings = store.settings();
    this.prefs = store.prefs();
    this.voice = new Voice(this.prefs);
    this.wake = new Wake();

    this.link = null;
    this.linkKind = null;
    this.connecting = null;         // label shown while a connect is in flight
    this.connectError = null;
    this.bridge = null;             // probe result for a local WhoopTimer

    this.timer = { battery: null, lastRx: 0, rfSetup: {} };
    this.rf = store.load('rf', {}); // slot -> {gain, threshold, floor, ceiling}
    this.sig = new tuning.SignalBank(SLOTS);
    this.cal = new tuning.Calibration();
    this.cal.preset = this.settings.preset;

    this.mode = store.load('mode', null);       // 'solo' | 'race' | null
    this.screen = 'connect';
    this.view = null;
    this.lastLap = null;            // {slot, n, time, isPb, at} for the hero flash
    this.sessionBest = null;
    this._writeTimer = null;
    this._dirty = new Set();

    /* No onChange hook: every screen re-reads race state each animation frame in
     * its own update(), so a lap never needs to rebuild the DOM. Structural
     * rebuilds happen only where the shape of the screen really changes —
     * start, stop, reset, pilot edits, settings. */
    this.race = new Race({
      onCallout: (text, opts) => this.callout(text, opts),
      onFinish: results => this.finishRace(results),
      onLap: lap => this.onLap(lap),
    });
    this.race.configure(this.settings);
    this.restorePilots();
    this.voice.onChange = () => this.markStructural();
  }

  /* ------------------------------------------------------------- lifecycle -- */
  async boot() {
    document.documentElement.dataset.theme = this.prefs.theme;
    this.render();
    this.loop();
    addEventListener('keydown', e => this.onKey(e));
    /* A rebuild between pointerdown and pointerup detaches the element being
     * pressed, and the browser then never fires the click. Hold rebuilds until
     * the finger comes off — a lap landing mid-tap must not eat the tap. */
    addEventListener('pointerdown', () => { this._pointerDown = true; this.voice.arm(); }, true);
    for (const ev of ['pointerup', 'pointercancel']) {
      addEventListener(ev, () => {
        this._pointerDown = false;
        if (this._deferredRender) this._flushRender();
      }, true);
    }
    /* Only a change of breakpoint matters — labels and layout branch on it. A
     * phone's address bar sliding away fires resize constantly, and rebuilding
     * on that would throw away scroll position mid-scroll. */
    let wasNarrow = innerWidth < 560;
    addEventListener('resize', () => {
      const narrow = innerWidth < 560;
      if (narrow === wasNarrow) return;
      wasNarrow = narrow;
      this.markStructural();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.race.state === 'running') this.wake.request();
    });

    /* Silently re-attach to a timer this browser already has permission for, so
     * a returning pilot lands on the flying screen and not on a chooser. */
    probeBridge().then(b => { if (b?.available) { this.bridge = b; this.markStructural(); } });
    for (const kind of ['bluetooth', 'usb']) {
      if (kind === 'bluetooth' && !this.caps.bluetooth) continue;
      if (kind === 'usb' && !this.caps.serial) continue;
      const link = this.makeLink(kind);
      let ok = false;
      try { ok = await link.reconnectKnown(); } catch (e) { ok = false; }
      if (ok) { this.adoptLink(link, kind); return; }
    }
  }

  loop() {
    const step = () => {
      this.race.tick();
      if (this.link?.kind === 'demo') {
        this.link.syncFlying(this.race.state === 'running' ? this.race.racing.map(p => p.slot) : []);
      }
      this.view?.update?.(this);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ link -- */
  async connect(kind, opts = {}) {
    if (this.connecting) return;
    this.connectingKind = kind;
    this.connecting = { bluetooth: 'Looking for your timer…', usb: 'Opening the USB port…',
                        bridge: 'Talking to WhoopTimer on this machine…',
                        demo: 'Starting the demo timer…' }[kind] || 'Connecting…';
    this.connectError = null;
    this.render();
    const link = this.makeLink(kind);
    try {
      await link.connect(opts);
      this.connecting = null;
      this.adoptLink(link, kind);
    } catch (err) {
      this.connecting = null;
      this.connectError = describeConnectError(err, kind);
      this.render();
    }
  }

  /**
   * Build a link with its handlers already attached.
   *
   * Wiring has to happen before connect(), not after: a link says hello as soon
   * as it opens, and the timer's reply — which carries the thresholds and
   * frequencies every other screen reasons about — lands in the gap if nobody
   * is listening yet.
   */
  makeLink(kind) {
    const link = kind === 'bluetooth' ? new BleLink()
               : kind === 'usb' ? new SerialLink()
               : kind === 'bridge' ? new BridgeLink()
               : new DemoLink();
    link.on('record', rec => this.onRecord(rec));
    link.on('state', () => this.markStructural());
    link.on('lost', () => this.onLinkLost());
    link.on('log', msg => console.debug('[link]', msg));
    return link;
  }

  adoptLink(link, kind) {
    this.link = link;
    this.linkKind = kind;
    this.connectError = null;
    /* Nothing is written to the timer just because we connected. The link's
     * hello() asks it to describe itself; adoptRfSetup() then corrects only the
     * slots where our saved intent actually differs. Writing on connect is how
     * an app clobbers real race frequencies with its own defaults. */
    if (!this.mode) this.screen = 'choose';
    else this.screen = this.mode === 'solo' ? 'fly' : 'race';
    this.render();
  }

  onLinkLost() {
    toast(this.linkKind === 'bluetooth'
      ? 'Timer disconnected. Power-cycle it, then reconnect.'
      : 'Timer disconnected.', 'err', 8000);
    this.markStructural();
  }

  async disconnect() {
    try { await this.link?.disconnect(); } catch (e) {}
    this.link = null; this.linkKind = null;
    this.screen = 'connect';
    this.render();
  }

  get connected() { return !!this.link?.connected; }
  get canControl() { return !!this.link?.canControl; }

  /* ------------------------------------------------------- inbound records -- */
  onRecord(rec) {
    this.timer.lastRx = Date.now();
    switch (rec.type) {
      case 'passing':
        if (rec.slot) this.race.onPassing(rec.slot);
        break;
      case 'status':
        if (rec.batteryVoltage) {
          this.timer.battery = rec.batteryVoltage > 100 ? rec.batteryVoltage / 1000 : rec.batteryVoltage;
        }
        this.ingestSlots(rec.slots);
        break;
      case 'rssi':
        this.ingestSlots(rec.slots, true);
        break;
      case 'rfSetup':
        if (rec.slot) this.adoptRfSetup(rec);
        break;
    }
  }

  ingestSlots(slots, mean = false) {
    for (const [k, v] of Object.entries(slots || {})) {
      const slot = Number(k);
      const val = mean ? (v.meanRssi ?? v.maxRssi) : v.lastRssi;
      if (val == null) continue;
      this.sig.add(slot, val);
      this.cal.feed(slot, val);
    }
    /* Software fallback detection, for a unit whose gate never fires. */
    if (this.sig.autoDetect) for (const s of this.sig.checkAll()) this.race.onPassing(s);
  }

  /** Mirror what the hardware says about itself; never invent a default. */
  adoptRfSetup(rec) {
    const slot = rec.slot;
    this.timer.rfSetup[slot] = {
      band: rec.band, channel: rec.channel, frequency: rec.frequency,
      gain: rec.gain, threshold: rec.threshold, enabled: !!rec.enabled,
    };
    const cur = (this.rf[slot] ||= {});
    if (cur.gain == null) cur.gain = rec.gain ?? 58;
    if (cur.threshold == null) cur.threshold = rec.threshold ?? 1600;
    store.save('rf', this.rf);

    /* Adopt the timer's actual frequency into the pilot, but only when we have
     * never been told otherwise — the app must not push a default channel over
     * a real race frequency. */
    const saved = store.load('pilots', {});
    const p = this.race.pilots.get(slot);
    if (!p || !rec.frequency) return;
    const mine = laprf.channelByName(p.channel).frequency;

    if (!saved[slot]) {
      /* Never configured here: take the hardware's word for it. Several
       * band/channel pairs share a frequency (R7 and F8 are both 5880), so only
       * adopt when the frequency genuinely differs — otherwise the pilot's
       * channel gets silently renamed to a synonym they never chose. */
      const match = laprf.channelsByFreq(rec.frequency)[0];
      if (mine !== rec.frequency && match) {
        this.race.setPilot(slot, { channel: match.name });
        this.savePilots();
      }
      return;
    }
    /* Configured here before: our saved intent wins — but only now that the
     * timer has said what it is actually holding, and only for the slots that
     * really differ. */
    if (mine !== rec.frequency || !!rec.enabled !== p.enabled) this.pushConfig([slot]);
  }

  /* ------------------------------------------------------ outbound config -- */
  rfFor(slot) { return this.rf[slot] || {}; }

  /** Queue slots for a config write. Coalesced so a slider does not flood the link.
   *  `now` writes in this tick, not on a timer — the caller may be about to move
   *  the race into a state where writes are refused. */
  pushConfig(slots = SLOTS, { now = false } = {}) {
    for (const s of slots) this._dirty.add(s);
    clearTimeout(this._writeTimer);
    if (now) this.flushConfig();
    else this._writeTimer = setTimeout(() => this.flushConfig(), 260);
  }

  flushConfig() {
    if (!this.canControl || !this._dirty.size) return;
    if (this.race.state === 'running' || this.race.state === 'staging') return;
    for (const slot of this._dirty) {
      const p = this.race.pilots.get(slot);
      if (!p) continue;
      const { band, channel, frequency } = laprf.channelByName(p.channel);
      const cfg = this.rfFor(slot);
      const hw = this.timer.rfSetup[slot] || {};
      /* Fall back to what the timer reported before falling back to a constant:
       * a made-up threshold written over a working one is how a timer stops
       * reporting laps for reasons nobody can see. */
      this.link.send(laprf.setRfSetup({
        slot, band, channel, frequency,
        threshold: Number(cfg.threshold ?? hw.threshold ?? 1600),
        gain: Number(cfg.gain ?? hw.gain ?? 58),
        enabled: !!p.enabled }));
    }
    this._dirty.clear();
    this.link.send(laprf.setMinLapTime(Number(this.settings.timerMinLapMs) || 0));
    this.link.send(laprf.getRfSetup());
  }

  /* ------------------------------------------------------------- persistence -- */
  savePilots() {
    store.save('pilots', Object.fromEntries([...this.race.pilots.values()].map(p =>
      [p.slot, { name: p.name, channel: p.channel, enabled: p.enabled, colour: p.color }])));
  }

  restorePilots() {
    const saved = store.load('pilots', {});
    for (const [k, v] of Object.entries(saved)) {
      const slot = Number(k);
      if (this.race.pilots.has(slot)) this.race.setPilot(slot, v);
    }
  }

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    store.save('settings', this.settings);
    this.race.configure(this.settings);
    this.cal.preset = this.settings.preset;
    this.markStructural();
  }

  savePrefs(patch) {
    Object.assign(this.prefs, patch);
    store.save('prefs', this.prefs);
    document.documentElement.dataset.theme = this.prefs.theme;
    this.markStructural();
  }

  saveRf(slot, patch) {
    Object.assign((this.rf[slot] ||= {}), patch);
    store.save('rf', this.rf);
  }

  /* ------------------------------------------------------------------ race -- */
  setPilot(slot, patch) {
    this.race.setPilot(slot, patch);
    this.savePilots();
    if (patch.channel != null || patch.enabled != null) this.pushConfig([slot]);
    this.markStructural();
  }

  /** Solo flying is one pilot on slot 1; the others are switched off on the
   *  timer so their receivers cannot contribute phantom laps. */
  useMode(mode) {
    this.mode = mode;
    store.save('mode', mode);
    if (mode === 'solo') {
      for (const s of SLOTS) this.race.setPilot(s, { enabled: s === 1 });
      if (this.settings.mode !== 'practice') this.saveSettings({ mode: 'practice' });
      this.savePilots();
      this.pushConfig(SLOTS);
    } else if (this.settings.mode === 'practice') {
      /* "Run a race" implies a race: open practice is the solo default, and
       * landing in a format with no finish line is not what was asked for. */
      this.saveSettings({ mode: 'laps' });
    }
    this.screen = mode === 'solo' ? 'fly' : 'race';
    this.render();
  }

  start() {
    this.voice.arm();
    this.sessionBest = null;
    this.lastLap = null;
    if (this.prefs.keepAwake) this.wake.request();
    /* Put the timer into the state this race assumes before the clock starts —
     * channels, enables and the timer's own minimum lap. Config writes are
     * refused once staging begins, so this has to happen now. */
    this.pushConfig(SLOTS, { now: true });
    if (this.settings.countdown > 0) this.race.arm(); else this.race.startNow();
    this.render();
  }

  stop() {
    this.race.stop();
    this.wake.release();
    this.flushConfig();          // anything edited mid-race was held back
    this.render();
  }

  resetRace() {
    this.race.reset();
    this.lastLap = null;
    this.sessionBest = null;
    this.flushConfig();
    this.render();
  }

  undoLast() {
    const slot = this.race.lastLapSlot();
    if (slot == null) { toast('No lap to undo'); return; }
    const r = this.race.undoLap(slot);
    toast(r.message, r.ok ? 'ok' : 'err');
    this.recomputeSessionBest();
    this.lastLap = null;
    this.render();
  }

  manualLap(slot) {
    if (this.race.state !== 'running') { toast('Start the session first'); return; }
    if (this.race.onPassing(slot)) toast(`Manual lap for slot ${slot}`, 'ok');
    else toast('Ignored — inside the minimum lap time');
  }

  onLap({ pilot, n, time, isPb }) {
    this.lastLap = { slot: pilot.slot, n, time, isPb, at: performance.now() };
    /* A recorded lap is proof the channel is right, so the app stops asking. */
    if (!store.load('channelPicked', false)) store.save('channelPicked', true);
    if (this.sessionBest == null || time < this.sessionBest) this.sessionBest = time;
  }

  recomputeSessionBest() {
    let best = null;
    for (const p of this.race.racing) if (p.best != null && (best == null || p.best < best)) best = p.best;
    this.sessionBest = best;
  }

  callout(text, { priority = false, lapTime = null } = {}) {
    this.voice.say(this.voice.phrase(text, { lapTime }), { priority });
    this.calloutText = text;
    this.calloutAt = performance.now();
  }

  finishRace(results) {
    store.appendHistory(results);
    this.wake.release();
    this.render();
    if (!this.race.solo || results.results[0]?.laps) this.showResults(results);
  }

  showResults(results) {
    SCREENS.results(this, results);
  }

  /* --------------------------------------------------------------- guidance -- */
  /**
   * The single next action, in words, at every moment. This is the whole
   * "no manual" strategy: if the app can always say what to do next, nobody
   * has to be told in advance.
   */
  coach() {
    if (!this.connected) {
      return { tone: 'bad', text: 'Timer not connected.',
               action: { label: 'Connect', fn: () => { this.screen = 'connect'; this.render(); } } };
    }
    if (this.link.mode === 'ascii') {
      return { tone: 'warn',
               text: 'This unit’s USB port is a read-only console — it reports signal but never a lap. ' +
                     'Connect over Bluetooth to time laps.',
               action: this.caps.bluetooth
                 ? { label: 'Bluetooth', fn: () => this.connect('bluetooth') } : null };
    }
    const fatal = this.race.racing.filter(p => this.health(p.slot).fatal);
    if (fatal.length) {
      const who = fatal.length === 1 ? fatal[0].name : `${fatal.length} receivers`;
      return { tone: 'bad', text: `${who} can never detect a lap — the trigger level is below the noise.`,
               action: { label: 'Fix the gate', fn: () => { this.screen = 'gate'; this.render(); } } };
    }
    if (this.race.state === 'idle') {
      if (this.mode === 'solo' && !store.load('channelPicked', false)) {
        return { tone: 'warn', text: 'Set the channel your quad transmits video on.',
                 action: { label: 'Find it for me', fn: () => SCREENS.findChannel(this, 1) } };
      }
      const untuned = this.race.racing.filter(p => this.health(p.slot).level === 'untuned');
      if (untuned.length && untuned.length === this.race.racing.length) {
        return { tone: 'warn',
                 text: 'Gates have never been tuned for this track. Two minutes now saves missed laps.',
                 action: { label: 'Tune', fn: () => { this.screen = 'gate'; this.render(); } } };
      }
    }
    switch (this.race.state) {
      case 'staging':
        return { tone: 'warn', text: 'Get on the line — the clock starts at zero.' };
      case 'running':
        return { tone: 'ok', text: this.race.solo
          ? 'Fly through the gate. Every crossing is a lap.'
          : 'Racing. Tap a pilot to add a lap by hand if a receiver misses one.' };
      case 'finished':
        return { tone: 'ok', text: 'Session saved. Go again, or look at the results.',
                 action: { label: 'Go again', fn: () => { this.resetRace(); this.start(); } } };
      default:
        return { tone: 'ok', text: this.race.solo
          ? 'Ready. Tap Start, then fly through the gate.'
          : `Ready — ${this.race.racing.length} pilots. Arm the race when everyone is on the line.` };
    }
  }

  /** Gate verdict for a slot, combining saved bounds with what the timer reports. */
  health(slot) {
    const cfg = this.rfFor(slot);
    const hw = this.timer.rfSetup[slot] || {};
    const p = this.race.pilots.get(slot);
    const sig = this.sig.slots.get(slot);
    return tuning.gateHealth({
      threshold: cfg.threshold ?? hw.threshold ?? null,
      floor: cfg.floor ?? null,
      ceiling: cfg.ceiling ?? null,
      live: this.sig.live(slot) ? sig?.value : null,
      enabled: p ? p.enabled : true,
    });
  }

  /* --------------------------------------------------------------- rendering -- */
  markStructural() {
    if (this._pending) return;
    this._pending = true;
    queueMicrotask(() => this._flushRender());
  }

  _flushRender() {
    if (this._pointerDown) { this._deferredRender = true; return; }
    this._pending = false;
    this._deferredRender = false;
    this.render();
  }

  render() {
    const build = SCREENS[this.connected ? this.screen : 'connect'] || SCREENS.connect;
    this.view = build(this);
    mount(document.getElementById('main'), this.view.node);
    mount(document.getElementById('topbar'), SCREENS.topbar(this));
  }

  go(screen) { this.screen = screen; closeSheet(); this.render(); }

  /* --------------------------------------------------------------- keyboard -- */
  onKey(e) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k >= '1' && k <= '4') { this.manualLap(Number(k)); e.preventDefault(); return; }
    if (k === ' ') {
      e.preventDefault();
      if (this.race.state === 'running' || this.race.state === 'staging') this.stop();
      else this.start();
      return;
    }
    if (k.toLowerCase() === 'u') { this.undoLast(); e.preventDefault(); }
    if (k.toLowerCase() === 'g') this.go('gate');
    if (k.toLowerCase() === 'h') this.go('history');
    if (k === 'Escape' && !sheetOpen() && this.screen !== 'fly' && this.screen !== 'race') {
      this.go(this.mode === 'solo' ? 'fly' : 'race');
    }
  }
}

/** Turn a browser exception into something a pilot at a track can act on. */
function describeConnectError(err, kind) {
  const name = err?.name || '';
  const msg = String(err?.message || err);
  if (name === 'NotFoundError' && /cancell?ed|chooser/i.test(msg)) {
    return { title: 'No timer picked', body: 'The chooser closed without a selection. Try again — ' +
             'if the list was empty, the timer may be off or past its advertising window.' };
  }
  if (name === 'NotFoundError') {
    return { title: 'No timer found', body: kind === 'bluetooth'
      ? 'Nothing matching a LapRF was advertising. Power-cycle the timer and try again — it only ' +
        'advertises for about a minute after switch-on. If it still does not appear, use “show all ' +
        'Bluetooth devices”.'
      : 'No serial port was selected.' };
  }
  if (name === 'SecurityError') {
    return { title: 'Blocked by the browser', body: 'Bluetooth needs a secure page and a real tap. ' +
             'Reload over https and press the button directly.' };
  }
  if (name === 'NetworkError') {
    return { title: 'Connection dropped', body: 'The timer stopped responding mid-connect. ' +
             'Power-cycle it and try again.' };
  }
  if (name === 'InvalidStateError' || /already open/i.test(msg)) {
    return { title: 'Port already in use', body: 'Another tab or app is holding this device. ' +
             'Close it and try again.' };
  }
  return { title: 'Could not connect', body: msg };
}

const app = new App();
window.wt = app;                    // a console handle for debugging at a track
app.boot();
export default app;
