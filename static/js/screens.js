/* Every screen in the app.
 *
 * Each builder returns { node, update } — `node` is built once, `update` runs
 * every animation frame and only touches text and attributes. That keeps the
 * clock smooth without a framework and without stealing focus from an input
 * somebody is typing in.
 */
'use strict';
import * as laprf from './laprf.js';
import * as store from './store.js';
import * as tuning from './tuning.js';
import { fmtDuration } from './race.js';
import { ChannelScanner } from './tuning.js';
import { h, mount, clear, icon, toast, sheet, confirmSheet, clockStr, fmt2, plural } from './ui.js';
import { DOCTOR_URL } from './setup.js';

export const SCREENS = {};
const SLOTS = [1, 2, 3, 4];
const idVar = slot => `var(--id-${((slot - 1) % 4) + 1})`;

/* =========================================================== top bar ===== */

SCREENS.topbar = app => {
  const link = app.link;
  const tone = !app.connected ? 'bad' : link.mode === 'ascii' ? 'warn' : 'ok';
  const label = !app.connected ? 'Not connected'
              : link.kind === 'demo' ? 'Demo timer'
              : (link.detail || 'Connected');

  const bits = [
    h('div.mark', icon('bolt', 22),
      h('span', { style: { display: window.innerWidth < 520 ? 'none' : 'inline' } }, 'WhoopTimer')),
    h('button.pill', { 'data-tone': tone, onclick: () => connectionSheet(app),
                       title: 'Connection' },
      h('span.dot'), label),
  ];
  if (app.timer.battery) {
    bits.push(h('span.pill', { title: 'Timer battery' }, app.timer.battery.toFixed(2) + 'V'));
  }
  bits.push(h('div.spacer'));
  if (app.connected) {
    const silent = !app.prefs.voiceOn || app.prefs.announce === 'off';
    const speaks = !silent && app.voice.available;
    const vLabel = !app.voice.available ? 'No voices' : silent ? 'Silent' : 'Voice';
    bits.push(h('button.pill', {
      'data-tone': speaks ? 'ok' : !app.voice.available ? 'warn' : '',
      'aria-label': speaks ? 'Voice callouts on' : 'Voice callouts off',
      title: !app.voice.available ? 'This browser reports no speech voices' : 'Tap to toggle spoken lap times',
      onclick: () => {
        app.voice.arm(true);
        /* One control, one meaning: tapping it makes callouts speak or stop,
         * whichever of the two settings was in the way. */
        if (silent) app.savePrefs({ voiceOn: true, announce: app.prefs.announce === 'off' ? 'full' : app.prefs.announce });
        else app.savePrefs({ voiceOn: false });
      },
    }, icon(speaks ? 'volume' : 'mute', 16),
       h('span', { style: { display: window.innerWidth < 420 ? 'none' : 'inline' } }, vLabel)));
    bits.push(h('button.pill', { 'aria-label': 'Menu', onclick: () => menuSheet(app) },
      icon('gear', 16)));
  }
  return bits;
};

function connectionSheet(app) {
  sheet('Connection', close => {
    const rows = [];
    if (app.connected) {
      const l = app.link;
      rows.push(h('div.note', { 'data-tone': l.mode === 'ascii' ? 'warn' : 'ok' },
        h('strong', l.detail || 'Connected'),
        l.mode === 'ascii'
          ? 'USB console only: this unit reports signal over USB but never a lap record. ' +
            'Use Bluetooth for timing.'
          : `Talking to the timer over ${l.kind === 'bluetooth' ? 'Bluetooth' :
             l.kind === 'usb' ? 'USB' : l.kind === 'demo' ? 'a simulator' : 'the local bridge'}.`));
      const ready = SLOTS.filter(s => app.health(s).level === 'good').length;
      rows.push(h('p.muted', ready === SLOTS.length ? 'Gate calibrated.'
                                                    : `${ready} of ${SLOTS.length} receivers calibrated.`));
      rows.push(h('button.ghost.wide', { onclick: () => { close(); app.disconnect(); } },
        'Disconnect'));
    } else {
      rows.push(h('p.muted', 'No timer. Switch it on, then connect.'));
      rows.push(h('button.go.wide', { onclick: () => { close(); app.go('connect'); } }, 'Connect'));
    }
    return h('div.stack', rows);
  });
}

function menuSheet(app) {
  const item = (glyph, label, sub, fn) => h('button.bigbtn.ghost', { onclick: () => fn() },
    h('div.ico', icon(glyph, 22)), h('div', h('strong', label), sub && h('small', sub)),
    h('div.chev', icon('chev', 18)));
  sheet('WhoopTimer', close => h('div.stack.tight',
    item('target', 'Gate & signal', 'What counts as a lap',
         () => { close(); app.go('gate'); }),
    item('list', 'History', 'Saved sessions and export', () => { close(); app.go('history'); }),
    item('clock', 'Race settings', 'Countdown, minimum lap, holeshot',
         () => { close(); settingsSheet(app); }),
    item('volume', 'Voice', 'Callout style, voice and speed', () => { close(); voiceSheet(app); }),
    item(app.mode === 'solo' ? 'flag' : 'pilot',
         app.mode === 'solo' ? 'Switch to racing' : 'Switch to solo practice',
         app.mode === 'solo' ? 'Two to four pilots' : 'Just you, open laps',
         () => { close(); app.useMode(app.mode === 'solo' ? 'race' : 'solo'); }),
    item('bolt', app.prefs.theme === 'day' ? 'Night colours' : 'Daylight colours',
         'For a hall with windows',
         () => { close(); app.savePrefs({ theme: app.prefs.theme === 'day' ? 'dark' : 'day' }); }),
    item('gear', 'Keyboard shortcuts', 'Manual laps and undo',
         () => { close(); shortcutsSheet(); }),
  ));
}

function shortcutsSheet() {
  sheet('Keyboard', () => h('div.kbdhelp',
    h('div', h('kbd', 'Space'), 'Start or stop the session'),
    h('div', h('kbd', '1'), h('kbd', '2'), h('kbd', '3'), h('kbd', '4'),
      'Log a lap by hand for that pilot'),
    h('div', h('kbd', 'U'), 'Undo the last lap'),
    h('div', h('kbd', 'G'), 'Gate and signal'),
    h('div', h('kbd', 'H'), 'History'),
    h('div', h('kbd', 'Esc'), 'Back to the session')));
}

/* =========================================================== connect ===== */

SCREENS.connect = app => {
  const c = app.caps;
  const node = h('div.screen');
  const inner = h('div.inner');
  node.appendChild(h('div.connect', inner));

  const hero = h('div.hero',
    h('div.logo', logoSvg()),
    h('h1', 'WhoopTimer'),
    h('p.sub', 'Lap timing for whoop racing'));

  if (app.connecting) {
    mount(inner, hero,
      h('div.searching',
        h('div.spinner'),
        h('strong', app.connecting),
        h('p.muted', app.connectingKind === 'usb' ? 'Pick the timer’s serial port.'
          : 'Pick your timer in the browser’s list. It appears as CrabLake on most units.')),
      h('button.ghost.wide', { onclick: () => app.cancelConnect() }, 'Cancel'));
    return { node };
  }

  /* A bridge that already holds a timer means step 1 is done — saying "switch
   * your timer on" to someone whose timer is plainly on reads as broken. */
  const bridgeReady = !!app.bridge?.available;
  const canConnect = c.bluetooth || c.serialLikely || bridgeReady;
  const steps = h('div.stack.tight',
    h('div.step', bridgeReady ? { 'data-done': '' } : { 'data-live': '' },
      h('div.n', bridgeReady ? '✓' : '1'),
      h('div',
        h('strong', 'Switch your timer on'),
        h('p.why', 'A LapRF only accepts a new connection for about a minute after ' +
                   'power-on — not after a dropout. If it has been on a while, flick it ' +
                   'off and on again now.'))),
    h('div.step',
      h('div.n', '2'),
      h('div',
        h('strong', canConnect ? (bridgeReady ? 'Tap the green button' : 'Connect below')
                               : 'This browser can’t connect to a timer'),
        h('p.why', canConnect
          ? 'Your browser will ask which device to use. Nothing is installed and nothing leaves this device.'
          : 'Open this page in Chrome or Edge (or Bluefy on an iPhone), or run WhoopTimer on a ' +
            'laptop and open the address it prints — see the link below.'))));

  const buttons = h('div.stack.tight');
  const option = (primary, glyph, title, sub, kind) =>
    h(primary ? 'button.bigbtn.go' : 'button.bigbtn',
      { onclick: () => (kind === 'reconnect' ? app.reconnect() : app.connect(kind)) },
      h('div.ico', icon(glyph)), h('div', h('strong', title), h('small', sub)),
      h('div.chev', icon('chev', 20)));

  /* Whichever route is most likely to work goes first and green. A bridge that
   * already has the timer beats a Bluetooth chooser this browser cannot open. */
  const opts = [];
  const dropped = app.link && !app.connected && app.linkKind !== 'demo';
  if (dropped && app.linkKind === 'bluetooth' && app.link.device) {
    opts.push(['reconnect', 'bluetooth', `Reconnect to ${app.link.deviceName || 'the timer'}`,
               'Power-cycle it first — no chooser needed']);
  }
  if (c.bluetooth) {
    opts.push(['bluetooth', 'bluetooth', 'Connect by Bluetooth', 'Recommended — full lap timing']);
  }
  if (bridgeReady) {
    opts.push(['bridge', 'plug', 'Use the timer WhoopTimer is holding',
               (app.bridge.detail ? `${app.bridge.detail} — ` : '') +
               'via the computer running WhoopTimer, which already has the link']);
  }
  if (c.serialLikely) {
    opts.push(['usb', 'usb', 'Connect by USB cable',
               'Signal and gate tuning only on most units — timing laps needs Bluetooth']);
  }
  opts.forEach(([kind, glyph, title, sub], i) =>
    buttons.appendChild(option(i === 0 && kind !== 'usb', glyph, title, sub, kind)));

  const notes = h('div.stack.tight');
  if (app.race.active) {
    notes.appendChild(h('div.note', { 'data-tone': 'warn' },
      h('strong', 'A session is still running' + (app.restored && !dropped ? ' (restored after the reload)' : '')),
      'Connect to keep timing from the gate, or press Esc to go back to it — laps by hand ' +
      '(keys 1–4) count either way.'));
  }
  if (app.connectError) {
    notes.appendChild(h('div.note', { 'data-tone': 'bad' },
      h('strong', app.connectError.title), app.connectError.body,
      c.bluetooth && h('div.act',
        h('button.ghost', { onclick: () => app.connect('bluetooth', { showAll: true }) },
          'Show all Bluetooth devices'))));
  }
  /* The setup check owns "this browser cannot reach Bluetooth" now — it says
   * the same thing and carries the commands that fix it. A local bridge makes
   * that moot, though: the timer is reachable without the browser's radio. */
  for (const p of app.setupProblems) {
    if (p.id === 'no-web-bluetooth' && bridgeReady) continue;
    notes.appendChild(setupNote(app, p));
  }
  if (c.bluetooth && !c.offlineCapable) {
    notes.appendChild(h('div.note',
      h('strong', 'No offline copy in this browser'),
      'This browser cannot store the app for use without signal. Open it once while you ' +
      'still have coverage on the way to the track, and keep the tab open.'));
  }

  mount(inner, hero, steps, buttons, notes,
    h('div.linkrow',
      h('button', { onclick: () => app.connect('demo') }, 'Try it without a timer'),
      h('button', { onclick: () => helpSheet(app) }, 'My timer isn’t showing up'),
      !canConnect && h('a', { href: 'https://github.com/Mathew-Harvey/WhoopRaceTimer#running-it-locally',
                              target: '_blank', rel: 'noopener' }, 'Get the local app')));
  return { node };
};

