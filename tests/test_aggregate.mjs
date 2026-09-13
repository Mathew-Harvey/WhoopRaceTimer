/* Lap cleaning and the pilot record.
 *
 * The cleaning is the part worth testing hardest, because every failure mode
 * looks plausible on a screen. A battery change kept as a lap does not look
 * like a bug — it looks like a pilot who had a bad lap. An honest lap thrown
 * out does not look like a bug either; the average just quietly improves.
 * Neither is visible without knowing what went in.
 *
 *   node tests/test_aggregate.mjs
 */
import {
  aggregate, bestConsecutive, cleanLaps, dayKey, fmtDuration, fmtLap,
  leaderboard, mad, mean, median, monthKey, quantile, REASONS, rollup, sessionStats,
  stdev, weekKey, fmtSpread, MIN_LAPS_FOR_MAD, STOPPAGE_FACTOR,
} from '../static/js/aggregate.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? '\n  ' + detail : ''}`);
}
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 0.01) =>
  check(name, got != null && Math.abs(got - want) <= tol, `got ${got}, want ~${want}`);
const reasons = r => r.laps.map(l => l.reason);

/* ------------------------------------------------------------ statistics -- */
{
  eq('median of an odd list', median([3, 1, 2]), 2);
  eq('median of an even list', median([4, 1, 2, 3]), 2.5);
  eq('median of nothing', median([]), null);
  eq('quantile at the ends', quantile([1, 2, 3, 4], 0), 1);
  near('quantile interpolates', quantile([1, 2, 3, 4], 0.5), 2.5);
  eq('mad of a constant list is zero', mad([5, 5, 5]), 0);
  near('mad ignores one wild value', mad([10, 10, 11, 11, 900]), 1);
  eq('stdev needs two samples', stdev([1]), null);

  eq('best consecutive over three', bestConsecutive([10, 9, 8, 20, 7], 3), 27);
  eq('  and refuses when there are not enough laps', bestConsecutive([10, 9], 3), null);
}

/* --------------------------------------------------------------- cleaning -- */

/* The case the whole thing exists for. A pilot flies six laps, lands, changes a
 * battery, and flies six more. The gate records the interval between the last
 * lap before and the first lap after as one lap eleven minutes long. */
{
  const laps = [24.1, 23.8, 24.4, 23.9, 24.2, 24.0, 666.0, 24.3, 23.7, 24.5, 24.1, 23.9];
  const r = cleanLaps(laps, { minLap: 1 });

  eq('a battery change is not a lap', r.counts[REASONS.stoppage], 1);
  eq('  and every real lap survives it', r.clean.length, 11);
  check('  the stoppage is the one that was flagged',
        r.laps.find(l => !l.ok).time === 666.0);
  near('  so the median pace is the real one', median(r.clean), 24.05, 0.2);
}

/* Two battery changes is where mean and standard deviation stop working, and
 * the reason this file uses a median and a MAD instead.
 *
 * It is called masking: each outlier inflates the sigma that is supposed to
 * catch the other. One stoppage among eleven honest laps sits at 3.18 sigma
 * and a three-sigma rule just catches it. Add a second and the mean climbs to
 * 80 with a sigma of 137, so both stoppages fall at about 2.2 sigma — inside
 * the band, kept, and the pilot's average lap becomes eighty seconds. A third
 * buries them further. The median does not move at all. */
{
  const honest = [24.1, 23.8, 24.4, 23.9, 24.2, 24.0, 24.3, 23.7, 24.5, 24.1, 23.9];
  const laps = [...honest.slice(0, 5), 400.0, ...honest.slice(5, 9), 380.0, ...honest.slice(9)];

  const r = cleanLaps(laps, { minLap: 1 });
  eq('two stoppages are both caught', r.counts[REASONS.stoppage], 2);
  eq('  and every honest lap remains', r.clean.length, 11);

  const m = laps.reduce((a, b) => a + b, 0) / laps.length;
  const sd = stdev(laps);
  check('mean and three sigma would have kept both of them',
        Math.abs(400 - m) < sd * 3 && Math.abs(380 - m) < sd * 3,
        `400 is ${((400 - m) / sd).toFixed(2)} sigma and 380 is ` +
        `${((380 - m) / sd).toFixed(2)} sigma from a mean of ${m.toFixed(1)}`);
  check('  and would have reported an eighty-second average lap', m > 70,
        `mean ${m.toFixed(1)}`);
}

