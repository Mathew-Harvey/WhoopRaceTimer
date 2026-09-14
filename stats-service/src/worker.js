/* The public stats service.
 *
 * A Cloudflare Worker and a D1 database, and deliberately almost nothing else.
 * It holds lap times and a name somebody typed, keyed by a uuid their browser
 * generated. There are no accounts, no email addresses, no passwords and no
 * password resets, because there is nothing here worth stealing and an account
 * system would collect more than the feature needs.
 *
 * OWNERSHIP. The browser generates a secret alongside the uuid and keeps it.
 * Only its SHA-256 is stored, so this database cannot be used to impersonate
 * anyone in it. Presenting the secret is what proves a rename or a delete comes
 * from the person who published — and it is the only proof there is, so a
 * cleared browser means a pilot page that can no longer be taken down by its
 * owner. That is written down in the app before anybody agrees to anything.
 *
 * The aggregation is imported from the app itself rather than reimplemented.
 * Two implementations of "which laps count" would disagree eventually, and the
 * disagreement would be a pilot's public record contradicting their own phone.
 */
import { aggregate, leaderboard } from '../../static/js/aggregate.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_RE = /^[0-9a-f]{32,128}$/i;

/* Bounds. Every one of these is a refusal rather than a truncation: silently
 * storing a shortened version of what somebody sent makes their public page
 * disagree with their phone, and they cannot see why. */
const LIMITS = {
  body: 256 * 1024,
  name: 32,
  track: 40,
  runId: 64,
  laps: 500,
  lapSeconds: 3600,
};

/* ------------------------------------------------------------------ util -- */

const now = () => Math.floor(Date.now() / 1000);

function json(data, status, env, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(env), ...extra },
  });
}

function cors(env) {
  return {
    'access-control-allow-origin': (env && env.ALLOWED_ORIGIN) || '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

const fail = (env, status, error) => json({ error }, status, env);

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Compare without leaking where two hex strings first differ. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The app's own rule, applied again here. A client-side check is a
 *  convenience; this is the boundary. */
function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, LIMITS.name)
    .trim();
}

/** A track name lands on the same public page as a display name and gets the
 *  same treatment. Empty means the session was flown before anybody named a
 *  track, which is a real answer and is stored as NULL. */
function cleanTrack(raw) {
  if (raw == null) return null;
  const t = String(raw)
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, LIMITS.track)
    .trim();
  return t || null;
}

/* ------------------------------------------------------------ validation -- */

function badSession(s) {
  if (!s || typeof s !== 'object') return 'no session';
  if (typeof s.runId !== 'string' || !s.runId || s.runId.length > LIMITS.runId) return 'bad runId';
  if (!Number.isFinite(s.at) || s.at < 946684800) return 'bad timestamp';
  /* A session claiming to be from next year is a clock problem on the device,
   * and accepting it puts a pilot at the top of a month they have not flown. */
  if (s.at > now() + 86400) return 'timestamp is in the future';
  if (s.track != null && typeof s.track !== 'string') return 'bad track';
  const e = s.entry;
  if (!e || typeof e !== 'object') return 'no entry';
  if (!Array.isArray(e.lapTimes)) return 'no lap times';
  if (e.lapTimes.length > LIMITS.laps) return 'too many laps';
  for (const t of e.lapTimes) {
    if (!Number.isFinite(t) || t <= 0 || t > LIMITS.lapSeconds) return 'bad lap time';
  }
  return null;
}

/** The shape aggregate() reads: a history record with one pilot in it. */
function toRecord(row) {
  return {
    runId: row.run_id,
    at: row.at,
    mode: row.mode,
    track: row.track || null,
    consecN: row.consec_n || 3,
    minLap: row.min_lap,
    holeshot: !!row.holeshot,
    duration: row.duration,
    results: [{
      pos: row.pos, name: '', channel: row.channel,
      laps: null, best: null, consec: null, total: null,
      lapTimes: JSON.parse(row.lap_times || '[]'),
    }],
  };
}

async function sessionsFor(env, pilotId) {
  const { results } = await env.DB
    .prepare('SELECT * FROM sessions WHERE pilot_id = ?1 ORDER BY at ASC')
    .bind(pilotId).all();
  return (results || []).map(toRecord);
}

