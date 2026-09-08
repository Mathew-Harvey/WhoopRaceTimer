/* Persistence.
 *
 * Everything the app knows lives in this browser. An early version of the
 * server kept pilot channels in memory only: a restart silently reset them to
 * defaults, and the next config write pushed those defaults onto the timer,
 * overwriting the real race frequencies. Anything that can be written to the
 * hardware is saved here first.
 */
'use strict';

const NS = 'wt.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw == null ? fallback : (JSON.parse(raw) ?? fallback);
  } catch (e) { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch (e) {}
  return value;
}

export function clear(key) {
  try { localStorage.removeItem(NS + key); } catch (e) {}
}

export const DEFAULT_SETTINGS = {
  mode: 'practice',
  targetLaps: 5,
  targetSeconds: 120,
  consecN: 3,
  minLap: 3.0,
  holeshot: false,
  countdown: 5,
  timerMinLapMs: 3000,
  preset: 'normal',
};

export const DEFAULT_PREFS = {
  voiceOn: true,
  voiceName: '',
  rate: 1.1,
  announce: 'full',      // full: "Lap 3, 24.7" | time: "24.7" | off
  theme: 'dark',
  keepAwake: true,
};

export function settings() { return { ...DEFAULT_SETTINGS, ...load('settings', {}) }; }
export function prefs() { return { ...DEFAULT_PREFS, ...load('prefs', {}) }; }

/** Save a finished session. A race that ended, had its last lap undone and
 *  ended again is one race, not two: an entry with the same runId is replaced. */
export function appendHistory(entry, cap = 200) {
  const h = load('history', []);
  entry.savedAt = Date.now() / 1000;
  const i = entry.runId ? h.findIndex(e => e.runId === entry.runId) : -1;
  if (i >= 0) h[i] = entry; else h.push(entry);
  return save('history', h.slice(-cap));
}

/** CSV of every saved session, the same shape the Python build exported. */
export function historyCsv() {
  const rows = [['session', 'when', 'mode', 'pos', 'pilot', 'channel',
                 'laps', 'best', 'best_consec', 'total', 'lap_times']];
  for (const r of load('history', [])) {
    const when = new Date((r.at || 0) * 1000).toISOString().slice(0, 16).replace('T', ' ');
    for (const e of r.results || []) {
      rows.push([r.name, when, r.mode, e.pos, e.name, e.channel, e.laps,
                 e.best ?? '', e.consec ?? '', e.total ?? '',
                 (e.lapTimes || []).map(x => x.toFixed(2)).join(' ')]);
    }
  }
  return rows.map(r => r.map(cell => {
    const s = String(cell ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}