/* The stoppage rule measures against the median and not the mean, and this is
 * the case that separates them. A pilot flies six laps, has a long stoppage,
 * then crashes and walks back. With a median baseline both are caught. With a
 * mean, the 900-second stoppage drags the baseline to 142, three times that is
 * 425, and the 90-second crash lap sails through as a lap. */
{
  const r = cleanLaps([24, 24, 24, 24, 24, 24, 900, 90], { minLap: 1 });
  eq('a long stoppage does not hide a shorter one', r.counts[REASONS.stoppage], 2);
  eq('  leaving only the laps that were flown', r.clean.length, 6);

  const m = mean([24, 24, 24, 24, 24, 24, 900, 90]);
  check('  a mean baseline would have kept the crash lap', 90 < m * STOPPAGE_FACTOR,
        `mean ${m.toFixed(1)}, so the cut would be ${(m * STOPPAGE_FACTOR).toFixed(0)}`);
}

/* A short session has no usable dispersion. Four laps cannot tell you what
 * normal looks like, so the robust test is off and only the hard rules run —
 * otherwise a pilot who flew three steady laps and one merely slow one loses
 * the slow one for no reason. */
{
  /* 31 against a median of 24 is well outside the band the robust test would
   * compute from four samples, and nowhere near the stoppage rule. If the
   * robust test ran here it would be thrown out. */
  const r = cleanLaps([24.0, 24.2, 23.9, 31.0], { minLap: 1 });
  eq('a four-lap session keeps its slow lap', r.clean.length, 4);
  check('  because the robust test needs more than that', MIN_LAPS_FOR_MAD > 4);
  check('  and the lap really is one the robust test would have rejected',
        cleanLaps([24.0, 24.2, 23.9, 31.0, 24.1, 24.0], { minLap: 1 }).clean.length === 5,
        'with enough laps for dispersion, 31 is an outlier');

  const withStop = cleanLaps([24.0, 24.2, 23.9, 300], { minLap: 1 });
  eq('but a stoppage in a short session is still a stoppage', withStop.clean.length, 3);
}

/* A metronomic pilot has a MAD of zero. Without a floor under the spread, the
 * band collapses to nothing and every lap that is not exactly the median —
 * which is to say all of them — is an outlier. */
{
  const r = cleanLaps([24.0, 24.0, 24.0, 24.0, 24.0, 24.6], { minLap: 1 });
  eq('a zero MAD does not reject the whole session', r.clean.length, 6);
  eq('  nothing is called an outlier', r.counts[REASONS.outlier], 0);
}

/* And the floor must not be so generous that it stops rejecting. */
{
  const r = cleanLaps([24.0, 24.0, 24.0, 24.0, 24.0, 24.0, 24.0, 60.0], { minLap: 1 });
  check('a lap well off a metronomic pace is still caught',
        r.clean.length === 7, `kept ${r.clean.length}`);
}

/* A double trigger is one crossing counted twice, and arrives below the
 * minimum lap. Both the app and the timer filter these, so one that reaches
 * here got past both. */
{
  const r = cleanLaps([24.0, 0.4, 23.8, 24.1, 24.0, 23.9], { minLap: 1.0 });
  eq('a double trigger is not a lap', r.counts[REASONS.short], 1);
  eq('  and does not become the personal best', Math.min(...r.clean) > 1, true);
}