/** Recompute the denormalised summary a leaderboard reads. */
async function refreshSummary(env, pilotId) {
  const rec = aggregate(await sessionsFor(env, pilotId), { match: () => true });
  await env.DB.prepare(
    `UPDATE pilots SET best_lap = ?2, best_consec = ?3, laps_clean = ?4,
            sessions_n = ?5, air_time_s = ?6, last_at = ?7, updated_at = ?8
       WHERE id = ?1`)
    .bind(pilotId, rec.best.lap, rec.best.consec, rec.totals.lapsClean,
          rec.totals.sessions, rec.totals.airTimeS, rec.totals.lastAt, now())
    .run();
  return rec;
}

/** Look a pilot up and check the secret. Returns the row, or a Response. */
async function authorise(env, pilotId, secret) {
  if (!UUID_RE.test(String(pilotId || ''))) return fail(env, 400, 'bad pilot id');
  if (!SECRET_RE.test(String(secret || ''))) return fail(env, 400, 'bad secret');
  const row = await env.DB.prepare('SELECT * FROM pilots WHERE id = ?1').bind(pilotId).first();
  if (!row) return fail(env, 404, 'no such pilot');
  if (!sameSecret(row.secret_hash, await sha256Hex(secret))) return fail(env, 403, 'not yours');
  return row;
}

/* --------------------------------------------------------------- handlers -- */

async function postSession(env, body) {
  const { pilotId, pilotName, secret, session } = body;
  if (!UUID_RE.test(String(pilotId || ''))) return fail(env, 400, 'bad pilot id');
  if (!SECRET_RE.test(String(secret || ''))) return fail(env, 400, 'bad secret');

  const name = cleanName(pilotName);
  if (name.length < 2) return fail(env, 400, 'bad name');

  const problem = badSession(session);
  if (problem) return fail(env, 400, problem);

  const hash = await sha256Hex(secret);
  const existing = await env.DB.prepare('SELECT * FROM pilots WHERE id = ?1').bind(pilotId).first();

  if (!existing) {
    /* First session from this uuid: it becomes the pilot, and the secret it
     * arrived with becomes the one that owns it from now on. */
    await env.DB.prepare(
      `INSERT INTO pilots (id, name, secret_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`)
      .bind(pilotId, name, hash, now()).run();
  } else {
    if (!sameSecret(existing.secret_hash, hash)) return fail(env, 403, 'not yours');
    const cap = Number(env.MAX_SESSIONS_PER_PILOT || 2000);
    if (existing.sessions_n >= cap) return fail(env, 429, 'this pilot has enough sessions');
    if (existing.name !== name) {
      await env.DB.prepare('UPDATE pilots SET name = ?2, updated_at = ?3 WHERE id = ?1')
        .bind(pilotId, name, now()).run();
    }
  }

  const e = session.entry;
  /* Replace rather than reject: a race that was finished, had a lap undone and
   * was finished again is one session, and the app re-sends it under the same
   * runId precisely so the second version wins. */
  await env.DB.prepare(
    `INSERT INTO sessions (pilot_id, run_id, at, mode, track, consec_n, min_lap, holeshot,
                           duration, channel, pos, lap_times, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
     ON CONFLICT(pilot_id, run_id) DO UPDATE SET
       at=excluded.at, mode=excluded.mode, track=excluded.track,
       consec_n=excluded.consec_n,
       min_lap=excluded.min_lap, holeshot=excluded.holeshot,
       duration=excluded.duration, channel=excluded.channel, pos=excluded.pos,
       lap_times=excluded.lap_times`)
    .bind(pilotId, session.runId, Math.floor(session.at), session.mode || null,
          cleanTrack(session.track),
          session.consecN || 3, session.minLap ?? null, session.holeshot ? 1 : 0,
          session.duration ?? null, e.channel || null, e.pos ?? null,
          JSON.stringify(e.lapTimes), now())
    .run();

  const rec = await refreshSummary(env, pilotId);
  return json({ ok: true, pilotId, best: rec.best.lap, sessions: rec.totals.sessions }, 200, env);
}

