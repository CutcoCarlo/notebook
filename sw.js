/* Offline cache so the app opens with no signal. App files are network-first so
   updates show up on the next load. Bump VERSION on each release. */
const VERSION = 'notebook-v9';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'render.js', 'export.js',
  'jspdf.umd.min.js', 'perfect-freehand.mjs', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const put = res => { if (res && res.ok) caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; };
  e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
