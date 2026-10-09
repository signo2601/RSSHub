// Gruzzolo service worker: lets the installed app open without a connection.
// - App pages (navigations): network first, cached app shell when offline or slow.
// - App files (css, js, icons): served from cache, refreshed in the background.
// - /api/* (prices, sync): always from the network, never cached here.
// - Google Fonts: cache first.
// Bump VERSION whenever the list below or the caching rules change.
const VERSION = 'gruzzolo-v2.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const FONT_CACHE = 'gruzzolo-fonts-v1';
const NAV_TIMEOUT_MS = 4000;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './css/app.css',
  './css/portfolio.css',
  './css/report.css',
  './css/report2.css',
  './css/extra.css',
  './js/main.js',
  './js/util.js',
  './js/registry.js',
  './js/app.js',
  './js/state.js',
  './js/engine.js',
  './js/market.js',
  './js/catalog.js',
  './js/metrics.js',
  './js/markowitz.js',
  './js/income.js',
  './js/costs.js',
  './js/charts.js',
  './js/store.js',
  './js/sync.js',
  './js/importer.js',
  './js/demo.js',
  './js/info.js',
  './js/views/home.js',
  './js/views/market.js',
  './js/views/sheets.js',
  './js/views/report.js',
  './js/views/sheet-summary.js',
  './js/views/sheet-visual.js',
  './js/views/sheet-composition.js',
  './js/views/sheet-income.js',
  './js/views/sheet-costs.js',
  './js/views/sheet-risk.js',
  './js/views/more.js',
];

const SCOPE_URL = new URL('./', self.location).href;
const API_PREFIX = new URL('./api/', self.location).pathname;

// A response that followed a redirect cannot answer a navigation: store a clean copy
async function cleanCopy(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function putInCache(cacheName, request, response) {
  if (!response || !response.ok || (response.type !== 'basic' && response.type !== 'cors')) return;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, await cleanCopy(response));
  } catch {
    /* storage full or unavailable: the network answer is still used */
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing file must not block the install; the app shell itself must be there
    const results = await Promise.allSettled(SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      await cache.put(path, await cleanCopy(response));
    }));
    if (results[0].status === 'rejected' && results[1].status === 'rejected') throw new Error('App shell not available');
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== FONT_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match('./')) || (await cache.match('./index.html')) || null;
}

// Network first with a timeout; the cached shell when offline or too slow
async function handleNavigation(event) {
  const network = fetch(event.request).then(async (response) => {
    const url = new URL(event.request.url);
    const isShell = url.href.split(/[?#]/)[0] === SCOPE_URL || url.pathname.endsWith('/index.html');
    if (isShell && response.ok) event.waitUntil(putInCache(SHELL_CACHE, './', response.clone()));
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    const shell = await cachedShell();
    if (shell) {
      event.waitUntil(network.catch(() => null)); // let it finish and refresh the cache
      return shell;
    }
    return await network;
  } catch {
    const shell = await cachedShell();
    if (shell) return shell;
    return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gruzzolo</title><p style="font-family:system-ui;padding:24px">Sei offline e l\'app non è ancora salvata su questo dispositivo. Riprova quando torni online.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// Stale-while-revalidate for the app's own files
async function handleStatic(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  const network = fetch(event.request).then(async (response) => {
    await putInCache(SHELL_CACHE, event.request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(network.catch(() => null));
    return cached;
  }
  return network;
}

// Cache first for Google Fonts (stylesheet and font files)
async function handleFont(event) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok || response.type === 'opaque') {
    try {
      await cache.put(event.request, response.clone());
    } catch { /* ignore */ }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(handleFont(event));
    return;
  }
  if (url.origin !== self.location.origin) return; // other sites: browser default
  if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith('/api/')) return; // live data: network only
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }
  if (!url.href.startsWith(SCOPE_URL)) return;
  event.respondWith(handleStatic(event));
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