/* A holeshot start times lap one from the countdown, so it carries the run-up
 * to the gate. It is distance covered, not a lap time. */
{
  const flying = cleanLaps([24.0, 23.8, 24.1, 24.0, 23.9], { minLap: 1, holeshot: false });
  eq('without a holeshot, lap one is a real lap', flying.clean.length, 5);

  const standing = cleanLaps([31.0, 23.8, 24.1, 24.0, 23.9], { minLap: 1, holeshot: true });
  eq('with one, lap one is an out-lap', standing.counts[REASONS.outLap], 1);
  eq('  and is not counted as pace', standing.clean.length, 4);
  eq('  but it is still a lap that was flown', standing.counts.total, 5);
}

/* Nothing is deleted. A page has to be able to say what happened to a lap. */
{
  const r = cleanLaps([24, 24, 24, 24, 24, 500, 0.5], { minLap: 1 });
  eq('every lap keeps a reason', r.laps.length, 7);
  eq('  ordered as flown', reasons(r).join(','),
     ['ok', 'ok', 'ok', 'ok', 'ok', 'stoppage', 'short'].join(','));
  eq('  and the counts add up', r.counts.ok + r.counts.stoppage + r.counts.short, 7);
}

/* Degenerate input must not throw. A session can be empty, and lapTimes has
 * come back from storage written by an older version of the app. */
{
  eq('no laps at all', cleanLaps([]).clean.length, 0);
  eq('undefined laps', cleanLaps(undefined).clean.length, 0);
  eq('rubbish in the list is dropped',
     cleanLaps([24, null, NaN, 'x', -3, 0, 24.2, 24.1, 23.9, 24.0], { minLap: 1 }).counts.total, 5);
}

/* ------------------------------------------------------------- a session -- */
{
  const session = { runId: 'r1', at: 1757700000, mode: 'practice', consecN: 3, minLap: 1 };
  const entry = { pos: 1, name: 'Kez', channel: 'R1',
                  lapTimes: [24.0, 23.5, 23.8, 400.0, 23.6, 24.2, 23.9] };
  const st = sessionStats(entry, session);

  eq('laps recorded counts the stoppage', st.lapsRecorded, 7);
  eq('  clean laps do not', st.lapsClean, 6);
  near('  the best lap is a real one', st.best, 23.5);
  near('  best three consecutive comes from clean laps', st.consec, 70.9, 0.3);
  check('  air time excludes the battery change', st.airTimeS < 200,
        `air time ${st.airTimeS}`);
  check('  consistency is a small fraction on a steady session',
        st.consistency != null && st.consistency < 0.05, `got ${st.consistency}`);
}

/* -------------------------------------------------------------- periods --- */
{
  /* Built from local-time components so the test says the same thing in every
   * timezone the app is used in. */
  const at = (y, mo, d, h = 12) => new Date(y, mo - 1, d, h, 0, 0).getTime() / 1000;

  eq('a day key is local', dayKey(at(2026, 9, 13)), '2026-09-13');
  eq('a month key is local', monthKey(at(2026, 9, 13)), '2026-09');

  /* ISO weeks: 2026-01-01 is a Thursday, so it belongs to week 1 of 2026. */
  eq('the first Thursday sets week one', weekKey(at(2026, 1, 1)), '2026-W01');
  /* The Monday before it is the same ISO week, in the previous calendar year. */
  eq('  and the Monday before is the same week', weekKey(at(2025, 12, 29)), '2026-W01');
  /* A year that starts on a Friday belongs to the last week of the year before. */
  eq('a Friday new year is last year business', weekKey(at(2027, 1, 1)), '2026-W53');
}

