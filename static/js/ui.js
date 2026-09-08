/* DOM helpers, icons, toasts and sheets. No framework, no build step —
 * the whole app has to be servable as static files from anywhere, including a
 * USB stick at a track with no internet. */
'use strict';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * h('div.card', {onclick}, child, child…)
 * Tag string carries classes: 'button.go.wide'. Attributes starting with 'on'
 * become listeners; everything else is set with setAttribute, except a few
 * properties that must be assigned.
 */
export function h(spec, attrs, ...kids) {
  const [tag, ...cls] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (cls.length) node.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs); attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  add(node, kids);
  return node;
}

function add(node, kids) {
  for (const k of kids.flat(4)) {
    if (k == null || k === false) continue;
    node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const frag = (...kids) => { const f = document.createDocumentFragment(); add(f, kids); return f; };
export const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); return node; };
export const mount = (node, ...kids) => { clear(node); add(node, kids); return node; };

/* --------------------------------------------------------------- formatting -- */
export const fmt2 = v => v == null ? '—' : Number(v).toFixed(2);
export const fmt1 = v => v == null ? '—' : Number(v).toFixed(1);
export const int = v => v == null ? '—' : String(Math.round(v));

/** 83.4 -> "1:23.4"; under a minute stays "23.4" so a lap time reads as one number. */
export function clockStr(t, { minutes = true } = {}) {
  t = Math.max(0, t || 0);
  if (!minutes || t < 60) return t.toFixed(1);
  const m = Math.floor(t / 60);
  return `${m}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/* ------------------------------------------------------------------- icons -- */
const ICONS = {
  bolt: 'M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z',
  bluetooth: 'm12 2 5 4-5 4V2Zm0 12 5 4-5 4v-8ZM7 8l10 8M17 8 7 16',
  usb: 'M12 21V6m0 0-3 3m3-3 3 3M8 13l-3 2v3m11-8 3 2v3M5 20a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm14 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  play: 'M7 4.5v15l13-7.5-13-7.5Z',
  stop: 'M6 6h12v12H6z',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  pilot: 'M12 3 3 20l9-4 9 4-9-17Z',
  chev: 'm9 5 7 7-7 7',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z M19.4 13a7.6 7.6 0 0 0 0-2l2-1.5-2-3.4-2.3 1a7.6 7.6 0 0 0-1.7-1L15 3.5h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.3-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.3 1 2-3.4L19.4 13Z',
  volume: 'M4 9v6h4l5 4V5L8 9H4Zm12.5-1a5 5 0 0 1 0 8m2.5-11a8.5 8.5 0 0 1 0 14',
  mute: 'M4 9v6h4l5 4V5L8 9H4Zm12 1 5 5m0-5-5 5',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  radar: 'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l6-6',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  check: 'm4 12 5 5L20 6',
  close: 'M6 6l12 12M18 6 6 18',
  plug: 'M9 3v6m6-6v6M7 9h10v3a5 5 0 0 1-10 0V9Zm5 8v4',
};

export function icon(name, size) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (size) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', ICONS[name] || ICONS.bolt);
  if (name === 'play' || name === 'stop') { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
  svg.appendChild(p);
  return svg;
}

/* ------------------------------------------------------------------ toasts -- */
export function toast(msg, kind = 'info', ms = 4200) {
  const host = $('#toasts');
  if (!host) return;
  const t = h('div.toast', { class: kind }, msg);
  host.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 280); }, ms);
}

/* ------------------------------------------------------------------ sheets -- */
let openSheet = null;

/** A bottom sheet on a phone, a centred dialog on a desktop. Returns a closer. */
export function sheet(title, build, { onClose } = {}) {
  closeSheet();
  const panel = h('div.panel', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const host = h('div.sheet', { onclick: e => { if (e.target === host) close(); } }, panel);
  const close = () => {
    if (openSheet?.host !== host) return;
    host.remove(); openSheet = null;
    document.removeEventListener('keydown', esc);
    onClose?.();
  };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  mount(panel,
    h('div.grip'),
    h('div.row', { style: { justifyContent: 'space-between', marginBottom: '12px' } },
      h('h2', title),
      h('button.quiet', { onclick: close, 'aria-label': 'Close' }, icon('close', 20))),
    build(close));
  document.body.appendChild(host);
  document.addEventListener('keydown', esc);
  openSheet = { host, close };
  /* On a phone, focusing an input raises the keyboard over the sheet before
   * anyone has read it. Only buttons get focus there. */
  const coarse = matchMedia('(pointer:coarse)').matches;
  panel.querySelector(coarse ? 'button:not(.quiet)' : 'input,select,button:not(.quiet)')
       ?.focus({ preventScroll: true });
  return close;
}

/** Close whatever sheet is open through its own closer, so its Escape listener
 *  goes with it and its onClose runs — a scan started from a sheet must stop
 *  when the sheet is closed from anywhere. */
export function closeSheet() {
  openSheet?.close();
}

export const sheetOpen = () => !!openSheet;

/** A destructive action needs a deliberate second tap, not a native confirm(). */
export function confirmSheet(title, body, confirmLabel, onConfirm, { danger = true } = {}) {
  sheet(title, close => h('div.stack',
    h('p.muted', body),
    h('div.row', { style: { gap: '8px' } },
      h('button.ghost', { style: { flex: '1' }, onclick: close }, 'Cancel'),
      h(danger ? 'button.danger' : 'button.go', { style: { flex: '1' },
        onclick: () => { close(); onConfirm(); } }, confirmLabel))));
}