/**
 * One pilot's record, optionally narrowed to one track.
 *
 * `track` is the query parameter as it arrived: absent (null) is every track,
 * present and empty is the sessions flown before anybody named one, and
 * anything else is that track. The narrowing is aggregate()'s, not a second
 * implementation here, for the same reason the aggregation itself is shared --
 * a public page that disagrees with the pilot's own phone about which laps
 * count is the failure this arrangement exists to prevent.
 */
async function getPilot(env, pilotId, track = null) {
  if (!UUID_RE.test(String(pilotId || ''))) return fail(env, 400, 'bad pilot id');
  if (track != null && track.length > LIMITS.track) return fail(env, 400, 'bad track');
  const row = await env.DB.prepare('SELECT * FROM pilots WHERE id = ?1').bind(pilotId).first();
  if (!row) return fail(env, 404, 'no such pilot');

  const record = aggregate(await sessionsFor(env, pilotId), { match: () => true, track });
  record.pilotName = row.name;
  return json({
    pilot: { id: row.id, name: row.name, since: row.created_at },
    record,
  }, 200, env, { 'cache-control': 'public, max-age=60' });
}

async function getLeaderboard(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, best_lap, best_consec, laps_clean, sessions_n, air_time_s, last_at
       FROM pilots WHERE sessions_n > 0
       ORDER BY (best_lap IS NULL), best_lap ASC LIMIT 500`).all();

  const table = leaderboard((results || []).map(r => ({
    pilotId: r.id,
    pilotName: r.name,
    best: { lap: r.best_lap, consec: r.best_consec },
    totals: { lapsClean: r.laps_clean, sessions: r.sessions_n,
              airTimeS: r.air_time_s, lastAt: r.last_at },
  })));
  return json({ pilots: table }, 200, env, { 'cache-control': 'public, max-age=60' });
}

async function postRename(env, body) {
  const who = await authorise(env, body.pilotId, body.secret);
  if (who instanceof Response) return who;
  const name = cleanName(body.name);
  if (name.length < 2) return fail(env, 400, 'bad name');
  await env.DB.prepare('UPDATE pilots SET name = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(who.id, name, now()).run();
  return json({ ok: true, name }, 200, env);
}

async function postDelete(env, body) {
  const who = await authorise(env, body.pilotId, body.secret);
  if (who instanceof Response) return who;
  /* Sessions first: the foreign key cascade depends on a pragma that is not on
   * by default in D1, and a pilot row deleted out from under its sessions
   * leaves lap times with nobody to own them. */
  await env.DB.prepare('DELETE FROM sessions WHERE pilot_id = ?1').bind(who.id).run();
  await env.DB.prepare('DELETE FROM pilots WHERE id = ?1').bind(who.id).run();
  return json({ ok: true, deleted: true }, 200, env);
}

/* ------------------------------------------------------------------ router -- */

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

  if (request.method === 'GET') {
    if (path === '/' || path === '/v1') {
      return json({ service: 'whooptimer-stats', endpoints: ['/v1/pilots', '/v1/pilots/:id'] }, 200, env);
    }
    if (path === '/v1/pilots') return getLeaderboard(env);
    const m = path.match(/^\/v1\/pilots\/([^/]+)$/);
    if (m) {
      return getPilot(env, decodeURIComponent(m[1]),
                      url.searchParams.has('track') ? url.searchParams.get('track') : null);
    }
    return fail(env, 404, 'no such endpoint');
  }

  if (request.method !== 'POST') return fail(env, 405, 'method not allowed');

  const raw = await request.text();
  if (raw.length > LIMITS.body) return fail(env, 413, 'too big');
  let body;
  try { body = JSON.parse(raw || '{}'); } catch (e) { return fail(env, 400, 'not json'); }
  if (!body || typeof body !== 'object') return fail(env, 400, 'not an object');

  try {
    if (path === '/v1/sessions') return await postSession(env, body);
    if (path === '/v1/pilots/rename') return await postRename(env, body);
    if (path === '/v1/pilots/delete') return await postDelete(env, body);
  } catch (err) {
    /* Never echo an internal error to a public endpoint. */
    console.error('[stats]', err && err.stack || err);
    return fail(env, 500, 'something went wrong');
  }
  return fail(env, 404, 'no such endpoint');
}

export default { fetch: handle };
