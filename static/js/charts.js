/* Inline SVG chart builders.
 *
 * No chart library. The app has to be servable as static files off a USB stick
 * at a track with no internet, which rules out a CDN, and a bundled library
 * would be larger than the whole rest of the app for six charts.
 *
 * Two rules everything here follows, and both exist for a reason:
 *
 *  - **Charts are drawn at a measured pixel width, not scaled by a viewBox.**
 *    A 600-wide viewBox squeezed into a 358px phone scales its text down with
 *    it, and a 13px axis label becomes 7.8px. This app has a 13px floor. So
 *    each chart measures its container and redraws when the width changes,
 *    which costs a ResizeObserver and buys type that is the size it says it is.
 *
 *  - **Colour is never the only encoding.** Every chart with more than one
 *    series has a legend, a dash pattern and a direct label at the end of the
 *    line, so it survives being read by somebody who cannot separate the hues,
 *    or printed.
 *
 * The activity ramp and the two-series pair were checked against the chart
 * surface (--recess) in both themes rather than chosen by eye; the values live
 * in app.css next to the note that says so.
 */
'use strict';
import { fmtDuration, fmtLap, fmtSpread } from './aggregate.js';
import { h, mount } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

/** h(), for SVG. Same shape, different namespace. */
export function s(spec, attrs, ...kids) {
  const [tag, ...cls] = String(spec).split('.');
  const node = document.createElementNS(NS, tag);
  if (cls.length) node.setAttribute('class', cls.join(' '));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs); attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(4)) {
    if (kid == null || kid === false) continue;
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

/* ------------------------------------------------------------- geometry -- */

const PAD = { l: 52, r: 14, t: 12, b: 26 };

/** Round ticks that land on numbers a person would have chosen. */
export function ticks(lo, hi, target = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}

/** A bar with rounded top corners, anchored square to the baseline. */
function barTop(x, y, w, height, r = 4) {
  r = Math.max(0, Math.min(r, w / 2, height));
  const b = y + height;
  return `M${x} ${b} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} ` +
         `L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} L${x + w} ${b} Z`;
}

/**
 * Show or hide an SVG element.
 *
 * Not `el.hidden = false`. On an SVG element that assigns a plain expando
 * property and leaves the hidden *attribute* in place, so the browser goes on
 * hiding it while the code reads back exactly what it wrote. The crosshair and
 * its dots were invisible for that reason, and the test that asked them
 * whether they were visible believed them.
 */
const show = (el, on) => {
  if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
};

const shortDate = at => new Date(at * 1000)
  .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const longDate = at => new Date(at * 1000)
  .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/* --------------------------------------------------------- the container -- */

/**
 * Draw into a container whose width is measured, and redraw when it changes.
 *
 * The observer holds the node and the node holds the observer, so dropping the
 * screen drops both. It also stops itself the first time it fires on a node
 * that is no longer in the document, which is what happens when a screen is
 * replaced while a resize is in flight.
 */
function responsive(build, { minWidth = 260 } = {}) {
  const host = h('div.chart');
  let last = 0;
  const draw = () => {
    if (!host.isConnected) return;
    const w = Math.max(minWidth, Math.round(host.clientWidth));
    if (w === last) return;
    last = w;
    mount(host, build(w));
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!host.isConnected) { ro.disconnect(); return; }
      requestAnimationFrame(draw);
    });
    ro.observe(host);
    host._ro = ro;
  } else {
    /* No observer: draw once on the next frame, at whatever width exists. */
    requestAnimationFrame(draw);
    addEventListener('resize', draw);
  }
  return host;
}

/** The floating readout. One per chart, reused, never re-created on move. */
function tipLayer(host) {
  const el = h('div.charttip', { hidden: true, role: 'status', 'aria-live': 'polite' });
  host.appendChild(el);
  let raf = 0;
  return {
    show(x, y, kids) {
      mount(el, kids);
      el.hidden = false;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const box = host.getBoundingClientRect();
        const w = el.offsetWidth, hh = el.offsetHeight;
        el.style.left = `${Math.max(2, Math.min(box.width - w - 2, x - w / 2))}px`;
        el.style.top = `${Math.max(2, y - hh - 12)}px`;
      });
    },
    hide() { el.hidden = true; },
  };
}

const tipRow = (label, value) => h('div.tiprow', h('span', label), h('b', value));

/* ================================================================ figure == */

