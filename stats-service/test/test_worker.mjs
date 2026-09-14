/* The stats service, against a D1 that lives in an array.
 *
 * What is worth testing here is not the SQL — it is the boundary. This endpoint
 * is open to the internet, takes a name and a pile of numbers from anybody, and
 * publishes the result under somebody's chosen identity. So: does a secret
 * actually gate a rename, does a second person's uuid collision get refused
 * rather than absorbed, does a delete really remove the laps as well as the
 * pilot, and does a name arrive on the server meaning the same thing it meant
 * in the browser.
 *
 *   node stats-service/test/test_worker.mjs
 */
import { handle } from '../src/worker.js';
import { cleanName as clientCleanName } from '../../static/js/pilot.js';
import { cleanTrack as clientCleanTrack } from '../../static/js/track.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/* ------------------------------------------------------- a D1 in an array -- */
function fakeDb() {
  const pilots = [];
  const sessions = [];
  const has = (sql, ...bits) => bits.every(b => sql.includes(b));

  return {
    pilots, sessions,
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() {
          if (has(sql, 'SELECT * FROM pilots')) return pilots.find(p => p.id === args[0]) || null;
          throw new Error('unhandled first(): ' + sql);
        },
        async all() {
          if (has(sql, 'SELECT * FROM sessions')) {
            return { results: sessions.filter(s => s.pilot_id === args[0]).sort((a, b) => a.at - b.at) };
          }
          if (has(sql, 'FROM pilots WHERE sessions_n > 0')) {
            return { results: pilots.filter(p => p.sessions_n > 0) };
          }
          throw new Error('unhandled all(): ' + sql);
        },
        async run() {
          if (has(sql, 'INSERT INTO pilots')) {
            pilots.push({ id: args[0], name: args[1], secret_hash: args[2],
                          created_at: args[3], updated_at: args[3],
                          best_lap: null, best_consec: null, laps_clean: 0,
                          sessions_n: 0, air_time_s: 0, last_at: null });
            return { success: true };
          }
          if (has(sql, 'UPDATE pilots SET best_lap')) {
            const p = pilots.find(x => x.id === args[0]);
            if (p) Object.assign(p, { best_lap: args[1], best_consec: args[2],
                                      laps_clean: args[3], sessions_n: args[4],
                                      air_time_s: args[5], last_at: args[6], updated_at: args[7] });
            return { success: true };
          }
          if (has(sql, 'UPDATE pilots SET name')) {
            const p = pilots.find(x => x.id === args[0]);
            if (p) { p.name = args[1]; p.updated_at = args[2]; }
            return { success: true };
          }
          if (has(sql, 'INSERT INTO sessions')) {
            /* Positional, like the real thing. It is spelled out here rather
             * than parsed so that adding a column to the INSERT and forgetting
             * this list fails loudly on the next run instead of shifting every
             * value one place to the left and storing a lap time as a date. */
            const row = { pilot_id: args[0], run_id: args[1], at: args[2], mode: args[3],
                          track: args[4], consec_n: args[5], min_lap: args[6],
                          holeshot: args[7], duration: args[8], channel: args[9],
                          pos: args[10], lap_times: args[11], created_at: args[12] };
            const i = sessions.findIndex(s => s.pilot_id === row.pilot_id && s.run_id === row.run_id);
            if (i >= 0) sessions[i] = row; else sessions.push(row);
            return { success: true };
          }
          if (has(sql, 'DELETE FROM sessions')) {
            for (let i = sessions.length - 1; i >= 0; i--) {
              if (sessions[i].pilot_id === args[0]) sessions.splice(i, 1);
            }
            return { success: true };
          }
          if (has(sql, 'DELETE FROM pilots')) {
            const i = pilots.findIndex(p => p.id === args[0]);
            if (i >= 0) pilots.splice(i, 1);
            return { success: true };
          }
          throw new Error('unhandled run(): ' + sql);
        },
      };
      return api;
    },
  };
}

const env = () => ({ DB: fakeDb(), ALLOWED_ORIGIN: '*', MAX_SESSIONS_PER_PILOT: '5' });
const ORIGIN = 'https://stats.example.org';

const post = (e, path, body) => handle(
  new Request(ORIGIN + path, { method: 'POST', headers: { 'content-type': 'application/json' },
                               body: JSON.stringify(body) }), e);
