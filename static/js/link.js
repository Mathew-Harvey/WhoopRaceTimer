/* Transports to a LapRF timer, straight from the browser.
 *
 * The point of this file is that whooptimer.webfpv.org can be a plain static
 * page: the browser owns the radio, so there is nothing to install and no
 * server in the path. Four transports, one interface:
 *
 *   BleLink     Web Bluetooth -> Nordic UART. The real control channel.
 *   SerialLink  Web Serial -> USB. Binary if the unit speaks it, otherwise the
 *               read-only ASCII debug console (signal only, no lap records).
 *   BridgeLink  a WhoopTimer running on this machine relays frames, for
 *               browsers with no Web Bluetooth (Firefox, Safari).
 *   DemoLink    a simulated timer, so the app can be understood without one.
 *
 * Every link emits the same events: 'record' (decoded LapRF record), 'log',
 * 'state'. Nothing above this file knows which transport it is talking to.
 */
'use strict';
import * as laprf from './laprf.js';

export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_CONTROL = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_STREAM  = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

/* The LapRF drops messages that arrive too fast; these gaps are from the
 * working Python transport and are not worth tuning down. */
const CHUNK = 20, CHUNK_GAP_MS = 30, MSG_GAP_MS = 60;

/* The slots this app races. Four, everywhere — see SLOTS in app.js. A query for
 * slots 5-8 asks a four-receiver unit about receivers it does not have. */
const QUERY_SLOTS = [1, 2, 3, 4];

/* A LapRF has just finished bringing up a link when the app first has something
 * to say. Let it finish. The first frame after a connect is the riskiest one a
 * client sends, and there is nothing here worth saying into that. */
const HELLO_DELAY_MS = 300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- base --- */

export class LapRFLink {
  constructor(kind) {
    this.kind = kind;
    this.connected = false;
    this.mode = 'disconnected';       // disconnected | binary | ascii
    this.deviceName = '';
    this.detail = '';
    this._handlers = {};
    this._buf = new Uint8Array(0);
    this._txq = [];
    this._txRunning = false;
  }

  on(evt, fn) { (this._handlers[evt] ||= []).push(fn); return this; }
  emit(evt, arg) {
    if (this._dead) return;
    for (const fn of this._handlers[evt] || []) { try { fn(arg); } catch (e) { console.error(e); } }
  }

  /** Retire this link: nothing it hears from now on reaches the app, and
   *  nothing it still had to say reaches the timer.
   *
   *  A replaced link keeps receiving notifications for as long as the browser
   *  holds the underlying device, and two links reporting the same timer means
   *  every reading arrives twice and a dropped old link toasts about a working
   *  new one. Silencing the events is only half of it: the queue is also live,
   *  and Chrome hands both links the same GATT characteristic, so a retired
   *  link's pending frames interleave 20 bytes at a time with the new link's
   *  and the timer is fed two records spliced together. */
  detach() { this._dead = true; this._handlers = {}; this._txq.length = 0; }
  log(msg) { this.emit('log', msg); }

  /** True once config writes will actually reach the timer. */
  get canControl() { return this.connected && this.mode === 'binary'; }

  setState(patch) {
    /* Messages queued for a link that just dropped belong to a conversation
     * that is over. Replaying them after a reconnect (a scan's channel hops,
     * say) would drive the timer somewhere nobody asked for. */
    if (patch.connected === false) this._txq.length = 0;
    Object.assign(this, patch);
    this.emit('state', this);
  }

  /** Queue a message. Delivery is serialised and paced by the subclass. */
  send(bytes) {
    this._txq.push(bytes);
    if (!this._txRunning) this._drain();
  }

  async _drain() {
    this._txRunning = true;
    try {
      while (this._txq.length && this.connected && !this._dead) {
        const msg = this._txq.shift();
        /* Every outbound frame, in the console. When a timer misbehaves the
         * only question that matters is what it was told immediately before. */
        this.log('tx ' + [...msg].map(b => b.toString(16).padStart(2, '0')).join(''));
        try { await this._write(msg); }
        catch (e) { this.log('write failed: ' + e.message); }
        await sleep(MSG_GAP_MS);
      }
    } finally {
      this._txRunning = false;
    }
  }

