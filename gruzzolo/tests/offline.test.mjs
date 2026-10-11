// Offline iPhone app: the service worker saves every file the app loads, the app contacts no
// other site, the service worker answers offline, files are shared with the iPhone share sheet,
// and the storage helpers never throw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { saveFile, storageStatus, requestPersistentStorage, isStandalone } from '../js/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const SW_SOURCE = read('sw.js');

/* ---------- What the app loads ---------- */
// Every file reached from index.html: <link>/<script> targets, manifest icons, url() in the
// stylesheets, static and dynamic imports in the modules. Returns project-relative paths.
function appGraph() {
  const seen = new Set();
  const external = [];
  const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
  const add = (abs, from) => {
    const r = rel(abs);
    if (seen.has(r)) return false;
    assert.ok(existsSync(abs), `${r} (used by ${from}) does not exist`);
    seen.add(r);
    return true;
  };
  const walkJs = (abs) => {
    const src = readFileSync(abs, 'utf8');
    const re = /(?:^|[;\n])\s*(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const m of src.matchAll(re)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('.')) {
        external.push(`${rel(abs)} → ${spec}`);
        continue;
      }
      const target = path.resolve(path.dirname(abs), spec);
      if (add(target, rel(abs))) walkJs(target);
    }
  };
  const walkCss = (abs) => {
    const src = readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      if (/^(data:|#)/.test(m[1])) continue;
      if (/^[a-z]+:/i.test(m[1])) external.push(`${rel(abs)} → ${m[1]}`);
      else add(path.resolve(path.dirname(abs), m[1].split(/[?#]/)[0]), rel(abs));
    }
    for (const m of src.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)/g)) {
      if (/^[a-z]+:/i.test(m[1])) external.push(`${rel(abs)} → ${m[1]}`);
      else {
        const target = path.resolve(path.dirname(abs), m[1]);
        if (add(target, rel(abs))) walkCss(target);
      }
    }
  };
  const html = read('index.html');
  add(path.join(ROOT, 'index.html'), 'root');
  for (const m of html.matchAll(/<(?:link|script)\b[^>]*?\s(?:href|src)="([^"]+)"[^>]*>/gi)) {
    const ref = m[1];
    if (/^[a-z]+:/i.test(ref) || ref.startsWith('//')) {
      external.push(`index.html → ${ref}`);
      continue;
    }
    const abs = path.join(ROOT, ref.split(/[?#]/)[0]);
    if (!add(abs, 'index.html')) continue;
    if (abs.endsWith('.css')) walkCss(abs);
    else if (abs.endsWith('.js')) walkJs(abs);
    else if (abs.endsWith('.webmanifest')) {
      const man = JSON.parse(readFileSync(abs, 'utf8'));
      for (const i of [...(man.icons || []), ...(man.shortcuts || []).flatMap((s) => s.icons || [])]) add(path.join(ROOT, i.src), 'manifest.webmanifest');
    }
  }
  return { files: [...seen], external };
}

function swAppFiles() {
  const m = SW_SOURCE.match(/const APP_FILES = \[([\s\S]*?)\];/);
  assert.ok(m, 'APP_FILES list in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('sw.js precaches exactly the files the app loads, and nothing else', () => {
  const { files } = appGraph();
  const listed = swAppFiles();
  assert.equal(new Set(listed).size, listed.length, 'no duplicates');
  assert.deepEqual(listed.slice(0, 2), ['./', './index.html'], 'the app page first');
  const expected = new Set(['./', ...files.map((f) => './' + f)]);
  const missing = [...expected].filter((f) => !listed.includes(f));
  const extra = listed.filter((f) => !expected.has(f));
  assert.deepEqual(missing, [], `add to APP_FILES in sw.js (and bump VERSION): ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `not loaded by the app, remove from APP_FILES: ${extra.join(', ')}`);
  for (const f of listed.slice(1)) assert.ok(existsSync(path.join(ROOT, f)), `${f} exists`);
  assert.ok(files.includes('fonts/manrope-latin.woff2') && files.includes('fonts/bricolage-grotesque-latin.woff2'), 'self-hosted fonts are part of the app');
  assert.ok(!files.some((f) => /sync/.test(f)), 'no sync module');
  assert.doesNotMatch(SW_SOURCE, /gruzzolo-v2\.0\.0'/, 'VERSION bumped after removing sync and Google Fonts');
});

test('the app loads nothing from other sites (no Google Fonts, no CDN)', () => {
  const { external } = appGraph();
  assert.deepEqual(external, []);
  const html = read('index.html');
  assert.doesNotMatch(html, /https?:\/\//, 'index.html has no absolute URL');
  assert.doesNotMatch(SW_SOURCE, /fonts\.(googleapis|gstatic)\.com/);
  for (const css of ['css/app.css', 'css/portfolio.css', 'css/report.css', 'css/report2.css', 'css/extra.css']) {
    assert.doesNotMatch(read(css), /@import|url\(\s*['"]?https?:/, css);
  }
  // iPhone home screen app: meta tags, icon, standalone manifest without desktop shortcuts
  for (const meta of ['apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style', 'apple-mobile-web-app-title']) assert.match(html, new RegExp(`name="${meta}"`));
  assert.match(html, /rel="apple-touch-icon" href="icon-180.png"/);
  const man = JSON.parse(read('manifest.webmanifest'));
  assert.equal(man.display, 'standalone');
  assert.equal(man.short_name, 'Gruzzolo');
  assert.equal(man.shortcuts, undefined);
  assert.ok(man.icons.some((i) => i.sizes === '512x512'));
  // Licence of the bundled fonts
  assert.match(read('fonts/OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(read('fonts/OFL.txt'), /Manrope Project Authors/);
  assert.match(read('fonts/OFL.txt'), /Bricolage Grotesque Project Authors/);
});

test('no sync and no cloud storage left in the app code or the server', () => {
  const { files } = appGraph();
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    assert.doesNotMatch(src, /\/api\/sync|['"`]\/sync\//, f);
    assert.doesNotMatch(src, /\.use\(\s*['"](db|user)['"]\s*\)/, `${f} must not use the Claude artifact database`);
  }
  const server = read('functions/api/[[path]].js');
  assert.doesNotMatch(server, /GRUZZOLO_KV|handleSync|\bkv\b/i);
  assert.doesNotMatch(read('dev/server.mjs'), /GRUZZOLO_KV|\.kv\.json/);
});

/* ---------- Service worker behaviour (run in a VM with a fake Cache API and network) ---------- */
const ORIGIN = 'https://gruzzolo.test';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

function swHarness({ files = {}, missing = [] } = {}) {
  const net = { offline: false, calls: [], overrides: { ...files } };
  const keyOf = (req, ignoreSearch = false) => {
    const u = new URL(typeof req === 'string' ? req : req.url, ORIGIN + '/');
    return ignoreSearch ? u.origin + u.pathname : u.href;
  };
  const stores = new Map();
  const makeCache = () => {
    const map = new Map();
    return {
      map,
      async put(req, res) {
        map.set(keyOf(req), { body: await res.clone().arrayBuffer(), status: res.status, headers: [...res.headers] });
      },
      async match(req, opts = {}) {
        const k = keyOf(req, opts.ignoreSearch);
        const hit = opts.ignoreSearch ? [...map.entries()].find(([key]) => keyOf(key, true) === k)?.[1] : map.get(k);
        return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
      },
    };
  };
  const caches = {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, makeCache());
      return stores.get(name);
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  const fetchFn = async (req) => {
    const url = new URL(typeof req === 'string' ? req : req.url, ORIGIN + '/');
    net.calls.push(url.href);
    if (net.offline) throw new TypeError('Failed to fetch');
    if (url.origin !== ORIGIN) return new Response('external', { status: 200 });
    let rel = decodeURIComponent(url.pathname).slice(1) || 'index.html';
    if (missing.includes(rel)) return new Response('Not found', { status: 404 });
    let body = net.overrides[rel];
    if (body === undefined) {
      const abs = path.join(ROOT, rel);
      if (!existsSync(abs)) return new Response('Not found', { status: 404 });
      body = readFileSync(abs);
    }
    const res = new Response(body, { status: 200, headers: { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' } });
    Object.defineProperty(res, 'type', { value: 'basic' });
    return res;
  };
  const listeners = {};
  const self = {
    location: new URL(ORIGIN + '/sw.js'),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  class SwRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' ? new URL(input, ORIGIN + '/').href : input, init);
    }
  }
  const context = vm.createContext({ self, caches, fetch: fetchFn, Request: SwRequest, Response, Headers, URL, Blob, Set, Map, Promise, setTimeout, clearTimeout, console });
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });
  const lifecycle = async (type) => {
    const waits = [];
    listeners[type]({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  // Returns { handled, response, settle } like the browser would see it
  const request = async (url, { mode = 'cors' } = {}) => {
    const waits = [];
    let responded = null;
    const req = { url: new URL(url, ORIGIN + '/').href, method: 'GET', mode };
    listeners.fetch({ request: req, respondWith: (p) => { responded = p; }, waitUntil: (p) => waits.push(p) });
    const response = responded ? await responded : null;
    return { handled: Boolean(responded), response, settle: () => Promise.all(waits) };
  };
  return { net, caches, lifecycle, request };
}

const cacheName = () => SW_SOURCE.match(/const VERSION = '([^']+)'/)[1] + '-app';

test('service worker: install saves every app file; activate removes old versions and the Google Fonts cache', async () => {
  const sw = swHarness();
  await sw.caches.open('gruzzolo-v2.0.0-shell');
  await sw.caches.open('gruzzolo-fonts-v1');
  await sw.caches.open('another-app');
  await sw.lifecycle('install');
  const cache = sw.caches.stores.get(cacheName());
  const listed = swAppFiles();
  assert.equal(cache.map.size, listed.length);
  for (const f of listed) assert.ok(cache.map.has(new URL(f, ORIGIN + '/').href), f);
  assert.ok(sw.net.calls.every((u) => u.startsWith(ORIGIN + '/')), 'only same-origin downloads');
  await sw.lifecycle('activate');
  assert.deepEqual((await sw.caches.keys()).sort(), ['another-app', cacheName()].sort());
});

test('service worker: a file that cannot be downloaded fails the install and leaves no half copy', async () => {
  const sw = swHarness({ missing: ['js/engine.js'] });
  await assert.rejects(sw.lifecycle('install'), /engine\.js/);
  assert.equal(sw.caches.stores.has(cacheName()), false);
});

test('service worker offline: the app page, every file and the fonts come from the cache; /api and other sites are not touched', async () => {
  const sw = swHarness();
  await sw.lifecycle('install');
  await sw.lifecycle('activate');
  sw.net.offline = true;
  const indexHtml = read('index.html');
  for (const url of ['/', '/?action=add', '/index.html']) {
    const r = await sw.request(url, { mode: 'navigate' });
    assert.ok(r.handled, url);
    assert.equal(r.response.status, 200, url);
    assert.equal(await r.response.text(), indexHtml, url);
    await r.settle(); // the background refresh fails quietly
  }
  const other = await sw.request('/una/pagina', { mode: 'navigate' });
  assert.equal(await other.response.text(), indexHtml, 'unknown pages fall back to the app');
  for (const f of ['js/main.js', 'js/views/more.js', 'css/app.css', 'fonts/manrope-latin.woff2', 'icon-180.png']) {
    const r = await sw.request('/' + f + '?v=2');
    assert.ok(r.handled, f);
    assert.deepEqual(Buffer.from(await r.response.arrayBuffer()), readFileSync(path.join(ROOT, f)), f);
    await r.settle();
  }
  for (const url of ['/api/quotes?symbols=ENEL.MI', '/api/health', 'https://fonts.googleapis.com/css2?family=Manrope', 'https://query1.finance.yahoo.com/v8/finance/chart/X']) {
    assert.equal((await sw.request(url)).handled, false, url);
  }
});

test('service worker online: cached copy first, refreshed in the background for the next start', async () => {
  const sw = swHarness();
  await sw.lifecycle('install');
  sw.net.overrides['js/main.js'] = '// new version';
  const first = await sw.request('/js/main.js');
  assert.equal(await first.response.text(), read('js/main.js'), 'old copy answers at once');
  await first.settle();
  const second = await sw.request('/js/main.js');
  assert.equal(await second.response.text(), '// new version');
  await second.settle();
  sw.net.overrides['index.html'] = '<!doctype html><title>v3</title>';
  const nav = await sw.request('/', { mode: 'navigate' });
  assert.equal(await nav.response.text(), read('index.html'));
  await nav.settle();
  assert.equal(await (await sw.request('/', { mode: 'navigate' })).response.text(), '<!doctype html><title>v3</title>');
});

test('service worker: offline before the first install shows a readable Italian page', async () => {
  const sw = swHarness();
  sw.net.offline = true;
  const r = await sw.request('/', { mode: 'navigate' });
  assert.equal(r.response.status, 503);
  assert.match(await r.response.text(), /Sei offline/);
});

/* ---------- Files: iPhone share sheet ---------- */
function withBrowser({ coarse = true, canShare = true, share = async () => {}, claude = null } = {}, fn) {
  const saved = {};
  const set = (key, value) => {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const shared = [];
  const downloads = [];
  set('navigator', {
    canShare: canShare === null ? undefined : (data) => canShare && Array.isArray(data.files) && data.files.every((f) => f instanceof File),
    share: async (data) => {
      shared.push(data);
      return share(data);
    },
  });
  set('matchMedia', (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }));
  set('window', claude ? { claude } : {});
  set('document', {
    createElement: () => ({ click() { downloads.push({ name: this.download, href: this.href }); }, remove() {} }),
    body: { append() {} },
  });
  const restore = () => {
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  };
  return Promise.resolve()
    .then(() => fn({ shared, downloads }))
    .finally(restore);
}

test('saveFile on iPhone: share sheet with the file ("Salva su File"), no download', async () => {
  await withBrowser({}, async ({ shared, downloads }) => {
    const ok = await saveFile('gruzzolo-backup-2026-10-11.json', '{"v":2}', 'application/json');
    assert.equal(ok, true);
    assert.equal(shared.length, 1);
    const [file] = shared[0].files;
    assert.equal(file.name, 'gruzzolo-backup-2026-10-11.json');
    assert.equal(file.type, 'application/json');
    assert.equal(await file.text(), '{"v":2}');
    assert.equal(shared[0].title, 'gruzzolo-backup-2026-10-11.json');
    assert.equal(downloads.length, 0);
  });
  // MIME parameters are dropped for the shared file (iOS and Chrome check the plain type)
  await withBrowser({}, async ({ shared }) => {
    await saveFile('t.csv', '﻿a;b', 'text/csv;charset=utf-8');
    assert.equal(shared[0].files[0].type, 'text/csv');
  });
});

test('saveFile: closing the share sheet resolves false silently; other share errors fall back to a download', async () => {
  const abort = () => Promise.reject(Object.assign(new Error('Share canceled'), { name: 'AbortError' }));
  await withBrowser({ share: abort }, async ({ downloads }) => {
    assert.equal(await saveFile('b.json', '{}', 'application/json'), false);
    assert.equal(downloads.length, 0);
  });
  const denied = () => Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
  await withBrowser({ share: denied }, async ({ downloads }) => {
    assert.equal(await saveFile('b.json', '{}', 'application/json'), true);
    assert.deepEqual(downloads.map((d) => d.name), ['b.json']);
  });
});

test('saveFile without file sharing: desktop download, or the Claude preview downloads capability', async () => {
  // Desktop (fine pointer): normal download even where sharing exists
  await withBrowser({ coarse: false }, async ({ shared, downloads }) => {
    assert.equal(await saveFile('a.csv', 'x', 'text/csv'), true);
    assert.equal(shared.length, 0);
    assert.equal(downloads.length, 1);
  });
  // Phone browser that cannot share files
  await withBrowser({ canShare: false }, async ({ shared, downloads }) => {
    assert.equal(await saveFile('a.csv', 'x', 'text/csv'), true);
    assert.equal(shared.length, 0);
    assert.equal(downloads.length, 1);
  });
  // Claude artifact preview: the host saves the file
  const saved = [];
  const claude = { use: async (name) => (name === 'downloads' ? { save: async (f) => saved.push(f) } : null) };
  await withBrowser({ canShare: null, claude }, async ({ downloads }) => {
    assert.equal(await saveFile('a.json', '{}', 'application/json'), true);
    assert.deepEqual(saved, [{ filename: 'a.json', data: '{}' }]);
    assert.equal(downloads.length, 0);
  });
  const declined = { use: async () => ({ save: async () => Promise.reject(Object.assign(new Error('no'), { code: 'declined' })) }) };
  await withBrowser({ canShare: null, claude: declined }, async () => {
    assert.equal(await saveFile('a.json', '{}'), false);
  });
});

/* ---------- Device storage ---------- */
function withStorage(storage, fn, { standalone = false } = {}) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { storage, standalone }, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
  });
}

test('storageStatus: values when supported, nulls when missing or failing, never throws', async () => {
  await withStorage({ persisted: async () => true, estimate: async () => ({ usage: 1234, quota: 5e9 }) }, async () => {
    assert.deepEqual(await storageStatus(), { persisted: true, usage: 1234, quota: 5e9, standalone: false });
  });
  await withStorage(undefined, async () => {
    assert.deepEqual(await storageStatus(), { persisted: null, usage: null, quota: null, standalone: false });
  });
  await withStorage({ persisted: () => Promise.reject(new Error('x')), estimate: () => { throw new Error('y'); } }, async () => {
    assert.deepEqual(await storageStatus(), { persisted: null, usage: null, quota: null, standalone: false });
  });
  await withStorage({ persisted: async () => false, estimate: async () => ({ usage: 10 }) }, async () => {
    assert.deepEqual(await storageStatus(), { persisted: false, usage: 10, quota: null, standalone: true });
    assert.equal(isStandalone(), true);
  }, { standalone: true });
});

test('requestPersistentStorage: asks only when not yet granted, null when unsupported or failing', async () => {
  let asked = 0;
  await withStorage({ persisted: async () => true, persist: async () => { asked++; return true; } }, async () => {
    assert.equal(await requestPersistentStorage(), true);
    assert.equal(asked, 0);
  });
  await withStorage({ persisted: async () => false, persist: async () => { asked++; return false; } }, async () => {
    assert.equal(await requestPersistentStorage(), false);
    assert.equal(asked, 1);
  });
  await withStorage({ persist: async () => true }, async () => {
    assert.equal(await requestPersistentStorage(), true);
  });
  await withStorage({ persisted: async () => false, persist: () => Promise.reject(new Error('denied')) }, async () => {
    assert.equal(await requestPersistentStorage(), null);
  });
  await withStorage(undefined, async () => {
    assert.equal(await requestPersistentStorage(), null);
  });
  // main.js asks once at start, without waiting for the answer
  const main = read('js/main.js');
  assert.match(main, /requestPersistentStorage\(\)\.catch\(/);
  assert.doesNotMatch(main, /await requestPersistentStorage/);
});
