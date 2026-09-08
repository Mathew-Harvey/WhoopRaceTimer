/* The spoken calibration flow, and the evidence rule behind it.
 *
 * Everything here is about what a pilot hears while holding a quad, so it is
 * pinned by the lines themselves. The failure this guards against is a phone
 * that repeats itself: the state machine is checked on every record, and
 * "nothing to say" has to be the common answer.
 *
 *   node tests/test_calibrate.mjs
 */
import { CalibrationCoach } from '../static/js/calibrate.js';
import { readiness, MIN_PASSES, MAX_PASSES } from '../static/js/tuning.js';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const has = (name, s, sub) => check(name, String(s).includes(sub), `"${s}" does not contain "${sub}"`);

function coach() {
  const said = [];
  const c = new CalibrationCoach({ say: line => said.push(line) });
  return { c, said };
}
const slot = (n, seen, need, ready, name) => ({ slot: n, name, seen, need, ready });

/* -------------------------------------------------------------- solo ----- */
{
  const { c, said } = coach();
  const line = c.update({ solo: true, slots: [slot(1, 0, 3, false)] });
  has('the brief names the power setting', line, '25 milliwatts');
  has('and says to fly', line, 'fly through the gate');

  eq('nothing new to say on an unchanged state', c.update({ solo: true, slots: [slot(1, 0, 3, false)] }), null);

  has('each calibration lap is counted aloud',
      c.update({ solo: true, slots: [slot(1, 1, 3, false)] }), 'Calibration lap 1 of 3');
  eq('and not repeated for the same lap',
     c.update({ solo: true, slots: [slot(1, 1, 3, false)] }), null);
  has('lap two', c.update({ solo: true, slots: [slot(1, 2, 3, false)] }), 'lap 2 of 3');

  const done = c.update({ solo: true, slots: [slot(1, 3, 3, true)] });
  has('completion is announced', done, 'Calibration complete');
  has('and says timing is now live', done, 'Timing is live');
  eq('then it goes quiet', c.update({ solo: true, slots: [slot(1, 4, 3, true)] }), null);
  eq('four lines for a whole solo calibration', said.length, 4);
}

/* Enough laps flown but the passes still disagree: say so, rather than going
 * silent at exactly the moment someone is waiting to hear "complete". */
{
  const { c } = coach();
  c.update({ solo: true, slots: [slot(1, 0, 6, false)] });
  for (let i = 1; i <= 6; i++) c.update({ solo: true, slots: [slot(1, i, 6, false)] });
  const line = c.update({ solo: true, slots: [slot(1, 7, 6, false)] });
  has('an unsettled gate explains itself', line, 'passes disagree');
}

/* -------------------------------------------------------------- race ----- */
{
  const { c, said } = coach();
  const four = (...ready) => ready.map((r, i) => slot(i + 1, r ? 3 : 1, 3, r, `Pilot ${i + 1}`));

  const brief = c.update({ solo: false, slots: four(false, false, false, false) });
  has('the race brief addresses everyone', brief, 'All pilots');
  has('and names the power setting', brief, '25 milliwatts');
  has('and asks for practice laps', brief, 'practice laps');

  const one = c.update({ solo: false, slots: four(true, false, false, false) });
  has('a finished pilot is named', one, 'Pilot 1 calibrated');
  has('and told how many remain', one, '3 quads to go');

  eq('an unchanged state says nothing', c.update({ solo: false, slots: four(true, false, false, false) }), null);

  has('singular when one remains',
      (c.update({ solo: false, slots: four(true, true, false, false) }),
       c.update({ solo: false, slots: four(true, true, true, false) })), '1 quad to go');

  const all = c.update({ solo: false, slots: four(true, true, true, true) });
  has('and the finish is for the whole grid', all, 'All quads calibrated');
  has('which is the cue to race', all, 'Ready to race');
  eq('silence afterwards', c.update({ solo: false, slots: four(true, true, true, true) }), null);
  check('no line was ever repeated', new Set(said).size === said.length, said.join(' | '));
}

/* A calibrated gate that drifts back is worth one line — from then on the lap
 * times cannot be trusted, and silence would hide that. */
{
  const { c } = coach();
  c.update({ solo: true, slots: [slot(1, 0, 3, false)] });
  c.update({ solo: true, slots: [slot(1, 3, 3, true)] });
  const back = c.update({ solo: true, slots: [slot(1, 3, 3, false)] });
  has('drifting out of calibration is announced', back, 'needs calibrating again');
  eq('but only once', c.update({ solo: true, slots: [slot(1, 3, 3, false)] }), null);
}

/* Nothing is said to a disconnected timer or an empty grid. */
{
  const { c } = coach();
  eq('no timer, no talking', c.update({ solo: true, slots: [slot(1, 0, 3, false)], connected: false }), null);
  eq('no pilots, no talking', c.update({ solo: true, slots: [] }), null);
}

/* ---------------------------------------------- evidence on a micro track --- */
/* Consistent passes settle quickly. */
{
  const quiet = 960;
  const p = v => ({ peak: v, quiet, counted: true, at: 0 });
  const r = readiness([p(2400), p(2380), p(2410)], 1600, 0.62);
  eq('agreeing passes need the minimum', r.need, MIN_PASSES);
  eq('and three of them are enough', r.ready, true);
}

/* Passes that disagree — the same gate taken at a different height and angle
 * each lap, which is what a micro track actually looks like — buy more
 * evidence rather than a coin flip. */
{
  const quiet = 960;
  const p = v => ({ peak: v, quiet, counted: true, at: 0 });
  const wild = [p(2400), p(1500), p(2100)];
  const r = readiness(wild, 1200, 0.62);
  eq('disagreeing passes need more', r.need, MAX_PASSES);
  eq('so three is not yet calibrated', r.ready, false);
  check('the disagreement is measured, not guessed', r.spread > 0.35, `spread ${r.spread}`);
}

/* The track preset decides where the trigger sits. A micro track puts it
 * higher, because the risk there is a hovering quad inventing a lap. */
{
  const quiet = 960;
  const p = v => ({ peak: v, quiet, counted: true, at: 0 });
  const passes = [p(2400), p(2380), p(2410)];
  const tiny = readiness(passes, 3000, 0.62).suggest;
  const open = readiness(passes, 3000, 0.32).suggest;
  check('a micro track triggers higher than an open one', tiny > open, `${tiny} vs ${open}`);
  check('and both sit clear of the noise', open > quiet + 120, `open ${open}`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('calibration flow: all scenarios pass');
