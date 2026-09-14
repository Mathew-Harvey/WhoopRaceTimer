/* Turning a pile of sessions into a pilot's record.
 *
 * Two jobs, and the first one decides whether the second means anything.
 *
 * CLEANING. A saved session's lap list is not a list of laps flown at racing
 * pace. It contains the stoppages — the pilot landed, changed a battery, put
 * the quad back up, and the gate obligingly recorded the interval as one lap
 * eleven minutes long. It contains crashes, walks of shame, cool-down laps and
 * the occasional double trigger. Averaging that is how you get a "personal
 * average" of four minutes and a chart nobody believes twice.
 *
 * So laps are classified before they are counted, and the method has to survive
 * the thing that breaks the obvious one: mean and standard deviation are
 * dragged so hard by an eleven-minute lap that the lap itself lands inside
 * three sigma and is kept, while the honest laps around it fall outside. The
 * median and the median absolute deviation do not move — MAD tolerates up to
 * half the sample being contaminated — so that is what decides, with hard
 * rules alongside it for the cases a robust statistic still cannot see:
 *
 *   · A session of four laps has no usable dispersion at all. Hard rules only.
 *   · A metronomic pilot has a MAD of zero, which makes every lap that is not
 *     exactly the median an outlier. There is a relative floor under it.
 *   · A stoppage is not a slow lap and should not be judged as one, so a lap
 *     several times the median is a stoppage whatever the dispersion says.
 *
 * Nothing is deleted. Every lap keeps its reason, so a stats page can say "14
 * laps, 2 stoppages" rather than quietly showing 12.
 *
 * AGGREGATION. The rollups are the ones a season of motorsport is read
 * through: a personal best, a race pace that is not the best lap, a
 * consistency figure, and all of it again per day, per week and per month so
 * improvement is visible as a shape rather than a single number. Form is the
 * last few sessions against the whole record, which is the only way a good
 * night and a good year look different.
 *
 * Pure functions, no storage and no DOM, because tests/test_aggregate.mjs runs
 * them and the stats service runs the identical code on the server.
 */
'use strict';

/* A lap this much longer than the session's median is a stoppage — a battery
 * change, a crash, a chat — rather than a slow lap. Three times is generous
 * for a whoop: a genuinely bad lap is rarely more than double. */
export const STOPPAGE_FACTOR = 3.0;

/* Robust rejection band, in MAD-derived sigmas. 3.5 is the conventional
 * cut for outlier work and keeps honest bad laps in. */
export const MAD_SIGMAS = 3.5;

/* Below this many laps the dispersion of a session is not a measurement, and
 * the robust test is switched off in favour of the hard rules. */
export const MIN_LAPS_FOR_MAD = 5;

/* The floor under a zero MAD. A pilot lapping at 24.0, 24.0, 24.0, 31.0 has a
 * MAD of zero, and without this every lap that is not exactly 24.0 — including
 * the honest ones — is an outlier. Expressed as a fraction of the median so it
 * means the same thing on a 10-second track and a 40-second one. */
export const MIN_SPREAD_FRACTION = 0.06;

/** 1.4826 makes the MAD an estimate of sigma for normally distributed data,
 *  which is what lets a MAD-based cut be quoted in sigmas at all. */
const MAD_TO_SIGMA = 1.4826;

export const REASONS = {
  ok: 'ok',
  stoppage: 'stoppage',   /* battery change, crash, a wander — not a lap */
  outlier: 'outlier',     /* far off this session's pace, but not a stoppage */
  short: 'short',         /* below the minimum lap: a double trigger */
  outLap: 'out-lap',      /* first lap from a standing start, so not a lap time */
};

/* ----------------------------------------------------------------- tracks -- */

