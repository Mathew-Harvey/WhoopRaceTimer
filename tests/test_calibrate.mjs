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
  has('and says to fly', line, 'Fly the gate');

  eq('nothing new to say on an unchanged state', c.update({ solo: true, slots: [slot(1, 0, 3, false)] }), null);

  has('each calibration lap is counted aloud',
      c.update({ solo: true, slots: [slot(1, 1, 3, false)] }), 'Calibration lap 1 of 3');
  eq('and not repeated for the same lap',
     c.update({ solo: true, slots: [slot(1, 1, 3, false)] }), null);
  has('lap two', c.update({ solo: true, slots: [slot(1, 2, 3, false)] }), 'lap 2 of 3');

  const done = c.update({ solo: true, slots: [slot(1, 3, 3, true)] });
  has('completion is announced', done, 'Calibration complete');
  has('and says timing is now live', done, 'Timing live');
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
  has('an unsettled gate explains itself', line, 'inconsistent');
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
  has('and told how many remain', one, '3 remaining');

  eq('an unchanged state says nothing', c.update({ solo: false, slots: four(true, false, false, false) }), null);

  has('the count of who is left is exact',
      (c.update({ solo: false, slots: four(true, true, false, false) }),
       c.update({ solo: false, slots: four(true, true, true, false) })), '1 remaining');

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
  has('drifting out of calibration is announced', back, 'out of calibration');
  eq('but only once', c.update({ solo: true, slots: [slot(1, 3, 3, false)] }), null);
}

/* A receiver that has heard nothing is on the wrong channel, not calibrating
 * slowly. Telling that pilot to keep flying is the worst possible answer. */
{
  const { c } = coach();
  c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 2 }] });
  eq('patience first', c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 10 }] }), null);
  const line = c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 40 }] });
  has('then it names the real problem', line, 'Check your video channel');
  eq('and says it once', c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 60 }] }), null);
}

/* In a race the silent pilot is named, because three others are flying fine. */
{
  const { c } = coach();
  const grid = sf => [ { ...slot(1, 2, 3, false, 'Ana'), silentFor: 1 },
                       { ...slot(2, 0, 3, false, 'Bo'), silentFor: sf } ];
  c.update({ solo: false, slots: grid(1) });
  const line = c.update({ solo: false, slots: grid(40) });
  has('the silent pilot is named', line, 'Bo');
  has('and it is a channel problem', line, 'video channel');
}

/* A quad switched off is not a gate drifting. Telling someone who has just
 * landed to keep flying is the wrong instruction; the evidence expired because
 * the receiver stopped hearing anything. */
{
  const { c } = coach();
  c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 0 }] });
  c.update({ solo: true, slots: [{ ...slot(1, 3, 3, true), silentFor: 0 }] });
  const line = c.update({ solo: true, slots: [{ ...slot(1, 0, 3, false), silentFor: 5 }] });
  has('a silent receiver is reported as such', line, 'No signal');
  check('and not as a gate that needs more laps', !/keep flying/i.test(line), line);
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

/* --------------------------------------- a wrong gate must be able to recover --- */
/* A trigger set too high produces no passing records, and self-tuning used to
 * run from passing records alone — so the correction depended on the signal the
 * misconfiguration suppresses, and a gate that was wrong stayed wrong. This is a
 * real flight's numbers: a stale trigger of 2579 carried in the timer's own
 * config, against passes peaking between 1670 and 2698. */
{
  const quiet = 936;
  const flown = [2292, 2229, 2227, 2373, 1670, 2598, 2698];
  let threshold = 2579.3;
  const passes = [];
  let moves = 0;
  for (const peak of flown) {
    passes.push({ peak, quiet, counted: peak >= threshold, at: 0 });
    const r = readiness(passes, threshold, 0.62);
    if (passes.length >= 3 && r.worthIt && r.verdict !== 'good' && r.verdict !== 'none') {
      threshold = r.suggest; moves++;
      for (const p of passes) p.counted = p.peak >= threshold;
    }
  }
  check('a stale high trigger is corrected', moves > 0, 'the gate never moved');
  check('down, not up', threshold < 2579.3, `ended at ${threshold}`);
  /* Every pass except the anomalously weak one. 1670 sits a thousand counts
   * below the rest of that flight, and designing the gate around it is exactly
   * the tail-chasing the outlier trimming exists to stop — so it is expected to
   * miss, and expected to be reported as an outlier rather than a fault. */
  const detected = passes.filter(p => p.peak >= threshold).length;
  eq('every pass but the outlier is detected', detected, flown.length - 1);
  const rep = readiness(passes, threshold, 0.62);
  eq('and the outlier is not held against the gate', rep.realMissed, 0);
  eq('it is named as one', rep.outliers, 1);
  check('while staying clear of the noise', threshold > quiet + 120, `threshold ${threshold}`);
}

/* ------------------------------------------------- calibration terminates --- */
/* The failure this guards against was reported from the air: "the pickups kept
 * getting better and better, but it never said it was completed."
 *
 * Every lap on a micro track is flown differently, so there is always a new
 * worst pass. If the worst pass ever seen defines the gate, each one lands
 * under the trigger, self-tuning drops the trigger to catch it, and the next
 * lap produces a weaker one still. Simulate exactly that and require it to
 * settle. */
{
  const quiet = 960;
  const p = v => ({ peak: v, quiet, counted: true, at: 0 });
  let threshold = 1600;
  const passes = [];
  /* Peaks around 2400 with one steadily worse outlier each lap. */
  const flown = [2400, 2380, 2410, 2350, 2100, 1900, 2390, 2360, 1750, 2400];
  let moves = 0;
  for (const peak of flown) {
    passes.push(p(peak));
    for (const q of passes) q.counted = q.peak >= threshold;
    const r = readiness(passes, threshold, 0.62);
    if (!r.ready && r.suggest != null && r.worthIt && r.verdict !== 'good') {
      threshold = r.suggest; moves++;
      for (const q of passes) q.counted = q.peak >= threshold;
    }
  }
  const final = readiness(passes, threshold, 0.62);
  check('the gate stops chasing outliers', moves < flown.length,
        `moved the trigger ${moves} times in ${flown.length} laps`);
  eq('and reaches calibrated', final.ready, true);
  check('with the trigger clear of the noise', threshold > quiet + 120, `threshold ${threshold}`);
  check('and under the passes it is designed for', threshold < final.weakest,
        `threshold ${threshold} vs weakest ${final.weakest}`);
}

/* One freak lap does not undo a calibrated gate, but it is still reported. */
{
  const quiet = 960;
  const p = (v, t) => ({ peak: v, quiet, counted: v >= t, at: 0 });
  const t = 1500;
  const passes = [2400, 2380, 2410, 2350, 900].map(v => p(v, t));
  const r = readiness(passes, t, 0.62);
  eq('the freak lap is counted as missed', r.missed, 1);
  eq('but not held against the gate', r.realMissed, 0);
  eq('and it is named as an outlier', r.outliers, 1);
  eq('so the gate is still calibrated', r.ready, true);
}

/* With too little evidence, every pass still counts — four laps is not enough
 * to tell an unusual lap from a badly placed gate. */
{
  const quiet = 960;
  const p = (v, t) => ({ peak: v, quiet, counted: v >= t, at: 0 });
  const t = 1500;
  const r = readiness([2400, 2380, 900].map(v => p(v, t)), t, 0.62);
  eq('a miss among three passes is a real miss', r.realMissed, 1);
  eq('so it is not calibrated', r.ready, false);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('calibration flow: all scenarios pass');