/* --------------------------------------------------------------- rollups -- */
{
  const mk = (at, times) => ({
    runId: 'r' + at, at, mode: 'practice', consecN: 3, minLap: 1,
    results: [{ pos: 1, name: 'Kez', channel: 'R1', lapTimes: times }],
  });
  const day = (d, h = 12) => new Date(2026, 8, d, h).getTime() / 1000;

  const sessions = [
    mk(day(1), [26.0, 25.8, 26.2, 25.9, 26.1, 500.0]),
    mk(day(1, 14), [25.5, 25.7, 25.4, 25.6, 25.8]),
    mk(day(8), [25.0, 24.8, 25.2, 24.9, 25.1]),
    mk(day(15), [24.0, 23.8, 24.2, 23.9, 24.1]),
    mk(day(22), [23.5, 23.3, 23.7, 23.4, 23.6]),
    mk(day(29), [23.0, 22.8, 23.2, 22.9, 23.1]),
  ];

  const rec = aggregate(sessions, { pilotName: 'Kez' });

  eq('every session counts as an outing', rec.totals.sessions, 6);
  eq('  the stoppage is counted and not hidden', rec.totals.stoppages, 1);
  eq('  laps recorded includes it', rec.totals.lapsRecorded, 31);
  eq('  clean laps do not', rec.totals.lapsClean, 30);
  near('  the personal best is the fastest clean lap', rec.best.lap, 22.8);
  check('  and it is attributed to the session it came from',
        rec.best.session && rec.best.session.at === day(29));

  eq('two sessions on one day are one day', rec.periods.day.length, 5);
  eq('  spread across five weeks', rec.periods.week.length, 5);
  eq('  inside one month', rec.periods.month.length, 1);
  eq('  and days are in order', rec.periods.day.map(d => d.key).join(' '),
     '2026-09-01 2026-09-08 2026-09-15 2026-09-22 2026-09-29');

  const firstDay = rec.periods.day[0];
  eq('the first day holds both of its sessions', firstDay.sessions, 2);
  near('  and its best is the better of the two', firstDay.best, 25.4);

  /* Air time is the point of the stoppage rule: 500 seconds of battery change
   * must not appear as time in the air. */
  check('air time is flying and not standing about',
        rec.totals.airTimeS < 800, `air time ${rec.totals.airTimeS}`);

  /* Improvement, which is the shape a season is read through. */
  eq('the progression has a point per session with laps', rec.progression.length, 6);
  const bests = rec.progression.map(p => p.best);
  check('  and only ever improves', bests.every((b, i) => i === 0 || b <= bests[i - 1]),
        bests.join(' '));
  near('  ending at the personal best', bests[bests.length - 1], 22.8);

  /* Form: the last five sessions against the whole record. A pilot getting
   * quicker has recent pace ahead of career pace, so the delta is negative. */
  check('form is faster than the career average for an improving pilot',
        rec.form.paceDelta < 0, `delta ${rec.form.paceDelta}`);
  eq('  and looks at five sessions', rec.form.last5.sessions, 5);
}

/* A pilot's own entry has to be picked out of a four-up race. */
{
  const session = {
    runId: 'race1', at: 1757700000, mode: 'laps', consecN: 3, minLap: 1,
    results: [
      { pos: 1, name: 'Kez', channel: 'R1', lapTimes: [24.0, 23.8, 24.1, 23.9, 24.0] },
      { pos: 2, name: 'Rowie', channel: 'R3', lapTimes: [26.0, 25.8, 26.1, 25.9, 26.0] },
    ],
  };
  const kez = aggregate([session], { pilotName: 'Kez' });
  const rowie = aggregate([session], { pilotName: 'Rowie' });
  near("one pilot's record is their own laps", kez.best.lap, 23.8);
  near('  and not the other pilot in the same race', rowie.best.lap, 25.8);
  eq('  each sees one session', kez.totals.sessions, 1);
}

/* A session where every lap was a stoppage still happened. */
{
  const rec = aggregate([{
    runId: 'x', at: 1757700000, consecN: 3, minLap: 1,
    results: [{ name: 'Kez', lapTimes: [0.2] }],
  }], { pilotName: 'Kez' });
  eq('an outing with nothing clean is still an outing', rec.totals.sessions, 1);
  eq('  with no laps to its name', rec.totals.lapsClean, 0);
  eq('  and no personal best', rec.best.lap, null);
  eq('  and no progression point', rec.progression.length, 0);
}

/* Nothing at all must produce a record, not an exception. */
{
  const empty = aggregate([], { pilotName: 'Nobody' });
  eq('an empty record has no sessions', empty.totals.sessions, 0);
  eq('  no best', empty.best.lap, null);
  eq('  and no periods', empty.periods.day.length, 0);
  eq('rollup of nothing', rollup([]).sessions, 0);
}