/**
 * One thing this machine is missing, and the exact command that fixes it.
 *
 * The commands are shown, not run: a page cannot install a package or edit a
 * config file, and the useful thing it can do instead is remove every step of
 * guesswork before the one paste that a person does have to make.
 */
function setupNote(app, p) {
  const note = h('div.note', { 'data-tone': 'warn' }, h('strong', p.title), p.body);
  const text = (p.commands || []).join('\n');
  if (text) note.appendChild(h('pre.cmd', text));
  if (p.hint) note.appendChild(h('div.muted', p.hint));
  note.appendChild(h('div.act',
    text && h('button.ghost', { onclick: e => copyCommands(e.currentTarget, note, text) },
              'Copy the commands'),
    p.doctor && h('a.ghostlink', { href: DOCTOR_URL, target: '_blank', rel: 'noopener' },
                  'Or run the setup script'),
    h('button.ghost', { onclick: () => app.dismissSetup(p.id) }, 'Not now')));
  return note;
}

async function copyCommands(btn, note, text) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch (err) {
    /* The clipboard wants a secure origin and a permission, and "this page is
     * not on a secure origin" is one of the problems this note reports. Select
     * the block instead so the paste can still happen by hand. */
    btn.textContent = 'Select it and copy';
    const r = document.createRange();
    r.selectNodeContents(note.querySelector('pre.cmd'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }
  setTimeout(() => { btn.textContent = 'Copy the commands'; }, 2500);
}

function helpSheet(app) {
  sheet('Timer isn’t showing up', () => h('div.stack',
    h('div.note', { 'data-tone': 'warn' },
      h('strong', 'Power-cycle it first'),
      'This is the answer nine times out of ten. A LapRF advertises for a short window ' +
      'after switch-on and then stops — a disconnect does not restart it, and neither ' +
      'does the bind button.'),
    h('div.note',
      h('strong', 'Still nothing?'),
      h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px' } },
        h('li', 'Check the battery — a flat timer advertises weakly or not at all.'),
        h('li', 'Close any other tab, phone or laptop still holding the link.'),
        h('li', 'Some units advertise a name but no service, so the filtered list stays ' +
                'empty. Use “show all Bluetooth devices”.'))),
    app.caps.advice && h('div.note', { 'data-tone': 'warn' },
      h('strong', 'This browser'), app.caps.advice),
    h('div.note',
      h('strong', 'No timer at all?'),
      'Everything except real laps works in demo mode — worth a look before you buy one.'),
    h('div.row',
      app.caps.bluetooth && h('button.go', { onclick: () => app.connect('bluetooth', { showAll: true }) },
        'Show all Bluetooth devices'),
      h('button.ghost', { onclick: () => app.connect('demo') }, 'Open the demo'))));
}

function logoSvg() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 64 64'); s.setAttribute('width', '60'); s.setAttribute('height', '60');
  s.innerHTML =
    '<circle cx="32" cy="32" r="29" fill="none" stroke="var(--line)" stroke-width="3"/>' +
    '<path d="M34 8 20 36h11l-2 20 16-30H33l1-18Z" fill="var(--state-green)"/>';
  return s;
}

/* ============================================================ chooser ===== */

SCREENS.choose = app => {
  const node = h('div.screen', h('div.scroller', h('div.wrap',
    h('div.stack',
      h('div', { style: { textAlign: 'center' } },
        h('h1', 'What are you doing?'),
        h('p.muted', { style: { marginTop: '6px' } },
          'You can switch at any time from the menu.')),
      h('div.choices',
        h('button.choice', { onclick: () => app.useMode('solo') },
          h('div.glyph', icon('pilot', 34)),
          h('strong', 'Just me'),
          h('span', 'Open practice. Start the clock and bang out laps — every crossing ' +
                    'is timed and read out.')),
        h('button.choice', { onclick: () => app.useMode('race') },
          h('div.glyph', icon('flag', 34)),
          h('strong', 'Run a race'),
          h('span', 'Two to four pilots, a format, a countdown, a timing tower and ' +
                    'saved results.')))))));
  return { node };
};

/* ================================================================ fly ===== */

