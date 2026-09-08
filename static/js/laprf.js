/* LapRF binary protocol — encode/decode for ImmersionRC LapRF timers.
 *
 * Line-for-line port of laprf.py so the browser can talk to the timer directly
 * over Web Bluetooth or Web Serial, with no server in the middle. Any change
 * here must be mirrored there; test-vectors.js pins the two together.
 *
 * Framing:  SOR | length u16le | crc u16le | recordType u16le | fields... | EOR
 *   length = total record byte count including SOR and EOR
 *   crc    = CRC-16 (reflected poly 0x8005, init 0) over the record, crc zeroed
 *   fields = signature u8 | byteLength u8 | value (little endian)
 * Escaping is applied last, to every interior byte equal to SOR/EOR/ESC.
 */
'use strict';

export const SOR = 0x5a, EOR = 0x5b, ESC = 0x5c, ESC_OFFSET = 0x40;

/* Record types */
export const RT_RSSI = 0xda01, RT_RF_SETUP = 0xda02, RT_STATE_CONTROL = 0xda04,
             RT_SETTINGS = 0xda07, RT_DESCRIPTOR = 0xda08, RT_PASSING = 0xda09,
             RT_STATUS = 0xda0a, RT_TIME = 0xda0c, RT_ERROR = 0xffff;

const RT_NAMES = {
  [RT_RSSI]: 'rssi', [RT_RF_SETUP]: 'rfSetup', [RT_STATE_CONTROL]: 'stateControl',
  [RT_SETTINGS]: 'settings', [RT_DESCRIPTOR]: 'descriptor', [RT_PASSING]: 'passing',
  [RT_STATUS]: 'status', [RT_TIME]: 'time', [RT_ERROR]: 'error',
};

/* Field signatures */
const RF_SLOT = 0x01, RF_ENABLED = 0x20, RF_CHANNEL = 0x21, RF_BAND = 0x22,
      RF_THRESHOLD = 0x23, RF_GAIN = 0x24, RF_FREQ = 0x25;
const PS_SLOT = 0x01, PS_RTC_TIME = 0x02, PS_DECODER_ID = 0x20,
      PS_PASSING_NUMBER = 0x21, PS_PEAK_HEIGHT = 0x22, PS_FLAGS = 0x23;
const ST_SLOT = 0x01, ST_FLAGS = 0x03, ST_BATTERY = 0x21, ST_LAST_RSSI = 0x22,
      ST_GATE_STATE = 0x23, ST_DETECT_COUNT = 0x24;
const SET_STATUS_INTERVAL = 0x22, SET_SAVE = 0x25, SET_MIN_LAP = 0x26;
const SC_GATE_STATE = 0x20;
const TF_RTC_TIME = 0x02, TF_TIME_RTC_TIME = 0x20;

/* Band index order is 'FREBA' -> F=1 R=2 E=3 B=4 A=5.  Raceband is 2, not 1.
 * Getting this wrong puts every pilot on the wrong frequency. */
export const BAND_ORDER = 'FREBA';
export const BANDS = {
  A: [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  B: [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  E: [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  F: [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  R: [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
};

/* Human-facing band names. Pilots say "Raceband 4", never "band index 2". */
export const BAND_LABELS = {
  R: 'Raceband', A: 'Boscam A', B: 'Boscam B', E: 'Boscam E', F: 'Fatshark',
};

/** 'R4' -> {band, channel, frequency} with 1-based band and channel indexes. */
export function channelByName(name) {
  const n = String(name).trim().toUpperCase();
  const b = n[0], c = parseInt(n[1], 10);
  const table = BANDS[b];
  if (!table || !(c >= 1 && c <= 8)) throw new Error('bad channel ' + name);
  return { band: BAND_ORDER.indexOf(b) + 1, channel: c, frequency: table[c - 1] };
}

export function channelName(bandIdx, chanIdx) {
  return BAND_ORDER[bandIdx - 1] + chanIdx;
}

export const ALL_CHANNELS = [].concat(...[...BAND_ORDER].map(
  b => BANDS[b].map((f, i) => ({ name: b + (i + 1), freq: f, band: b, ch: i + 1 }))));

export function channelsByFreq(freq) {
  return ALL_CHANNELS.filter(c => c.freq === freq);
}

/* ---- CRC-16, reflected poly 0x8005, init 0 ---- */
const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let r = (i << 8) & 0xff00;
    for (let k = 0; k < 8; k++) r = (r & 0x8000) ? (((r << 1) & 0xffff) ^ 0x8005) : ((r << 1) & 0xffff);
    t[i] = r;
  }
  return t;
})();

const REFLECT8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let o = 0;
    for (let b = 0; b < 8; b++) if ((i >> b) & 1) o |= 1 << (7 - b);
    t[i] = o;
  }
  return t;
})();

