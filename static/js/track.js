/* Where you are flying.
 *
 * A track is a property of a session, not of a pilot: the same person flies a
 * hall on Tuesday and a field on Sunday, and a personal best set on a
 * 12-second indoor course says nothing about a 30-second outdoor one. So the
 * name is recorded on each session as it is saved, and the stats can be
 * narrowed to one place.
 *
 * It is an arbitrary string the pilot types. There is no list of tracks and no
 * registry: a club knows what it calls its own field, and making them pick
 * from somebody else's list would be worse than useless.
 */
'use strict';
import { trackKey } from './aggregate.js';
import * as pilot from './pilot.js';
import * as publish from './publish.js';
import * as store from './store.js';

export { trackKey };

export const MAX = 40;

/**
 * A flying night belongs to the day it started on.
 *
 * Racing that begins at nine and finishes at half past midnight is one night,
 * and asking "what track are you flying tonight?" again at 00:01 because the
 * calendar rolled over would be absurd. Four in the morning is the boundary:
 * nobody is mid-session then, and nobody has started one either.
 *
 * This is only used for the question. The stats still bucket by calendar day,
 * because that is what a date means to everybody reading them.
 */
const NIGHT_OFFSET_S = 4 * 3600;

const pad = n => String(n).padStart(2, '0');

export function nightKey(atSeconds = Date.now() / 1000) {
  const d = new Date((atSeconds - NIGHT_OFFSET_S) * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ---------------------------------------------------------------- naming -- */

/** The same rules as a pilot name, because it lands on the same public page:
 *  trimmed, length-capped, no control characters and no angle brackets. The
 *  service checks this again -- a client-side rule is a convenience, never a
 *  boundary. */
export function cleanTrack(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    /* Spelled as escapes rather than written literally: real control bytes in
     * a source file make it binary to git and grep and invisible in an editor. */
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, MAX)
    .trim();
}

export function trackProblem(raw) {
  const t = cleanTrack(raw);
  if (t.length < 2) return 'Give the track a name of at least two characters.';
  return null;
}

/* ---------------------------------------------------------------- current -- */

const DEFAULT = { name: '', setAt: null, askedNight: null };

export function get() {
  return { ...DEFAULT, ...store.load('track', {}) };
}

/** The name to stamp on a session saved right now, or null. */
export function currentName() {
  return get().name || null;
}

/** Whether tonight's track is settled -- named tonight, or asked and waved
 *  away tonight. Either way the question has been put, and it does not come
 *  back until the next night's flying. */
export function settledTonight() {
  const t = get();
  const tonight = nightKey();
  return (!!t.name && nightKey(t.setAt) === tonight) || t.askedNight === tonight;
}

/** Asked and not answered. Do not ask again until tomorrow night. */
export function markAsked() {
  return store.save('track', { ...get(), askedNight: nightKey() });
}

/**
 * Name tonight's track.
 *
 * Returns { name, tagged, requeued }: sessions already flown tonight that
 * nobody had named a track for are stamped with it too. Somebody who flies
 * three races and then answers the question flew all three here, and leaving
 * the first two blank would be a worse record than not asking at all.
 */
export function set(raw) {
  const name = cleanTrack(raw);
  const problem = trackProblem(name);
  if (problem) throw new Error(problem);
  const at = Math.floor(Date.now() / 1000);
  store.save('track', { name, setAt: at, askedNight: nightKey(at) });
  return { name, ...backfillTonight(name) };
}

/** Stop recording a track, without touching anything already saved. */
export function clear() {
  return store.save('track', { ...get(), name: '', setAt: null });
}

/** Stamp a finished session, in place, on its way to the history. */
export function stamp(session) {
  if (session && !session.track) {
    const name = currentName();
    if (name) session.track = name;
  }
  return session;
}

/**
 * Fill in tonight's untracked sessions.
 *
 * A session already sent to the stats service has to go again, or the pilot's
 * public page says "no track" for a night their phone says was Bunbury. The
 * service replaces a session it already has by runId, so re-sending is an
 * update rather than a duplicate -- the same mechanism an undone lap already
 * relies on.
 */
function backfillTonight(name) {
  const tonight = nightKey();
  const history = store.load('history', []);
  let tagged = 0, requeued = 0;
  for (const s of history) {
    if (!s.at || s.track || nightKey(s.at) !== tonight) continue;
    s.track = name;
    tagged++;
    if (pilot.hasPublished(s.runId)) {
      pilot.unmarkPublished(s.runId);
      const entry = pilot.entryFor(s, pilot.get().name);
      if (entry && publish.enqueue(s, entry)) requeued++;
    }
  }
  if (tagged) {
    store.save('history', history);
    if (requeued) publish.flush().catch(() => {});
  }
  return { tagged, requeued };
}

/* ------------------------------------------------------------------ known -- */

/**
 * Every track this browser has a session for, most recently flown first.
 *
 * Offered as buttons in the sheet so the second night at a track is one tap and
 * cannot be a typo -- which is also what keeps the stats filter from filling up
 * with three spellings of the same field.
 */
export function known(history = store.load('history', [])) {
  const seen = new Map();
  for (const s of history) {
    const key = trackKey(s.track);
    if (!key) continue;
    const cur = seen.get(key);
    if (!cur || (s.at || 0) >= cur.at) {
      seen.set(key, { key, name: cleanTrack(s.track), at: s.at || 0 });
    }
  }
  const now = get();
  if (now.name && !seen.has(trackKey(now.name))) {
    seen.set(trackKey(now.name), { key: trackKey(now.name), name: now.name, at: now.setAt || 0 });
  }
  return [...seen.values()].sort((a, b) => b.at - a.at);
}