/* ---------------------------------------------------------- leaderboard --- */
{
  const rec = (name, best, cleanLaps) => ({
    pilotName: name, best: { lap: best }, totals: { lapsClean: cleanLaps },
  });
  const table = leaderboard([
    rec('Slow', 30.0, 50), rec('Fast', 22.0, 10), rec('Untimed', null, 99), rec('Mid', 25.0, 20),
  ]);
  eq('the fastest lap tops the table', table[0].pilotName, 'Fast');
  eq('  then the next fastest', table[1].pilotName, 'Mid');
  eq('  a pilot with no time is last however much they have flown',
     table[table.length - 1].pilotName, 'Untimed');
  eq('  and ranks are one-based', table[0].rank, 1);
  /* The sort key is added, not substituted. Replacing `best` with a bare number
   * here left every caller that reads best.lap or best.consec — the public
   * table among them — rendering an empty column and reporting nothing wrong. */
  eq('  the record survives the sort', table[0].best.lap, 22.0);
  eq('  with a flat key beside it', table[0].bestLap, 22.0);
  eq('  and totals intact', table[0].totals.lapsClean, 10);
}

/* ------------------------------------------------------------ formatting -- */
{
  eq('a lap under a minute', fmtLap(23.456), '23.46');
  eq('a lap over one', fmtLap(83.4), '1:23.40');
  eq('nothing to show', fmtLap(null), '—');
  eq('a short duration', fmtDuration(45), '45s');
  eq('minutes and seconds', fmtDuration(125), '2m 05s');
  eq('hours', fmtDuration(7325), '2h 02m');

  /* Consistency is a ratio, not a time, and the formatter is the only thing
   * standing between that and a dashboard that says "0.02s spread". */
  eq('consistency prints as a percentage', fmtSpread(0.0153), '1.5%');
  eq('  and copes with nothing to print', fmtSpread(null), '—');
}