/**
 * A chart in its card, with the table that says the same thing.
 *
 * The table is not a fallback for when the chart fails. It is the version you
 * can read out loud, copy, or reach with a screen reader, and every chart here
 * has one because a picture of numbers that does not let you get at the numbers
 * is a worse answer than a table.
 */
export function figure({ title, note, legend, chart, table, wide }) {
  if (!chart) return null;
  let showing = 'chart';
  const body = h('div');
  const swap = h('button.quiet.tabletoggle', {
    'aria-pressed': 'false',
    onclick: () => {
      showing = showing === 'chart' ? 'table' : 'chart';
      swap.setAttribute('aria-pressed', showing === 'table' ? 'true' : 'false');
      swap.textContent = showing === 'table' ? 'Chart' : 'Table';
      mount(body, showing === 'table' ? table : chart);
    },
  }, 'Table');
  mount(body, chart);

  return h('div.card.figure', { 'data-wide': wide || null },
    h('div.fighead',
      h('div', h('h3', title), note ? h('p.muted.fignote', note) : null),
      table ? swap : null),
    legend && legend.length ? h('div.legend', ...legend.map(item =>
      h('span.legitem',
        item.dash
          ? s('svg', { width: 20, height: 8, 'aria-hidden': 'true' },
              s('line', { x1: 1, y1: 4, x2: 19, y2: 4, stroke: item.color,
                          'stroke-width': 2, 'stroke-dasharray': item.dash,
                          'stroke-linecap': 'round' }))
          : h('i.swatch', { style: { background: item.color } }),
        item.label))) : null,
    body);
}

/** A plain table, built the same way everywhere so the twins match. */
export function dataTable(head, rows, { align = [] } = {}) {
  if (!rows.length) return h('p.muted', 'Nothing to show yet.');
  return h('div.tablewrap',
    h('table',
      h('thead', h('tr', ...head.map((t, i) =>
        h('th', { class: 'cap', style: { textAlign: align[i] === 'l' ? 'left' : 'right' } }, t)))),
      h('tbody', ...rows.map(r => h('tr', ...r.map((cell, i) =>
        h('td', { class: align[i] === 'l' ? null : 'num',
                  style: { textAlign: align[i] === 'l' ? 'left' : 'right' } }, cell)))))));
}

/* ====================================================== activity calendar == */

const LEVEL_VAR = ['var(--cal-0)', 'var(--cal-1)', 'var(--cal-2)', 'var(--cal-3)', 'var(--cal-4)'];
const WEEKDAY = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

/**
 * Days flown, one square per day.
 *
 * The shade is a rank within this pilot's own year, not an absolute count — one
 * enormous Saturday would otherwise flatten every other day to the bottom of
 * the scale and the year would read as blank.
 *
 * On a narrow screen it drops whole weeks off the left rather than shrinking
 * the squares into a texture. Fewer weeks you can actually read beats a year
 * you cannot.
 */