  async _write() { throw new Error('not implemented'); }

  /** Feed raw inbound bytes; decoded records come out as 'record' events. */
  ingest(chunk) {
    const merged = new Uint8Array(this._buf.length + chunk.length);
    merged.set(this._buf); merged.set(chunk, this._buf.length);
    const { records, rest } = laprf.splitRecords(merged);
    this._buf = rest.length > 4096 ? rest.slice(rest.length - 1024) : rest;
    /* SOR is 0x5A, which is also a capital Z, and EOR is 0x5B, a '['. Console
     * text can contain both, so a framed span is only evidence of the binary
     * protocol once its CRC checks out — flipping on a bogus frame would stop
     * the ASCII parser for good. */
    let proven = false;
    for (const r of records) {
      const rec = laprf.decodeRecord(r);
      if (!rec) continue;
      if (rec.type !== 'crc_error') proven = true;
      this.emit('record', rec);
    }
    if (proven && this.mode !== 'binary') this.setState({ mode: 'binary' });
  }

  /**
   * Say hello: ask the timer to describe the slots this app will race.
   *
   * Read-only, one slot per record, and nothing whose answer is thrown away.
   * The RTC clock used to be asked for here; no screen ever read the reply, and
   * the request declared two eight-byte fields as four — see getRtcTime(). A
   * connect handshake should be the most boring thing the app ever sends.
   */
  hello() {
    for (const slot of QUERY_SLOTS) this.send(laprf.getRfSetup(slot));
  }
}

/* ------------------------------------------------------- web bluetooth --- */

export class BleLink extends LapRFLink {
  constructor() {
    super('bluetooth');
    this.device = null;
    this.ctrl = null;
    this._stream = null;
    this._onDisc = () => this._dropped();
    this._onValue = e => this.ingest(new Uint8Array(e.target.value.buffer));
  }

  /**
   * Ask the browser for a device. Must be called from a user gesture.
   * `showAll` widens the chooser for units that advertise no service UUID —
   * some LapRFs only advertise a name, and a filtered chooser stays empty
   * forever with no explanation, which looks exactly like a broken timer.
   */
  async connect({ showAll = false } = {}) {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth.');
    const options = showAll
      ? { acceptAllDevices: true, optionalServices: [NUS_SERVICE] }
      : { filters: [{ services: [NUS_SERVICE] }, { namePrefix: 'CrabLake' },
                    { namePrefix: 'LapRF' }, { namePrefix: 'ImmersionRC' }],
          optionalServices: [NUS_SERVICE] };
    const device = await navigator.bluetooth.requestDevice(options);
    return this._attach(device);
  }

  /** Reconnect to a timer this browser has already been given permission for. */
  async reconnectKnown() {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
    let known = [];
    try { known = await navigator.bluetooth.getDevices(); } catch (e) { return false; }
    for (const d of known) {
      try { await this._attach(d); return true; } catch (e) { /* try the next */ }
    }
    return false;
  }

  /** Reconnect to the timer this link already knows, with no chooser. After a
   *  power-cycle this is the one-tap path back into a running race. */
  async reconnect() {
    if (!this.device) throw new Error('no timer to reconnect to');
    return this._attach(this.device);
  }

  async _attach(device) {
    this.device = device;
    this.deviceName = device.name || 'LapRF';
    this.log(`connecting to ${this.deviceName}…`);
    /* Chrome hands back the same device and characteristic objects every time,
     * so listeners must be removed before being added or a reconnect doubles
     * every notification. */
    device.removeEventListener('gattserverdisconnected', this._onDisc);
    device.addEventListener('gattserverdisconnected', this._onDisc);
    const server = await device.gatt.connect();
    let stream;
    try {
      const svc = await server.getPrimaryService(NUS_SERVICE);
      this.ctrl = await svc.getCharacteristic(NUS_CONTROL);
      stream = await svc.getCharacteristic(NUS_STREAM);
      this._stream?.removeEventListener('characteristicvaluechanged', this._onValue);
      stream.removeEventListener('characteristicvaluechanged', this._onValue);
      await stream.startNotifications();
    } catch (err) {
      /* Service discovery failed after the radio link came up. Let go of the
       * connection, or the timer sits connected-to-nobody and stops
       * advertising, and the next attempt finds an empty chooser. */
      device.removeEventListener('gattserverdisconnected', this._onDisc);
      try { device.gatt.disconnect(); } catch (e) {}
      throw err;
    }
    stream.addEventListener('characteristicvaluechanged', this._onValue);
    this._stream = stream;
    this._buf = new Uint8Array(0);
    this.setState({ connected: true, mode: 'binary', detail: this.deviceName });
    this.log('connected');
    await sleep(HELLO_DELAY_MS);
    this.hello();
    return true;
  }