SCREENS.fly = app => {
  const pilot = app.race.pilots.get(1);
  const node = h('div.screen.fly');
  const body = h('div.body');
  const bar = h('div.actionbar');
  node.append(body, bar);

  /* --- channel row ------------------------------------------------------ */
  const chanSel = h('select', {
    'aria-label': 'Your video channel',
    onchange: e => { app.setPilot(1, { channel: e.target.value }); store.save('channelPicked', true); },
  }, ...laprf.ALL_CHANNELS.map(c =>
    h('option', { value: c.name, selected: c.name === pilot.channel }, c.name)));

  const chanFreq = h('span.freq', laprf.channelByName(pilot.channel).frequency + ' MHz');
  const chanChip = h('div.chanchip',
    h('span.swatch', { style: { background: idVar(1) } }),
    h('span.cap', 'Channel'), chanSel, chanFreq);

  const gatePill = h('button.pill', { onclick: () => app.go('gate') });

  const narrow = () => window.innerWidth < 560;
  const findBtn = h('button', { title: 'Sweep every channel and pick the strongest',
                                onclick: () => SCREENS.findChannel(app, 1) },
    icon('radar', 18), narrow() ? ' Find' : ' Find my channel');
  body.appendChild(h('div.chanbar', chanChip, findBtn, h('div.grow'), gatePill));

  /* --- coach ------------------------------------------------------------ */
  const coach = h('div.coach');
  body.appendChild(coach);

  /* --- hero ------------------------------------------------------------- */
  const heroState = h('span.cap', 'Ready');
  const heroBig = h('div.big.num', { 'data-tone': 'idle' }, '0.0');
  const stats = {
    last: statCell('Last'), best: statCell('Best'),
    consec: statCell(`Best ${app.settings.consecN}`), laps: statCell('Laps'),
    session: statCell('Session'),
  };
  const hero = h('div.hero-lap',
    h('div.flash'),
    h('div.state', heroState),
    heroBig,
    h('div.stats', ...Object.values(stats).map(s => s.node)));
  body.appendChild(hero);

  /* --- lap list --------------------------------------------------------- */
  const list = h('div.laplist', h('div.empty', 'No laps yet. Start the session and fly through the gate.'));
  body.appendChild(list);
  let drawn = 0;

  /* --- actions ---------------------------------------------------------- */
  const primary = h('button.primary.go.wide');
  const undoBtn = h('button.ghost', { onclick: () => app.undoLast() },
    icon('undo', 18), narrow() ? ' Undo' : ' Undo lap');
  const manualBtn = h('button.ghost', { title: 'Log a lap the timer missed',
    onclick: () => app.manualLap(1) }, 'Lap now');
  bar.append(primary, h('div.subactions', undoBtn, manualBtn));

  primary.addEventListener('click', () => {
    const s = app.race.state;
    if (s === 'running' || s === 'staging') app.requestStop();
    else if (s === 'finished') { app.resetRace(); app.start(); }
    else app.start();
  });

  /* --- live update ------------------------------------------------------ */
  let lastHitAt = 0;
  const update = () => {
    const r = app.race, p = r.pilots.get(1);
    applyCoach(coach, app.coach());

    const hp = app.health(1);
    gatePill.dataset.tone = hp.level === 'good' ? 'ok' : hp.level === 'fatal' || hp.level === 'bad'
      ? 'bad' : hp.level === 'warn' ? 'warn' : '';
    /* On a phone the gate chip costs a whole row, so it only appears when it
     * has something to warn about. A tuned gate needs no badge. */
    gatePill.hidden = narrow() && hp.level === 'good';
    if (gatePill._t !== hp.title) {
      gatePill._t = hp.title;
      mount(gatePill, h('span.dot'), narrow() ? hp.title : 'Gate: ' + hp.title);
    }

    if (chanSel.value !== p.channel) chanSel.value = p.channel;
    chanFreq.textContent = laprf.channelByName(p.channel).frequency + ' MHz';

    /* The hero holds a landed lap for a beat — that pause is the moment the
     * pilot actually reads the number — then returns to the running clock. */
    const fresh = app.lastLap && (performance.now() - app.lastLap.at) < 2600;
    if (r.state === 'running' && fresh) {
      heroState.textContent = `Lap ${app.lastLap.n}`;
      setHero(heroBig, fmt2(app.lastLap.time));
      heroBig.dataset.tone = app.lastLap.time === app.sessionBest ? 'purple'
                           : app.lastLap.isPb ? 'green' : '';
    } else if (r.state === 'running') {
      const since = p.lastPass != null ? (performance.now() / 1000) - p.lastPass : r.elapsed;
      heroState.textContent = `Lap ${p.lapCount + 1} · running`;
      setHero(heroBig, clockStr(since));
      heroBig.dataset.tone = '';
    } else if (r.state === 'staging') {
      heroState.textContent = 'Get ready';
      setHero(heroBig, String(Math.ceil(r.countdownLeft ?? 0)));
      heroBig.dataset.tone = '';
    } else if (r.state === 'finished') {
      heroState.textContent = p.best != null ? 'Best lap' : 'Session over';
      setHero(heroBig, p.best != null ? fmt2(p.best) : '0.0');
      heroBig.dataset.tone = p.best != null ? 'purple' : 'idle';
    } else {
      heroState.textContent = 'Ready';
      setHero(heroBig, '0.0');
      heroBig.dataset.tone = 'idle';
    }


    if (app.lastLap && app.lastLap.at !== lastHitAt) {
      lastHitAt = app.lastLap.at;
      hero.classList.remove('hit'); void hero.offsetWidth; hero.classList.add('hit');
    }

    stats.last.set(p.last == null ? '—' : fmt2(p.last));
    stats.best.set(p.best == null ? '—' : fmt2(p.best), p.best != null ? 'purple' : null);
    stats.consec.set(fmtOrDash(p.bestConsecutive(app.settings.consecN)));
    stats.laps.set(String(p.lapCount));
    stats.session.set(clockStr(r.elapsed));

    if (p.lapCount !== drawn) {
      renderLaps(list, p, app.sessionBest);
      drawn = p.lapCount;
    }

    const s = r.state;
    const running = s === 'running' || s === 'staging';
    const blind = !running && hp.fatal;
    setPrimary(primary, running ? 'stop' : 'play',
      running ? 'Stop'
      : blind ? 'Start anyway — laps may not record'
      : s === 'finished' ? 'Go again' : 'Start flying',
      'primary wide ' + (running ? 'danger' : blind ? 'warn' : 'go'));
    undoBtn.disabled = p.lapCount === 0;
    manualBtn.disabled = s !== 'running';
    /* Changing channel mid-session would not reach the timer until the session
     * ends, so the chip would say R6 while the receiver sat on R1. */
    chanSel.disabled = running;
    findBtn.disabled = running || !app.canControl;
  };
  update();
  return { node, update };
};

/** Render "10.77" as 10 + a smaller .77, without a second source of truth for
 *  the value: the text is set normally and re-split here each frame. */
function setHero(node, text) {
  if (node._raw === text) return;
  node._raw = text;
  const dot = text.indexOf('.');
  if (dot < 0) { node.textContent = text; }
  else {
    node.textContent = text.slice(0, dot);
    node.appendChild(h('span.dec', text.slice(dot)));
  }
  if (text.length > 5) node.dataset.wide = ''; else delete node.dataset.wide;
}

/** Primary-button label and glyph, written only when they change: this runs
 *  every frame and an SVG per frame is battery for nothing. */
function setPrimary(btn, glyph, label, cls) {
  const key = glyph + '|' + label + '|' + cls;
  if (btn._key === key) return;
  btn._key = key;
  mount(btn, icon(glyph, 22), label);
  btn.className = cls;
}

function statCell(label) {
  const v = h('div.v.num', '—');
  return {
    node: h('div.stat', v, h('div.cap', label)),
    set: (text, tone) => {
      if (v.textContent !== text) v.textContent = text;
      if (tone) { if (v.dataset.tone !== tone) v.dataset.tone = tone; }
      else if ('tone' in v.dataset) delete v.dataset.tone;
    },
  };
}

const fmtOrDash = v => v == null ? '—' : fmt2(v);

function renderLaps(list, pilot, sessionBest) {
  if (!pilot.laps.length) {
    mount(list, h('div.empty', 'No laps yet. Start the session and fly through the gate.'));
    return;
  }
  const times = pilot.laps.map(l => l.time);
  const worst = Math.max(...times), best = Math.min(...times);
  /* Bars are scaled across the session's own range, not from zero: whoop laps
   * sit within a couple of seconds of each other, so bars drawn from zero are
   * all the same length and say nothing. Longer means faster. */
  const spread = Math.max(0.001, worst - best);
  const rows = [...pilot.laps].reverse().map((l, i) => {
    const isBest = l.time === best;
    const frac = worst === best ? 1 : 0.18 + 0.82 * ((worst - l.time) / spread);
    return h('div.lap', { 'data-best': isBest || null, class: i === 0 ? 'fresh' : '' },
      h('span.n', '#' + l.n),
      h('span.t.num', { 'data-tone': l.time === sessionBest ? 'purple' : isBest ? 'green' : '' },
        fmt2(l.time)),
      h('span.tag', isBest ? 'best' : ''),
      h('span.bar', h('i', { style: { width: (frac * 100).toFixed(1) + '%' } })));
  });
  mount(list, ...rows);
}

function applyCoach(node, c) {
  if (node._text === c.text && node._label === c.action?.label) return;
  node._text = c.text; node._label = c.action?.label;
  node.dataset.tone = c.tone || '';
  mount(node,
    h('span.k', c.tone === 'bad' ? '!' : c.tone === 'warn' ? '!' : '→'),
    h('span.text', c.text),
    c.action && h('button', { onclick: c.action.fn }, c.action.label));
}

/* =============================================================== race ===== */

SCREENS.race = app => {
  const r = app.race;
  return (r.state === 'idle') ? raceSetup(app) : raceLive(app);
};

