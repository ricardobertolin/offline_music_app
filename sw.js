/* Offline Music — service worker.
   App shell is cache-first (works fully offline); the library itself lives in IndexedDB,
   so audio never goes through here. Also implements the Web Share Target hand-off. */

// Keep in step with APP_VERSION in js/util.js — a worker cannot import from it,
// and Settings → Version prints both so a mismatch means "reload, you are stale".
const VERSION = 'v2.8.0';
const SHELL = `shell-${VERSION}`;
const SHARE = 'share-inbox';
// Webfonts are cross-origin and versioned by URL, so they get their own cache
// that survives shell upgrades. Without this the app falls back to the local
// condensed/mono stack when offline, which is legible but off-design.
const FONTS = 'fonts-v1';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// On localhost the cache only gets in the way: always try the network first so a
// reload shows the code you just edited, and fall back to the cache when offline.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/db.js',
  './js/library.js',
  './js/metadata.js',
  './js/image.js',
  './js/zip.js',
  './js/zipwrite.js',
  './js/source.js',
  './js/archive.js',
  './js/report.js',
  './js/audio/decode.js',
  './js/audio/player.js',
  './js/audio/transcode.js',
  './js/audio/wav.js',
  './js/audio/oggopus.js',
  './js/dsp/loudness.js',
  './js/dsp/quality.js',
  './js/dsp/analyzer-worker.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll is all-or-nothing; add individually so one missing optional asset
    // cannot break the whole install.
    await Promise.all(ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
  if (e.data === 'version') e.source?.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Share target: files POSTed to the app.
  if (req.method === 'POST' && url.pathname.endsWith('/index.html')) {
    e.respondWith(handleShare(e));
    return;
  }
  if (req.method !== 'GET') return;

  // Cache-first for webfonts; an opaque response is fine, it only has to replay.
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const cache = await caches.open(FONTS);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Navigations: serve the shell, fall back to network.
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      if (DEV) {
        try { return await fetch(req); } catch { /* offline, use the cache */ }
      }
      const cached = await caches.match('./index.html', { ignoreSearch: true });
      if (cached) { refresh(req); return cached; }
      try { return await fetch(req); } catch { return new Response('Offline', { status: 503 }); }
    })());
    return;
  }

  e.respondWith((async () => {
    if (DEV) {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.type === 'basic') (await caches.open(SHELL)).put(req, fresh.clone());
        return fresh;
      } catch { /* offline, use the cache */ }
    }
    const cached = await caches.match(req, { ignoreSearch: false });
    if (cached) { refresh(req); return cached; }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') (await caches.open(SHELL)).put(req, res.clone());
      return res;
    } catch {
      return cached || new Response('Offline', { status: 503 });
    }
  })());
});

/** Background revalidate; failures are expected offline. */
function refresh(req) {
  fetch(req).then(async (res) => {
    if (res && res.ok && res.type === 'basic') (await caches.open(SHELL)).put(req, res);
  }).catch(() => {});
}

async function handleShare(e) {
  try {
    const form = await e.request.formData();
    const files = form.getAll('media').filter((f) => f && f.size);
    const cache = await caches.open(SHARE);
    let i = 0;
    for (const f of files) {
      await cache.put(
        new Request(`./__shared/${Date.now()}-${i++}-${encodeURIComponent(f.name || 'file')}`),
        new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream' } }),
      );
    }
  } catch { /* fall through to a normal load */ }
  return Response.redirect('./index.html?shared=1', 303);
}
