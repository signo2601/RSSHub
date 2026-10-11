// Gruzzolo service worker: the app installed on the iPhone opens and works with no connection.
// - Install: every file the app loads (APP_FILES) is saved in a versioned cache, all or nothing:
//   a partial copy would break offline use, so a failed install is simply retried at the next start
//   (the previous version keeps working meanwhile).
// - App page and files (html, css, js, fonts, icons): answered at once from the cache and refreshed
//   in the background, so a new version arrives at the following start. Offline, any page of the
//   app falls back to the cached index.html.
// - /api/* (public market data): always from the network, never cached here (market.js keeps the
//   prices it downloaded in IndexedDB). Other sites are not handled: the app contacts none.
// Bump VERSION whenever APP_FILES or the caching rules change. tests/offline.test.mjs checks that
// APP_FILES lists exactly the files that index.html, the stylesheets and the JS imports load.
const VERSION = 'gruzzolo-v2.1.0';
const CACHE = `${VERSION}-app`;
const CACHE_PREFIX = 'gruzzolo-';

const APP_FILES = [
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
  './fonts/manrope-latin.woff2',
  './fonts/manrope-latin-ext.woff2',
  './fonts/bricolage-grotesque-latin.woff2',
  './fonts/bricolage-grotesque-latin-ext.woff2',
  './js/main.js',
  './js/app.js',
  './js/registry.js',
  './js/state.js',
  './js/util.js',
  './js/store.js',
  './js/market.js',
  './js/catalog.js',
  './js/engine.js',
  './js/charts.js',
  './js/demo.js',
  './js/metrics.js',
  './js/markowitz.js',
  './js/income.js',
  './js/costs.js',
  './js/info.js',
  './js/importer.js',
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
const SHELL_URLS = new Set([SCOPE_URL, new URL('./index.html', self.location).href]);
const API_PREFIX = new URL('./api/', self.location).pathname;

// A response that followed a redirect (Cloudflare turns /index.html into /) cannot answer a
// navigation: store a clean copy
async function cleanCopy(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function download(path) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (response.ok) return cleanCopy(response);
      lastError = new Error(`${path}: HTTP ${response.status}`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await Promise.all(APP_FILES.map(async (path) => cache.put(path, await download(path))));
    } catch (e) {
      await caches.delete(CACHE); // never keep half a copy of the app
      throw e;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Remove older versions (and the Google Fonts cache of version 2.0)
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function refresh(cache, request, key) {
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    try {
      await cache.put(key, await cleanCopy(response.clone()));
    } catch { /* storage full: the cached copy stays */ }
  }
  return response;
}

async function cachedShell(cache) {
  return (await cache.match('./')) || (await cache.match('./index.html')) || null;
}

const OFFLINE_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gruzzolo</title>'
  + '<p style="font-family:system-ui;padding:24px">Sei offline e Gruzzolo non è ancora salvata su questo telefono. Aprila una volta con la connessione: da quel momento funziona anche offline.</p>';

// The app page: cached copy at once (fast start, works offline), refreshed in the background.
// Other pages of the site: network first, the app page when offline.
async function handleNavigation(event) {
  const cache = await caches.open(CACHE);
  const url = new URL(event.request.url);
  const isShell = SHELL_URLS.has(url.origin + url.pathname);
  const cached = await cachedShell(cache);
  if (isShell && cached) {
    event.waitUntil(refresh(cache, event.request, './').catch(() => null));
    return cached;
  }
  try {
    return isShell ? await refresh(cache, event.request, './') : await fetch(event.request);
  } catch {
    if (cached) return cached;
    return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

// App files: cached copy at once, refreshed in the background (stale-while-revalidate)
async function handleStatic(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  const network = refresh(cache, event.request, event.request);
  if (cached) {
    event.waitUntil(network.catch(() => null));
    return cached;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // other sites (a custom price server): browser default
  if (url.pathname.startsWith(API_PREFIX) || url.pathname.startsWith('/api/')) return; // live market data: network only
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