function reflect16(v) {
  let o = 0;
  for (let i = 0; i < 16; i++) if ((v >> i) & 1) o |= 1 << (15 - i);
  return o & 0xffff;
}

export function crc16(buf) {
  let rem = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = REFLECT8[buf[i] & 0xff];
    const b = (rem >> 8) & 0xff;
    const c = (rem << 8) & 0xffff;
    rem = (CRC_TABLE[a ^ b] ^ c) & 0xffff;
  }
  return reflect16(rem);
}

/* ---- escaping ---- */
export function escape(rec) {
  const out = [];
  const last = rec.length - 1;
  for (let i = 0; i < rec.length; i++) {
    const byte = rec[i];
    if ((byte === ESC || byte === SOR || byte === EOR) && i !== 0 && i !== last) {
      out.push(ESC, (byte + ESC_OFFSET) & 0xff);
    } else {
      out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

export function unescape(rec) {
  const out = [];
  let esc = false;
  for (let i = 0; i < rec.length; i++) {
    const byte = rec[i];
    if (esc) { out.push((byte - ESC_OFFSET) & 0xff); esc = false; }
    else if (byte === ESC) { esc = true; }
    else { out.push(byte); if (byte === EOR) break; }
  }
  return Uint8Array.from(out);
}

/* ---- encoding ---- */
const SIZES = { u8: 1, u16: 2, u32: 4, f32: 4 };

/** fields: array of [signature, type, value] */
export function encode(recordType, fields) {
  let bodyLen = 0;
  for (const [, typ] of fields) bodyLen += 2 + SIZES[typ];
  const rec = new Uint8Array(1 + 2 + 2 + 2 + bodyLen + 1);
  const dv = new DataView(rec.buffer);
  rec[0] = SOR;
  dv.setUint16(5, recordType, true);
  let p = 7;
  for (const [sig, typ, val] of fields) {
    rec[p] = sig; rec[p + 1] = SIZES[typ];
    if (typ === 'u8') dv.setUint8(p + 2, val & 0xff);
    else if (typ === 'u16') dv.setUint16(p + 2, val & 0xffff, true);
    else if (typ === 'u32') dv.setUint32(p + 2, val >>> 0, true);
    else dv.setFloat32(p + 2, val, true);
    p += 2 + SIZES[typ];
  }
  rec[p] = EOR;
  dv.setUint16(1, rec.length, true);
  dv.setUint16(3, crc16(rec), true);
  return escape(rec);
}

export const getRtcTime = () =>
  encode(RT_TIME, [[TF_RTC_TIME, 'u32', 0], [TF_TIME_RTC_TIME, 'u32', 0]]);

export const getRfSetup = (slot) => {
  const slots = slot ? [slot] : [1, 2, 3, 4, 5, 6, 7, 8];
  return encode(RT_RF_SETUP, slots.map(s => [RF_SLOT, 'u8', s]));
};

export const setRfSetup = ({ slot, band, channel, frequency,
                             threshold = 900.0, gain = 51, enabled = true }) =>
  encode(RT_RF_SETUP, [
    [RF_SLOT, 'u8', slot], [RF_ENABLED, 'u16', enabled ? 1 : 0],
    [RF_CHANNEL, 'u16', channel], [RF_BAND, 'u16', band],
    [RF_THRESHOLD, 'f32', threshold], [RF_GAIN, 'u16', gain],
    [RF_FREQ, 'u16', frequency]]);

export const setMinLapTime = ms => encode(RT_SETTINGS, [[SET_MIN_LAP, 'u32', ms]]);
export const setStatusInterval = ms => encode(RT_SETTINGS, [[SET_STATUS_INTERVAL, 'u16', ms]]);
export const setGateState = on => encode(RT_STATE_CONTROL, [[SC_GATE_STATE, 'u8', on ? 1 : 0]]);

/* ---- decoding ---- */
const U8 = 'u8', U16 = 'u16', U32 = 'u32', U64 = 'u64', F32 = 'f32';
const FIELD_TYPES = {
  [RT_RF_SETUP]: { [RF_SLOT]: U8, [RF_ENABLED]: U16, [RF_CHANNEL]: U16, [RF_BAND]: U16,
                   [RF_THRESHOLD]: F32, [RF_GAIN]: U16, [RF_FREQ]: U16 },
  [RT_PASSING]: { [PS_SLOT]: U8, [PS_RTC_TIME]: U64, [PS_DECODER_ID]: U32,
                  [PS_PASSING_NUMBER]: U32, [PS_PEAK_HEIGHT]: U16, [PS_FLAGS]: U16 },
  [RT_STATUS]: { [ST_SLOT]: U8, [ST_FLAGS]: U16, [ST_BATTERY]: U16,
                 [ST_LAST_RSSI]: F32, [ST_GATE_STATE]: U8, [ST_DETECT_COUNT]: U32 },
  [RT_RSSI]: { 0x01: U8, 0x07: U32, 0x20: F32, 0x21: F32, 0x22: F32,
               0x23: F32, 0x24: U32, 0x25: U32, 0x26: U32 },
  [RT_SETTINGS]: { [SET_STATUS_INTERVAL]: U16, [SET_SAVE]: U8, [SET_MIN_LAP]: U32 },
  [RT_TIME]: { [TF_RTC_TIME]: U64, [TF_TIME_RTC_TIME]: U64 },
  [RT_STATE_CONTROL]: { [SC_GATE_STATE]: U8 },
};
const FIELD_NAMES = {
  [RT_RF_SETUP]: { [RF_SLOT]: 'slot', [RF_ENABLED]: 'enabled', [RF_CHANNEL]: 'channel',
                   [RF_BAND]: 'band', [RF_THRESHOLD]: 'threshold', [RF_GAIN]: 'gain',
                   [RF_FREQ]: 'frequency' },
  [RT_PASSING]: { [PS_SLOT]: 'slot', [PS_RTC_TIME]: 'rtcTime', [PS_DECODER_ID]: 'decoderId',
                  [PS_PASSING_NUMBER]: 'passingNumber', [PS_PEAK_HEIGHT]: 'peakHeight',
                  [PS_FLAGS]: 'flags' },
  [RT_STATUS]: { [ST_SLOT]: 'slot', [ST_FLAGS]: 'flags', [ST_BATTERY]: 'batteryVoltage',
                 [ST_LAST_RSSI]: 'lastRssi', [ST_GATE_STATE]: 'gateState',
                 [ST_DETECT_COUNT]: 'detectionCount' },
  [RT_RSSI]: { 0x01: 'slot', 0x07: 'sampleCount', 0x20: 'minRssi',
               0x21: 'maxRssi', 0x22: 'meanRssi' },
  [RT_SETTINGS]: { [SET_STATUS_INTERVAL]: 'statusInterval', [SET_MIN_LAP]: 'minLapTime' },
  [RT_TIME]: { [TF_RTC_TIME]: 'rtcTime', [TF_TIME_RTC_TIME]: 'timeRtcTime' },
};
const SIZE_OF = { u8: 1, u16: 2, u32: 4, u64: 8, f32: 4 };
const SLOT_SCOPED = new Set(['lastRssi', 'minRssi', 'maxRssi', 'meanRssi', 'sampleCount']);

function readLE(dv, off, typ, size) {
  switch (typ) {
    case U8: return dv.getUint8(off);
    case U16: return dv.getUint16(off, true);
    case U32: return dv.getUint32(off, true);
    case F32: return dv.getFloat32(off, true);
    case U64: return readInt(dv, off, 8);     // no BigInt: older WebKit lacks getBigUint64, and Number is the target anyway
    default: return readInt(dv, off, size);
  }
}

function readInt(dv, off, size) {
  let v = 0;
  for (let i = size - 1; i >= 0; i--) v = v * 256 + dv.getUint8(off + i);
  return v;
}

const hex = buf => [...buf].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * rec: one unescaped record including SOR/EOR. Returns a plain object, or null.
 * Status records interleave slot/lastRssi pairs, so slot-scoped values are
 * collected into rec.slots[slotIndex] rather than flattened.
 */
export function decodeRecord(rec) {
  if (rec.length < 8 || rec[0] !== SOR) return null;
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const crcRx = dv.getUint16(3, true);
  const chk = rec.slice();
  chk[3] = 0; chk[4] = 0;
  if (crc16(chk) !== crcRx) return { type: 'crc_error', raw: hex(rec) };
  const rtype = dv.getUint16(5, true);
  const types = FIELD_TYPES[rtype] || {};
  const names = FIELD_NAMES[rtype] || {};
  const out = { type: RT_NAMES[rtype] || ('0x' + rtype.toString(16).padStart(4, '0')),
                rtype, slots: {} };
  let curSlot = null, i = 7;
  while (i < rec.length - 1) {
    if (rec[i] === EOR) break;
    const sig = rec[i], size = rec[i + 1];
    if (i + 2 + size > rec.length) break;
    const typ = types[sig];
    const val = (typ && SIZE_OF[typ] === size)
      ? readLE(dv, i + 2, typ, size)
      : ([1, 2, 4, 8].includes(size) ? readInt(dv, i + 2, size)
                                     : hex(rec.subarray(i + 2, i + 2 + size)));
    const name = names[sig] || ('f' + sig.toString(16).padStart(2, '0'));
    if ((rtype === RT_STATUS || rtype === RT_RSSI) && name === 'slot') {
      curSlot = val;
      if (!out.slots[curSlot]) out.slots[curSlot] = {};
    } else if ((rtype === RT_STATUS || rtype === RT_RSSI) && curSlot !== null && SLOT_SCOPED.has(name)) {
      (out.slots[curSlot] ||= {})[name] = val;
    } else {
      out[name] = val;
    }
    i += 2 + size;
  }
  return out;
}

/**
 * Extract complete records from buf.
 * Returns {records, rest} so a partial tail can be re-fed on the next read.
 */
export function splitRecords(buf) {
  const records = [];
  let pos = 0;
  for (;;) {
    let sor = -1;
    for (let i = pos; i < buf.length; i++) if (buf[i] === SOR) { sor = i; break; }
    if (sor < 0) { pos = buf.length; break; }
    let i = sor + 1, esc = false, end = -1;
    for (; i < buf.length; i++) {
      const b = buf[i];
      if (esc) esc = false;
      else if (b === ESC) esc = true;
      else if (b === EOR) { end = i; break; }
    }
    if (end < 0) { pos = sor; break; }      // incomplete: keep from sor onwards
    records.push(unescape(buf.subarray(sor, end + 1)));
    pos = end + 1;
  }
  return { records, rest: buf.subarray(pos) };
}

/* The magic sequence that switches a LapRF's USB endpoint from its ASCII debug
 * stream to the binary protocol. Device must be power-cycled afterwards. */
export const ENABLE_BINARY = Uint8Array.from([0x55, 0x70, 0x70, 0x0d, 0x0a]);