  async _write(msg) {
    for (let i = 0; i < msg.length; i += CHUNK) {
      const slice = msg.subarray(i, i + CHUNK);
      if (this.ctrl.writeValueWithoutResponse) await this.ctrl.writeValueWithoutResponse(slice);
      else await this.ctrl.writeValue(slice);
      await sleep(CHUNK_GAP_MS);
    }
  }

  _dropped() {
    if (!this.connected) return;
    this.setState({ connected: false, mode: 'disconnected' });
    this.log('link lost — the timer must be power-cycled before it advertises again');
    this.emit('lost');
  }

  detach() {
    try { this.device?.removeEventListener('gattserverdisconnected', this._onDisc); } catch (e) {}
    try { this._stream?.removeEventListener('characteristicvaluechanged', this._onValue); } catch (e) {}
    super.detach();
  }

  async disconnect() {
    this.detach();
    try { if (this.device?.gatt?.connected) this.device.gatt.disconnect(); } catch (e) {}
    this.setState({ connected: false, mode: 'disconnected' });
  }
}

/* -------------------------------------------------- mixed binary / ascii --- */

/* [199376] status - voltage: 4.091162  noise: 963.00 (0/199) 962.00 (0/199) … */
const ASCII_STATUS = /\[(\d+)\]\s*status\s*-\s*voltage:\s*([\d.]+)\s*noise:\s*(.*)/;
const ASCII_SLOT = /([\d.]+)\s*\((\d+)\/(\d+)\)/g;

/** One line of the LapRF's ASCII debug console -> a status record, or null. */
export function parseAsciiStatus(text) {
  const m = ASCII_STATUS.exec(text);
  if (!m) return null;
  const slots = {};
  let sm, i = 0;
  ASCII_SLOT.lastIndex = 0;
  while ((sm = ASCII_SLOT.exec(m[3]))) {
    i += 1;
    /* A slot reporting zero samples is unpopulated, not quiet. */
    if (Number(sm[3]) > 0) slots[i] = { lastRssi: Number(sm[1]), detections: Number(sm[2]) };
  }
  return { type: 'status', batteryVoltage: Number(m[2]) * 1000, slots, ascii: true };
}

/**
 * Feed a chunk that may be binary records, console text, or both.
 *
 * Binary records take priority; anything before or between them is console
 * text. A unit stuck in ASCII mode carries no lap records at all — only signal
 * — so `mode` has to reach the UI, which is what the caller uses it for.
 */
function consumeMixed(link, chunk) {
  if (link.mode === 'binary' || chunk.includes(laprf.SOR) || link._buf.length) {
    link.ingest(chunk);
    if (link.mode === 'binary') return;
  }
  link._text = (link._text || '') + new TextDecoder().decode(chunk);
  let nl;
  while ((nl = link._text.indexOf('\n')) >= 0) {
    const line = link._text.slice(0, nl).trim();
    link._text = link._text.slice(nl + 1);
    if (!line) continue;
    const rec = parseAsciiStatus(line);
    if (rec) link.emit('record', rec); else link.log(line);
  }
  if (link._text.length > 4096) link._text = link._text.slice(-1024);
}

/* ------------------------------------------------------------ web serial --- */

export class SerialLink extends LapRFLink {
  constructor() {
    super('usb');
    this.port = null;
    this._reader = null;
    this._writer = null;
    this._text = '';
  }