export function activityHeatmap(cal) {
  if (!cal || !cal.cells.length) return null;

  return responsive(w => {
    const GUT = 30, GAP = 3, MIN = 9, MAX = 15, TOP = 18;
    const avail = w - GUT - 2;
    let cell = Math.floor(avail / cal.weeks) - GAP;
    let firstWeek = 0;
    if (cell < MIN) {
      cell = MIN;
      const fits = Math.max(4, Math.floor(avail / (cell + GAP)));
      firstWeek = Math.max(0, cal.weeks - fits);
    }
    cell = Math.min(cell, MAX);
    const weeks = cal.weeks - firstWeek;
    const gridW = weeks * (cell + GAP) - GAP;
    const height = TOP + 7 * (cell + GAP) - GAP;
    const cells = cal.cells.filter(c => c.week >= firstWeek);

    const host = h('div.chartbody');
    const tip = tipLayer(host);
    const x = c => GUT + (c.week - firstWeek) * (cell + GAP);
    const y = c => TOP + c.weekday * (cell + GAP);

    /* A month label above the first column that month starts in. */
    const months = [];
    let seen = '';
    for (const c of cells) {
      const key = c.key.slice(0, 7);
      if (key === seen || c.weekday !== 0) continue;
      seen = key;
      const at = x(c);
      if (at + 26 > GUT + gridW) continue;
      months.push(s('text', { x: at, y: 11, class: 'axis' },
        new Date(c.at * 1000).toLocaleDateString(undefined, { month: 'short' })));
    }

    const flown = cells.filter(c => c.laps > 0).length;
    const svg = s('svg', {
      width: GUT + gridW, height,
      viewBox: `0 0 ${GUT + gridW} ${height}`,
      role: 'img', class: 'cal',
      'aria-label': `${flown} days flown in the last ${weeks} weeks.`,
    },
      ...months,
      ...WEEKDAY.map((label, i) => label
        ? s('text', { x: GUT - 6, y: TOP + i * (cell + GAP) + cell / 2 + 4,
                      class: 'axis', 'text-anchor': 'end' }, label) : null).filter(Boolean),
      ...cells.map(c => s('rect', {
        x: x(c), y: y(c), width: cell, height: cell, rx: 3,
        fill: c.future ? 'transparent' : LEVEL_VAR[c.level],
        stroke: c.future ? 'var(--line-subtle)' : 'none',
        'stroke-dasharray': c.future ? '2 2' : null,
        class: 'calcell',
        onpointerenter: e => {
          if (c.future) return;
          const b = e.target.getBoundingClientRect(), p = host.getBoundingClientRect();
          tip.show(b.left - p.left + cell / 2, b.top - p.top, [
            h('strong', longDate(c.at)),
            c.laps
              ? [tipRow('Laps', String(c.laps)),
                 tipRow('Sessions', String(c.sessions)),
                 c.best != null ? tipRow('Best', fmtLap(c.best)) : null,
                 tipRow('Air time', fmtDuration(c.airTimeS))]
              : h('div.tiprow', h('span', 'Did not fly')),
          ]);
        },
        onpointerleave: () => tip.hide(),
      })));

    const legend = h('div.callegend',
      h('span.cap', 'Quieter'),
      ...[1, 2, 3, 4].map(l => h('i.swatch', { style: { background: LEVEL_VAR[l] } })),
      h('span.cap', 'Busier'));

    host.appendChild(h('div.calscroll', svg));
    host.appendChild(legend);
    return host;
  });
}

export function calendarTable(cal) {
  if (!cal) return null;
  const byMonth = new Map();
  for (const c of cal.cells) {
    if (!c.laps) continue;
    const k = c.key.slice(0, 7);
    const cur = byMonth.get(k) || { days: 0, laps: 0, sessions: 0, air: 0, best: null };
    cur.days++; cur.laps += c.laps; cur.sessions += c.sessions; cur.air += c.airTimeS;
    if (c.best != null && (cur.best == null || c.best < cur.best)) cur.best = c.best;
    byMonth.set(k, cur);
  }
  return dataTable(
    ['Month', 'Days flown', 'Sessions', 'Laps', 'Best', 'Air time'],
    [...byMonth.entries()].reverse().map(([k, v]) =>
      [k, String(v.days), String(v.sessions), String(v.laps), fmtLap(v.best), fmtDuration(v.air)]),
    { align: ['l'] });
}

/* ============================================================ line charts == */

/**
 * One or more series against session number.
 *
 * Sessions are spaced evenly rather than by date on purpose: a pilot who flew
 * every day for a week and then again three months later has a real gap, but
 * plotting it to scale squashes the week into two pixels and the chart stops
 * being about lap times. The x axis is labelled by date at the ticks, so the
 * gap is still visible — it is just not allowed to eat the data.
 */
