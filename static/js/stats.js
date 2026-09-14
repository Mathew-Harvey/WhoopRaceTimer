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
import { aggregate, REASONS } from './aggregate.js';
import { dashboard } from './dashboard.js';
import * as pilot from './pilot.js';
import * as publish from './publish.js';
import * as store from './store.js';
import * as track from './track.js';
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

/**
 * Which track the Stats screen is narrowed to.
 *
 * null is every track, '' is the sessions flown before anybody named one, and
 * anything else is that track. Remembered, because a pilot who flies two places
 * mostly wants to look at one of them.
 */
export function focusTrack() {
  return store.load('statsTrack', null);
}

export function setFocusTrack(value) {
  if (value == null) store.clear('statsTrack');
  else store.save('statsTrack', value);
  return value;
}

export function localRecord(name = focusName(), trackFilter = focusTrack()) {
  return aggregate(store.load('history', []), { pilotName: name, track: trackFilter });
}

/* --------------------------------------------------------------- consent -- */

/**
 * Ask, once, after a session. Everything about this sheet is arranged so that
 * the default outcome of dismissing it is that nothing happens.
 */
export function askToPublish(app, { onDone } = {}) {
  let name = pilot.get().name || focusName() || '';
  let where = track.currentName() || '';
  const err = h('p.muted', { style: { color: 'var(--state-red)' }, hidden: true });
  const input = h('input', {
    value: name, maxlength: 32, placeholder: 'The name to show',
    'aria-label': 'Public display name',
    oninput: e => { name = e.target.value; err.hidden = true; },
  });
  const trackInput = h('input', {
    value: where, maxlength: track.MAX, id: 'pubtrack', autocomplete: 'off',
    placeholder: 'Bunbury hall, the back paddock…', 'aria-label': 'Track',
    oninput: e => { where = e.target.value; },
  });

  /* The track is not part of the consent. It is saved on this device whichever
   * button is pressed, because somebody who typed where they are flying has
   * said something true about tonight and throwing it away on a "no thanks" to
   * publishing would be answering a question they were not asked. */
  const keepTrack = () => {
    if (track.trackProblem(where)) return;
    if (track.trackKey(where) === track.trackKey(track.currentName())) return;
    track.set(where);
  };

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

    h('div.field',
      h('label', { for: 'pubtrack' }, 'What track are you flying tonight?'),
      trackInput,
      h('span.hint', 'Stamped on tonight\u2019s sessions so your stats can be read one ' +
                     'track at a time. Saved on this device either way, and you can leave ' +
                     'it blank.')),
    track.known().length ? h('div.row', { style: { gap: 'var(--s2)' } },
      ...track.known().slice(0, 6).map(t => h('button.pill', {
        onclick: () => { where = t.name; trackInput.value = t.name; },
      }, t.name))) : null,

    h('div.row', { style: { gap: '8px' } },
      h('button.ghost', { style: { flex: '1' },
        onclick: () => { keepTrack(); pilot.decline(); close(); onDone?.(false); app?.render?.(); } },
        'No thanks'),
      h('button.go', { style: { flex: '1' }, onclick: () => {
        const problem = pilot.nameProblem(name);
        if (problem) { err.textContent = problem; err.hidden = false; return; }
        keepTrack();
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

/**
 * The Stats screen.
 *
 * The dashboard itself is not built here. It is built by dashboard.js, which
 * the public page also uses, so a pilot's own screen and the page they share
 * cannot end up disagreeing about their own record. What is local to this
 * screen is the two things the public page has no business showing: which of
 * the names on this device to look at, and whether to publish.
 */
SCREENS.stats = app => {
  const node = h('div.screen');
  const names = knownNames();
  const name = focusName();
  const rec = name ? localRecord(name) : null;
  const p = pilot.get();

  const heading = name ? h('div.row', { style: { justifyContent: 'space-between',
                                                 alignItems: 'baseline',
                                                 marginBottom: 'var(--s3)' } },
    h('h3', name),
    names.length > 1 ? h('select', {
      'aria-label': 'Which pilot',
      style: { width: 'auto', minWidth: '140px' },
      onchange: e => { store.save('statsName', e.target.value); app.render(); },
    }, ...names.map(n => h('option', { value: n, selected: n === name }, n))) : null) : null;

  const publishing = h('div.card',
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
    }, p.consent === pilot.CONSENT.public ? 'Publishing settings' : 'Publish my times'));

  mount(node, h('div.scroller', h('div.wrap.stack',
    h('div.row', { style: { justifyContent: 'space-between' } },
      h('h2', 'Stats'),
      h('button.ghost', { onclick: () => app.go(app.mode === 'solo' ? 'fly' : 'race') },
        'Back to the session')),

    rec
      ? dashboard(rec, {
          own: true, heading,
          onTrack: v => { setFocusTrack(v); app.render(); },
        })
      : h('div.card', h('p.muted',
          'No sessions saved on this device yet. Fly one and it lands here.')),

    publishing)));
  return { node };
};

export { REASONS };