function raceSetup(app) {
  const node = h('div.screen');
  const wrap = h('div.wrap.stack');
  const bar = h('div.actionbar');
  node.append(h('div.scroller', wrap), bar);
  const coach = h('div.coach');

  /* 1 — pilots */
  const pilotList = h('div.stack.tight');
  const drawPilots = () => {
    mount(pilotList, ...SLOTS.map(slot => {
      const p = app.race.pilots.get(slot);
      return h('div.pilotcard', { 'data-off': p.enabled ? null : '',
                                  style: { borderLeftColor: idVar(slot) } },
        h('button.toggle', { 'aria-pressed': String(p.enabled), 'aria-label': `Slot ${slot} racing`,
                             onclick: () => { app.setPilot(slot, { enabled: !p.enabled }); drawPilots(); } },
          h('span.pip')),
        h('div.fields',
          h('input', { value: p.name, 'aria-label': `Pilot ${slot} name`, maxlength: '18',
                       placeholder: `Pilot ${slot}`,
                       onchange: e => app.setPilot(slot, { name: e.target.value.trim() || `Pilot ${slot}` }) }),
          h('div.row', { style: { gap: '6px', flexWrap: 'nowrap' } },
            h('select', { 'aria-label': `Pilot ${slot} channel`, style: { width: 'auto', minWidth: '116px' },
                          onchange: e => app.setPilot(slot, { channel: e.target.value }) },
              ...laprf.ALL_CHANNELS.map(c => h('option', { value: c.name, selected: c.name === p.channel },
                `${c.name} · ${c.freq}`))),
            h('button.quiet', { title: `Find pilot ${slot}'s channel by sweeping the receiver`,
                                'aria-label': `Find pilot ${slot}'s channel`,
                                onclick: () => SCREENS.findChannel(app, slot) }, icon('radar', 18)))),
        badges[slot] = gateBadge(app, slot));
    }));
  };
  const badges = {};
  drawPilots();

  /* 2 — format */
  const modes = [['laps', 'First to N'], ['time', 'Timed'], ['consecutive', 'Best consecutive'],
                 ['practice', 'Open practice']];
  const seg = h('div.seg', ...modes.map(([m, label]) =>
    h('button', { 'aria-pressed': String(app.settings.mode === m),
                  onclick: () => { app.saveSettings({ mode: m }); app.render(); } }, label)));
  const detail = h('div.grid2');
  const drawDetail = () => {
    const s = app.settings;
    const rows = [];
    if (s.mode === 'laps') rows.push(numField('Laps to win', s.targetLaps, 1, 60, 1,
      v => app.saveSettings({ targetLaps: v })));
    if (s.mode === 'time') rows.push(numField('Race length (seconds)', s.targetSeconds, 10, 3600, 10,
      v => app.saveSettings({ targetSeconds: v })));
    if (s.mode === 'consecutive') rows.push(numField('Consecutive laps', s.consecN, 2, 10, 1,
      v => app.saveSettings({ consecN: v })));
    rows.push(numField('Minimum lap (seconds)', s.minLap, 0, 60, 0.5,
      v => app.saveSettings({ minLap: v }),
      'Ignores a second crossing inside this window. A whoop hovering in the gate ' +
      'otherwise racks up a dozen laps.'));
    rows.push(numField('Countdown (seconds)', s.countdown, 0, 30, 1,
      v => app.saveSettings({ countdown: v }), '0 starts the instant you press Arm.'));
    mount(detail, ...rows);
  };
  drawDetail();

  const formatLine = h('p.muted');

  /* 3 — gate check */
  const gateSummary = h('div.stack.tight');
  const drawGate = () => {
    const racing = app.race.racing.map(p => ({ p, hp: app.health(p.slot) }));
    const by = level => racing.filter(x => x.hp.level === level);
    const fatal = racing.filter(x => x.hp.fatal);
    const shaky = racing.filter(x => !x.hp.fatal && (x.hp.level === 'bad' || x.hp.level === 'warn'));
    const learning = by('learning');
    const unknown = by('unknown');
    const kids = [];
    const names = xs => xs.map(x => `${x.p.name} (${x.hp.title.toLowerCase()})`).join(', ');
    if (fatal.length) {
      kids.push(h('div.note', { 'data-tone': 'bad' },
        h('strong', `${fatal.map(x => x.p.name).join(', ')} cannot detect a lap`),
        'The trigger level for those receivers sits at or below their own noise, so the ' +
        'timer believes a quad is permanently in the gate. Fly one lap and the app will ' +
        'correct it; until then this race records nothing.',
        h('div.act', h('button.ghost', { onclick: () => app.go('gate') }, 'Watch it happen'))));
    }
    if (shaky.length) {
      kids.push(h('div.note', { 'data-tone': 'warn' },
        h('strong', `${plural(shaky.length, 'receiver')} may miss or invent laps`),
        names(shaky) + '. The gate screen says what to change.',
        h('div.act', h('button.ghost', { onclick: () => app.go('gate') }, 'Open the gate screen'))));
    }
    if (learning.length) {
      /* Not a warning and not a task: the first laps do this by themselves. It
       * is here only so the state is not a mystery. */
      kids.push(h('div.note',
        h('strong', `${plural(learning.length, 'receiver')} still calibrating`),
        'Fly as normal — the first few laps set the trigger, and the app says when ' +
        'it has settled.'));
    }
    if (unknown.length) {
      kids.push(h('div.note', { 'data-tone': 'warn' },
        h('strong', 'The timer has not reported its thresholds yet'),
        'Give it a moment, or reconnect.'));
    }
    if (!kids.length) {
      kids.push(h('div.note', { 'data-tone': 'ok' },
        h('strong', 'Gate calibrated'), 'Every racing receiver is seeing clean passes.'));
    }
    mount(gateSummary, ...kids);
  };
  drawGate();

  mount(wrap,
    coach,
    h('div.card.stack',
      h('div', h('h3', '1 · Who’s racing?'),
        h('p.muted', 'Switch a slot on, give it a name, and set the channel that pilot’s ' +
                     'video transmitter is on.')),
      pilotList),
    h('div.card.stack',
      h('div', h('h3', '2 · Format'), formatLine),
      seg, detail),
    h('div.card.stack',
      h('div', h('h3', '3 · Gate check'),
        h('p.muted', 'Whether the timer can actually see a pass.')),
      gateSummary));

  const primary = h('button.primary.go.wide', { onclick: () => app.start() });
  bar.append(primary, h('div.subactions',
    h('button.ghost', { onclick: () => app.go('gate') }, 'Gate & signal'),
    h('button.ghost', { onclick: () => app.go('history') }, 'History')));

  const update = () => {
    applyCoach(coach, app.coach());
    formatLine.textContent = app.race.formatLine();
    const n = app.race.racing.length;
    /* A receiver that cannot detect a lap makes this race record nothing. The
     * button still works — it is their call — but it stops looking like the
     * obvious next thing to press, and says what it is agreeing to. */
    const blind = app.race.racing.some(p => app.health(p.slot).fatal);
    setPrimary(primary, 'play',
      n === 0 ? 'Switch on at least one pilot' :
      blind ? 'Start anyway — laps may not record' :
      app.settings.countdown > 0 ? `Arm the race · ${plural(n, 'pilot')}`
                                 : `Start now · ${plural(n, 'pilot')}`,
      'primary wide ' + (blind ? 'warn' : 'go'));
    primary.disabled = n === 0;
  };
  update();
  /* Structural pieces only redraw when the shape of the screen changes: who is
   * racing and which format. Names and channels are the inputs themselves, and
   * a receiver's verdict is painted in place — rebuilding the form for either
   * throws away whatever is being typed. */
  let sig = '', gateSig = '';
  const structural = () => {
    const now = SLOTS.map(s => app.race.pilots.get(s).enabled ? '1' : '0').join('') + app.settings.mode;
    if (now !== sig) { sig = now; drawPilots(); drawDetail(); }
    const g = SLOTS.map(s => app.health(s).level).join(',');
    if (g !== gateSig) {
      gateSig = g;
      drawGate();
      for (const s of SLOTS) if (badges[s]) refreshBadge(badges[s], app.health(s));
    }
  };
  structural();
  return { node, update: () => { update(); structural(); } };
}

function gateBadge(app, slot) {
  const b = h('button.pill', { onclick: () => app.go('gate') }, h('span.dot'), '');
  refreshBadge(b, app.health(slot));
  return b;
}

function refreshBadge(b, hp) {
  const tone = hp.level === 'good' ? 'ok' : hp.fatal || hp.level === 'bad' ? 'bad'
             : hp.level === 'off' ? '' : 'warn';
  if (b._t === hp.title + tone) return;
  b._t = hp.title + tone;
  b.dataset.tone = tone;
  b.title = hp.detail;
  mount(b, h('span.dot'), hp.title);
}

function numField(label, value, min, max, step, onChange, hint) {
  return h('div.field',
    h('label', label),
    h('input', { type: 'number', value, min, max, step, inputmode: 'decimal',
                 onchange: e => {
                   const v = Math.min(max, Math.max(min, Number(e.target.value)));
                   e.target.value = v; onChange(v);
                 } }),
    hint && h('div.hint', hint));
}

function raceLive(app) {
  const node = h('div.screen');
  const flag = h('div.flagchip', { role: 'status' }, 'Idle');
  const fmt = h('div.fmt');
  const clock = h('div.clock.num', '0.0');
  const band = h('div.band', flag, fmt, clock);
  const coachWrap = h('div', { style: { padding: '12px 16px 0', maxWidth: '1100px',
                                        margin: '0 auto', width: '100%' } });
  const coach = h('div.coach');
  coachWrap.appendChild(coach);
  const tower = h('div.tower');
  const bar = h('div.actionbar');
  node.append(band, h('div.scroller', coachWrap, tower), bar);

  const rows = new Map();
  for (const p of app.race.racing) {
    const cells = { last: towerCell('Last'), best: towerCell('Best'), laps: towerCell('Laps') };
    const pos = h('div.pos.num', '—');
    const nm = h('div.nm', p.name);
    const ch = h('span.ch', p.channel);
    const addLap = h('button.quiet.addlap', { 'aria-label': `Add a lap by hand for ${p.name}`,
                                               title: 'Add a lap the receiver missed',
                                               onclick: () => app.manualLap(p.slot) }, '+ lap');
    const row = h('div.trow', { style: { borderLeftColor: idVar(p.slot) } },
      pos,
      h('div.who', nm, h('div.meta', ch, h('span', 'slot ' + p.slot))),
      h('div.times', ...Object.values(cells).map(c => c.node), addLap));
    rows.set(p.slot, { row, pos, cells });
    tower.appendChild(row);
  }

  const primary = h('button.primary.danger.wide', { onclick: () => app.stop() });
  bar.append(primary, h('div.subactions',
    h('button.ghost', { onclick: () => app.undoLast() }, icon('undo', 18), ' Undo'),
    h('button.ghost', { onclick: () => confirmSheet('Reset the race?',
        'Every lap in this race is discarded and the tower goes back to zero.',
        'Reset', () => app.resetRace()) }, 'Reset')));

  let lastHit = new Map();
  const update = () => {
    const r = app.race;
    applyCoach(coach, app.coach());
    flag.textContent = { idle: 'Idle', staging: 'Staging', running: 'Racing',
                         finished: 'Finished' }[r.state];
    flag.dataset.state = r.state;
    fmt.textContent = r.formatLine();
    const shown = r.mode === 'time' && r.state === 'running' ? r.remaining : r.elapsed;
    clock.textContent = clockStr(shown);
    clock.dataset.tone = (r.mode === 'time' && r.remaining != null && r.remaining < 10) ? 'low' : '';

    const order = r.standings();
    order.forEach((p, i) => {
      const ref = rows.get(p.slot);
      if (!ref) return;
      ref.row.style.order = String(i);
      ref.row.dataset.pos = String(i + 1);
      ref.pos.textContent = String(i + 1);
      ref.cells.last.set(p.last == null ? '—' : fmt2(p.last),
        p.last != null && p.last === app.sessionBest ? 'purple' : p.last == null ? 'none' : '');
      ref.cells.best.set(p.best == null ? '—' : fmt2(p.best),
        p.best != null && p.best === app.sessionBest ? 'purple' : p.best == null ? 'none' : '');
      ref.cells.laps.set(String(p.lapCount) + (r.mode === 'laps' ? `/${r.targetLaps}` : ''));
      const l = p.laps[p.laps.length - 1];
      if (l && lastHit.get(p.slot) !== l.at) {
        lastHit.set(p.slot, l.at);
        ref.row.classList.remove('hit'); void ref.row.offsetWidth; ref.row.classList.add('hit');
      }
    });
    tower.style.display = 'grid';

    for (const [slot, ref] of rows) ref.row.querySelector('.addlap').disabled = r.state !== 'running';
    if (r.state === 'finished') {
      setPrimary(primary, 'play', 'Set up the next race', 'primary go wide');
      primary.onclick = () => app.resetRace();
    } else {
      setPrimary(primary, 'stop', r.state === 'staging' ? 'Cancel start' : 'Stop the race',
                 'primary danger wide');
      primary.onclick = () => app.requestStop();
    }
  };
  update();
  return { node, update };
}