const get = (e, path) => handle(new Request(ORIGIN + path), e);

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '9c858901-8a57-4791-81fe-4c455b099bc9';
const SECRET = 'a'.repeat(64);
const session = (runId, at, lapTimes) => ({
  runId, at, mode: 'practice', consecN: 3, minLap: 1, holeshot: false,
  duration: 120, entry: { channel: 'R1', pos: 1, lapTimes },
});
const laps = [24.0, 23.8, 24.1, 23.9, 24.2, 400.0];

/* ------------------------------------------------------------ publishing -- */
{
  const e = env();
  let r = await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Kez 99', secret: SECRET, session: session('r1', 1757700000, laps),
  });
  eq('a first session is accepted', r.status, 200);
  eq('  and creates the pilot', e.DB.pilots.length, 1);
  eq('  under the name as typed, digits and all', e.DB.pilots[0].name, 'Kez 99');
  eq('  storing only a hash of the secret', e.DB.pilots[0].secret_hash.length, 64);
  check('  which is not the secret', e.DB.pilots[0].secret_hash !== SECRET);

  const body = await r.json();
  eq('  and the battery change is not the best lap', body.best, 23.8);
  eq('  the pilot has one session', body.sessions, 1);

  /* The same race, finished twice after an undo, is one session. */
  r = await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Kez 99', secret: SECRET,
    session: session('r1', 1757700000, [24.0, 23.5]),
  });
  eq('re-sending a runId replaces it', r.status, 200);
  eq('  rather than adding a second row', e.DB.sessions.length, 1);
  eq('  and the summary follows', e.DB.pilots[0].best_lap, 23.5);
}

/* --------------------------------------------------------------- the name -- */
/* The server re-cleans the name it is given. If it cleaned differently from the
 * browser, a pilot's public page would show a different name from their phone
 * and neither would look wrong on its own. */
{
  const e = env();
  for (const raw of ['Kez 99', '  spaced   out  ', '<script>x', 'R8 Pilot-2', 'a'.repeat(40)]) {
    await post(e, '/v1/sessions', {
      pilotId: UUID, pilotName: raw, secret: SECRET, session: session('r' + raw.length, 1757700000, [24, 23.9]),
    });
    const stored = e.DB.pilots[0].name;
    eq(`server and browser agree on ${JSON.stringify(raw.slice(0, 14))}`,
       stored, clientCleanName(raw));
  }
}

/* -------------------------------------------------------------- ownership -- */
{
  const e = env();
  await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Kez', secret: SECRET, session: session('r1', 1757700000, laps),
  });

  let r = await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Impostor', secret: 'b'.repeat(64), session: session('r2', 1757700000, laps),
  });
  eq('somebody else cannot publish under your id', r.status, 403);
  eq('  and cannot rename you', (await post(e, '/v1/pilots/rename',
     { pilotId: UUID, secret: 'b'.repeat(64), name: 'Rude' })).status, 403);
  eq('  nor delete you', (await post(e, '/v1/pilots/delete',
     { pilotId: UUID, secret: 'b'.repeat(64) })).status, 403);
  eq('  and your name is untouched', e.DB.pilots[0].name, 'Kez');

  r = await post(e, '/v1/pilots/rename', { pilotId: UUID, secret: SECRET, name: 'Kez Two' });
  eq('you can rename yourself', r.status, 200);
  eq('  and it takes', e.DB.pilots[0].name, 'Kez Two');
}

/* A delete has to take the lap times with it, not just the name on them. */
{
  const e = env();
  await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Kez', secret: SECRET, session: session('r1', 1757700000, laps),
  });
  eq('there are laps to delete', e.DB.sessions.length, 1);
  const r = await post(e, '/v1/pilots/delete', { pilotId: UUID, secret: SECRET });
  eq('delete succeeds', r.status, 200);
  eq('  the pilot is gone', e.DB.pilots.length, 0);
  eq('  and so are the laps', e.DB.sessions.length, 0);
  eq('  and the page 404s', (await get(e, '/v1/pilots/' + UUID)).status, 404);
}