  async connect({ port } = {}) {
    if (!navigator.serial) throw new Error('This browser has no Web Serial.');
    this.port = port || await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); } catch (e) {}
    this._writer = this.port.writable.getWriter();
    this._buf = new Uint8Array(0);
    this._text = '';
    this.setState({ connected: true, mode: 'ascii', detail: 'USB serial' });
    this.log('USB port open');
    this._readLoop();
    await sleep(HELLO_DELAY_MS);
    this.hello();       // harmless if the unit is in ASCII mode
    return true;
  }

  /** Reopen a port this browser already has permission for, with no prompt. */
  async reconnectKnown() {
    if (!navigator.serial || !navigator.serial.getPorts) return false;
    const ports = await navigator.serial.getPorts();
    for (const p of ports) {
      try { await this.connect({ port: p }); return true; } catch (e) { /* next */ }
    }
    return false;
  }

  async _readLoop() {
    try {
      this._reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this._reader.read();
        if (done) break;
        if (value && value.length) consumeMixed(this, new Uint8Array(value));
      }
    } catch (e) {
      this.log('USB read stopped: ' + e.message);
    } finally {
      try { this._reader?.releaseLock(); } catch (e) {}
      if (this.connected) {
        /* Unplanned exit (unplugged, or the OS revoked the port). Release our
         * locks and close the port, or the browser keeps it marked open and the
         * next connect attempt fails with "already open". */
        this.setState({ connected: false, mode: 'disconnected' });
        try { this._writer?.releaseLock(); } catch (e) {}
        try { await this.port?.close(); } catch (e) {}
        this.emit('lost');
      }
    }
  }

  _consume(chunk) { consumeMixed(this, chunk); }

  async _write(msg) { await this._writer.write(msg); }

  async disconnect() {
    this.setState({ connected: false, mode: 'disconnected' });
    try { await this._reader?.cancel(); } catch (e) {}
    try { this._writer?.releaseLock(); } catch (e) {}
    try { await this.port?.close(); } catch (e) {}
  }
}

/* ---------------------------------------------------------------- bridge --- */

/**
 * A WhoopTimer process on this machine owns the radio and relays raw frames.
 * This is the path for browsers with no Web Bluetooth. It only works against
 * localhost or a plain-http page: a secure page may not talk to a LAN address,
 * which is why the local app serves this same UI itself over the LAN.
 */
export class BridgeLink extends LapRFLink {
  constructor(base = '') {
    super('bridge');
    this.base = base.replace(/\/$/, '');
    this._es = null;
  }

  async connect() {
    const info = await fetch(this.base + '/bridge/status', { cache: 'no-store' })
      .then(r => r.json());
    if (!info.available) throw new Error(info.reason || 'the local bridge has no timer');
    this._es = new EventSource(this.base + '/bridge/events');
    let opened = false;
    this._es.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'rx') consumeMixed(this, Uint8Array.from(atob(m.b64), c => c.charCodeAt(0)));
      else if (m.type === 'log') this.log(m.text);
      else if (m.type === 'link') this.setState({ connected: !!m.connected,
                                                  mode: m.connected ? this.mode : 'disconnected',
                                                  detail: m.detail || 'local bridge' });
    };

    /* Wait for the stream before saying anything. The bridge relays only to
     * clients already subscribed, so a hello sent during the EventSource
     * handshake gets a reply nobody is listening for — and the timer's
     * thresholds, which every other screen reasons about, never arrive. */
    await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error('the local bridge did not start streaming')), 6000);
      this._es.onopen = () => { opened = true; clearTimeout(giveUp); resolve(); };
      this._es.onerror = () => {
        if (opened) return;
        clearTimeout(giveUp);
        reject(new Error('could not open the local bridge stream'));
      };
    }).catch(err => { try { this._es.close(); } catch (e) {} this._es = null; throw err; });
    /* EventSource reconnects on its own after a blip. Anything half-received
     * before the drop is garbage now, and the timer should be asked to describe
     * itself again in case it was power-cycled meanwhile. */
    this._es.onerror = () => {
      if (this.connected) { this.setState({ connected: false, mode: 'disconnected' }); this.emit('lost'); }
    };
    this._es.onopen = () => {
      if (this.connected) return;
      this._buf = new Uint8Array(0);
      this._text = '';
      this.setState({ connected: true, mode: 'ascii' });
      this.hello();
    };

    this.setState({ connected: true, mode: info.mode || 'binary',
                    detail: info.detail || 'WhoopTimer on this machine' });
    this.hello();
    return true;
  }

  async _write(msg) {
    await fetch(this.base + '/bridge/tx', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: btoa(String.fromCharCode(...msg)) }),
    });
  }

  async disconnect() {
    try { this._es?.close(); } catch (e) {}
    this.setState({ connected: false, mode: 'disconnected' });
  }
}

