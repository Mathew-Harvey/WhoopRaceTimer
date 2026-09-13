/* The public stats page.
 *
 * Three things it can be, decided by what it is given:
 *
 *   ?pilot=<uuid>   one pilot's record, fetched from the stats service
 *   no query        the championship table, everybody who has published
 *   no service      this browser's own history, aggregated locally
 *
 * That last case is the reason this file does not simply refuse when nothing is
 * configured. The aggregation is the same code either way, so a club running
 * the app with no backend at all still gets the page — it just only ever shows
 * the person holding the phone.
 */
'use strict';
import { aggregate, fmtLap } from './aggregate.js';
import { dashboard } from './dashboard.js';
import * as publish from './publish.js';
import * as store from './store.js';
import { h, mount } from './ui.js';

const page = document.getElementById('page');
const params = new URLSearchParams(location.search);

const when = at => at ? new Date(at * 1000).toLocaleDateString(undefined,
  { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

function header(title, sub) {
  return h('div.row', { style: { justifyContent: 'space-between', alignItems: 'baseline',
                                 marginBottom: 'var(--s2)' } },
    h('div', h('h1', { style: { fontSize: 'var(--t-32)' } }, title),
             sub ? h('p.muted', sub) : null),
    h('a.pill', { href: '../' }, 'Open the timer'));
}

/**
 * One pilot's page.
 *
 * The cards are the same cards the pilot sees on their own phone, built by the
 * same code from the same aggregation — see dashboard.js. Only the sentence
 * under the name differs, because only that depends on whose page this is.
 */
function pilotView(name, rec, { since, local } = {}) {
  return h('div.stack',
    header(name, local
      ? 'From this browser only — nothing here has been published.'
      : `Publishing since ${when(since)}`),
    ...dashboard(rec, { own: false }));
}

function leaderboardView(pilots) {
  return h('div.stack',
    header('Pilots', `${pilots.length} publishing`),
    pilots.length ? h('div.card', h('div.tablewrap', h('table',
      h('thead', h('tr', ...['', 'Pilot', 'Best lap', 'Best consec', 'Laps', 'Sessions', 'Last flown']
        .map(t => h('th', { class: 'cap' }, t)))),
      h('tbody', ...pilots.map(p => h('tr',
        h('td.num', String(p.rank)),
        h('td', h('a', { href: `?pilot=${encodeURIComponent(p.pilotId)}` }, p.pilotName)),
        h('td.num', { style: { color: 'var(--t-purple)' } }, fmtLap(p.bestLap ?? p.best?.lap)),
        h('td.num', fmtLap(p.best?.consec)),
        h('td.num', String(p.totals?.lapsClean ?? 0)),
        h('td.num', String(p.totals?.sessions ?? 0)),
        h('td.num', when(p.totals?.lastAt))))))))
      : h('div.card', h('p.muted', 'Nobody has published yet.')));
}

function problem(title, body) {
  return h('div.stack', header('Pilot stats'), h('div.note', { 'data-tone': 'warn' },
    h('strong', title), body));
}

/* ------------------------------------------------------------------ boot -- */

async function main() {
  const id = params.get('pilot');

  if (!publish.configured()) {
    /* No service. Show what this browser knows, which is honest and still
     * useful, and say plainly that it is not a public page. */
    const history = store.load('history', []);
    const names = new Map();
    for (const s of history) {
      for (const e of s.results || []) {
        if ((e.lapTimes || []).length) names.set(e.name, (names.get(e.name) || 0) + 1);
      }
    }
    const name = params.get('name') || [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!name) {
      mount(page, problem('No public stats service is configured for this site.',
        'This page would show published pilots. There is also nothing saved in this ' +
        'browser to fall back on, so there is nothing to show at all yet.'));
      return;
    }
    mount(page, h('div.stack',
      h('div.note', { 'data-tone': 'warn' },
        h('strong', 'This is not a public page.'),
        'No stats service is configured for this site, so this is your own saved ' +
        'history, read from this browser. Nobody else can see it.'),
      pilotView(name, aggregate(history, { pilotName: name }), { local: true })));
    return;
  }

  try {
    if (id) {
      const data = await publish.fetchPilot(id);
      mount(page, pilotView(data.pilot.name, data.record, { since: data.pilot.since }));
      document.title = `${data.pilot.name} — WhoopTimer stats`;
    } else {
      const data = await publish.fetchLeaderboard();
      mount(page, leaderboardView(data.pilots || []));
    }
  } catch (err) {
    mount(page, problem(
      err.status === 404 ? 'No such pilot.' : 'Could not reach the stats service.',
      err.status === 404
        ? 'The link may be wrong, or the pilot deleted their data — which they are ' +
          'entitled to do at any time.'
        : 'It may be offline, or you may be. The timer itself does not need it.'));
  }
}

main();