function towerCell(label) {
  const v = h('div.v.num', '—');
  return {
    node: h('div.cell', v, h('div.cap', label)),
    set: (t, tone) => {
      if (v.textContent !== t) v.textContent = t;
      if (tone) { if (v.dataset.tone !== tone) v.dataset.tone = tone; }
      else if ('tone' in v.dataset) delete v.dataset.tone;
    },
  };
}

/* ============================================================== gate ====== */

SCREENS.gate = app => {
  const node = h('div.screen');
  const wrap = h('div.wrap.stack');
  node.appendChild(h('div.scroller', wrap));

  const wizardBox = h('div.card.stack');
  const statusBox = h('div.card.stack');
  const slotBox = h('div.stack');
  const advanced = h('details.card', { open: app.gateAdvancedOpen || null,
    ontoggle: e => { app.gateAdvancedOpen = e.target.open; } });

  const drawWizard = () => {
    const phase = app.cal.phase;
    /* Option text only: the hint lives under the control, because a select is
     * as wide as its longest option and these are sentences. */
    const presetHint = h('p.hint', tuning.PRESETS[app.settings.preset]?.hint || '');
    const presetSel = h('select', { style: { width: 'auto' }, 'aria-label': 'Track type',
      onchange: e => {
        app.saveSettings({ preset: e.target.value });
        app.cal.preset = e.target.value;
        presetHint.textContent = tuning.PRESETS[e.target.value].hint;
      } },
      ...Object.entries(tuning.PRESETS).map(([k, v]) =>
        h('option', { value: k, selected: k === app.settings.preset }, v.label)));

    const steps = h('div.stack.tight',
      h('div.step', { 'data-live': phase === 'idle' ? '' : null,
                      'data-done': phase !== 'idle' ? '' : null },
        h('div.n', '1'), h('div', h('strong', 'Measure quiet'),
          h('p.why', 'Land everything and keep quads out of the gate. This finds each ' +
                     'receiver’s own noise floor.'))),
      h('div.step', { 'data-live': phase === 'noise' ? '' : null,
                      'data-done': (phase === 'pass' || phase === 'done') ? '' : null },
        h('div.n', '2'), h('div', h('strong', 'Fly one pass'),
          h('p.why', 'One clean crossing at racing speed and height. That is the peak the ' +
                     'trigger has to sit under.'))),
      h('div.step', { 'data-live': phase === 'pass' ? '' : null,
                      'data-done': phase === 'done' ? '' : null },
        h('div.n', '3'), h('div', h('strong', 'Apply'),
          h('p.why', 'Each receiver gets a trigger level between its own two bounds, and ' +
                     'it is written to the timer.'))));

    const action =
      phase === 'idle' ? h('button.go.wide', { onclick: () => {
          app.cal.beginNoise(SLOTS); app.render(); } }, 'Start — keep the gate clear')
      : phase === 'noise' ? h('button.go.wide', { disabled: true, onclick: () => {
          app.cal.beginPass(SLOTS); app.render(); } }, 'Quiet measured — now fly a pass')
      : phase === 'pass' ? h('button.go.wide', { disabled: true, onclick: () => {
          app.cal.finish(); app.render(); } }, 'Pass flown — show me the numbers')
      : h('div.row',
          h('button.go', { style: { flex: '1' }, onclick: () => applyCalibration(app) },
            'Write to the timer'),
          h('button.ghost', { onclick: () => { app.cal.cancel(); app.render(); } }, 'Start over'));

    const evidence = h('p.muted');
    wizAction = action;
    mount(wizardBox,
      h('div.row', { style: { justifyContent: 'space-between' } },
        h('h3', 'Calibrate by hand'),
        h('div', { style: { display: 'grid', gap: '4px', justifyItems: 'end' } },
          h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('span.cap', 'Track'), presetSel),
          presetHint)),
      h('p.muted', 'Not normally needed — flying calibrates the gate on its own. This measures ' +
                   'the same thing deliberately: the quiet level, then one flown pass, then a ' +
                   'trigger set between them.'),
      steps, action, evidence);
    return evidence;
  };
  let wizAction = null;
  let evidence = drawWizard();

  /* A receiver that is not racing is not a problem to solve, so it collapses to
   * one line. Solo practice would otherwise open this screen on three sets of
   * instruments for slots nobody is flying. */
  let showAll = app.gateShowAll || app.race.racing.length === SLOTS.length;
  const slotCards = new Map();
  const drawSlots = () => {
    clear(slotBox);
    slotCards.clear();
    for (const slot of SLOTS) {
      const p = app.race.pilots.get(slot);
      if (!p.enabled && !showAll) {
        slotBox.appendChild(h('div.off',
          h('span.chanchip', h('span.swatch', { style: { background: idVar(slot) } }),
            h('span.name', p.channel), h('span.freq', `slot ${slot}`)),
          h('span', 'not racing')));
        continue;
      }
      const canvas = h('canvas', { width: 600, height: 120 });
      const verdict = h('div.verdict');
      const readout = h('div.readout');
      const thrOf = () => app.rfFor(slot).threshold ?? app.timer.rfSetup[slot]?.threshold ?? null;
      const thrInput = h('input', { type: 'number', step: '10', min: '1', max: '4000',
        value: thrOf() == null ? '' : Math.round(thrOf()),
        placeholder: 'not reported',
        onchange: e => {
          const v = Number(e.target.value);
          if (!e.target.value.trim() || !isFinite(v) || v <= 0) {
            /* A cleared box is not a request to write zero. */
            e.target.value = thrOf() == null ? '' : Math.round(thrOf());
            return;
          }
          app.saveRf(slot, { threshold: v });
          app.pushConfig([slot], { now: true });
          if (app.race.active) toast('Saved — it reaches the timer when the session ends');
          app.markStructural();
        } });
      const passLine = h('div.passline');
      const card = h('div.gateslot',
        h('header',
          h('span.chanchip', h('span.swatch', { style: { background: idVar(slot) } }),
            h('span.name', p.channel),
            h('span.freq', `slot ${slot}`)),
          h('label.trig', h('span.cap', 'Trigger'), thrInput),
          /* Unset means on — the same rule autoTune applies. Reading it as off
           * because undefined is falsy would show every receiver switched off
           * while it was quietly tuning itself, which is worse than either
           * state being wrong. */
          h('button.autotune', { 'aria-pressed': String(app.rfFor(slot).auto !== false),
            title: 'Let this receiver correct its own trigger as you fly',
            onclick: e => {
              const on = app.rfFor(slot).auto === false;
              app.saveRf(slot, { auto: on });
              e.currentTarget.setAttribute('aria-pressed', String(on));
              toast(on ? `Slot ${slot} will correct itself as you fly`
                       : `Slot ${slot} will keep the trigger you set`, 'ok');
            } }, 'Auto')),
        verdict, canvas, readout, passLine);
      slotBox.appendChild(card);
      slotCards.set(slot, { canvas, verdict, readout, thrInput, passLine });
    }
    if (!showAll) {
      slotBox.appendChild(h('button.ghost', {
        onclick: () => { showAll = app.gateShowAll = true; drawSlots(); } }, 'Show all four receivers'));
    }
  };
  drawSlots();

  mount(advanced,
    h('summary', { style: { cursor: 'pointer', fontWeight: '700' } }, 'Advanced'),
    h('div.stack', { style: { marginTop: '16px' } },
      numField('Timer’s own minimum lap (ms)', app.settings.timerMinLapMs, 0, 60000, 500,
        v => { app.saveSettings({ timerMinLapMs: v }); app.pushConfig(SLOTS, { now: true }); },
        'Written to the timer. WhoopTimer also enforces its own minimum lap in software.'),
      h('div.field',
        h('label', 'Receiver gain'),
        h('div.row', { style: { flexWrap: 'wrap' } },
          ...SLOTS.map(slot => h('label', { style: { display: 'flex', gap: '6px',
            alignItems: 'center' } }, h('span.cap', 'S' + slot),
          h('input', { type: 'number', min: '0', max: '63', style: { width: '80px' },
            value: app.rfFor(slot).gain ?? 58,
            onchange: e => { app.saveRf(slot, { gain: Number(e.target.value) });
                             app.pushConfig([slot], { now: true }); } }))))),
      h('div.row',
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('span.cap', 'Slot'),
          h('select', { id: 'scanSlot', style: { width: 'auto' } },
            ...SLOTS.map(s => h('option', { value: s }, String(s))))),
        h('button.ghost', { onclick: () => SCREENS.findChannel(app, Number(document.getElementById('scanSlot').value)) },
          icon('radar', 18), ' Scan 40 channels')),
      /* The step-by-step calibration lives here now rather than at the top of
       * the screen. It still works and is still occasionally the right tool —
       * a track where nobody wants to fly a lap to find out — but leading with
       * it told everyone they had a job to do before they could fly, which was
       * never true and is no longer true at all. */
      h('hr', { style: { border: '0', borderTop: '1px solid var(--line)', margin: '4px 0' } }),
      wizardBox));

  /**
   * The state of the gate in one sentence, and never an instruction.
   *
   * This replaced a three-step wizard at the top of the screen. The wizard told
   * everyone who opened it that they had a job to do before they could fly,
   * which stopped being true when the trigger learned to correct itself.
   */
  const drawStatus = () => {
    const racing = app.race.racing;
    const states = racing.map(p => {
      const th = app.thresholdFor(p.slot);
      return { p, th, rep: tuning.passReport(app.sig.get(p.slot).passes, th) };
    });
    const done = states.filter(x => x.rep.verdict === 'good' && x.rep.seen >= 3);
    const seenAny = states.some(x => x.rep.seen > 0);
    if (!racing.length) {
      mount(statusBox, h('p.muted', 'No receiver is racing, so there is nothing to calibrate.'));
      return;
    }
    if (done.length === racing.length) {
      mount(statusBox,
        h('h3', 'Gate calibrated'),
        h('p.muted', 'Every racing receiver is seeing clean passes. Nothing here needs touching.'));
      return;
    }
    mount(statusBox,
      h('h3', 'Calibrating as you fly'),
      h('p.muted', seenAny
        ? `${done.length} of ${racing.length} receivers settled. Keep flying — each pass sharpens ` +
          'the trigger, and the app says out loud when the gate is calibrated.'
        : 'Fly through the gate. The first few laps set each receiver’s trigger by themselves, ' +
          'and the app says out loud when it is done.'));
  };
  drawStatus();

  const gateCoach = h('div.coach');
  mount(wrap,
    h('div.row', { style: { justifyContent: 'space-between' } },
      h('h2', 'Gate & signal'),
      h('button.ghost', { onclick: () => app.go(app.mode === 'solo' ? 'fly' : 'race') },
        'Back to the session')),
    gateCoach, statusBox, slotBox, advanced);

  let phaseSeen = app.cal.phase;
  let lastDraw = 0;
  const update = () => {
    /* The timer reports signal a few times a second at best, so redrawing four
     * instruments every animation frame buys nothing and costs battery. */
    const paint = performance.now() - lastDraw > 90;
    if (paint) lastDraw = performance.now();
    if (app.cal.phase !== phaseSeen) { phaseSeen = app.cal.phase; evidence = drawWizard(); }
    if (paint) drawStatus();
    { const c = app.coach(); gateCoach.hidden = c.tone === 'ok'; if (!gateCoach.hidden) applyCoach(gateCoach, c); }
    /* Samples from the receivers actually racing are what the wizard needs;
     * an idle slot contributing nothing must not hold the count at zero. */
    const racingSlots = app.race.racing.map(p => p.slot);
    const counts = racingSlots.map(s => (app.cal.counts || {})[s] || 0);
    const samples = counts.length ? Math.min(...counts) : 0;
    const measuring = app.cal.phase === 'noise' || app.cal.phase === 'pass';
    const enough = samples >= 4;
    if (wizAction && measuring) wizAction.disabled = !enough || !app.connected;
    evidence.textContent =
      measuring && !app.connected ? 'Timer link lost — reconnect, then start the measurement again.'
      : app.cal.phase === 'noise' ? (enough ? `Quiet measured (${samples} samples per receiver). Ready for a pass.`
                                            : `Listening… ${samples} of 4 samples per receiver.`)
      : app.cal.phase === 'pass' ? (enough ? `Watching for a peak… ${samples} samples so far. Fly the gate now.`
                                           : `Waiting for readings… ${samples} of 4.`)
      : app.cal.phase === 'done' ? describeCal(app)
      : '';
    for (const slot of SLOTS) {
      const ref = slotCards.get(slot);
      if (!ref) continue;
      const hp = app.health(slot);
      /* A slot that is merely still learning says so at the top of the screen
       * already, and the live line under its meter says it again with real
       * numbers. Repeating it a third time per receiver was the bulk of what
       * made this screen look like a job. Problems still speak up. */
      const quietVerdict = hp.level === 'learning' || hp.level === 'good';
      ref.verdict.hidden = quietVerdict;
      if (!quietVerdict && ref.verdict._t !== hp.title + hp.detail) {
        ref.verdict._t = hp.title + hp.detail;
        ref.verdict.dataset.level = hp.level;
        mount(ref.verdict, h('strong', hp.title), h('span', hp.detail));
      }
      const cfg = app.rfFor(slot);
      const sig = app.sig.slots.get(slot);
      const shownThr = cfg.threshold ?? app.timer.rfSetup[slot]?.threshold ?? null;
      if (document.activeElement !== ref.thrInput) {
        const want = shownThr == null ? '' : String(Math.round(shownThr));
        if (ref.thrInput.value !== want) ref.thrInput.value = want;
      }
      const live = sig?.value ?? 0;
      /* Both of these used to read "not measured" until someone ran the wizard,
       * which is a way of saying "you have not done your homework" on a screen
       * that no longer sets any. Quiet is observed continuously, and the peak of
       * the last real pass is known the moment one is flown. */
      const quiet = cfg.floor ?? sig?.quiet() ?? null;
      const lastPass = sig?.passes?.length ? sig.passes[sig.passes.length - 1].peak
                                           : (cfg.ceiling ?? null);
      const key = `${Math.round(live)}|${Math.round(quiet ?? -1)}|${Math.round(lastPass ?? -1)}`;
      if (ref.readout._t !== key) {
        ref.readout._t = key;
        mount(ref.readout,
          kv('Live', app.sig.live(slot) ? Math.round(live) : '—'),
          kv('Quiet', quiet == null ? '—' : Math.round(quiet)),
          kv('Last pass', lastPass == null ? 'none yet' : Math.round(lastPass)));
      }
      renderPassLine(app, slot, ref, sig, shownThr);
      if (paint) {
        drawMeter(ref.canvas, { live, floor: cfg.floor, ceiling: cfg.ceiling,
                                threshold: shownThr, series: sig?.series() || [],
                                passes: sig?.passes || [] });
      }
    }
  };
  update();
  return { node, update };
};