/**
 * Two spellings of the same track are the same track.
 *
 * A track name is typed by hand, on a phone, at a track, once a night, and
 * "Bunbury", "bunbury" and "Bunbury " are one place. Comparison is done on this
 * key; what is shown is whatever the pilot last typed.
 *
 * It lives here, with no dependencies, because the worker imports this file and
 * has to group a pilot's sessions exactly the way their phone does.
 */
export function trackKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The empty key: sessions flown before anybody named the track. */
export const UNTRACKED = '';

/* ------------------------------------------------------------ statistics -- */

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Median absolute deviation. Robust where a standard deviation is not. */
export function mad(xs) {
  const m = median(xs);
  if (m == null) return null;
  return median(xs.map(x => Math.abs(x - m)));
}

export function mean(xs) {
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Best run of n consecutive laps, as the app itself scores it. */
export function bestConsecutive(times, n) {
  if (n <= 0 || times.length < n) return null;
  let best = null, sum = 0;
  for (let i = 0; i < times.length; i++) {
    sum += times[i];
    if (i >= n) sum -= times[i - n];
    if (i >= n - 1 && (best == null || sum < best)) best = sum;
  }
  return best == null ? null : round3(best);
}

const round3 = v => v == null ? null : Math.round(v * 1000) / 1000;
const round2 = v => v == null ? null : Math.round(v * 100) / 100;

/* --------------------------------------------------------------- cleaning -- */

/**
 * Classify one session's laps.
 *
 * @param {number[]} times lap times in seconds, in the order flown
 * @param {object}   opts  { minLap, holeshot }
 * @returns {{ laps: Array<{i,time,reason,ok}>, clean: number[], counts: object }}
 */
export function cleanLaps(times, opts = {}) {
  const minLap = Number(opts.minLap) > 0 ? Number(opts.minLap) : 0;
  const holeshot = !!opts.holeshot;
  const list = (times || []).filter(t => typeof t === 'number' && isFinite(t) && t > 0);

  const laps = list.map((time, i) => ({ i, time, reason: REASONS.ok, ok: true }));
  const mark = (lap, reason) => { lap.reason = reason; lap.ok = false; };

  /* A holeshot start times the first lap from the countdown rather than from a
   * crossing, so it carries the run-up to the gate and is not a lap time. In
   * motorsport terms it is an out-lap: it counts as distance covered and not as
   * pace. Without a holeshot the clock starts at the first crossing and lap one
   * is already a real lap. */
  if (holeshot && laps.length) mark(laps[0], REASONS.outLap);

  /* Below the minimum lap is one crossing counted twice. The app and the timer
   * both filter these, so anything arriving here got past both — which is
   * exactly why it is worth catching rather than trusting. */
  for (const lap of laps) if (lap.ok && minLap > 0 && lap.time < minLap) mark(lap, REASONS.short);

  /* Everything below judges a lap against the session's own pace, so the pace
   * has to be computed from laps not already thrown out. */
  const candidates = laps.filter(l => l.ok);
  const med = median(candidates.map(l => l.time));

  if (med != null) {
    /* A stoppage is judged first and on its own terms. It is not a slow lap and
     * the dispersion test should never get the chance to call it one — with
     * two battery changes in a short session the median itself starts to move,
     * and the absolute rule is what holds. */
    for (const lap of candidates) {
      if (lap.time > med * STOPPAGE_FACTOR) mark(lap, REASONS.stoppage);
    }

    /* Then the robust test, on what is left, if there is enough of it. */
    const rest = laps.filter(l => l.ok);
    if (rest.length >= MIN_LAPS_FOR_MAD) {
      const t = rest.map(l => l.time);
      const m2 = median(t);
      const sigma = Math.max((mad(t) || 0) * MAD_TO_SIGMA, m2 * MIN_SPREAD_FRACTION);
      const band = sigma * MAD_SIGMAS;
      for (const lap of rest) {
        if (Math.abs(lap.time - m2) > band) mark(lap, REASONS.outlier);
      }
    }
  }

  const counts = { total: laps.length, ok: 0 };
  for (const r of Object.values(REASONS)) counts[r] = 0;
  for (const lap of laps) counts[lap.reason]++;
  counts.ok = laps.filter(l => l.ok).length;

  return { laps, clean: laps.filter(l => l.ok).map(l => l.time), counts };
}

/* ------------------------------------------------------------- one session -- */

/**
 * A single pilot's figures for a single session.
 * `entry` is one element of a history record's `results` array; `session` is
 * the record it came from.
 */
export function sessionStats(entry, session = {}) {
  const consecN = Number(session.consecN) || 3;
  const { laps, clean, counts } = cleanLaps(entry.lapTimes || [], {
    minLap: session.minLap,
    holeshot: session.holeshot,
  });

  const spread = clean.length >= 2
    ? { p25: quantile(clean, 0.25), p75: quantile(clean, 0.75) } : null;

  return {
    runId: session.runId || null,
    at: session.at || null,
    sessionName: session.name || null,
    mode: session.mode || null,
    track: session.track || null,
    channel: entry.channel || null,
    pos: entry.pos || null,
    /* Every lap the gate recorded, stoppages included: this is distance
     * covered, and it is not the same question as pace. */
    lapsRecorded: counts.total,
    lapsClean: clean.length,
    counts,
    /* Pace, from clean laps only. */
    best: clean.length ? round3(Math.min(...clean)) : null,
    medianLap: round3(median(clean)),
    consec: bestConsecutive(clean, consecN),
    consecN,
    /* Consistency: the interquartile range as a fraction of the median. Scale
     * free, so a 12-second track and a 35-second one are comparable, and
     * quartiles rather than a standard deviation so one bad lap that survived
     * cleaning does not decide it. */
    consistency: spread && spread.p75 != null && median(clean)
      ? round3((spread.p75 - spread.p25) / median(clean)) : null,
    /* Time actually spent flying, which is the clean laps and nothing else —
     * counting an eleven-minute battery change as air time is how a pilot ends
     * up with forty hours in a season. */
    airTimeS: round2(clean.reduce((a, b) => a + b, 0)),
    laps,
  };
}

/* --------------------------------------------------------------- periods --- */

const pad = n => String(n).padStart(2, '0');

/** Local-time day key. Local, not UTC: a Tuesday night club session that runs
 *  past midnight UTC is still Tuesday to the person who flew it. */
export function dayKey(atSeconds) {
  const d = new Date(atSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKey(atSeconds) {
  const d = new Date(atSeconds * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** ISO-8601 week: weeks start Monday and week 1 is the one holding the first
 *  Thursday. Worth the arithmetic — a home-made "divide by seven" drifts, and
 *  a leaderboard that disagrees with a calendar about which week it is gets
 *  argued about rather than read. */
export function weekKey(atSeconds) {
  const d = new Date(atSeconds * 1000);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  /* Thursday of this week decides the year the week belongs to. */
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const year = t.getFullYear();
  const firstThursday = new Date(year, 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
  const week = 1 + Math.round((t - firstThursday) / (7 * 86400000));
  return `${year}-W${pad(week)}`;
}

/** Roll a list of per-session stats into one bucket's figures. */
export function rollup(statsList) {
  const clean = [];
  let lapsRecorded = 0, airTimeS = 0, stoppages = 0;
  let best = null, bestConsec = null;

  for (const s of statsList) {
    lapsRecorded += s.lapsRecorded;
    airTimeS += s.airTimeS || 0;
    stoppages += (s.counts && s.counts[REASONS.stoppage]) || 0;
    for (const lap of s.laps) if (lap.ok) clean.push(lap.time);
    if (s.best != null && (best == null || s.best < best)) best = s.best;
    if (s.consec != null && (bestConsec == null || s.consec < bestConsec)) bestConsec = s.consec;
  }

  const med = median(clean);
  const p25 = quantile(clean, 0.25), p75 = quantile(clean, 0.75);

  return {
    sessions: statsList.length,
    lapsRecorded,
    lapsClean: clean.length,
    stoppages,
    airTimeS: round2(airTimeS),
    best,
    bestConsec,
    medianLap: round3(med),
    /* Race pace: the middle half of the clean laps, which is the figure a
     * pilot can actually expect to repeat. */
    pace: clean.length >= 4 ? round3(mean(clean.filter(t => t >= p25 && t <= p75))) : round3(med),
    consistency: med && p75 != null && clean.length >= 2 ? round3((p75 - p25) / med) : null,
    from: statsList.length ? Math.min(...statsList.map(s => s.at || Infinity)) : null,
    to: statsList.length ? Math.max(...statsList.map(s => s.at || 0)) : null,
  };
}

function bucketBy(statsList, keyFn) {
  const map = new Map();
  for (const s of statsList) {
    if (!s.at) continue;
    const k = keyFn(s.at);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return [...map.entries()]
    .map(([key, list]) => ({ key, ...rollup(list) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/* ------------------------------------------------------------- the record -- */

/**
 * Everything a stats page shows for one pilot.
 *
 * @param {Array} sessions history records — the shape race.results() produces
 * @param {object} opts { pilotName, match, track } — `match` picks this pilot's
 *                 entry out of a multi-pilot session; it defaults to matching on
 *                 the pilot name recorded in the session. `track` narrows the
 *                 record to one place: leave it out (or null) for every track,
 *                 pass a name for that track, or pass '' for the sessions flown
 *                 before anybody named one.
 */
export function aggregate(sessions, opts = {}) {
  const name = opts.pilotName;
  const match = opts.match || (entry => !name || entry.name === name);
  const wantTrack = opts.track == null ? null : trackKey(opts.track);

  const perSession = [];
  /* Which tracks this pilot has flown, counted over everything they have flown
   * and NOT over the filtered subset. A control built from the filtered record
   * would be a one-way door: choose Bunbury and Bunbury is the only option
   * left, with no way back to the other tracks or to all of them. */
  const seen = new Map();

  for (const s of sessions || []) {
    for (const entry of s.results || []) {
      if (!match(entry, s)) continue;

      const key = trackKey(s.track);
      const t = seen.get(key) || { key, name: null, sessions: 0, lastAt: null };
      t.sessions++;
      if (key && (t.lastAt == null || (s.at || 0) >= t.lastAt)) {
        /* The most recent spelling wins, so fixing a typo tonight fixes the
         * label everywhere rather than leaving both on the page. */
        t.name = String(s.track).replace(/\s+/g, ' ').trim();
      }
      if (s.at && (t.lastAt == null || s.at > t.lastAt)) t.lastAt = s.at;
      seen.set(key, t);

      if (wantTrack != null && key !== wantTrack) continue;
      const st = sessionStats(entry, s);
      /* A session where nothing survived cleaning is a session that happened —
       * it counts as an outing — but it cannot contribute to pace. */
      perSession.push(st);
    }
  }
  perSession.sort((a, b) => (a.at || 0) - (b.at || 0));

  const withLaps = perSession.filter(s => s.lapsClean > 0);
  const all = rollup(perSession);

  /* Personal best as it stood after each session, which is the improvement
   * curve rather than a scatter of session bests. */
  const progression = [];
  let running = null;
  for (const s of withLaps) {
    if (s.best != null && (running == null || s.best < running)) running = s.best;
    progression.push({ at: s.at, best: running, sessionBest: s.best });
  }

  const last5 = withLaps.slice(-5);
  const form = rollup(last5);

  return {
    pilotName: name || null,
    /* The track this record is narrowed to, echoed back so a page rendering it
     * does not have to remember what it asked for. */
    track: opts.track == null ? null : opts.track,
    tracks: [...seen.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)),
    totals: {
      sessions: perSession.length,
      sessionsWithLaps: withLaps.length,
      lapsRecorded: all.lapsRecorded,
      lapsClean: all.lapsClean,
      stoppages: all.stoppages,
      airTimeS: all.airTimeS,
      firstAt: perSession.length ? perSession[0].at : null,
      lastAt: perSession.length ? perSession[perSession.length - 1].at : null,
    },
    best: {
      lap: all.best,
      consec: all.bestConsec,
      /* Which session the personal best came from, so a page can link to it. */
      session: withLaps.reduce((acc, s) =>
        s.best != null && (acc == null || s.best < acc.best) ? s : acc, null),
    },
    pace: all.pace,
    medianLap: all.medianLap,
    consistency: all.consistency,
    periods: {
      day: bucketBy(perSession, dayKey),
      week: bucketBy(perSession, weekKey),
      month: bucketBy(perSession, monthKey),
    },
    form: {
      last5: form,
      allTime: all,
      /* Negative is faster than the career median: improving. */
      paceDelta: form.pace != null && all.pace != null ? round3(form.pace - all.pace) : null,
    },
    progression,
    sessions: perSession,
  };
}

/** Order a set of pilot records into a championship table. Fastest lap decides
 *  it; a pilot with no clean lap has not set a time and sorts last however many
 *  sessions they have. */
export function leaderboard(records) {
  /* bestLap is added alongside the record, never over it. Flattening `best`
   * into a number here used to be tidy and quietly broke every caller that
   * went on to read best.lap or best.consec — including the public table,
   * which then showed a blank column and no error anywhere. */
  const key = r => (r.best && r.best.lap != null ? r.best.lap : null);
  return [...records]
    .map(r => ({ ...r, bestLap: key(r) }))
    .sort((a, b) => {
      if (a.bestLap == null && b.bestLap == null) {
        return (b.totals?.lapsClean || 0) - (a.totals?.lapsClean || 0);
      }
      if (a.bestLap == null) return 1;
      if (b.bestLap == null) return -1;
      return a.bestLap - b.bestLap;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Seconds as a lap time reads on a timing tower. */
export function fmtLap(s) {
  if (s == null || !isFinite(s)) return '—';
  if (s < 60) return s.toFixed(2);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(2).padStart(5, '0')}`;
}

/**
 * Consistency, as the percentage it is.
 *
 * consistency is the interquartile range as a fraction of the median — it is
 * deliberately scale-free so a 12-second track and a 35-second one compare, and
 * that makes it the one figure on the page that is not in seconds. Printing it
 * with an "s" after it, which is what happened first, turns a tidy 1.5% into a
 * meaningless 0.02s and invites a pilot to read it as a lap time.
 */
export function fmtSpread(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

/** Seconds as a duration, for air time. */
export function fmtDuration(s) {
  if (s == null || !isFinite(s)) return '—';
  const total = Math.round(s);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(total % 60)}s`;
  return `${total}s`;
}

/* ======================================================================== */
/* Series for the dashboard.                                                */
/*                                                                          */
/* Everything below turns the record above into something a chart can draw. */
/* Kept here rather than in the chart code so it is testable without a DOM, */
/* and so the in-app screen and the public page cannot drift apart.         */
/* ======================================================================== */

const DAY_MS = 86400000;

/** Midnight local, as a Date, for a day key or an epoch. */
function startOfDay(at) {
  const d = new Date(typeof at === 'string' ? at + 'T00:00:00' : at * 1000);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * A day-by-day activity grid, the shape a contribution calendar has: one column
 * per week, Monday at the top.
 *
 * Level is a rank rather than a raw count, because one enormous session would
 * otherwise flatten every other day to the bottom of the scale. Four levels,
 * cut on the quantiles of the days actually flown, so the scale describes this
 * pilot's own year rather than an absolute idea of a busy day.
 */
export function activityCalendar(perSession, { days = 371, today = Date.now() } = {}) {
  const byDay = new Map();
  for (const s of perSession) {
    if (!s.at) continue;
    const k = dayKey(s.at);
    const cur = byDay.get(k) || { laps: 0, sessions: 0, best: null, airTimeS: 0 };
    cur.laps += s.lapsClean;
    cur.sessions += 1;
    cur.airTimeS += s.airTimeS || 0;
    if (s.best != null && (cur.best == null || s.best < cur.best)) cur.best = s.best;
    byDay.set(k, cur);
  }

  /* Quantile cuts over the days that have laps. With very few days the cuts
   * collapse onto each other; ranking still works, it just uses fewer levels. */
  const counts = [...byDay.values()].map(v => v.laps).filter(n => n > 0).sort((a, b) => a - b);
  const cut = q => (counts.length ? quantile(counts, q) : 0);
  const cuts = [cut(0.25), cut(0.5), cut(0.75)];
  const levelFor = laps => {
    if (!laps) return 0;
    if (laps <= cuts[0]) return 1;
    if (laps <= cuts[1]) return 2;
    if (laps <= cuts[2]) return 3;
    return 4;
  };

  /* End on the Sunday of this week so the grid is whole columns. */
  const end = startOfDay(today / 1000);
  end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7) - 1));
  const start = new Date(end.getTime() - (days - 1) * DAY_MS);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));  /* back to Monday */

  const cells = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const d = new Date(t);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hit = byDay.get(key);
    cells.push({
      key,
      at: Math.floor(t / 1000),
      weekday: (d.getDay() + 6) % 7,           /* 0 = Monday */
      week: Math.floor((t - start.getTime()) / (7 * DAY_MS)),
      laps: hit ? hit.laps : 0,
      sessions: hit ? hit.sessions : 0,
      best: hit ? hit.best : null,
      airTimeS: hit ? round2(hit.airTimeS) : 0,
      level: levelFor(hit ? hit.laps : 0),
      future: t > startOfDay(today / 1000).getTime(),
    });
  }
  return { cells, weeks: (cells[cells.length - 1]?.week ?? 0) + 1, cuts, daysFlown: byDay.size };
}

/**
 * Days flown, and how they run together.
 *
 * A current streak that has already been broken is not a current streak, so it
 * only counts when the last day flown is today or yesterday — anything else is
 * a streak that ended, and reporting it as live is the kind of flattery that
 * makes a number worthless.
 */
export function streaks(perSession, { today = Date.now() } = {}) {
  const daySet = new Set(perSession.filter(s => s.at && s.lapsClean > 0).map(s => dayKey(s.at)));
  const days = [...daySet].sort();
  if (!days.length) {
    return { daysFlown: 0, current: 0, longest: 0, live: false, lastFlown: null,
             thisMonth: 0, thisYear: 0 };
  }

  let longest = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = startOfDay(days[i - 1]).getTime();
    const cur = startOfDay(days[i]).getTime();
    run = (cur - prev === DAY_MS) ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  /* Walk back from the last day flown. */
  let current = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const a = startOfDay(days[i - 1]).getTime(), b = startOfDay(days[i]).getTime();
    if (b - a === DAY_MS) current++; else break;
  }
  const t0 = startOfDay(today / 1000).getTime();
  const last = startOfDay(days[days.length - 1]).getTime();
  const live = (t0 - last) <= DAY_MS;

  const now = new Date(today);
  const monthPrefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const yearPrefix = String(now.getFullYear());

  return {
    daysFlown: days.length,
    current: live ? current : 0,
    longest,
    live,
    lastFlown: days[days.length - 1],
    thisMonth: days.filter(d => d.startsWith(monthPrefix)).length,
    thisYear: days.filter(d => d.startsWith(yearPrefix)).length,
  };
}

/** Every clean lap as a point, for a scatter of pace over time. */
export function lapScatter(perSession) {
  const pts = [];
  for (const s of perSession) {
    if (!s.at) continue;
    let n = 0;
    for (const lap of s.laps) {
      if (!lap.ok) continue;
      pts.push({ at: s.at, t: lap.time, runId: s.runId, lapNumber: ++n });
    }
  }
  return pts;
}

/**
 * A histogram of clean laps.
 *
 * Freedman–Diaconis for the bin width — 2·IQR/n^(1/3) — because a fixed bin
 * count either buries the shape of a tight pilot's laps in one bar or shatters
 * a loose one into noise. Falls back to a fixed count when the IQR is zero,
 * which a metronomic session really can produce.
 */
export function distribution(times, { maxBins = 24 } = {}) {
  const xs = (times || []).filter(t => Number.isFinite(t)).sort((a, b) => a - b);
  if (xs.length < 2) return { bins: [], lo: null, hi: null, width: null };

  const lo = xs[0], hi = xs[xs.length - 1];
  const iqr = quantile(xs, 0.75) - quantile(xs, 0.25);
  let width = iqr > 0 ? 2 * iqr / Math.cbrt(xs.length) : (hi - lo) / 8;
  if (!(width > 0)) width = 0.1;
  let count = Math.ceil((hi - lo) / width) || 1;
  if (count > maxBins) { count = maxBins; width = (hi - lo) / count; }

  const bins = Array.from({ length: count }, (_, i) => ({
    from: round3(lo + i * width), to: round3(lo + (i + 1) * width), n: 0,
  }));
  for (const x of xs) {
    let i = Math.floor((x - lo) / width);
    if (i >= count) i = count - 1;      /* the maximum lands in the last bin */
    if (i < 0) i = 0;
    bins[i].n++;
  }
  return { bins, lo: round3(lo), hi: round3(hi), width: round3(width) };
}

/** The handful of "most ever" figures a season page leads with. */
export function records(perSession) {
  const withLaps = perSession.filter(s => s.lapsClean > 0);
  const byDay = new Map();
  for (const s of withLaps) {
    const k = dayKey(s.at);
    byDay.set(k, (byDay.get(k) || 0) + s.lapsClean);
  }
  let bestDay = null;
  for (const [key, laps] of byDay) if (!bestDay || laps > bestDay.laps) bestDay = { key, laps };

  const most = withLaps.reduce((a, s) => (!a || s.lapsClean > a.lapsClean ? s : a), null);
  const longest = withLaps.reduce((a, s) => (!a || s.airTimeS > a.airTimeS ? s : a), null);
  const tidiest = withLaps
    .filter(s => s.consistency != null && s.lapsClean >= 5)
    .reduce((a, s) => (!a || s.consistency < a.consistency ? s : a), null);

  return {
    mostLapsInSession: most ? { laps: most.lapsClean, at: most.at } : null,
    mostLapsInDay: bestDay,
    longestSession: longest ? { airTimeS: longest.airTimeS, at: longest.at } : null,
    tidiestSession: tidiest
      ? { consistency: tidiest.consistency, at: tidiest.at, laps: tidiest.lapsClean } : null,
  };
}

/** Everything the dashboard draws, in one call. */
export function dashboardSeries(rec, opts = {}) {
  const per = rec.sessions || [];
  const clean = [];
  for (const s of per) for (const lap of s.laps) if (lap.ok) clean.push(lap.time);
  return {
    calendar: activityCalendar(per, opts),
    streaks: streaks(per, opts),
    scatter: lapScatter(per),
    distribution: distribution(clean),
    records: records(per),
    /* Per-session consistency, for the trend of how tidy the flying is. */
    consistency: per.filter(s => s.consistency != null)
      .map(s => ({ at: s.at, v: s.consistency, laps: s.lapsClean })),
    sessionPace: per.filter(s => s.medianLap != null)
      .map(s => ({ at: s.at, best: s.best, pace: s.medianLap, laps: s.lapsClean })),
  };
}
