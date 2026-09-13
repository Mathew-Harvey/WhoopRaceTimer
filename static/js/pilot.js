/* Who you are, and whether you have said yes.
 *
 * The app has never had an account and still does not. What it has now is an
 * identity you can choose to create: a random id generated in this browser, a
 * display name you pick, and a secret that stays here and is the only thing
 * that can later take your data down again. No email, no password, no sign-in.
 *
 * The default is off. Nothing leaves this device until somebody reads the
 * warning and taps the button, and the app works exactly as it did before for
 * anyone who never does.
 */
'use strict';
import * as store from './store.js';

export const CONSENT = {
  unset: 'unset',       /* never been asked, or asked and dismissed */
  declined: 'declined', /* asked and said no; do not ask again unprompted */
  public: 'public',     /* said yes, with the warning shown */
};

/** The exact words somebody has to have been shown before anything is
 *  uploaded. Kept here rather than in a screen so the consent record can name
 *  the version that was agreed to, and so it cannot quietly drift. */
export const WARNING_VERSION = 1;
export const WARNING = [
  'Your lap times and the name you choose become a public web page that anyone can see.',
  'It is not indexed by search engines, but the link works for anyone who has it.',
  'Do not use your real name if you would rather not be identifiable.',
  'You can change your name or delete everything at any time, from this device.',
];

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  (globalThis.crypto || {}).getRandomValues?.(a);
  /* No crypto at all is not a browser this app runs in, but a fallback that
   * produces something unique beats one that produces the same id for
   * everybody. */
  if (!globalThis.crypto?.getRandomValues) {
    for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  }
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  /* RFC 4122 version 4, assembled by hand where randomUUID is missing. */
  const h = randomHex(16).split('');
  h[12] = '4';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const DEFAULT = {
  id: null,
  secret: null,
  name: '',
  consent: CONSENT.unset,
  consentAt: null,
  warningVersion: 0,
  /* runIds already accepted by the service, so a reconnect does not re-upload
   * a season. */
  published: [],
};

export function get() {
  return { ...DEFAULT, ...store.load('pilot', {}) };
}

export function save(patch) {
  const next = { ...get(), ...patch };
  store.save('pilot', next);
  return next;
}

/** Names are shown on a public page beside a lap time, so they are trimmed,
 *  length-capped and stripped of control characters and angle brackets. The
 *  service checks this again — a client-side rule is a convenience, never a
 *  boundary. */
export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    /* Whitespace first, so a tab becomes a space rather than vanishing and
     * welding two words together. */
    .replace(/\s+/g, ' ')
    /* Then control characters and angle brackets. Spelled as escapes rather
     * than written literally: real control bytes in a source file make it
     * binary to git and grep and invisible in an editor. */
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, 32)
    /* The slice can leave a trailing space behind. */
    .trim();
}

export function nameProblem(raw) {
  const n = cleanName(raw);
  if (n.length < 2) return 'Give a name of at least two characters.';
  if (n.length > 32) return 'Keep it to 32 characters.';
  return null;
}

/** Say yes. Creates the identity if this is the first time. */
export function acceptPublic(rawName) {
  const problem = nameProblem(rawName);
  if (problem) throw new Error(problem);
  const cur = get();
  return save({
    id: cur.id || uuid(),
    secret: cur.secret || randomHex(32),
    name: cleanName(rawName),
    consent: CONSENT.public,
    consentAt: Math.floor(Date.now() / 1000),
    warningVersion: WARNING_VERSION,
  });
}

export function decline() {
  return save({ consent: CONSENT.declined, consentAt: Math.floor(Date.now() / 1000) });
}

/** Stop publishing. Keeps the id and secret, because taking the data down
 *  needs them — forgetting who you were is not the same as deleting anything,
 *  and doing the first would make the second impossible. */
export function stopPublishing() {
  return save({ consent: CONSENT.declined });
}

/** After the service confirms a delete: nothing left to own. */
export function forget() {
  store.clear('pilot');
  return get();
}

export function isPublic() {
  const p = get();
  return p.consent === CONSENT.public && !!p.id && !!p.name;
}

/** Whether it is worth asking. Asked once, answered either way, never again
 *  unprompted — the menu is where somebody changes their mind. */
export function shouldAsk() {
  return get().consent === CONSENT.unset;
}

export function markPublished(runId) {
  if (!runId) return;
  const p = get();
  if (p.published.includes(runId)) return;
  save({ published: [...p.published, runId].slice(-500) });
}

export function hasPublished(runId) {
  return get().published.includes(runId);
}

/**
 * Which entry in a session is this pilot.
 *
 * A saved session holds every pilot who raced, and publishing all of them
 * would put three other people's names and times on a public page on the
 * strength of one person's consent. So only the consenting pilot's own entry
 * is ever uploaded, and this is what finds it.
 *
 * Returns null when it cannot tell, which is a refusal and not a failure: the
 * Stats screen then offers the choice rather than guessing.
 */
export function entryFor(session, name) {
  const entries = (session && session.results) || [];
  const withLaps = entries.filter(e => (e.lapTimes || []).length > 0);
  if (!withLaps.length) return null;
  const want = cleanName(name).toLowerCase();
  const matches = withLaps.filter(e => cleanName(e.name).toLowerCase() === want);
  if (matches.length === 1) return matches[0];
  /* Flying on your own is unambiguous whatever the slot was called. */
  if (!matches.length && withLaps.length === 1) return withLaps[0];
  return null;
}