/**
 * What this slot has actually seen, and the one action worth offering.
 *
 * Tuning a gate used to mean flying, seeing no lap, and having no way to tell
 * whether the trigger was too high or the quad simply had not crossed. This
 * line closes that: it counts the passes, says how many would have been timed,
 * and when one missed it offers the number that would have caught it — one tap,
 * no arithmetic, no slider hunting.
 */
function renderPassLine(app, slot, ref, sig, threshold) {
  const rep = tuning.passReport(sig?.passes || [], threshold);
  const key = `${rep.seen}|${rep.counted}|${rep.worstMiss}|${Math.round(threshold ?? -1)}`;
  if (ref.passLine._t === key) return;
  ref.passLine._t = key;

  if (!rep.seen) {
    mount(ref.passLine, h('span.muted', 'No pass seen yet — fly through the gate.'));
    return;
  }
  const tone = rep.verdict === 'good' ? 'ok'
             : rep.verdict === 'fragile' ? 'warn'
             : rep.missed === rep.seen ? 'bad' : 'warn';
  const words = rep.verdict === 'good'
    ? `${plural(rep.seen, 'pass', 'passes')} seen, all would count.`
    : rep.verdict === 'fragile'
    /* Counted, but only just. Saying "all would count" here would be true today
     * and a lie on the next flight, which is the worst kind of reassurance. */
    ? `${plural(rep.seen, 'pass', 'passes')} seen, all counted — but the closest cleared ` +
      `by only ${Math.round(rep.thinnest)}. A weaker pass would be missed.`
    : `${plural(rep.seen, 'pass', 'passes')} seen — ${rep.counted} would count, ` +
      `${rep.missed} missed by up to ${Math.round(rep.worstMiss)}.`;
  const kids = [h('span.dot', { 'data-tone': tone }), h('span', words)];
  /* Only offer the fix when there is one: a suggestion that cannot separate a
   * pass from the noise is not an improvement, it is a different mistake. */
  if (rep.verdict !== 'good' && rep.suggest != null && rep.worthIt) {
    kids.push(h('button.ghost', {
      onclick: () => {
        app.saveRf(slot, { threshold: rep.suggest });
        app.pushConfig([slot], { now: true });
        sig.clearPasses();          // the old verdicts judged a trigger that is gone
        toast(`Slot ${slot} trigger set to ${Math.round(rep.suggest)} — fly it again to confirm`, 'ok');
        app.markStructural();
      } }, `Use ${Math.round(rep.suggest)}`));
  }
  mount(ref.passLine, ...kids);
}

