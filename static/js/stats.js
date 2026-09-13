/* The pilot's own record, and the decision to make it public.
 *
 * Two things live here and they are deliberately separate.
 *
 * The Stats screen works for everybody, always, with nothing switched on and
 * nothing sent anywhere. It is this browser's own saved history, cleaned and
 * rolled up. No consent is involved because no new data exists: the sessions
 * were already on this device before this screen was written.
 *
 * Publishing is the opt-in, and it is the only thing that asks. The warning is
 * shown before the name field, not after it and not in a link — somebody
 * typing a name into a box has already decided, and a warning that arrives
 * after the decision is a formality rather than a choice.
 */
'use strict';
import { aggregate, fmtDuration, fmtLap, REASONS } from './aggregate.js';
import * as pilot from './pilot.js';
import * as publish from './publish.js';
import * as store from './store.js';
import { SCREENS } from './screens.js';
import { confirmSheet, h, mount, plural, sheet, sheetOpen, toast } from './ui.js';

/* ------------------------------------------------------------------ data -- */

/** Every pilot name this browser has ever recorded a lap for. */
export function knownNames(history = store.load('history', [])) {
  const seen = new Map();
  for (const s of history) {
    for (const e of s.results || []) {
      if (!(e.lapTimes || []).length) continue;
      const n = pilot.cleanName(e.name);
      if (n) seen.set(n, (seen.get(n) || 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

/** Whose record the Stats screen is showing. The published name wins; failing
 *  that, whichever name this browser has flown most. */
export function focusName() {
  const p = pilot.get();
  if (p.name) return p.name;
  const saved = store.load('statsName', null);
  if (saved) return saved;
  return knownNames()[0] || null;
}

export function localRecord(name = focusName()) {
  return aggregate(store.load('history', []), { pilotName: name });
}

/* --------------------------------------------------------------- consent -- */

/**
 * Ask, once, after a session. Everything about this sheet is arranged so that
 * the default outcome of dismissing it is that nothing happens.
 */
export function askToPublish(app, { onDone } = {}) {
  let name = pilot.get().name || focusName() || '';
  const err = h('p.muted', { style: { color: 'var(--state-red)' }, hidden: true });
  const input = h('input', {
    value: name, maxlength: 32, placeholder: 'The name to show',
    'aria-label': 'Public display name',
    oninput: e => { name = e.target.value; err.hidden = true; },
  });

  sheet('Save your times?', close => h('div.stack',
    h('p', 'WhoopTimer keeps every session on this device already. You can also publish ' +
           'your lap times to a public page, so you can follow your own progress from ' +
           'anywhere and compare it with other pilots.'),

    h('div.note', { 'data-tone': 'warn' },
      h('strong', 'This part is public.'),
      h('ul', { style: { margin: '6px 0 0', paddingLeft: '1.2em' } },
        ...pilot.WARNING.map(line => h('li', line)))),

    h('div.field',
      h('label', { for: 'pubname' }, 'Name to publish under'),
      Object.assign(input, { id: 'pubname' }),
      h('span.hint', 'A nickname is fine. You can change it or delete everything later.')),
    err,

    h('div.row', { style: { gap: '8px' } },
      h('button.ghost', { style: { flex: '1' },
        onclick: () => { pilot.decline(); close(); onDone?.(false); app?.render?.(); } },
        'No thanks'),
      h('button.go', { style: { flex: '1' }, onclick: () => {
        const problem = pilot.nameProblem(name);
        if (problem) { err.textContent = problem; err.hidden = false; return; }
        pilot.acceptPublic(name);
        close();
        queueEverything();
        publish.flush().then(r => {
          if (r.sent) toast(`Published ${plural(r.sent, 'session')}.`, 'ok');
          else if (r.remaining) toast('Saved — it will publish when there is signal.', 'ok');
        }).catch(() => {});
        onDone?.(true);
        app?.render?.();
      } }, 'Publish my times')),

    h('p.muted', { style: { fontSize: 'var(--t-13)' } },
      'Not now? Nothing is sent, and the app carries on exactly as before. ' +
      'You can turn this on later from the menu.')),
  { onClose: () => { onDone?.(null); } });
}

/** Put every unpublished session this pilot owns on the queue. */
export function queueEverything() {
  const who = pilot.get();
  if (!pilot.isPublic()) return 0;
  let n = 0;
  for (const s of store.load('history', [])) {
    if (pilot.hasPublished(s.runId)) continue;
    const entry = pilot.entryFor(s, who.name);
    if (entry && publish.enqueue(s, entry, who)) n++;
  }
  return n;
}

/**
 * Wait for the results to be read, then ask.
 *
 * A finished session opens its results sheet immediately after this runs, and
 * opening a sheet closes whatever was already open — so asking straight away
 * creates the consent sheet and then destroys it a tick later. Nobody sees it
 * and nobody is ever asked again, because the app has recorded that it asked.
 *
 * Waiting for the results to be dismissed is also the better moment: the pilot
 * has just seen the laps the question is about.
 */
function askWhenFree(app) {
  let tries = 0;
  const tick = () => {
    /* Ten minutes of patience, then give up rather than ambush somebody who
     * left the results open and walked away. shouldAsk() is re-checked because
     * they may have used the menu in the meantime. */
    if (sheetOpen()) {
      if (tries++ < 1200) setTimeout(tick, 500);
      return;
    }
    if (pilot.shouldAsk()) askToPublish(app);
  };
  setTimeout(tick, 800);
}

/** Called by the app when a session ends. Never blocks and never throws. */
export function onSessionSaved(app, session) {
  try {
    if (pilot.isPublic()) {
      const entry = pilot.entryFor(session, pilot.get().name);
      if (entry && publish.enqueue(session, entry)) {
        publish.flush().catch(() => {});
      }
      return;
    }
    /* Asked once, ever, and only after a session that actually recorded
     * something — being asked to publish nothing is just a dialog in the way. */
    if (pilot.shouldAsk() && (session.results || []).some(e => (e.lapTimes || []).length >= 3)) {
      askWhenFree(app);
    }
  } catch (err) {
    console.warn('[stats]', err);
  }
}

/* -------------------------------------------------------------- settings -- */

export function publishingSheet(app) {
  const p = pilot.get();
  const link = publish.pilotUrl(p.id);

  sheet('Publishing', close => h('div.stack',
    !publish.configured() ? h('div.note',
      h('strong', 'No public service is configured for this site.'),
      'Your stats page works here, on this browser’s own history. Publishing is off ' +
      'because there is nowhere to publish to — see stats-service/README.md.') : null,

    p.consent === pilot.CONSENT.public ? h('div.stack.tight',
      h('div.note', { 'data-tone': 'ok' },
        h('strong', `Publishing as ${p.name}`),
        link ? h('div', h('a', { href: link }, link)) : 'Queued on this device.'),
      publish.queueSize()
        ? h('p.muted', `${plural(publish.queueSize(), 'session')} waiting for signal.`)
        : null,
      h('div.row', { style: { gap: '8px' } },
        h('button.ghost', { onclick: () => { close(); renameSheet(app); } }, 'Change name'),
        h('button.ghost', { onclick: () => {
          pilot.stopPublishing(); close(); app?.render?.();
          toast('Stopped publishing. What is already up stays up until you delete it.');
        } }, 'Stop publishing')),
      h('button.danger.wide', { onclick: () => { close(); deleteSheet(app); } },
        'Delete my public data'))
      : h('div.stack.tight',
          h('p.muted', p.consent === pilot.CONSENT.declined
            ? 'Not publishing. Your sessions stay on this device.'
            : 'Not publishing yet.'),
          h('button.go.wide', { onclick: () => { close(); askToPublish(app); } },
            'Publish my times')),

    h('p.muted', { style: { fontSize: 'var(--t-13)' } },
      'Your stats page on this device works either way. Publishing only decides ' +
      'whether anyone else can see it.')));
}

function renameSheet(app) {
  let name = pilot.get().name;
  const err = h('p.muted', { style: { color: 'var(--state-red)' }, hidden: true });
  sheet('Change your public name', close => h('div.stack',
    h('div.field',
      h('label', 'Name'),
      h('input', { value: name, maxlength: 32, oninput: e => { name = e.target.value; err.hidden = true; } })),
    err,
    h('div.row', { style: { gap: '8px' } },
      h('button.ghost', { style: { flex: '1' }, onclick: close }, 'Cancel'),
      h('button.go', { style: { flex: '1' }, onclick: async () => {
        try {
          await publish.rename(name);
          close(); app?.render?.(); toast('Name changed.', 'ok');
        } catch (e) { err.textContent = e.message; err.hidden = false; }
      } }, 'Save'))));
}

function deleteSheet(app) {
  confirmSheet('Delete everything you have published?',
    'Your public page, your name and every lap time on it are removed. The sessions ' +
    'saved on this device are not touched. This cannot be undone, and a new name ' +
    'later starts from nothing.',
    'Delete it all',
    async () => {
      try {
        await publish.deleteEverything();
        app?.render?.();
        toast('Deleted. Nothing of yours is published any more.', 'ok');
      } catch (e) {
        toast('Could not reach the service — nothing was deleted. Try again with signal.', 'err', 7000);
      }
    });
}

/* ---------------------------------------------------------------- screen -- */

const PERIODS = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months']];

function stat(label, value, tone) {
  return h('div.stat', { style: { display: 'grid', gap: '2px', justifyItems: 'start' } },
    h('div.cap', label),
    h('div.num', { style: { fontSize: 'var(--t-24)', fontWeight: '700',
                            color: tone ? `var(--t-${tone})` : 'var(--t-plain)' } }, value));
}

/** The personal best over time, as one line. Small enough to read at a glance
 *  and the only chart that answers "am I getting quicker". */
function progressionChart(points) {
  if (points.length < 2) return null;
  const W = 600, H = 120, PAD = 8;
  const bests = points.map(p => p.best);
  const lo = Math.min(...bests), hi = Math.max(...bests);
  const span = (hi - lo) || 1;
  const x = i => PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = v => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.best).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => h('circle', {
    cx: x(i).toFixed(1), cy: y(p.sessionBest ?? p.best).toFixed(1), r: 2.5,
    style: { fill: 'var(--fg-3)' },
  }));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Personal best over ${points.length} sessions, ` +
                                 `from ${fmtLap(bests[0])} to ${fmtLap(bests[bests.length - 1])}`);
  svg.style.width = '100%';
  svg.style.height = 'auto';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-width', '2.5');
  path.style.stroke = 'var(--t-purple)';
  for (const d of dots) svg.appendChild(d);
  svg.appendChild(path);
  return h('div', { style: { background: 'var(--recess)', borderRadius: 'var(--r2)',
                             padding: 'var(--s3)' } }, svg);
}

function periodTable(rows) {
  if (!rows.length) return h('p.muted', 'Nothing here yet.');
  return h('div', { style: { overflowX: 'auto' } },
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--t-15)' } },
      h('thead', h('tr',
        ...['', 'Sessions', 'Laps', 'Best', 'Pace', 'Air time'].map(t =>
          h('th', { class: 'cap', style: { textAlign: t ? 'right' : 'left', padding: '6px 8px' } }, t)))),
      h('tbody', ...[...rows].reverse().map(r => h('tr',
        h('td', { style: { padding: '6px 8px', borderTop: '1px solid var(--line-subtle)' } },
          h('strong', r.key)),
        ...[r.sessions, r.lapsClean, fmtLap(r.best), fmtLap(r.pace), fmtDuration(r.airTimeS)]
          .map(v => h('td', { class: 'num', style: { textAlign: 'right', padding: '6px 8px',
                                                     borderTop: '1px solid var(--line-subtle)' } }, v)))))));
}

SCREENS.stats = app => {
  const node = h('div.screen');
  const names = knownNames();
  const name = focusName();
  const rec = localRecord(name);
  const p = pilot.get();
  let period = store.load('statsPeriod', 'day');

  const body = h('div.stack');
  const draw = () => mount(body,
    !name ? h('div.card', h('p.muted',
      'No sessions saved on this device yet. Fly one and it lands here.')) : null,

    name ? h('div.card',
      h('div.row', { style: { justifyContent: 'space-between', alignItems: 'baseline' } },
        h('h3', name),
        names.length > 1 ? h('select', {
          'aria-label': 'Which pilot',
          onchange: e => { store.save('statsName', e.target.value); app.render(); },
        }, ...names.map(n => h('option', { value: n, selected: n === name }, n))) : null),
      h('div', { style: { display: 'grid', gap: 'var(--s4)', marginTop: 'var(--s3)',
                          gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))' } },
        stat('Best lap', fmtLap(rec.best.lap), 'purple'),
        stat(`Best ${rec.sessions[0]?.consecN || 3}`, fmtLap(rec.best.consec)),
        stat('Race pace', fmtLap(rec.pace)),
        stat('Sessions', String(rec.totals.sessions)),
        stat('Clean laps', String(rec.totals.lapsClean)),
        stat('Air time', fmtDuration(rec.totals.airTimeS)))) : null,

    name && rec.progression.length > 1 ? h('div.card',
      h('h3', 'Personal best over time'),
      /* Form against career only says something once there is a career to
       * compare against. With five sessions the last five are the career, and
       * "0.00s off your career pace" is a true sentence that means nothing. */
      h('p.muted', rec.form.paceDelta != null && rec.totals.sessionsWithLaps > rec.form.last5.sessions
        ? (rec.form.paceDelta < 0
            ? `Your last five sessions are ${Math.abs(rec.form.paceDelta).toFixed(2)}s a lap quicker than your career pace.`
            : `Your last five sessions are ${rec.form.paceDelta.toFixed(2)}s a lap off your career pace.`)
        : `${rec.totals.sessionsWithLaps} sessions so far.`),
      progressionChart(rec.progression)) : null,

    name && rec.totals.sessions ? h('div.card',
      h('div.row', { style: { justifyContent: 'space-between' } },
        h('h3', 'Over time'),
        h('div.seg', ...PERIODS.map(([k, label]) => h('button', {
          'aria-pressed': period === k, onclick: () => { period = store.save('statsPeriod', k); draw(); },
        }, label)))),
      periodTable(rec.periods[period])) : null,

    name && rec.totals.stoppages ? h('div.note',
      h('strong', `${plural(rec.totals.stoppages, 'lap')} left out of your pace`),
      `Battery changes, crashes and double triggers are counted as laps flown ` +
      `(${rec.totals.lapsRecorded}) but not as lap times (${rec.totals.lapsClean}). ` +
      `Without that, one battery change makes your average lap look like several minutes.`) : null,

    h('div.card',
      h('h3', 'Publishing'),
      h('p.muted', p.consent === pilot.CONSENT.public
        ? `Publishing as ${p.name}.` + (publish.queueSize()
            ? ` ${plural(publish.queueSize(), 'session')} waiting for signal.` : '')
        : 'Everything above is on this device only. Nothing has been uploaded.'),
      publish.pilotUrl(p.id)
        ? h('p', h('a', { href: publish.pilotUrl(p.id) }, publish.pilotUrl(p.id))) : null,
      /* Straight to the question when there is a question to ask. Routing a
       * first-time yes through a settings sheet that then offers the same
       * button again is a step that exists only because the code was
       * organised that way. */
      h('button.ghost', {
        onclick: () => (p.consent === pilot.CONSENT.public ? publishingSheet(app) : askToPublish(app)),
      }, p.consent === pilot.CONSENT.public ? 'Publishing settings' : 'Publish my times')));

  draw();
  mount(node, h('div.scroller', h('div.wrap.stack',
    h('div.row', { style: { justifyContent: 'space-between' } },
      h('h2', 'Stats'),
      h('button.ghost', { onclick: () => app.go(app.mode === 'solo' ? 'fly' : 'race') },
        'Back to the session')),
    body)));
  return { node };
};

export { REASONS };
