/* Naming the track, and what naming it does to what is already saved.
 *
 * Two things here are easy to get wrong in a way that looks fine. A flying
 * night that runs past midnight is still one night, and asking again at 00:01
 * because the calendar rolled over is the kind of bug nobody reports and
 * everybody notices. And answering the question after three races has to reach
 * back over those three races, including the ones already uploaded, or the
 * pilot's public page and their phone disagree about where they were.
 *
 *   node tests/test_track.mjs
 */

/* localStorage, in a Map, before anything that reads it is imported. */
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: k => { mem.delete(k); },
  clear: () => mem.clear(),
};

const track = await import('../static/js/track.js');
const pilot = await import('../static/js/pilot.js');
const publish = await import('../static/js/publish.js');
const store = await import('../static/js/store.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
}
const eq = (name, got, want) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const realNow = Date.now;
const at = (y, m, d, hh, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime() / 1000;
const freeze = seconds => { Date.now = () => seconds * 1000; };
const thaw = () => { Date.now = realNow; };
const reset = () => { mem.clear(); thaw(); };

/* ------------------------------------------------------------- the night -- */
{
  eq('an evening belongs to its own day', track.nightKey(at(2026, 9, 13, 21)), '2026-09-13');
  eq('and so does half past midnight after it',
     track.nightKey(at(2026, 9, 14, 0, 30)), '2026-09-13');
  eq('  and three in the morning', track.nightKey(at(2026, 9, 14, 3, 0)), '2026-09-13');
  eq('the next morning is a new night', track.nightKey(at(2026, 9, 14, 9)), '2026-09-14');
}

/* -------------------------------------------------------------- cleaning -- */
{
  eq('whitespace collapses', track.cleanTrack('  Bunbury   hall '), 'Bunbury hall');
  eq('angle brackets go', track.cleanTrack('<b>Shed</b>'), 'bShed/b');
  eq('a long name is capped', track.cleanTrack('x'.repeat(90)).length, track.MAX);
  eq('a control character does not survive',
     track.cleanTrack('Bun' + String.fromCharCode(7) + 'bury'), 'Bunbury');
  check('one character is not a track name', !!track.trackProblem('x'));
  eq('two is', track.trackProblem('Oz'), null);
  eq('spellings of one place share a key', track.trackKey(' BUNBURY '), track.trackKey('bunbury'));
}

/* -------------------------------------------------------------- settling -- */
{
  reset();
  freeze(at(2026, 9, 13, 19));
  check('nothing is settled before anybody is asked', !track.settledTonight());
  eq('and there is no track to stamp', track.currentName(), null);

  track.markAsked();
  check('waving the question away settles tonight', track.settledTonight());
  eq('  without inventing a track', track.currentName(), null);

  freeze(at(2026, 9, 14, 0, 45));
  check('and it is still settled after midnight', track.settledTonight());

  freeze(at(2026, 9, 14, 19));
  check('but the question comes back the next night', !track.settledTonight());

  track.set('Bunbury');
  eq('naming it settles tonight too', track.currentName(), 'Bunbury');
  check('  and it is settled', track.settledTonight());

  freeze(at(2026, 9, 20, 19));
  eq('a track set last week is still the track', track.currentName(), 'Bunbury');
  check('  but it is asked about again on a new night', !track.settledTonight());
  reset();
}

/* --------------------------------------------------------------- stamping -- */
{
  reset();
  freeze(at(2026, 9, 13, 19));
  track.set('Bunbury');
  eq('a saved session is stamped', track.stamp({ at: Date.now() / 1000 }).track, 'Bunbury');
  eq('  and one that already names a track is left alone',
     track.stamp({ track: 'Elsewhere' }).track, 'Elsewhere');
  track.clear();
  eq('with no track there is nothing to stamp',
     track.stamp({ at: Date.now() / 1000 }).track, undefined);
  reset();
}

/* ------------------------------------------------------------- back-fill -- */
{
  reset();
  const mk = (runId, when) => ({
    runId, at: when, mode: 'practice', consecN: 3, minLap: 1,
    results: [{ pos: 1, name: 'Kez', channel: 'R1', lapTimes: [24, 23.8, 24.1] }],
  });

  store.save('history', [
    mk('old', at(2026, 9, 6, 20)),            /* last week */
    mk('early', at(2026, 9, 13, 19, 30)),     /* tonight, before the question */
    mk('late', at(2026, 9, 14, 0, 20)),       /* tonight, after midnight */
    mk('tagged', at(2026, 9, 13, 21)),        /* tonight, already named */
  ]);
  const h0 = store.load('history', []);
  h0[3].track = 'Somewhere else';
  store.save('history', h0);

  /* One of tonight's sessions has already gone up. */
  pilot.acceptPublic('Kez');
  pilot.markPublished('early');

  freeze(at(2026, 9, 14, 0, 40));
  const r = track.set('Bunbury');
  eq('tonight is tagged, both sides of midnight', r.tagged, 2);
  eq('  and the one already uploaded goes again', r.requeued, 1);

  const after = store.load('history', []);
  const by = id => after.find(s => s.runId === id);
  eq('last week is not touched', by('old').track, undefined);
  eq('tonight, before the question, is', by('early').track, 'Bunbury');
  eq('and after midnight too', by('late').track, 'Bunbury');
  eq('a session that already named a track keeps it', by('tagged').track, 'Somewhere else');

  check('the re-send is on the queue', publish.queue().some(i => i.session.runId === 'early'));
  eq('  carrying the track', publish.queue().find(i => i.session.runId === 'early').session.track,
     'Bunbury');
  check('  and it is no longer counted as published', !pilot.hasPublished('early'));
  reset();
}

/* ----------------------------------------------------------------- known -- */
{
  reset();
  store.save('history', [
    { runId: 'a', at: 100, track: 'Bunbury', results: [] },
    { runId: 'b', at: 300, track: ' bunbury ', results: [] },
    { runId: 'c', at: 200, track: 'Perth Hall', results: [] },
    { runId: 'd', at: 400, results: [] },
  ]);
  const k = track.known();
  eq('one entry per place', k.length, 2);
  eq('  most recently flown first', k[0].key, 'bunbury');
  eq('  spelled the way it was last typed', k[0].name, 'bunbury');
  eq('  and the other is there too', k[1].name, 'Perth Hall');
  reset();
}

thaw();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('tracks: nights, cleaning, stamping and the back-fill all hold');