const kv = (label, value) => h('div', h('div.cap', label),
  h('div.num', { style: { fontSize: 'var(--t-17)', fontWeight: '700' } }, String(value)));

function describeCal(app) {
  const res = app.cal.results();
  const racing = app.race.racing.map(p => p.slot);
  const usable = app.cal.usable();
  const noQuiet = racing.filter(s => res[s]?.floor == null);
  const noPass = racing.filter(s => res[s]?.floor != null && (res[s]?.ceiling == null || res[s].ceiling <= res[s].floor));
  const weak = racing.filter(s => res[s]?.floor != null && res[s]?.ceiling != null &&
                                  res[s].ceiling > res[s].floor && res[s].suggested == null);
  const bits = [];
  if (usable.length) bits.push(`${plural(usable.length, 'receiver')} measured cleanly: ` +
    usable.map(u => `slot ${u.slot} → ${Math.round(u.suggested)}`).join(', ') + '.');
  if (noQuiet.length) bits.push(`No quiet reading arrived for slot ${noQuiet.join(', ')} — was the timer connected?`);
  if (noPass.length) bits.push(`No pass was seen on slot ${noPass.join(', ')} — that quad did not cross the gate.`);
  if (weak.length) bits.push(`Slot ${weak.join(', ')}: the pass barely lifted above quiet. Move the timer closer or raise gain.`);
  if (!bits.length) bits.push('Nothing was measured. Start again with the timer connected.');
  return bits.join(' ');
}

function applyCalibration(app) {
  const usable = app.cal.usable();
  /* Only slots that produced a usable measurement change. A receiver whose
   * quad did not fly the pass keeps last week's good bounds rather than being
   * downgraded to "too weak" by a measurement that was never made. */
  for (const u of usable) app.saveRf(u.slot, { floor: u.floor, ceiling: u.ceiling, threshold: u.suggested });
  if (!usable.length) { toast('Nothing to apply — no receiver saw a separable pass', 'err'); return; }
  if (!app.canControl) { toast('Saved, but there is no control link to write it', 'err'); return; }
  app.pushConfig(usable.map(u => u.slot), { now: true });
  if (app.race.active) toast(`Saved for ${plural(usable.length, 'receiver')} — written when the session ends`, 'ok');
  else toast(`Written to ${plural(usable.length, 'receiver')}`, 'ok');
  app.cal.cancel();
  app.render();
}

function drawMeter(cv, { live, floor, ceiling, threshold, series, passes }) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = cv.clientWidth || 600, hgt = cv.clientHeight || 120;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cs = getComputedStyle(document.documentElement);
  const col = n => cs.getPropertyValue(n).trim();
  g.clearRect(0, 0, w, hgt);

  const vals = series.map(s => s.v);
  const lo = Math.min(...[floor, threshold, live, ...vals].filter(v => v != null), Infinity);
  const hi = Math.max(...[ceiling, threshold, live, ...vals].filter(v => v != null), -Infinity);
  if (!isFinite(lo) || !isFinite(hi)) return;
  const pad = Math.max(60, (hi - lo) * 0.12);
  const min = lo - pad, max = hi + pad;
  const y = v => hgt - ((v - min) / (max - min)) * hgt;

  /* Below the trigger nothing counts as a lap: paint that band as dead space so
   * a threshold under the noise floor is visible as a screen that is all dead. */
  if (threshold != null) {
    g.fillStyle = col('--m-nolap');
    g.fillRect(0, y(threshold), w, hgt - y(threshold));
    g.fillStyle = col('--m-pass');
    g.fillRect(0, 0, w, y(threshold));
  }
  if (vals.length > 1) {
    g.strokeStyle = col('--m-trace'); g.lineWidth = 1.5; g.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v));
    });
    g.stroke();
  }
  const line = (v, colour, dash) => {
    if (v == null) return;
    g.save(); g.strokeStyle = colour; g.lineWidth = 1.5; g.setLineDash(dash || []);
    g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke(); g.restore();
  };
  line(floor, col('--m-bound'), [4, 4]);
  line(ceiling, col('--m-peak'), [4, 4]);
  line(threshold, col('--thr-line'));

  /* Every excursion the watcher saw, at its peak, on the time axis of the
   * trace. Green cleared the trigger; red did not. A red dot sitting just under
   * the line is the whole tuning problem made visible in one glance — and it is
   * information that otherwise does not exist anywhere on screen, because a
   * pass that missed produces no lap and no record of having happened. */
  if (passes?.length && series.length > 1) {
    const t0 = series[0].t, t1 = series[series.length - 1].t;
    const span = t1 - t0;
    for (const p of passes) {
      if (span <= 0 || p.at < t0 || p.at > t1) continue;
      const x = ((p.at - t0) / span) * w;
      g.beginPath();
      g.fillStyle = col(p.counted ? '--state-green' : '--state-red');
      g.arc(x, y(p.peak), 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = col('--surface-1'); g.lineWidth = 1.5; g.stroke();
    }
  }
  g.fillStyle = col('--fg-3');
  g.font = '600 11px ' + col('--font-cond');
  if (threshold != null) g.fillText('TRIGGER ' + Math.round(threshold), 6, Math.max(12, y(threshold) - 5));
  if (floor != null) g.fillText('QUIET ' + Math.round(floor), 6, Math.min(hgt - 4, y(floor) + 13));
  if (ceiling != null) g.fillText('PASS PEAK ' + Math.round(ceiling), 6, Math.max(11, y(ceiling) - 5));
}

/* ==================================================== channel finder ====== */

SCREENS.findChannel = (app, slot) => {
  if (!app.canControl) {
    toast('Scanning needs a control link — connect over Bluetooth', 'err');
    return;
  }
  if (app.race.active) {
    toast('Stop the session first — a scan moves the receiver off your channel', 'err');
    return;
  }
  const bars = h('div.scanbars');
  const status = h('p.muted', 'Power your quad up with video ON and hold it a metre from the ' +
                              'timer. The scan takes about 20 seconds.');
  const result = h('div');
  let scanner = null;

  /* Every channel sits on the same noise floor, so bars drawn from zero are all
   * full and identical. Scale across the measured range instead: the point of
   * this screen is which channel stands out, not the absolute number. */
  const draw = results => {
    const peaks = results.map(r => r.peak);
    const lo = Math.min(...peaks), hi = Math.max(...peaks);
    const span = Math.max(1, hi - lo);
    mount(bars, ...results.map(r => h('div.scanbar',
      { 'data-top': r.peak === hi && hi - lo > 40 ? '' : null },
      h('span.nm', r.name),
      h('span.track', h('i', { style: {
        width: (4 + ((r.peak - lo) / span) * 96).toFixed(1) + '%' } })),
      h('span.pk', Math.round(r.peak)))));
  };

  sheet('Find my channel', close => {
    const start = h('button.go.wide', { onclick: async () => {
      if (scanner?.active) { scanner.stop(); return; }
      start.disabled = true;
      mount(start, 'Sweeping…');
      status.textContent = 'Sweeping 40 channels…';
      /* Sweeping means the timer will report forty channels for this slot in
       * a row; none is the pilot's. Say so before the first echo arrives, and
       * assert the current channel as intent so that if the link drops
       * mid-sweep a reconnect restores it instead of adopting wherever the
       * receiver was parked. */
      app.scanning = slot;
      if (!app.touched[slot]) { app.touched[slot] = true; store.save('pilotsTouched', app.touched); }
      scanner = new ChannelScanner({
        link: app.link,
        rfFor: s => ({ ...(app.timer.rfSetup[s] || {}), ...app.rfFor(s) }),
        sample: s => { const x = app.sig.slots.get(s); return x ? { v: x.value, t: x.lastAt } : null; },
      });
      const results = await scanner.run(slot, p => {
        status.textContent = `Sweeping… ${p.index + 1} of ${p.total}`;
        draw(p.results);
      });
      app.scanning = null;
      app.pushConfig([slot], { now: true });     // put the slot back where it belongs
      start.disabled = false;
      mount(start, 'Scan again');
      if (scanner.lost) {
        status.textContent = 'Timer link lost during the scan.';
        mount(result, h('div.note', { 'data-tone': 'bad' },
          h('strong', 'The timer dropped out mid-sweep'),
          'Power-cycle it and reconnect; your channel is put back automatically. Then scan again.'));
        return;
      }
      const best = ChannelScanner.best(results);
      if (!best || !best.confident) {
        status.textContent = 'No channel stood out.';
        mount(result, h('div.note', { 'data-tone': 'warn' },
          h('strong', 'Nothing clearly transmitting'),
          'Check the quad is powered with video on, hold it closer to the timer, and scan ' +
          'again. If it still finds nothing, the VTX may be off or on a band this timer ' +
          'cannot reach.'));
        return;
      }
      status.textContent = '';
      mount(result, h('div.note', { 'data-tone': 'ok' },
        h('strong', `${best.name} — ${best.freq} MHz`),
        `That channel came back ${Math.round(best.lift)} counts above everything else, so ` +
        'it is almost certainly your video.',
        h('div.act', h('button.go', { onclick: () => {
          app.setPilot(slot, { channel: best.name });
          store.save('channelPicked', true);
          toast(`Slot ${slot} set to ${best.name}`, 'ok');
          close();
        } }, `Use ${best.name}`))));
    } }, 'Start the scan');

    return h('div.stack', status, start, result, bars);
  }, { onClose: () => { scanner?.stop(); app.scanning = null; app.pushConfig([slot], { now: true }); } });
};