/* ------------------------------------------------------------------ demo --- */

/**
 * A timer that isn't there. Every screen in the app — connect, tuning, solo,
 * a four-up race — has to be explorable before someone owns hardware, or the
 * hosted page is a dead end for anyone evaluating it.
 */
export class DemoLink extends LapRFLink {
  constructor() {
    super('demo');
    this._timers = [];
    this._rf = {};
    this._flying = new Set();
    this._nextPass = {};
    this._ambient = 0;
  }

  async connect() {
    this.setState({ connected: true, mode: 'binary', detail: 'Simulated timer' });
    this.log('demo timer — no hardware, laps are generated');
    for (let s = 1; s <= 4; s++) {
      const ch = laprf.channelByName(['R1', 'R3', 'R6', 'R7'][s - 1]);
      this._rf[s] = { slot: s, ...ch, threshold: 1600, gain: 58, enabled: true };
    }
    this._timers.push(setInterval(() => this._status(), 250));
    this._timers.push(setInterval(() => this._maybePass(), 100));
    setTimeout(() => { for (const s of [1, 2, 3, 4]) this._emitRf(s); }, 60);
    return true;
  }

  /** The app tells the demo who is flying, so laps only appear once a race is
   *  actually under way — not while the start countdown is still running. */
  setFlying(slots) {
    this._flying = new Set(slots);
    const now = performance.now();
    for (const s of slots) {
      if (!this._nextPass[s]) this._nextPass[s] = now + 9000 + Math.random() * 4000 + s * 500;
    }
    for (const k of Object.keys(this._nextPass)) if (!this._flying.has(+k)) delete this._nextPass[k];
  }

  /** Idempotent: only reshuffles when the set of flying slots actually changes. */
  syncFlying(slots) {
    const key = slots.slice().sort().join(',');
    if (key === this._flyingKey) return;
    this._flyingKey = key;
    this.setFlying(slots);
  }

  _emitRf(slot) {
    const r = this._rf[slot];
    if (!r) return;
    this.emit('record', { type: 'rfSetup', slot, band: r.band, channel: r.channel,
                          frequency: r.frequency, gain: r.gain, threshold: r.threshold,
                          enabled: r.enabled ? 1 : 0, slots: {} });
  }

  _status() {
    const t = performance.now();
    /* Something buzzes past the gate every few seconds even when no race is on,
     * so the tuning screen and its wizard have a real peak to measure. It moves
     * the signal without emitting a passing record — which is exactly what an
     * untuned gate looks like, and exactly what the wizard is there to fix. */
    if (!this._flying.size) {
      if (!this._ambient || t > this._ambient + 7000) this._ambient = t + Math.random() * 1200;
    }
    const ambient = !this._flying.size && this._ambient && t > this._ambient && t < this._ambient + 500;
    const slots = {};
    for (let s = 1; s <= 4; s++) {
      const flying = this._flying.has(s);
      const near = flying && this._nextPass[s] && (this._nextPass[s] - t < 700);
      slots[s] = { lastRssi: Math.round(940 + Math.random() * 40 + (flying ? 120 : 0) +
                                        (near || ambient ? 1180 + Math.random() * 240 : 0)) };
    }
    this.emit('record', { type: 'status', batteryVoltage: 4020, slots });
  }