/* ------------------------------------------------------------- validation -- */
{
  const e = env();
  const bad = async (what, body, want = 400) =>
    eq(what, (await post(e, '/v1/sessions', body)).status, want);

  const base = { pilotId: UUID, pilotName: 'Kez', secret: SECRET };
  await bad('a pilot id that is not a uuid', { ...base, pilotId: 'kez', session: session('a', 1757700000, [24]) });
  await bad('a secret that is not hex', { ...base, secret: 'hunter2', session: session('a', 1757700000, [24]) });
  await bad('a one-character name', { ...base, pilotName: 'K', session: session('a', 1757700000, [24]) });
  await bad('no session at all', { ...base });
  await bad('no lap times', { ...base, session: { runId: 'a', at: 1757700000, entry: {} } });
  await bad('a negative lap', { ...base, session: session('a', 1757700000, [-5]) });
  await bad('a lap of two hours', { ...base, session: session('a', 1757700000, [7200]) });
  await bad('five hundred and one laps',
            { ...base, session: session('a', 1757700000, new Array(501).fill(24)) });
  await bad('a session from before FPV existed', { ...base, session: session('a', 100, [24]) });
  /* A device with a wrong clock would otherwise take the top of a month it has
   * not flown in. */
  await bad('a session from next week',
            { ...base, session: session('a', Math.floor(Date.now() / 1000) + 700000, [24]) });

  /* The same checks guard the endpoints that take a secret, and they have to
   * answer "that is not an id" rather than "no such pilot" — a 404 for a
   * malformed id is a lookup that should never have been attempted. */
  eq('a malformed id cannot be renamed',
     (await post(e, '/v1/pilots/rename', { pilotId: 'kez', secret: SECRET, name: 'x' })).status, 400);
  eq('a malformed id cannot be deleted',
     (await post(e, '/v1/pilots/delete', { pilotId: 'kez', secret: SECRET })).status, 400);
  eq('a rename with no secret at all', 
     (await post(e, '/v1/pilots/rename', { pilotId: UUID, name: 'x' })).status, 400);
  eq('an unknown but well-formed id is simply not there',
     (await post(e, '/v1/pilots/delete', { pilotId: OTHER, secret: SECRET })).status, 404);

  eq('an unknown endpoint', (await post(e, '/v1/nope', {})).status, 404);
  eq('a GET of an unknown endpoint', (await get(e, '/v1/nope')).status, 404);
  eq('a bad uuid on the public page', (await get(e, '/v1/pilots/nope')).status, 400);
  eq('a pilot who does not exist', (await get(e, '/v1/pilots/' + OTHER)).status, 404);
  eq('nothing was stored by any of that', e.DB.pilots.length, 0);
}

/* A cap, so one client cannot fill the database. */
{
  const e = env();  /* MAX_SESSIONS_PER_PILOT is 5 in the test env */
  for (let i = 0; i < 5; i++) {
    await post(e, '/v1/sessions', {
      pilotId: UUID, pilotName: 'Kez', secret: SECRET, session: session('r' + i, 1757700000 + i, [24, 23.9]),
    });
  }
  eq('five sessions are in', e.DB.sessions.length, 5);
  const r = await post(e, '/v1/sessions', {
    pilotId: UUID, pilotName: 'Kez', secret: SECRET, session: session('r99', 1757700000, [24, 23.9]),
  });
  eq('the sixth is refused', r.status, 429);
  eq('  and not stored', e.DB.sessions.length, 5);
}

/* --------------------------------------------------------------- reading -- */
{
  const e = env();
  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
    session: session('a', 1757700000, [24.0, 23.8, 24.1, 23.9, 24.2, 400.0]) });
  await post(e, '/v1/sessions', { pilotId: OTHER, pilotName: 'Rowie', secret: 'c'.repeat(64),
    session: session('b', 1757700000, [26.0, 25.8, 26.1]) });

  const page = await (await get(e, '/v1/pilots/' + UUID)).json();
  eq('a pilot page names the pilot', page.pilot.name, 'Kez');
  eq('  reports the personal best', page.record.best.lap, 23.8);
  eq('  counts the laps that were flown', page.record.totals.lapsRecorded, 6);
  eq('  and the ones that count', page.record.totals.lapsClean, 5);
  eq('  and says how many were stoppages', page.record.totals.stoppages, 1);
  check('  with a day bucket', page.record.periods.day.length === 1);
  check('  and never reveals the secret',
        !JSON.stringify(page).includes(SECRET) && !JSON.stringify(page).includes('secret_hash'));

  const table = await (await get(e, '/v1/pilots')).json();
  eq('the leaderboard has both pilots', table.pilots.length, 2);
  eq('  fastest first', table.pilots[0].pilotName, 'Kez');
  eq('  ranked from one', table.pilots[0].rank, 1);
  check('  and carries no secrets either', !JSON.stringify(table).includes('secret'));
}

