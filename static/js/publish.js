/* Sending a session to the public stats service, and coping when that fails.
 *
 * Which it will, most of the time, at the moment it matters: a session ends at
 * a track, and a track is exactly where there is no signal. So nothing here
 * blocks anything. A finished session goes into a queue in this browser and the
 * queue drains whenever the network comes back — on load, when the browser says
 * it is online again, and after each successful send.
 *
 * If no service is configured this whole file is inert and the app is what it
 * has always been: a timer with its history in one browser and nothing
 * uploaded anywhere.
 */
'use strict';
import * as pilot from './pilot.js';
import * as store from './store.js';

/* Where the stats service lives.
 *
 * Empty by default, and empty means the public leaderboard does not exist:
 * the Stats screen still works, on this browser's own history, and nothing is
 * ever sent. Set this to a deployed worker's origin to turn publishing on for
 * everybody using this copy of the app. See stats-service/README.md.
 *
 * A localStorage override sits in front of it so a development build can be
 * pointed at a local worker without editing and redeploying the site. */
export const SERVICE_URL = '';

export function serviceUrl() {
  const override = store.load('statsService', null);
  const url = (override || SERVICE_URL || '').trim().replace(/\/+$/, '');
  return url || null;
}

export function configured() {
  return !!serviceUrl();
}

/** The link somebody shares. Null when there is no service to link to. */
export function pilotUrl(id) {
  if (!configured() || !id) return null;
  return `${location.origin}/stats/?pilot=${encodeURIComponent(id)}`;
}

/* ----------------------------------------------------------------- queue -- */

const QUEUE_CAP = 200;

export function queue() {
  return store.load('publishQueue', []);
}

function setQueue(q) {
  return store.save('publishQueue', q.slice(-QUEUE_CAP));
}

export function queueSize() {
  return queue().length;
}

/**
 * Put one session's own entry on the queue.
 *
 * Only the consenting pilot's entry travels. A saved session holds everyone who
 * raced, and uploading all of them would publish three other people's names on
 * the strength of one person's consent.
 */
export function enqueue(session, entry, who = pilot.get()) {
  if (!session || !entry || !who.id) return false;
  if (pilot.hasPublished(session.runId)) return false;
  const q = queue();
  if (q.some(item => item.session.runId === session.runId)) return false;

  q.push({
    queuedAt: Math.floor(Date.now() / 1000),
    session: {
      runId: session.runId,
      at: session.at,
      mode: session.mode,
      track: session.track || null,
      consecN: session.consecN,
      minLap: session.minLap,
      holeshot: session.holeshot,
      duration: session.duration,
      /* One entry, flattened: the pilot's own laps and nothing about anybody
       * else who happened to be in the same race. */
      entry: {
        channel: entry.channel || null,
        pos: entry.pos || null,
        laps: entry.laps || (entry.lapTimes || []).length,
        lapTimes: entry.lapTimes || [],
      },
    },
  });
  setQueue(q);
  return true;
}

/** Drop a queued session without sending it. */
export function drop(runId) {
  setQueue(queue().filter(item => item.session.runId !== runId));
}

export function clearQueue() {
  setQueue([]);
}

/* ---------------------------------------------------------------- sending -- */

let flushing = false;

async function post(path, body, { timeoutMs = 12000 } = {}) {
  const url = serviceUrl();
  if (!url) throw new Error('no stats service configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `service said ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function get(path, { timeoutMs = 12000 } = {}) {
  const url = serviceUrl();
  if (!url) throw new Error('no stats service configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url + path, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`service said ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send whatever is queued.
 *
 * Returns { sent, failed, remaining }. Never throws: a failure here must not
 * be able to interrupt a race, and the queue is the retry.
 */
export async function flush() {
  if (flushing || !configured() || !pilot.isPublic()) {
    return { sent: 0, failed: 0, remaining: queueSize() };
  }
  const who = pilot.get();
  if (!who.id || !who.secret) return { sent: 0, failed: 0, remaining: queueSize() };

  flushing = true;
  let sent = 0, failed = 0;
  try {
    /* One at a time and stop on the first failure. A queue that keeps trying
     * every item against a service that is down turns one dead network into
     * fifty timeouts and a flat battery. */
    for (const item of [...queue()]) {
      try {
        await post('/v1/sessions', {
          pilotId: who.id,
          pilotName: who.name,
          secret: who.secret,
          session: item.session,
        });
        pilot.markPublished(item.session.runId);
        drop(item.session.runId);
        sent++;
      } catch (err) {
        /* A refusal is permanent: the service has looked at this and said no,
         * so retrying it forever blocks everything behind it. Anything else is
         * the network, and the queue is exactly the right place to wait. */
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
          drop(item.session.runId);
          failed++;
          console.warn('[stats] service refused a session, dropping it:', err.message);
          continue;
        }
        failed++;
        break;
      }
    }
  } finally {
    flushing = false;
  }
  return { sent, failed, remaining: queueSize() };
}

/** Change the public display name. */
export async function rename(newName) {
  const who = pilot.get();
  const clean = pilot.cleanName(newName);
  const problem = pilot.nameProblem(clean);
  if (problem) throw new Error(problem);
  if (configured() && who.id && who.secret) {
    await post('/v1/pilots/rename', { pilotId: who.id, secret: who.secret, name: clean });
  }
  pilot.save({ name: clean });
  return clean;
}

/** Take everything down. The secret is what proves this is the same person who
 *  put it up, which is the whole of the ownership model — no account, no email,
 *  and nothing recoverable if this browser's storage is cleared. */
export async function deleteEverything() {
  const who = pilot.get();
  if (configured() && who.id && who.secret) {
    await post('/v1/pilots/delete', { pilotId: who.id, secret: who.secret });
  }
  clearQueue();
  pilot.forget();
}

/* ----------------------------------------------------------------- public -- */

/** One pilot's record. `track` narrows it: null for every track, '' for the
 *  sessions flown before one was named, or the track's name. */
export function fetchPilot(id, track = null) {
  const q = track == null ? '' : `?track=${encodeURIComponent(track)}`;
  return get(`/v1/pilots/${encodeURIComponent(id)}${q}`);
}

export function fetchLeaderboard() {
  return get('/v1/pilots');
}

/* --------------------------------------------------------------- lifecycle -- */

let wired = false;

/** Drain on load and whenever the network returns. Called once, by the app. */
export function autoFlush(onResult) {
  if (wired) return;
  wired = true;
  const go = () => {
    flush().then(r => { if (r.sent && onResult) onResult(r); }).catch(() => {});
  };
  addEventListener('online', go);
  /* Coming back to the tab at the end of a night is the other moment the
   * network is likely to be there again. */
  addEventListener('visibilitychange', () => { if (!document.hidden) go(); });
  go();
}
