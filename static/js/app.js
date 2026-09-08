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
import { toast, mount, closeSheet, sheetOpen, confirmSheet } from './ui.js';
import { SCREENS } from './screens.js';

export const SLOTS = [1, 2, 3, 4];

/* How many times the same setup is written to one slot before the app accepts
 * that the timer is not going to take it. See flushConfig(). */
const MAX_WRITE_TRIES = 3;

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
    this.rf = store.load('rf', {}); // slot -> {gain, threshold, floor, ceiling} — measured or user-set only
    /* Slots whose channel the user has chosen here. Everything else is the
     * timer's business: the app mirrors what it reports and never writes a
     * default over it. Saving all four pilots' defaults as "intent" is exactly
     * how a club's race frequencies got overwritten on first connect. */
    this.touched = store.load('pilotsTouched', {});
    this.sig = new tuning.SignalBank(SLOTS);
    this.cal = new tuning.Calibration();
    this.cal.preset = this.settings.preset;

    this.mode = store.load('mode', null);       // 'solo' | 'race' | null
    this._attempt = 0;                          // connect attempts; a stale one may not adopt
    this.scanning = null;                       // slot under a channel sweep: its echoes are not intent
    this.screen = 'connect';
    this.view = null;
    this.lastLap = null;            // {slot, n, time, isPb, at} for the hero flash
    this.sessionBest = null;
    this._writeTimer = null;
    this._dirty = new Set();
    /* slot -> {sig, count}: what was last written there and how many times in a
     * row the same thing has been written without the timer agreeing. */
    this._writeTries = {};
    this._linkLog = [];             // last 500 link lines, for WT.log()

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

    /* A race in progress when the page went away comes back with it. Ten laps
     * into a first-to-ten is not something anyone wants to fly twice. */
    const cp = store.load('checkpoint', null);
    if (cp && cp.state === 'running' && (Date.now() / 1000 - (cp.savedAtEpoch || 0)) < 3 * 3600) {
      if (this.race.restore(cp)) {
        this.restored = true;
        this.recomputeSessionBest();
        this.screen = this.mode === 'solo' ? 'fly' : 'race';
      }
    }
  }

  /* ------------------------------------------------------------- lifecycle -- */
  async boot() {
    document.documentElement.dataset.theme = this.prefs.theme;
    this.render();
    this.loop();
    if (this.restored) {
      toast('Race restored after the reload. Power-cycle the timer and reconnect to keep timing ' +
            'from the gate; laps by hand count meanwhile.', 'ok', 10000);
    }
    /* Another tab of this app writing settings must not be overwritten by this
     * one's stale copy on its next save. */
    addEventListener('storage', e => {
      if (!e.key || !e.key.startsWith('wt.')) return;
      this.rf = store.load('rf', {});
      this.touched = store.load('pilotsTouched', {});
      Object.assign(this.settings, store.settings());
      Object.assign(this.prefs, store.prefs());
      if (!this.race.active) { this.restorePilots(); this.race.configure(this.settings); }
      this.markStructural();
    });
    addEventListener('keydown', e => this.onKey(e));
    /* A rebuild between pointerdown and pointerup detaches the element being
     * pressed, and the browser then never fires the click. Hold rebuilds until
     * the finger comes off — a lap landing mid-tap must not eat the tap. */
    addEventListener('pointerdown', () => { this._pointerDown = true; this.voice.arm(); }, true);
    for (const ev of ['pointerup', 'pointercancel']) {
      addEventListener(ev, () => {
        this._pointerDown = false;
        /* click is dispatched after pointerup within the same task, so a
         * rebuild here would still land under the finger. Defer past it. */
        if (this._deferredRender) setTimeout(() => this._flushRender(), 60);
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
      if (document.visibilityState === 'hidden') this.checkpoint();
    });
    addEventListener('pagehide', () => this.checkpoint());

    /* Silently re-attach to a timer this browser already has permission for, so
     * a returning pilot lands on the flying screen and not on a chooser. If
     * the pilot taps a connect button before this finishes, theirs wins: a
     * second link to the same timer would double every reading. */
    probeBridge().then(b => { if (b?.available) { this.bridge = b; this.markStructural(); } });
    this._autoConnect = true;
    for (const kind of ['bluetooth', 'usb']) {
      if (!this._autoConnect) break;
      if (kind === 'bluetooth' && !this.caps.bluetooth) continue;
      if (kind === 'usb' && !this.caps.serial) continue;
      const link = this.makeLink(kind);
      let ok = false;
      try { ok = await link.reconnectKnown(); } catch (e) { ok = false; }
      if (!this._autoConnect || this.link) {          // a manual connect happened meanwhile
        link.detach();
        /* If the manual link is to this same device the GATT connection is
         * shared — closing it here would drop the link the pilot just made. */
        const shared = ok && this.link?.kind === 'bluetooth' && this.link.device === link.device;
        if (ok && !shared) link.disconnect().catch(() => {});
        break;
      }
      if (ok) { this.adoptLink(link, kind); break; }
    }
    this._autoConnect = false;
  }

  loop() {
    let lastState = this.race.state;
    const step = () => {
      requestAnimationFrame(step);            // schedule first: an error below must not end the loop
      try {
        this.race.tick();
        if (this.race.state !== lastState) { lastState = this.race.state; this.checkpoint(); }
        if (this.link?.kind === 'demo') {
          this.link.syncFlying(this.race.state === 'running' ? this.race.racing.map(p => p.slot) : []);
        }
        this.view?.update?.(this);
      } catch (e) {
        console.error(e);
      }
    };
    requestAnimationFrame(step);
    /* requestAnimationFrame stops entirely while a tab is in the background,
     * so a timed race's end and the start countdown would wait for the pilot
     * to look back at the screen. A timer keeps running there, just slower. */
    setInterval(() => this.race.tick(), 250);
  }

  /* ------------------------------------------------------------------ link -- */
  async connect(kind, opts = {}) {
    if (this.connecting) return;
    this._autoConnect = false;
    this.connectingKind = kind;
    this.connecting = { bluetooth: 'Looking for your timer…', usb: 'Opening the USB port…',
                        bridge: 'Talking to WhoopTimer on this machine…',
                        demo: 'Starting the demo timer…' }[kind] || 'Connecting…';
    this.connectError = null;
    this.render();
    const attempt = ++this._attempt;
    const link = this.makeLink(kind);
    try {
      await link.connect(opts);
      if (this._attempt !== attempt) {
        /* Cancelled, or superseded by another connect while the chooser was
         * open. Whatever this attempt got hold of must not take over. */
        link.detach();
        if (link.connected) link.disconnect().catch(() => {});
        return;
      }
      this.connecting = null;
      this.adoptLink(link, kind);
    } catch (err) {
      link.detach();
      if (this._attempt !== attempt) return;
      this.connecting = null;
      this.connectError = describeConnectError(err, kind);
      /* The connect screen shows the error; anywhere else (a coach button
       * during a session) it would vanish silently. */
      if (this.link) toast(`${this.connectError.title}. ${this.connectError.body}`, 'err', 8000);
      this.render();
    }
  }

  cancelConnect() {
    this._attempt = (this._attempt || 0) + 1;
    this.connecting = null;
    this.render();
  }

  /**
   * Get the same timer back after a dropout. For Bluetooth this reuses the
   * device the browser already granted, so after a power-cycle it is one tap
   * and no chooser; anything else goes through a normal connect.
   */
  async reconnect() {
    if (this.connecting) return;
    const link = this.link, kind = this.linkKind;
    if (kind === 'bluetooth' && link?.device) {
      this.connecting = `Reconnecting to ${link.deviceName}…`;
      this.connectError = null;
      this.markStructural();
      try {
        await link.reconnect();
        this.connecting = null;
        this.markStructural();
        return;
      } catch (err) {
        this.connecting = null;
        this.connectError = describeConnectError(err, kind);
      }
    }
    if (kind === 'usb' && link?.reconnectKnown) {
      this.connecting = 'Reopening the USB port…';
      this.markStructural();
      let ok = false;
      try { ok = await link.reconnectKnown(); } catch (e) { ok = false; }
      this.connecting = null;
      if (ok) { this.markStructural(); return; }
    }
    return this.connect(kind || 'bluetooth');
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
    /* console.log, not console.debug: Chrome's DevTools hides debug messages
     * unless the level filter is set to Verbose, so the one record of what the
     * app said to the timer was invisible exactly when it was needed. Also kept
     * in a ring buffer — `copy(wt.linkLog())` hands over the lot at a track,
     * where scrolling a console on a phone is not a thing anyone will do. */
    link.on('log', msg => {
      const line = new Date().toISOString().slice(11, 23) + ' ' + msg;
      this._linkLog.push(line);
      if (this._linkLog.length > 500) this._linkLog.shift();
      console.log('[link]', msg);
    });
    return link;
  }

  adoptLink(link, kind) {
    const old = this.link;
    if (old && old !== link) {
      /* One link at a time. A demo left running under a real timer feeds fake
       * peaks into the tuning wizard; a dropped link left wired toasts about a
       * connection that is fine. The one case not to close is the same
       * Bluetooth device reached twice — that GATT connection is the new link's. */
      old.detach();
      const sameDevice = old.kind === 'bluetooth' && link.kind === 'bluetooth' && old.device === link.device;
      if (old.connected && !sameDevice) old.disconnect().catch(() => {});
    }
    this.link = link;
    this.linkKind = kind;
    this.connectError = null;
    /* What the previous timer reported is not what this one holds. In
     * particular the demo's 1600 must never be mistaken for a real unit's
     * threshold. */
    this.timer = { battery: null, lastRx: 0, rfSetup: {} };
    this._writeTries = {};
    /* Nothing is written to the timer just because we connected. The link's
     * hello() asks it to describe itself; adoptRfSetup() then corrects only the
     * slots where our saved intent actually differs. Writing on connect is how
     * an app clobbers real race frequencies with its own defaults. */
    if (!this.mode) this.screen = 'choose';
    else this.screen = this.mode === 'solo' ? 'fly' : 'race';
    this.render();
  }

  /** The last 500 link lines, one per row. `copy(wt.linkLog())` in the console. */
  linkLog() { return this._linkLog.join('\n'); }

  onLinkLost() {
    toast(this.linkKind === 'bluetooth'
      ? 'Timer disconnected. Power-cycle it, then reconnect.'
      : 'Timer disconnected.', 'err', 8000);
    this.markStructural();
  }

  disconnect() {
    if (this.race.active) {
      confirmSheet('Disconnect the timer?',
        'The session keeps running and laps by hand still count. You can reconnect at any time.',
        'Disconnect', () => this._disconnect(), { danger: false });
      return;
    }
    return this._disconnect();
  }

  async _disconnect() {
    try { await this.link?.disconnect(); } catch (e) {}
    this.link?.detach();
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
        if (rec.slot) this.race.onPassing(rec.slot, undefined, rec.rtcTime ?? null);
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
  }

  /** Mirror what the hardware says about itself; never invent a default. */
  adoptRfSetup(rec) {
    const slot = rec.slot;
    /* The timer's own values live here and only here. Threshold and gain are
     * not copied into this.rf: that store holds what was measured or chosen in
     * this app, and a value merely seen on some timer (the demo's, say) must
     * never be written back to a different one as if it were intent. */
    this.timer.rfSetup[slot] = {
      band: rec.band, channel: rec.channel, frequency: rec.frequency,
      gain: rec.gain, threshold: rec.threshold, enabled: !!rec.enabled,
    };
    const p = this.race.pilots.get(slot);
    if (!p || !rec.frequency) return;
    /* While a channel sweep drives this slot across all forty channels the
     * timer echoes each one back; none of them is the pilot's channel. */
    if (slot === this.scanning) return;
    const mine = laprf.channelByName(p.channel).frequency;
    const wantEnabled = p.enabled;

    if (!this.touched[slot]) {
      /* The user never chose a channel for this slot: mirror the timer. Prefer
       * the band and channel it reported over a frequency lookup — R7 and F8
       * are both 5880, and a pilot who set R7 should see R7. */
      const name = timerChannelName(rec);
      if (name && name !== p.channel) {
        this.race.setPilot(slot, { channel: name });
        this.savePilots();
      }
      /* Enabled is still ours to decide (solo practice switches the others off). */
      if (!!rec.enabled !== wantEnabled) this.pushConfig([slot]);
      else delete this._writeTries[slot];
      return;
    }
    /* The user chose this slot's channel here: that wins — but only now that
     * the timer has said what it holds, and only if it actually differs. */
    if (mine !== rec.frequency || !!rec.enabled !== wantEnabled) this.pushConfig([slot]);
    else delete this._writeTries[slot];        // it took: the next change starts fresh
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
    const sent = [], settled = [];
    for (const slot of this._dirty) {
      const p = this.race.pilots.get(slot);
      if (!p) continue;
      const cfg = this.rfFor(slot);
      const hw = this.timer.rfSetup[slot] || {};
      /* A slot whose channel the user never chose keeps the frequency the timer
       * reported. If the timer has not reported yet, the slot waits: writing
       * the app's default there is how a club's race frequencies get lost. */
      let rf;
      if (this.touched[slot]) rf = laprf.channelByName(p.channel);
      else if (hw.frequency) rf = { band: hw.band, channel: hw.channel, frequency: hw.frequency };
      else continue;
      /* Likewise thresholds and gain: what was measured or set here, else what
       * the timer holds, and only as a last resort a constant. */
      const want = {
        slot, band: rf.band, channel: rf.channel, frequency: rf.frequency,
        threshold: Number(cfg.threshold ?? hw.threshold ?? 1600),
        gain: Number(cfg.gain ?? hw.gain ?? 58),
        enabled: !!p.enabled };
      /* A write is followed by a read-back, and a read-back that still differs
       * marks the slot dirty again. That is a loop with no exit if the timer
       * will not take the value — a slot it does not have, an enable it
       * ignores — and the loop is not idle: it re-tunes every receiver a few
       * times a second, for as long as the link is up. Ask three times, then
       * leave the hardware alone and say so once. */
      const tries = this._writeTries[slot];
      const sig = JSON.stringify(want);
      const count = tries && tries.sig === sig ? tries.count : 0;
      if (count >= MAX_WRITE_TRIES) {
        if (!tries.warned) {
          tries.warned = true;
          console.warn('[timer] slot ' + slot + ' will not take this setup; leaving it alone', want);
          toast(`The timer would not accept the setup for slot ${slot} — it is still on ` +
                `${timerChannelName(hw) || 'its own channel'}.`, 'err', 8000);
        }
        settled.push(slot);
        continue;
      }
      this._writeTries[slot] = { sig, count: count + 1, warned: false };
      this.link.send(laprf.setRfSetup(want));
      sent.push(slot);
    }
    for (const slot of sent.concat(settled)) this._dirty.delete(slot);
    if (!sent.length) return;
    this.link.send(laprf.setMinLapTime(Number(this.settings.timerMinLapMs) || 0));
    for (const slot of sent) this.link.send(laprf.getRfSetup(slot));
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
    if ('mode' in patch || 'preset' in patch) this.markStructural();
  }

  savePrefs(patch) {
    Object.assign(this.prefs, patch);
    store.save('prefs', this.prefs);
    document.documentElement.dataset.theme = this.prefs.theme;
    this.markStructural();
  }

  saveRf(slot, patch) {
    const cur = (this.rf[slot] ||= {});
    /* Bounds were measured at a particular gain. Change the gain and the noise
     * floor and pass peak both move; keeping the old numbers would make the
     * verdict confidently wrong. */
    if (patch.gain != null && cur.gain != null && patch.gain !== cur.gain) {
      delete cur.floor; delete cur.ceiling;
    }
    Object.assign(cur, patch);
    store.save('rf', this.rf);
  }

  /* ------------------------------------------------------------------ race -- */
  setPilot(slot, patch) {
    if (this.race.active && (patch.channel != null || patch.enabled != null)) {
      toast('Finish the session first — the timer cannot be reconfigured mid-race');
      return;
    }
    this.race.setPilot(slot, patch);
    this.savePilots();
    if (patch.channel != null) {
      this.touched[slot] = true;
      store.save('pilotsTouched', this.touched);
    }
    if (patch.channel != null || patch.enabled != null) this.pushConfig([slot]);
    /* Only a change of who is racing changes the shape of a screen. Rebuilding
     * on a typed name throws away the focus of the field being typed in. */
    if (patch.enabled != null) this.markStructural();
  }

  /** Solo flying is one pilot on slot 1; the others are switched off on the
   *  timer so their receivers cannot contribute phantom laps. */
  useMode(mode) {
    if (this.race.active && mode !== this.mode) {
      confirmSheet('End the session?',
        'Switching modes ends the session that is running now. Its laps are saved to history first.',
        'End and switch', () => { this.stop(); this.useMode(mode); });
      return;
    }
    if (this.race.state === 'finished') this.race.reset();   // its laps are already in history
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
    if (!this.race.racing.length) { toast('Switch on at least one pilot first'); return; }
    if (this.race.active) return;
    this.voice.arm();
    if (!this.voice.available && this.prefs.voiceOn && !this._voiceWarned) {
      this._voiceWarned = true;
      toast('This browser has no speech voices — lap times show on screen but are not spoken.', 'err', 8000);
    }
    this.sessionBest = null;
    this.lastLap = null;
    if (this.prefs.keepAwake) {
      this.wake.request().then(ok => {
        /* Silence here means the screen locks mid-race and, on a phone, the
         * Bluetooth link goes with it. Say so once. */
        if (!ok && !this._wakeWarned) {
          this._wakeWarned = true;
          toast('This browser cannot keep the screen awake — set auto-lock to Never while racing.', 'err', 9000);
        }
      });
    }
    /* Put the timer into the state this race assumes before the clock starts —
     * channels, enables and the timer's own minimum lap. Config writes are
     * refused once staging begins, so this has to happen now. */
    this.pushConfig(SLOTS, { now: true });
    if (this.settings.countdown > 0) this.race.arm(); else this.race.startNow();
    this.render();
  }

  /**
   * What every Stop control and the space bar call. During the countdown it is
   * a cancel — nothing is saved and nothing is spoken. A running race with more
   * than one pilot asks first: one brush of a thumb on a phone should not end
   * four people's heat. Solo practice stops instantly; there is nothing to lose.
   */
  requestStop() {
    if (this.race.state === 'staging') { this.resetRace(); return; }
    if (this.race.state !== 'running') return;
    if (this.race.solo || this.race.open) { this.stop(); return; }
    confirmSheet('Stop the race?',
      'Every pilot’s laps so far become the result and it is saved. A stopped race cannot be resumed.',
      'Stop the race', () => this.stop());
  }

  stop() {
    this.race.stop();
    this.checkpoint();
    this.wake.release();
    this.flushConfig();          // anything edited mid-race was held back
    this.render();
  }

  resetRace() {
    this.race.reset();
    this.checkpoint();
    this.lastLap = null;
    this.sessionBest = null;
    this.wake.release();
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
    this.checkpoint();
    /* A finished race is already in history; an undo that changes it has to
     * change what was saved, not only what is on screen. */
    if (r.ok && this.race.state === 'finished' && this.race.racing.some(p => p.lapCount)) {
      store.appendHistory(this.race.results());
    }
    if (r.resumed) { closeSheet(); if (this.prefs.keepAwake) this.wake.request(); }
    this.render();
  }

  manualLap(slot) {
    if (this.race.state !== 'running') { toast('Start the session first'); return; }
    const p = this.race.pilots.get(slot);
    if (this.race.onPassing(slot)) toast(this.race.solo ? 'Lap added by hand' : `Lap added for ${p?.name || 'slot ' + slot}`, 'ok');
    else toast('Ignored — inside the minimum lap time');
  }

  /** Persist a running race so a reload does not lose it; clear it otherwise. */
  checkpoint() {
    if (this.race.state === 'running') store.save('checkpoint', this.race.toCheckpoint());
    else store.clear('checkpoint');
  }

  onLap({ pilot, n, time, isPb }) {
    this.lastLap = { slot: pilot.slot, n, time, isPb, at: performance.now() };
    this.checkpoint();
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
    const anyLaps = results.results.some(r => r.laps > 0);
    if (anyLaps) store.appendHistory(results);
    this.wake.release();
    this.render();
    if (anyLaps) this.showResults(results);
    else toast('Session ended — no laps were recorded, so nothing was saved');
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
    if (this.connecting) {
      return { tone: 'warn', text: this.connecting };
    }
    if (!this.connected) {
      const drop = this.link && this.linkKind !== 'demo';
      return { tone: 'bad',
               text: drop && this.linkKind === 'bluetooth'
                 ? 'Timer link lost. Power-cycle the timer, then reconnect — laps by hand still count (keys 1–4).'
                 : drop ? 'Timer link lost. Laps by hand still count (keys 1–4).'
                 : 'Timer not connected.',
               action: drop ? { label: 'Reconnect', fn: () => this.reconnect() }
                            : { label: 'Connect', fn: () => { this.screen = 'connect'; this.render(); } } };
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
      case 'finished': {
        const saved = store.load('history', []).some(e => e.runId === this.race.runId);
        const back = () => { this.go(this.mode === 'solo' ? 'fly' : 'race'); this.resetRace(); this.start(); };
        return { tone: 'ok',
                 text: saved ? 'Session saved. Go again, or look at the results.'
                             : 'Nothing was recorded. Go again when you are ready.',
                 action: { label: 'Go again', fn: back } };
      }
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
    const hp = tuning.gateHealth({
      threshold: cfg.threshold ?? hw.threshold ?? null,
      floor: cfg.floor ?? null,
      ceiling: cfg.ceiling ?? null,
      live: this.sig.quiet(slot),
      enabled: p ? p.enabled : true,
    });
    /* Config writes wait while a session runs. A verdict that describes a
     * threshold the timer does not hold yet has to say so. */
    if (this.race.active && this._dirty.has(slot) && this.canControl) {
      hp.pending = true;
      hp.detail += ' This change reaches the timer when the session ends.';
    }
    return hp;
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
    /* The connect screen is for a browser with no link at all. A link that
     * dropped mid-race keeps the race on screen — laps by hand still count and
     * the coach offers the way back — instead of replacing the tower with
     * "switch your timer on". */
    const build = SCREENS[(this.link || this.race.active) ? this.screen : 'connect'] || SCREENS.connect;
    this.view = build(this);
    mount(document.getElementById('main'), this.view.node);
    mount(document.getElementById('topbar'), SCREENS.topbar(this));
  }

  go(screen) { this.screen = screen; closeSheet(); this.render(); }

  /* --------------------------------------------------------------- keyboard -- */
  onKey(e) {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === 'Escape' && this.race.state === 'staging') { this.resetRace(); e.preventDefault(); return; }
    /* A sheet owns the keyboard while it is open: Space on its focused Cancel
     * must cancel, not stop the race behind it. */
    if (sheetOpen()) return;
    const onSession = this.link && (this.screen === 'fly' || this.screen === 'race');
    if (k >= '1' && k <= '4') { if (onSession) { this.manualLap(Number(k)); e.preventDefault(); } return; }
    if (k === ' ') {
      if (!onSession) return;
      e.preventDefault();
      if (this.race.active) this.requestStop();
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

/** The channel name a timer's rfSetup record describes, or null if the record
 *  is inconsistent (band/channel that do not produce its frequency). */
function timerChannelName(rec) {
  try {
    const name = laprf.channelName(rec.band, rec.channel);
    if (laprf.channelByName(name).frequency === rec.frequency) return name;
  } catch (e) { /* fall through */ }
  return laprf.channelsByFreq(rec.frequency)[0]?.name || null;
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