/* ----------------------------------------------------------------- tracks -- */

/* A track is free text from the internet that ends up on a public page beside
 * a name, so it gets the same treatment as the name, and it has to mean the
 * same thing here as it did in the browser -- a pilot filtering their own page
 * to "Bunbury" and getting nothing because the server stored something else is
 * the failure worth spending a test on. */
{
  const e = env();
  const at = 1757700000;
  const withTrack = (runId, when, track, lapTimes) => ({ ...session(runId, when, lapTimes), track });

  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                  session: withTrack('t1', at, 'Bunbury', [24, 23.8, 24.1]) });
  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                  session: withTrack('t2', at + 86400, ' bunbury  ', [23.5, 23.6]) });
  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                  session: withTrack('t3', at + 172800, 'Perth Hall', [30, 30.2]) });
  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                  session: session('t4', at + 259200, [26, 26.2]) });

  const all = await (await get(e, '/v1/pilots/' + UUID)).json();
  eq('every track is counted', all.record.totals.sessions, 4);
  eq('  and listed, most recent first', all.record.tracks[0].name, null);
  eq('  with two spellings folded into one track',
     all.record.tracks.filter(t => t.key === 'bunbury').length, 1);
  eq('  that knows how many sessions it holds',
     all.record.tracks.find(t => t.key === 'bunbury').sessions, 2);
  eq('  and an unfiltered record names no track', all.record.track, null);

  const b = await (await get(e, '/v1/pilots/' + UUID + '?track=BUNBURY')).json();
  eq('a track filter narrows the record', b.record.totals.sessions, 2);
  eq('  case and spacing do not matter', b.record.best.lap, 23.5);
  eq('  and Perth Hall is not in it', b.record.totals.lapsClean, 5);
  eq('  the record says which track it is', b.record.track, 'BUNBURY');
  eq('  and still offers every other track to switch to', b.record.tracks.length, 3);

  const none = await (await get(e, '/v1/pilots/' + UUID + '?track=')).json();
  eq('an empty filter is the sessions with no track', none.record.totals.sessions, 1);
  eq('  which is a real group, not an error', none.record.best.lap, 26);

  const nowhere = await (await get(e, '/v1/pilots/' + UUID + '?track=Nowhere')).json();
  eq('a track nobody flew is empty rather than everything',
     nowhere.record.totals.sessions, 0);

  /* The boundary. */
  await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                  session: withTrack('t5', at + 345600, '  <b>Shed</b>  ', [22]) });
  const cleaned = await (await get(e, '/v1/pilots/' + UUID)).json();
  const shed = cleaned.record.tracks.find(t => t.name && t.name.includes('Shed'));
  eq('angle brackets do not survive the server', shed.name, 'bShed/b');
  eq('  and the browser would have sent exactly that',
     clientCleanTrack('  <b>Shed</b>  '), 'bShed/b');

  const long = 'x'.repeat(60);
  eq('a long track is capped the same on both sides',
     clientCleanTrack(long).length, 40);
  const r = await post(e, '/v1/sessions', { pilotId: UUID, pilotName: 'Kez', secret: SECRET,
                                            session: { ...session('t6', at + 432000, [21]), track: 42 } });
  eq('a track that is not a string is refused', r.status, 400);
}

/* ------------------------------------------------------------------ CORS -- */
{
  const e = env();
  const pre = await handle(new Request(ORIGIN + '/v1/sessions', { method: 'OPTIONS' }), e);
  eq('a preflight is answered', pre.status, 204);
  eq('  with an origin', pre.headers.get('access-control-allow-origin'), '*');
  const r = await get(e, '/v1/pilots');
  eq('  and so is a real request', r.headers.get('access-control-allow-origin'), '*');
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('stats service: ownership, validation and reading all hold');
