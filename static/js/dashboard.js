/* The dashboard.
 *
 * One layout, used by both the in-app Stats screen and the public pilot page.
 * It lives in its own file for exactly one reason: two copies of "what a pilot
 * record looks like" would drift, and the way that failure shows up is a pilot
 * whose public page disagrees with the phone in their hand about their own best
 * lap. The aggregation is already shared with the server for the same reason.
 *
 * The order is the order the questions get asked: what have I done, how often
 * am I flying, am I getting quicker, what do my laps actually look like, and
 * what are the numbers underneath.
 */
'use strict';
import { dashboardSeries, fmtDuration, fmtLap, fmtSpread } from './aggregate.js';
import * as charts from './charts.js';
import * as store from './store.js';
import { h, mount, plural } from './ui.js';

const card = (...kids) => h('div.card', ...kids);
const dayLabel = key => key
  ? new Date(key + 'T00:00:00').toLocaleDateString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';
const atLabel = at => at
  ? new Date(at * 1000).toLocaleDateString(undefined,
      { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

export function stat(label, value, tone) {
  return h('div.stat',
    h('div.cap', label),
    h('div.v', { 'data-tone': tone || null }, value));
}

const PERIODS = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']];

/* ------------------------------------------------------------- the cards -- */

function headline(rec, consecN, heading) {
  return card(
    heading || null,
    h('div.statgrid',
      stat('Best lap', fmtLap(rec.best.lap), 'purple'),
      stat(`Best ${consecN || 3}`, fmtLap(rec.best.consec)),
      stat('Race pace', fmtLap(rec.pace)),
      stat('Spread', fmtSpread(rec.consistency)),
      stat('Sessions', String(rec.totals.sessions)),
      stat('Clean laps', String(rec.totals.lapsClean)),
      stat('Air time', fmtDuration(rec.totals.airTimeS))));
}

/**
 * The days-flown tracker.
 *
 * A current streak is only reported while it is still alive — see streaks() —
 * because a number labelled "current" that is actually a memory of March is the
 * kind of flattery that makes every other number on the page suspect.
 */
function daysFlown(series) {
  const st = series.streaks;
  const heat = charts.activityHeatmap(series.calendar);
  return card(
    h('div.fighead',
      h('div', h('h3', 'Days flown'),
        h('p.muted.fignote', st.daysFlown
          ? `${plural(st.daysFlown, 'day')} in the air, last on ${dayLabel(st.lastFlown)}.`
          : 'No days flown yet.')),
      null),
    h('div.statgrid.tight',
      stat('Days flown', String(st.daysFlown)),
      stat('Current streak', st.live ? plural(st.current, 'day') : '—',
           st.live && st.current > 1 ? 'green' : null),
      stat('Longest streak', plural(st.longest, 'day')),
      stat('This month', String(st.thisMonth)),
      stat('This year', String(st.thisYear))),
    heat,
    heat ? h('details.tabledrop',
      h('summary.cap', 'Month by month'),
      charts.calendarTable(series.calendar)) : null);
}

function bests(series, rec) {
  const r = series.records;
  const rows = [
    r.mostLapsInSession && ['Most laps in a session', String(r.mostLapsInSession.laps),
                            atLabel(r.mostLapsInSession.at)],
    r.mostLapsInDay && ['Most laps in a day', String(r.mostLapsInDay.laps),
                        dayLabel(r.mostLapsInDay.key)],
    r.longestSession && ['Longest session', fmtDuration(r.longestSession.airTimeS),
                         atLabel(r.longestSession.at)],
    r.tidiestSession && ['Tidiest session', `${fmtSpread(r.tidiestSession.consistency)} spread`,
                         atLabel(r.tidiestSession.at)],
    rec.best.session && ['Personal best', fmtLap(rec.best.lap), atLabel(rec.best.session.at)],
  ].filter(Boolean);
  if (!rows.length) return null;
  return card(h('h3', 'Career bests'),
    charts.dataTable(['', 'Figure', 'When'], rows, { align: ['l', 'r', 'r'] }));
}

function overTime(rec) {
  if (!rec.totals.sessions) return null;
  let period = store.load('statsPeriod', 'day');
  const table = h('div');
  const draw = () => mount(table, periodTable(rec.periods[period]));
  draw();
  return card(
    h('div.fighead',
      h('h3', 'Over time'),
      h('div.seg', ...PERIODS.map(([k, label]) => h('button', {
        'aria-pressed': period === k,
        onclick: e => {
          period = store.save('statsPeriod', k);
          for (const b of e.target.parentNode.children) b.setAttribute('aria-pressed', 'false');
          e.target.setAttribute('aria-pressed', 'true');
          draw();
        },
      }, label)))),
    table);
}

function periodTable(rows) {
  if (!rows || !rows.length) return h('p.muted', 'Nothing here yet.');
  return charts.dataTable(
    ['', 'Sessions', 'Laps', 'Best', 'Pace', 'Air time'],
    [...rows].reverse().slice(0, 40).map(r =>
      [h('strong', r.key), String(r.sessions), String(r.lapsClean),
       fmtLap(r.best), fmtLap(r.pace), fmtDuration(r.airTimeS)]),
    { align: ['l'] });
}

function form(rec) {
  /* Form against career only says something once there is a career to compare
   * against. With five sessions the last five are the career, and "0.00s off
   * your career pace" is a true sentence that means nothing. */
  if (rec.form.paceDelta == null) return null;
  if (rec.totals.sessionsWithLaps <= rec.form.last5.sessions) return null;
  const d = rec.form.paceDelta;
  return card(
    h('h3', 'Form'),
    h('p.muted', d < 0
      ? `The last five sessions are ${Math.abs(d).toFixed(2)}s a lap quicker than the career pace.`
      : `The last five sessions are ${d.toFixed(2)}s a lap off the career pace.`),
    h('div.statgrid.tight',
      stat('Recent pace', fmtLap(rec.form.last5.pace), d < 0 ? 'green' : null),
      stat('Career pace', fmtLap(rec.form.allTime.pace)),
      stat('Recent best', fmtLap(rec.form.last5.best))));
}

function cleaningNote(rec, { own }) {
  if (!rec.totals.stoppages) return null;
  const whose = own ? 'your' : 'the';
  return h('div.note',
    h('strong', `${plural(rec.totals.stoppages, 'lap')} left out of ${whose} pace`),
    `Battery changes, crashes and double triggers count as laps flown ` +
    `(${rec.totals.lapsRecorded}) but not as lap times (${rec.totals.lapsClean}). ` +
    `Without that, one battery change makes an average lap look like several minutes.`);
}

/* ------------------------------------------------------------------ all -- */

/**
 * Every card, in order, as an array the caller can splice its own cards into.
 *
 * `own` only changes pronouns. Nothing about what is shown or how it is
 * computed depends on whose page this is.
 */
export function dashboard(rec, { today = Date.now(), own = false, heading = null } = {}) {
  const series = dashboardSeries(rec, { today });
  const consecN = rec.sessions[0] && rec.sessions[0].consecN;

  return [
    headline(rec, consecN, heading),
    cleaningNote(rec, { own }),
    daysFlown(series),

    charts.figure({
      title: 'Pace over time',
      note: 'Best lap and the median lap of each session. Sessions are spaced ' +
            'evenly, not by date, so a quiet month cannot squash a busy week.',
      legend: [
        { label: 'Best lap', color: 'var(--c-best)' },
        { label: 'Session pace', color: 'var(--c-pace)', dash: '5 4' },
      ],
      chart: charts.paceChart(series.sessionPace),
      table: charts.paceTable(series.sessionPace),
    }),

    form(rec),

    charts.figure({
      title: 'Every lap',
      note: series.scatter.length > charts.SCATTER_MAX
        ? `The most recent ${charts.SCATTER_MAX.toLocaleString()} clean laps, in the ` +
          `order they were flown, of ${series.scatter.length.toLocaleString()} flown ` +
          `in all. The purple one is the best of those shown.`
        : 'Each clean lap in the order it was flown. The purple one is the best.',
      chart: charts.lapScatterChart(series.scatter),
      table: charts.dataTable(['Lap time', 'Lap of session', 'Flown'],
        [...series.scatter].reverse().slice(0, 200).map(p =>
          [fmtLap(p.t), String(p.lapNumber), atLabel(p.at)]), { align: ['l'] }),
    }),

    charts.figure({
      title: 'Where the laps land',
      note: 'Every clean lap, counted into bins. A tall narrow shape is a ' +
            'consistent pilot; a long tail to the right is laps that went wrong.',
      chart: charts.histogram(series.distribution),
      table: charts.histogramTable(series.distribution),
    }),

    charts.figure({
      title: 'Consistency',
      note: 'How tightly each session\u2019s laps cluster: the middle half of the laps ' +
            'as a share of the median lap. Lower is tidier, and because it is a share ' +
            'rather than a time it means the same thing on a fast track and a slow one.',
      chart: charts.consistencyChart(series.consistency),
      table: charts.consistencyTable(series.consistency),
    }),

    bests(series, rec),
    overTime(rec),

    h('p.muted.finenote',
      'Lap times are cleaned before they are counted: a lap more than three times the ' +
      'session median is treated as a stoppage, and the rest are judged against the ' +
      'session’s own median and median absolute deviation rather than a mean, which one ' +
      'battery change is enough to ruin.'),
  ].filter(Boolean);
}
