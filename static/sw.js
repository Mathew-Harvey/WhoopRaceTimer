/* Offline cache.
 *
 * A track is exactly where there is no signal, and a timing app that needs the
 * internet to open is not a timing app. Everything is precached on first visit
 * and served cache-first; a fresh copy is fetched in the background so the next
 * launch is up to date.
 */
'use strict';

const VERSION = 'wt-6';
const SHELL = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg',
  'icon-192.png', 'icon-512.png', 'icon-maskable.png',
  'js/boot.js', 'js/app.js', 'js/screens.js', 'js/ui.js', 'js/link.js',
  'js/laprf.js', 'js/race.js', 'js/tuning.js', 'js/store.js', 'js/speech.js',
  'js/setup.js', 'js/calibrate.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    /* cache: 'reload' bypasses the HTTP cache, so an install cannot mix one
     * module from the previous deploy with the rest from this one. */
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  /* The bridge is live state; never answer it from a cache. */
  if (url.pathname.startsWith('/bridge/')) return;
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