/* ==================================================================== */
/* Dashboard series                                                      */
/* ==================================================================== */
{
  const { activityCalendar, streaks, lapScatter, distribution, records, dashboardSeries } =
    await import('../static/js/aggregate.js');

  const day = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000;
  const mk = (at, times) => ({
    runId: 'r' + at, at, mode: 'practice', consecN: 3, minLap: 1,
    results: [{ pos: 1, name: 'Kez', channel: 'R1', lapTimes: times }],
  });
  const TODAY = new Date(2026, 8, 13, 18).getTime();   /* Sun 13 Sep 2026 */

  /* ---- the calendar ---- */
  {
    const rec = aggregate([
      mk(day(2026, 9, 11), [24, 23.8, 24.1]),
      mk(day(2026, 9, 12), [24, 23.8, 24.1, 23.9, 24.2, 24.0, 23.7, 24.3]),
      mk(day(2026, 9, 12, 16), [24, 23.9]),
      mk(day(2026, 9, 13), [24, 23.8, 24.1, 23.9]),
    ], { pilotName: 'Kez' });
    const cal = activityCalendar(rec.sessions, { today: TODAY });

    eq('the calendar is whole weeks', cal.cells.length % 7, 0);
    eq('  three days were flown', cal.daysFlown, 3);
    const flown = cal.cells.filter(c => c.laps > 0);
    eq('  and three cells carry laps', flown.length, 3);

    const d12 = cal.cells.find(c => c.key === '2026-09-12');
    eq('two sessions on one day are one cell', d12.sessions, 2);
    eq('  with their laps added up', d12.laps, 10);
    check('  at the top level of the scale', d12.level === 4, `level ${d12.level}`);

    const d11 = cal.cells.find(c => c.key === '2026-09-11');
    check('a quieter day sits lower on the scale', d11.level < d12.level,
          `${d11.level} vs ${d12.level}`);
    eq('a day not flown is level zero', cal.cells.find(c => c.key === '2026-09-10').level, 0);

    /* Monday first, and every column a full week. */
    eq('the grid starts on a Monday', cal.cells[0].weekday, 0);
    check('  and no cell is beyond today+this week',
          cal.cells.every(c => c.week >= 0 && c.week < cal.weeks));
    check('  today is in it', !!cal.cells.find(c => c.key === '2026-09-13'));
    /* Days after today are marked, so a chart can draw them as empty rather
     * than as days nobody flew. */
    check('  and the rest of this week is marked future',
          cal.cells.filter(c => c.future).every(c => c.laps === 0));
  }

  /* ---- streaks ---- */
  {
    const three = [mk(day(2026, 9, 11), [24, 23, 24]), mk(day(2026, 9, 12), [24, 23, 24]),
                   mk(day(2026, 9, 13), [24, 23, 24])];
    const s = streaks(aggregate(three, { pilotName: 'Kez' }).sessions, { today: TODAY });
    eq('three days running', s.current, 3);
    eq('  which is also the longest', s.longest, 3);
    eq('  and it is live', s.live, true);
    eq('  three days flown', s.daysFlown, 3);

    /* A streak that ended is not a current streak. */
    const old = [mk(day(2026, 8, 1), [24, 23, 24]), mk(day(2026, 8, 2), [24, 23, 24]),
                 mk(day(2026, 8, 3), [24, 23, 24])];
    const s2 = streaks(aggregate(old, { pilotName: 'Kez' }).sessions, { today: TODAY });
    eq('a streak from last month is not current', s2.current, 0);
    eq('  but it is still the longest', s2.longest, 3);
    eq('  and it is not live', s2.live, false);

    /* Yesterday still counts as live: nobody has flown yet today. */
    const y = [mk(day(2026, 9, 11), [24, 23, 24]), mk(day(2026, 9, 12), [24, 23, 24])];
    const s3 = streaks(aggregate(y, { pilotName: 'Kez' }).sessions, { today: TODAY });
    eq('yesterday keeps a streak alive', s3.current, 2);
    eq('  and live', s3.live, true);

    /* A gap breaks it. */
    const gap = [mk(day(2026, 9, 9), [24, 23, 24]), mk(day(2026, 9, 12), [24, 23, 24]),
                 mk(day(2026, 9, 13), [24, 23, 24])];
    const s4 = streaks(aggregate(gap, { pilotName: 'Kez' }).sessions, { today: TODAY });
    eq('a gap breaks the run', s4.current, 2);
    eq('  and the longest is the longest unbroken run', s4.longest, 2);
    eq('  days flown counts all of them', s4.daysFlown, 3);

    eq('nothing flown, nothing claimed', streaks([], { today: TODAY }).current, 0);
  }

  /* ---- the scatter and the histogram ---- */
  {
    const rec = aggregate([mk(day(2026, 9, 12), [24.0, 23.8, 500.0, 24.1, 23.9, 24.2])],
                          { pilotName: 'Kez' });
    const pts = lapScatter(rec.sessions);
    eq('the scatter is clean laps only', pts.length, 5);
    check('  so a battery change is not a point', pts.every(p => p.t < 100));
    eq('  numbered as flown', pts[0].lapNumber, 1);

    const d = distribution([20, 21, 21, 22, 22, 22, 23, 23, 24]);
    check('a histogram has bins', d.bins.length >= 2, `got ${d.bins.length}`);
    eq('  every lap lands in one', d.bins.reduce((a, b) => a + b.n, 0), 9);
    check('  the maximum is not lost off the end',
          d.bins[d.bins.length - 1].to >= 24 - 1e-9);
    eq('  and it spans the data', d.lo, 20);

    /* A metronomic pilot has an IQR of zero, which is a division waiting to
     * happen. */
    const flat = distribution([24, 24, 24, 24, 24, 24]);
    eq('a flat distribution does not divide by zero',
       flat.bins.reduce((a, b) => a + b.n, 0), 6);

    /* Zero IQR with a real spread. The metronomic case above cannot tell the
     * fallback width apart from the last-resort 0.1, because its range is zero
     * too and both land in the same place. Here they do not: half the range
     * over eight is one second, and 0.1 would ask for eighty bins. */
    const spread = distribution([20, 24, 24, 24, 24, 24, 24, 24, 24, 28]);
    eq('no IQR still bins by the range, not by a hard-coded floor',
       spread.bins.length, 8);
    eq('  with every lap in one', spread.bins.reduce((a, b) => a + b.n, 0), 10);

    /* The bin cap makes the width divide the range exactly, and that is the
     * only arrangement in which the slowest lap indexes one bin past the end.
     * Without the clamp this throws rather than quietly mis-binning, so the
     * assertion that matters is that the call returns at all. */
    const wide = distribution([
      ...Array(16).fill(23), ...Array(16).fill(25), 20, 68,
    ]);
    eq('the bin cap holds', wide.bins.length, 24);
    eq('  and the slowest lap is still counted',
       wide.bins.reduce((a, b) => a + b.n, 0), 34);
    eq('  in the last bin', wide.bins[wide.bins.length - 1].n, 1);

    eq('one lap is not a distribution', distribution([24]).bins.length, 0);
    eq('no laps either', distribution([]).bins.length, 0);
  }

  /* ---- records ---- */
  {
    const rec = aggregate([
      mk(day(2026, 9, 11), [24, 23.8, 24.1]),
      mk(day(2026, 9, 12), [24, 23.8, 24.1, 23.9, 24.2, 24.0, 23.7]),
      mk(day(2026, 9, 12, 16), [24, 23.9, 24.1]),
    ], { pilotName: 'Kez' });
    const r = records(rec.sessions);
    eq('most laps in one session', r.mostLapsInSession.laps, 7);
    eq('most laps in one day counts both sessions', r.mostLapsInDay.laps, 10);
    eq('  on the right day', r.mostLapsInDay.key, '2026-09-12');
    check('the longest session is a session', r.longestSession.airTimeS > 0);

    eq('no sessions, no records', records([]).mostLapsInSession, null);
  }

  /* ---- the record survives the wire ----
   * The public page does not compute the record; it is handed one as JSON by
   * the worker. If anything the dashboard reads were dropped or reshaped in
   * that trip the charts would come out empty on the public page and full on
   * the pilot's own phone, which is the one failure this whole arrangement of
   * sharing aggregate() with the server exists to prevent. */
  {
    const rec = aggregate([
      mk(day(2026, 9, 10), [24, 23.8, 24.1, 300, 23.9, 24.2, 24.0]),
      mk(day(2026, 9, 12), [23.5, 23.7, 23.4, 23.9, 23.6]),
    ], { pilotName: 'Kez' });
    const overTheWire = JSON.parse(JSON.stringify(rec));
    const here = dashboardSeries(rec, { today: TODAY });
    const there = dashboardSeries(overTheWire, { today: TODAY });
    eq('the wire keeps every lap of the scatter', there.scatter.length, here.scatter.length);
    check('  and the whole dashboard is identical',
          JSON.stringify(there) === JSON.stringify(here));
    check('  including the laps the cleaning threw out',
          overTheWire.sessions[0].laps.some(l => !l.ok));
  }

  /* ---- one call for the whole dashboard ---- */
  {
    const rec = aggregate([mk(day(2026, 9, 12), [24, 23.8, 24.1, 23.9, 24.2])],
                          { pilotName: 'Kez' });
    const s = dashboardSeries(rec, { today: TODAY });
    check('the dashboard series has everything it draws',
          !!(s.calendar && s.streaks && s.scatter && s.distribution && s.records &&
             s.consistency && s.sessionPace));
    eq('  and an empty record does not throw',
       dashboardSeries(aggregate([], { pilotName: 'x' }), { today: TODAY }).streaks.daysFlown, 0);
  }
}

/* The epilogue belongs at the very bottom. Anything below it runs with its
 * failures counted and never reported, which is worth exactly nothing. */
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('aggregation: cleaning, periods, the pilot record and the dashboard series all hold');