/* ============================================================ results ===== */

SCREENS.results = (app, res) => {
  /* One pilot has no podium. Show the numbers a practising pilot actually
   * wants — best lap, best consecutive, how many laps — not a table of one. */
  if (res.results.length === 1) return soloResults(app, res);
  const rows = res.results.map(r => h('div.resrow', { style: { borderLeftColor: idVar(r.slot) } },
    h('div.pos.num', String(r.pos)),
    h('div', h('div', { style: { fontWeight: '700' } }, r.name),
      h('div.cap', `${r.channel} · ${plural(r.laps, 'lap')}`)),
    h('div', { style: { textAlign: 'right' } },
      h('div.v', r.best == null ? '—' : fmt2(r.best)),
      h('div.cap', 'best lap'))));
  const chips = res.results.map(r => h('div',
    h('div.cap', { style: { marginBottom: '4px' } }, r.name),
    h('div.lapchips', ...r.lapTimes.map(t => h('span.lapchip', { 'data-best': t === r.best ? '' : null },
      fmt2(t))))));
  sheet(res.mode === 'practice' ? 'Session' : 'Result', close => h('div.stack',
    h('p.muted', `${describeFormat(res)} · ${clockStr(res.duration)}`),
    h('div.results', ...rows),
    ...chips,
    h('div.row',
      h('button.go', { style: { flex: '1' }, onclick: () => { close(); app.resetRace(); app.start(); } },
        'Go again'),
      h('button.ghost', { onclick: () => { close(); app.go('history'); } }, 'History'))));
};

function soloResults(app, res) {
  const r = res.results[0];
  const cell = (label, value, tone) => h('div',
    h('div.v', { 'data-tone': tone || null }, value), h('div.cap', label));
  sheet('Session', close => h('div.stack',
    h('p.muted', `${describeFormat(res)} · ${clockStr(res.duration)} on ${r.channel}`),
    h('div.solosum',
      cell('Laps', String(r.laps)),
      cell('Best lap', r.best == null ? '—' : fmt2(r.best), 'purple'),
      cell(`Best ${res.consecN}`, r.consec == null ? '—' : fmt2(r.consec)),
      cell('Average', r.laps ? fmt2(r.total / r.laps) : '—')),
    r.lapTimes.length && h('div',
      h('div.cap', { style: { marginBottom: '6px' } }, 'Every lap'),
      h('div.lapchips', ...r.lapTimes.map(t =>
        h('span.lapchip', { 'data-best': t === r.best ? '' : null }, fmt2(t))))),
    h('div.row',
      h('button.go', { style: { flex: '1' }, onclick: () => { close(); app.resetRace(); app.start(); } },
        'Go again'),
      h('button.ghost', { onclick: () => { close(); app.go('history'); } }, 'History'))));
}

function describeFormat(res) {
  if (res.mode === 'laps') return `First to ${res.targetLaps} laps`;
  if (res.mode === 'time') return `${fmtDuration(res.targetSeconds)} race`;
  if (res.mode === 'consecutive') return `Best ${res.consecN} consecutive`;
  return 'Open practice';
}

/* ============================================================ history ===== */

SCREENS.history = app => {
  const node = h('div.screen');
  const list = h('div.stack');
  const races = store.load('history', []).slice().reverse();

  const csv = async () => {
    const blob = new Blob([store.historyCsv()], { type: 'text/csv' });
    /* On iOS a download link does nothing useful; the share sheet does. */
    try {
      const file = new File([blob], 'whooptimer-history.csv', { type: 'text/csv' });
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e?.name === 'AbortError') return; }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'whooptimer-history.csv' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  mount(list, ...(races.length ? races.map(r => {
    const winner = r.results[0];
    return h('div.histrow',
      h('div.row', { style: { justifyContent: 'space-between' } },
        h('strong', `${r.name} · ${describeFormat(r)}`),
        h('span.cap', new Date(r.at * 1000).toLocaleString())),
      ...r.results.map(e => h('div',
        h('div.row', { style: { gap: '8px' } },
          h('span.pill', h('span.swatch', { style: { width: '10px', height: '10px',
            borderRadius: '3px', background: idVar(e.slot) } }), `${e.pos}. ${e.name}`),
          h('span.muted', `${plural(e.laps, 'lap')} · best ${fmt2(e.best)}` +
            (e.consec != null ? ` · ${r.consecN} consec ${fmt2(e.consec)}` : ''))),
        h('div.lapchips', { style: { marginTop: '4px' } },
          ...e.lapTimes.map(t => h('span.lapchip', { 'data-best': t === e.best ? '' : null }, fmt2(t)))))));
  }) : [h('div.card', h('p.muted', 'No saved sessions yet. Every race and practice session ' +
                                   'lands here when it ends.'))]));

  mount(node, h('div.scroller', h('div.wrap.stack',
    h('div.row', { style: { justifyContent: 'space-between' } },
      h('h2', 'History'),
      h('button.ghost', { onclick: () => app.go(app.mode === 'solo' ? 'fly' : 'race') },
        'Back to the session')),
    h('div.row',
      h('button.ghost', { onclick: csv, disabled: !races.length }, 'Export CSV'),
      h('button.ghost', { disabled: !races.length, onclick: () => confirmSheet('Clear history?',
          'Every saved session is deleted from this device. Export first if you want them.',
          'Delete all', () => { store.save('history', []); app.render(); }) }, 'Clear')),
    list)));
  return { node };
};

/* =========================================================== settings ===== */

function settingsSheet(app) {
  sheet('Race settings', () => h('div.stack',
    numField('Minimum lap (seconds)', app.settings.minLap, 0, 60, 0.5,
      v => app.saveSettings({ minLap: v }),
      'A whoop hovering in the gate otherwise racks up a dozen laps.'),
    numField('Countdown (seconds)', app.settings.countdown, 0, 30, 1,
      v => app.saveSettings({ countdown: v })),
    numField('Consecutive laps to score', app.settings.consecN, 2, 10, 1,
      v => app.saveSettings({ consecN: v })),
    h('div.field',
      h('label', 'Holeshot start'),
      h('div.row',
        h('button.toggle', { 'aria-pressed': String(app.settings.holeshot),
          onclick: e => { const on = !app.settings.holeshot;
                          app.saveSettings({ holeshot: on });
                          e.currentTarget.setAttribute('aria-pressed', String(on)); } },
          h('span.pip')),
        h('span.muted', 'On when you launch from the far side of the gate: the first ' +
                        'crossing only starts the clock instead of ending lap 1.')))));
}

function voiceSheet(app) {
  const v = app.voice;
  sheet('Voice', () => h('div.stack',
    !v.available && h('div.note', { 'data-tone': 'warn' },
      h('strong', 'This browser reports no voices'),
      'Callouts will be silent. On Linux the browser speaks through speech-dispatcher: ' +
      'install it and a voice (espeak-ng), and on Chrome or Chromium also launch with ' +
      '--enable-speech-dispatcher, which is off by default. Lap times still appear on screen.'),
    h('div.field', h('label', 'Read out'),
      h('div.seg', ...[['full', 'Lap and time'], ['time', 'Just the time'], ['off', 'Silent']]
        .map(([k, label]) => h('button', { 'aria-pressed': String(app.prefs.announce === k),
          onclick: e => { app.savePrefs({ announce: k });
            [...e.currentTarget.parentNode.children].forEach(b =>
              b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, label)))),
    h('div.field', h('label', 'Voice'),
      h('select', { onchange: e => app.savePrefs({ voiceName: e.target.value }) },
        ...v.pickable().map(vo => h('option', { value: vo.name, selected: vo.name === v.voice?.name },
          `${vo.name} (${vo.lang})`)))),
    h('div.field', h('label', `Speed`),
      h('input', { type: 'range', min: '0.7', max: '1.6', step: '0.05', value: app.prefs.rate,
        oninput: e => app.savePrefs({ rate: Number(e.target.value) }) })),
    h('div.field', h('label', 'Gate beep'),
      h('div.row',
        h('button', { 'aria-pressed': String(!!app.prefs.gateBeep),
          onclick: e => {
            const on = !app.prefs.gateBeep;
            app.savePrefs({ gateBeep: on });
            e.currentTarget.setAttribute('aria-pressed', String(on));
            if (on) app.beeper.ping(1, { force: true });
          } }, 'Beep on every crossing'),
        h('button.ghost', { onclick: () => app.beeper.ping(1, { force: true }) }, 'Hear it'))),
    h('div.muted', 'A tone the instant the timer reports a crossing. Stand at the gate and ' +
                   'fly through it: if the beep lands with the quad rather than after it, the ' +
                   'lap times are honest. One pitch per receiver.'),
    h('button.ghost.wide', { onclick: () => v.say('Lap 3, 24.7', { force: true }) },
      'Test a callout')));
}