function lineChart(series, { height = 190, fmt = fmtLap, invertGood = false, aria } = {}) {
  const n = Math.max(...series.map(sr => sr.points.length));
  if (!n || n < 2) return null;

  return responsive(w => {
    const host = h('div.chartbody');
    const tip = tipLayer(host);
    const W = w, H = height;

    /* Series labels go in a gutter to the right of the plot, not on top of it.
     * A label printed over the line it names is unreadable exactly where it
     * matters, at the end, where the lines converge. On a narrow screen the
     * gutter would cost more than the labels are worth, so it is dropped and
     * the legend above carries identity on its own — which is why the legend
     * is not optional. */
    const CH = 6.7;                                   /* 13px condensed, near enough */
    const wantGutter = series.length > 1
      ? Math.max(...series.map(sr => sr.label.length)) * CH + 10 : 0;
    const gutter = (W - PAD.l - PAD.r - wantGutter) >= 250 ? wantGutter : 0;
    const padR = PAD.r + gutter;
    const plotW = W - PAD.l - padR, plotH = H - PAD.t - PAD.b;

    const all = series.flatMap(sr => sr.points.map(p => p.v)).filter(v => v != null);
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.12 || Math.max(0.5, hi * 0.05);
    lo -= pad; hi += pad;
    const x = i => PAD.l + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH;

    const grid = ticks(lo, hi, 4).map(v => [
      s('line', { x1: PAD.l, y1: y(v), x2: W - padR, y2: y(v), class: 'grid' }),
      s('text', { x: PAD.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, fmt(v)),
    ]);

    /* Three x labels: first, middle, last. More than that collides. */
    const base = series[0].points;
    const xlab = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i)
      .map(i => base[i] ? s('text', {
        x: Math.min(W - padR, Math.max(PAD.l, x(i))), y: H - 7, class: 'axis',
        'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      }, shortDate(base[i].at)) : null).filter(Boolean);

    const paths = series.map(sr => {
      let d = '', pen = false;
      sr.points.forEach((p, i) => {
        if (p.v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`;
        pen = true;
      });
      return s('path', {
        d, fill: 'none', stroke: sr.color, 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-dasharray': sr.dash || null,
      });
    });

    /* The end of each line is labelled where it is, so the legend is a
     * convenience rather than the only way to tell the series apart. Two
     * series that finish close together would print their labels on top of
     * each other, so they are pushed apart first — the point of the label is
     * that it can be read. */
    const endLabels = (() => {
      if (!gutter || n < 4) return [];
      const placed = [];
      for (const sr of series) {
        const lastIdx = sr.points.reduce((a, p, i) => (p.v != null ? i : a), -1);
        if (lastIdx < 0) continue;
        placed.push({ sr, at: y(sr.points[lastIdx].v) - 8 });
      }
      placed.sort((a, b) => a.at - b.at);
      const MIN = 15;
      for (let i = 1; i < placed.length; i++) {
        if (placed[i].at - placed[i - 1].at < MIN) placed[i].at = placed[i - 1].at + MIN;
      }
      /* If pushing down ran off the bottom, push the whole stack back up. */
      const over = placed.length
        ? placed[placed.length - 1].at - (PAD.t + plotH - 2) : 0;
      if (over > 0) for (const it of placed) it.at -= over;
      return placed.map(it => s('text', {
        x: W - PAD.r, y: Math.max(12, it.at + 4),
        class: 'endlab', 'text-anchor': 'end', fill: it.sr.color,
      }, it.sr.label));
    })();

    const cross = s('line', { class: 'cross', y1: PAD.t, y2: PAD.t + plotH, hidden: true });
    const dots = series.map(sr => s('circle', {
      r: 4.5, class: 'crossdot', fill: sr.color, hidden: true,
    }));

    const move = e => {
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - PAD.l) / plotW) * (n - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      show(cross, true);
      const rows = [];
      series.forEach((sr, k) => {
        const p = sr.points[i];
        if (!p || p.v == null) { show(dots[k], false); return; }
        show(dots[k], true);
        dots[k].setAttribute('cx', x(i)); dots[k].setAttribute('cy', y(p.v));
        rows.push(tipRow(sr.label, fmt(p.v)));
      });
      const at = base[i] && base[i].at;
      tip.show(x(i), y(series[0].points[i]?.v ?? lo),
               [h('strong', at ? longDate(at) : `Session ${i + 1}`), ...rows]);
    };
    const leave = () => {
      show(cross, false);
      for (const d of dots) show(d, false);
      tip.hide();
    };

    const svg = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': aria || `${series.map(sr => sr.label).join(' and ')} over ${n} sessions.`,
      onpointermove: move, onpointerleave: leave,
    },
      ...grid.flat(), ...xlab, cross, ...paths, ...endLabels, ...dots,
      s('rect', { x: PAD.l, y: PAD.t, width: plotW, height: plotH, fill: 'transparent' }));

    host.appendChild(svg);
    return host;
  });
}

/** Session best and session pace, one axis, both in seconds. */
export function paceChart(sessionPace) {
  const pts = sessionPace || [];
  if (pts.length < 2) return null;
  return lineChart([
    { label: 'Best lap', color: 'var(--c-best)',
      points: pts.map(p => ({ at: p.at, v: p.best })) },
    { label: 'Session pace', color: 'var(--c-pace)', dash: '5 4',
      points: pts.map(p => ({ at: p.at, v: p.pace })) },
  ], { aria: `Best lap and median lap for each of ${pts.length} sessions.` });
}

export function paceTable(sessionPace) {
  return dataTable(['Session', 'Best lap', 'Session pace', 'Laps'],
    [...(sessionPace || [])].reverse().map(p =>
      [shortDate(p.at), fmtLap(p.best), fmtLap(p.pace), String(p.laps)]),
    { align: ['l'] });
}

/** How tightly the laps cluster, session by session. Lower is tidier. */
export function consistencyChart(consistency) {
  const pts = consistency || [];
  if (pts.length < 2) return null;
  return lineChart([
    { label: 'Spread', color: 'var(--c-best)', points: pts.map(p => ({ at: p.at, v: p.v })) },
  ], { fmt: fmtSpread, height: 160,
       aria: `Lap-time spread for each of ${pts.length} sessions, as a percentage of ` +
             `the median lap; lower is tidier.` });
}

export function consistencyTable(consistency) {
  return dataTable(['Session', 'Spread', 'Laps'],
    [...(consistency || [])].reverse().map(p =>
      [shortDate(p.at), fmtSpread(p.v), String(p.laps)]),
    { align: ['l'] });
}

/* ================================================================ scatter == */

/**
 * Every clean lap, in the order it was flown.
 *
 * The line charts summarise a session into one number each; this is the one
 * chart that shows what the session actually looked like — the warm-up laps,
 * the one good one, and how much of the session was spent nowhere near it.
 */
export const SCATTER_MAX = 3000;

export function lapScatterChart(points, { max = SCATTER_MAX } = {}) {
  const all = points || [];
  if (all.length < 4) return null;
  /* One circle per lap, and a pilot at the service's session cap has around
   * nineteen thousand of them. That many nodes is seconds of layout and a lot
   * of memory on a phone, for a chart whose oldest half is a smear anyway, so
   * the most recent are drawn and the caption says how many. */
  const pts = all.length > max ? all.slice(-max) : all;

  return responsive(w => {
    const host = h('div.chartbody');
    const tip = tipLayer(host);
    const W = w, H = 210;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const vals = pts.map(p => p.t);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.1 || 0.5;
    lo -= pad; hi += pad;
    const x = i => PAD.l + (pts.length === 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
    const y = v => PAD.t + (1 - (v - lo) / (hi - lo)) * plotH;

    const grid = ticks(lo, hi, 4).map(v => [
      s('line', { x1: PAD.l, y1: y(v), x2: W - PAD.r, y2: y(v), class: 'grid' }),
      s('text', { x: PAD.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }, fmtLap(v)),
    ]);

    /* The best lap is the smallest one on the chart, found here rather than
     * matched against the record's rounded figure — comparing a raw lap time
     * to a rounded one finds nothing, and the highlight silently disappears. */
    let bestIdx = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i].t < pts[bestIdx].t) bestIdx = i;
    const r = pts.length > 1200 ? 2.2 : pts.length > 400 ? 2.6 : 3.2;

    const dots = pts.map((p, i) => i === bestIdx ? null : s('circle', {
      cx: x(i).toFixed(1), cy: y(p.t).toFixed(1), r,
      fill: 'var(--c-pace)',
      /* A ring in the surface colour so overlapping laps stay countable
       * instead of merging into one smear — but only once the dots are big
       * enough to carry one. On a 1.8px dot a ring is just dimming. */
      stroke: r >= 2.4 ? 'var(--recess)' : 'none',
      'stroke-width': r >= 2.4 ? 1.4 : 0,
    }));
    /* Drawn last, so a thousand later laps cannot bury it. */
    dots.push(s('circle', {
      cx: x(bestIdx).toFixed(1), cy: y(pts[bestIdx].t).toFixed(1), r: r + 2.5,
      fill: 'var(--c-best)', class: 'pbdot',
    }));

    const hover = s('circle', { r: 6, class: 'crossdot', fill: 'none',
                                stroke: 'var(--fg)', 'stroke-width': 2, hidden: true });

    const move = e => {
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left, py = e.clientY - box.top;
      let bestI = -1, bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const dx = x(i) - px, dy = y(pts[i].t) - py;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      if (bestI < 0 || bestD > 40 * 40) { leave(); return; }
      const p = pts[bestI];
      show(hover, true);
      hover.setAttribute('cx', x(bestI)); hover.setAttribute('cy', y(p.t));
      tip.show(x(bestI), y(p.t), [
        h('strong', fmtLap(p.t)),
        tipRow('Lap', `${p.lapNumber} of that session`),
        tipRow('Flown', shortDate(p.at)),
        bestI === bestIdx ? tipRow('', 'Personal best') : null,
      ].filter(Boolean));
    };
    const leave = () => { show(hover, false); tip.hide(); };

    const svg = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `${pts.length} clean laps in the order flown, from ` +
                    `${fmtLap(Math.min(...vals))} to ${fmtLap(Math.max(...vals))}.`,
      onpointermove: move, onpointerleave: leave,
    },
      ...grid.flat(),
      s('text', { x: PAD.l, y: H - 7, class: 'axis' }, shortDate(pts[0].at)),
      s('text', { x: W - PAD.r, y: H - 7, class: 'axis', 'text-anchor': 'end' },
        shortDate(pts[pts.length - 1].at)),
      ...dots, hover,
      s('rect', { x: PAD.l, y: PAD.t, width: plotW, height: plotH, fill: 'transparent' }));

    host.appendChild(svg);
    return host;
  });
}

/* ============================================================== histogram == */

/**
 * Where the laps actually land. Freedman–Diaconis bins, done in aggregate.js.
 *
 * A shape needs enough laps to be a shape. Three laps bin perfectly happily
 * into two bars and the result looks like a finding, so below a floor there is
 * no chart at all — the pilot's first session is better served by the numbers
 * above it than by a picture of three laps.
 */
export function histogram(dist, { minLaps = 20 } = {}) {
  if (!dist || dist.bins.length < 2) return null;
  if (dist.bins.reduce((a, b) => a + b.n, 0) < minLaps) return null;

  return responsive(w => {
    const host = h('div.chartbody');
    const tip = tipLayer(host);
    const W = w, H = 190;
    const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;
    const maxN = Math.max(...dist.bins.map(b => b.n));
    const slot = plotW / dist.bins.length;
    const GAP = 2;                                    /* surface gap between bars */
    const bw = Math.max(2, slot - GAP);
    const y = v => PAD.t + (1 - v / maxN) * plotH;

    const grid = ticks(0, maxN, 4).map(v => [
      s('line', { x1: PAD.l, y1: y(v), x2: W - PAD.r, y2: y(v), class: 'grid' }),
      s('text', { x: PAD.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' },
        String(Math.round(v))),
    ]);

    const bars = dist.bins.map((b, i) => {
      const bx = PAD.l + i * slot + GAP / 2;
      const top = y(b.n), height = PAD.t + plotH - top;
      return s('path', {
        d: barTop(bx, top, bw, height), fill: 'var(--c-hist)', class: 'bar',
        onpointerenter: e => {
          const r = e.target.getBoundingClientRect(), p = host.getBoundingClientRect();
          tip.show(r.left - p.left + r.width / 2, r.top - p.top, [
            h('strong', `${b.from.toFixed(2)}–${b.to.toFixed(2)}s`),
            tipRow('Laps', String(b.n)),
            tipRow('Share', `${Math.round(100 * b.n / dist.bins.reduce((a, x) => a + x.n, 0))}%`),
          ]);
        },
        onpointerleave: () => tip.hide(),
      });
    });

    const svg = s('svg', {
      width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img',
      'aria-label': `Distribution of clean lap times between ${fmtLap(dist.lo)} and ` +
                    `${fmtLap(dist.hi)}, in ${dist.bins.length} bins.`,
    },
      ...grid.flat(),
      s('text', { x: PAD.l, y: H - 7, class: 'axis' }, fmtLap(dist.lo)),
      s('text', { x: W - PAD.r, y: H - 7, class: 'axis', 'text-anchor': 'end' }, fmtLap(dist.hi)),
      ...bars);

    host.appendChild(svg);
    return host;
  });
}

export function histogramTable(dist) {
  if (!dist) return null;
  const total = dist.bins.reduce((a, b) => a + b.n, 0) || 1;
  return dataTable(['Lap time', 'Laps', 'Share'],
    dist.bins.map(b => [`${b.from.toFixed(2)}–${b.to.toFixed(2)}s`, String(b.n),
                        `${Math.round(100 * b.n / total)}%`]),
    { align: ['l'] });
}