  _maybePass() {
    const now = performance.now();
    for (const s of this._flying) {
      if (this._nextPass[s] && now >= this._nextPass[s]) {
        this._nextPass[s] = now + 11000 + Math.random() * 6000 + s * 400;
        this.emit('record', { type: 'passing', slot: s, rtcTime: Math.round(now),
                              peakHeight: 2400, slots: {} });
      }
    }
  }

  async _write(msg) {
    /* Accept config writes so the tuning and scanning screens behave like the
     * real thing. A query asks for all eight slots; only four are fitted. */
    const { records } = laprf.splitRecords(msg.slice());
    for (const r of records) {
      const rec = laprf.decodeRecord(r);       // splitRecords has already unescaped
      if (!rec || rec.type !== 'rfSetup' || !this._rf[rec.slot]) continue;
      if (rec.frequency) Object.assign(this._rf[rec.slot], rec);
      setTimeout(() => this._emitRf(rec.slot), 30);
    }
  }

  async disconnect() {
    this._timers.forEach(clearInterval);
    this._timers = [];
    this.setState({ connected: false, mode: 'disconnected' });
  }
}

/* ---------------------------------------------------------- capabilities --- */

function browserId() {
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const bluefy = /Bluefy|WebBLE/i.test(ua);
  return {
    iOS,
    android: /Android/.test(ua),
    firefox: /Firefox\//.test(ua),
    safari: /^((?!chrome|android|crios|fxios).)*safari/i.test(ua) && !bluefy,
    chromium: /Chrome\/|Chromium\/|Edg\//.test(ua),
  };
}

/**
 * What this browser can actually do, and — when it can't — the specific thing
 * this person should do instead. A generic "not supported" is what sends
 * people looking for a manual.
 */
export function capabilities() {
  const b = browserId();
  const secure = window.isSecureContext;
  const bluetooth = !!navigator.bluetooth && secure;
  const serial = !!navigator.serial && secure;
  let advice = '';
  if (!secure) {
    advice = 'Bluetooth needs a secure page. Open this site over https, or run the ' +
             'WhoopTimer app on this machine and use its own address.';
  } else if (!bluetooth && b.iOS) {
    advice = 'iOS Safari has no Bluetooth for web pages. Open this page in Bluefy ' +
             '(free, App Store) to connect directly — or run WhoopTimer on a laptop ' +
             'and open the address it prints on this phone.';
  } else if (!bluetooth && b.firefox) {
    advice = 'Firefox has no Web Bluetooth. Use Chrome or Edge to connect directly, ' +
             'or run WhoopTimer on this machine and let it hold the link.';
  } else if (!bluetooth && b.safari) {
    advice = 'Safari has no Web Bluetooth. Use Chrome or Edge, or run WhoopTimer on ' +
             'this machine and let it hold the link.';
  } else if (!bluetooth && b.chromium && /Linux/.test(navigator.userAgent) && !b.android) {
    advice = 'Chrome on Linux only offers Bluetooth to web pages when the system BlueZ stack is ' +
             'available, and on some builds only behind chrome://flags/#enable-experimental-web-platform-features. ' +
             'Try that, or run WhoopTimer on this machine and let it hold the link.';
  } else if (!bluetooth) {
    advice = 'This browser has no Web Bluetooth. Chrome and Edge do, on desktop and ' +
             'on Android.';
  }
  return { bluetooth, serial, secure, ...b, advice,
           /* No service worker means no offline copy — Bluefy (WKWebView) is the
            * main case, and it is also the main iOS path. */
           offlineCapable: 'serviceWorker' in navigator,
           /* Web Serial is desktop-only; on a phone the USB option is a dead end. */
           serialLikely: serial && !b.android && !b.iOS };
}

/** Is a WhoopTimer bridge running on this machine? */
export async function probeBridge(base = '') {
  try {
    /* AbortSignal.timeout() is newer than the browsers that most need the
     * bridge (older Safari, Firefox); build the timeout by hand. */
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1200);
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/bridge/status',
                            { cache: 'no-store', signal: ctl.signal });
      if (!r.ok) return null;
      return await r.json();
    } finally { clearTimeout(t); }
  } catch (e) { return null; }
}
