// market.js network layer with a mocked fetch (no real network). Node has no IndexedDB, so the
// main tests use the memory-only path; a small fake IndexedDB checks the persistence rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { market, mergeHistory } from '../js/market.js';

const API = 'http://test.local';

// Business days starting at `start`
function days(start, n) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// A fake server: every symbol has a full daily history; 5d answers return its last 5 days
function fakeServer({ universe = {}, currencies = {} } = {}) {
  const calls = [];
  const series = (symbol) => {
    if (!universe[symbol]) return null;
    const { dates, close, adj = close, divs = [], splits = [], time = Date.now() } = universe[symbol];
    return { symbol, currency: currencies[symbol] || 'EUR', name: symbol + ' name', type: 'stock', exchange: 'TEST', price: close.at(-1), prev: close.at(-2) ?? null, time, dates, close, adj, divs, splits };
  };
  const tail = (c, k) => ({ ...c, dates: c.dates.slice(-k), close: c.close.slice(-k), adj: c.adj.slice(-k) });
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const handler = async (url) => {
    const u = new URL(url);
    const route = u.pathname.replace(/^\/api\//, '');
    calls.push(route + (u.search ? decodeURIComponent(u.search) : ''));
    if (route === 'health') return reply({ ok: true, sync: false });
    if (route === 'search') return reply({ results: [{ symbol: 'ENEL.MI', name: 'Enel SpA', exchange: 'Milano', type: 'stock', typeDisp: 'Azione', sector: '', industry: '' }] });
    if (route === 'chart') {
      const c = series(u.searchParams.get('symbol'));
      if (!c) return reply({ error: 'Titolo non trovato' }, 404);
      return reply(u.searchParams.get('range') === '5d' ? tail(c, 5) : c);
    }
    if (route === 'quotes') {
      const quotes = {};
      for (const s of u.searchParams.get('symbols').split(',')) {
        const c = series(s);
        if (c) {
          const { symbol: _s, ...rest } = tail(c, 5);
          quotes[s] = rest;
        }
      }
      return reply({ quotes });
    }
    return reply({ error: 'sconosciuto' }, 404);
  };
  globalThis.fetch = (url) => handler(String(url));
  return { calls, universe };
}

function makeSeries(start, n, { base = 100, step = 1, adjFactor = 1 } = {}) {
  const dates = days(start, n);
  const close = dates.map((_, i) => base + i * step);
  return { dates, close, adj: close.map((c) => c * adjFactor) };
}

function counter() {
  const c = { n: 0 };
  c.off = market.subscribe(() => c.n++);
  return c;
}

test('offline: blocked fetch (Claude artifact) ends offline quickly and never throws', async () => {
  globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  const t0 = Date.now();
  const status = await market.init({ apiBase: API });
  assert.equal(status, 'offline');
  assert.equal(market.status, 'offline');
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(await market.search('enel'), []);
  assert.equal(await market.ensureHistory('AAPL'), null);
  assert.equal(await market.lookup('AAPL'), null);
  const r = await market.refresh(['AAPL', 'ENEL.MI']);
  assert.equal(r.offline, true);
  assert.deepEqual(r.failed.sort(), ['AAPL', 'ENEL.MI']);
});

test('offline: a host without the API (HTML 404) is offline', async () => {
  globalThis.fetch = async () => new Response('<h1>Not found</h1>', { status: 404, headers: { 'Content-Type': 'text/html' } });
  assert.equal(await market.init({ apiBase: API }), 'offline');
});

test('offline: health check gives up after 4 seconds', async () => {
  globalThis.fetch = (url, { signal } = {}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  const t0 = Date.now();
  assert.equal(await market.init({ apiBase: API }), 'offline');
  const ms = Date.now() - t0;
  assert.ok(ms >= 3900 && ms < 6000, `took ${ms} ms`);
});

test('init online, URL base without trailing slash, search with cache', async () => {
  const srv = fakeServer();
  assert.equal(await market.init({ apiBase: API + '/' }), 'online');
  assert.deepEqual(market.health, { ok: true, sync: false });
  const r1 = await market.search('  enel ');
  assert.equal(r1[0].symbol, 'ENEL.MI');
  await market.search('ENEL');
  assert.equal(srv.calls.filter((c) => c.startsWith('search')).length, 1);
  assert.deepEqual(await market.search(''), []);
});

test('ensureHistory: downloads 10y once, adds the FX rate, bumps version and notifies once', async () => {
  const srv = fakeServer({
    universe: { 'AAA.US': makeSeries('2026-01-05', 30), 'EURUSD=X': makeSeries('2026-01-05', 30, { base: 1.1, step: 0 }) },
    currencies: { 'AAA.US': 'USD', 'EURUSD=X': 'USD' },
  });
  await market.init({ apiBase: API });
  const v0 = market.version;
  const c = counter();
  const h = await market.ensureHistory('AAA.US');
  c.off();
  assert.equal(h.dates.length, 30);
  assert.equal(h.currency, 'USD');
  assert.ok(h.fullAt > 0 && h.updatedAt > 0);
  assert.equal(market.version, v0 + 1);
  assert.equal(c.n, 1);
  assert.ok(srv.calls.includes('chart?symbol=AAA.US&range=10y&interval=1d'));
  assert.ok(srv.calls.includes('chart?symbol=EURUSD=X&range=10y&interval=1d'));
  assert.ok(market.getHistory('EURUSD=X'));

  // Fresh: no new download, also with force
  const n = srv.calls.length;
  await market.ensureHistory('AAA.US');
  await market.ensureHistory('AAA.US', { force: true });
  assert.equal(srv.calls.length, n);

  // Older than 12 h + force: download again and merge (union by date, new wins)
  const old = market.getHistory('AAA.US');
  old.fullAt = Date.now() - 13 * 3600e3;
  old.dates.unshift('2025-12-31');
  old.close.unshift(99);
  old.adj.unshift(99);
  old.close[old.close.length - 1] = 1; // overwritten by the server value
  srv.universe['AAA.US'] = makeSeries('2026-01-05', 31);
  const h2 = await market.ensureHistory('AAA.US', { force: true });
  assert.equal(h2.dates.length, 32);
  assert.equal(h2.dates[0], '2025-12-31');
  assert.equal(h2.close[0], 99);
  assert.equal(h2.close[30], 129);
  assert.equal(h2.close[31], 130);
  assert.equal(h2.price, 130);
});

test('ensureHistory: unknown symbol → null, demo symbols never hit the network', async () => {
  const srv = fakeServer();
  await market.init({ apiBase: API });
  assert.equal(await market.ensureHistory('NOPE.XX'), null);
  market.inject('demo:ZZZ', { currency: 'EUR', dates: ['2026-01-05'], close: [1], adj: [1], divs: [], synthetic: true });
  const before = srv.calls.length;
  const d = await market.ensureHistory('demo:ZZZ');
  assert.equal(d.close[0], 1);
  assert.equal(await market.ensureHistory('bad symbol!'), null);
  assert.equal(srv.calls.length, before);
  assert.equal(market.isDemoSymbol('demo:ZZZ'), true);
  assert.equal(market.isDemoSymbol('ZZZ'), false);
});

test('refresh: quotes in batches of 40, new symbols get 10y, FX added, one version bump and one notify', async () => {
  const universe = {};
  const currencies = {};
  const held = [];
  for (let i = 0; i < 45; i++) {
    const s = `S${i}.TST`;
    held.push(s);
    universe[s] = makeSeries('2026-02-02', 25, { base: 50 + i });
    currencies[s] = i === 0 ? 'GBP' : 'EUR';
  }
  universe['NEW1.TST'] = makeSeries('2026-02-02', 25, { base: 10 });
  universe['NEW2.TST'] = makeSeries('2026-02-02', 25, { base: 20 });
  universe['EURGBP=X'] = makeSeries('2026-02-02', 25, { base: 0.85, step: 0 });
  currencies['EURGBP=X'] = 'GBP';
  const srv = fakeServer({ universe, currencies });
  await market.init({ apiBase: API });
  // We already hold the first 22 days of each held symbol
  for (const s of held) {
    const full = universe[s];
    market.inject(s, { currency: currencies[s], dates: full.dates.slice(0, 22), close: full.close.slice(0, 22), adj: full.adj.slice(0, 22), divs: [], price: full.close[21], time: 1 }, { persist: true });
  }
  market.lastRefresh = 0;
  srv.calls.length = 0;
  const v0 = market.version;
  const c = counter();
  const progress = [];
  const r = await market.refresh([...held, 'NEW1.TST', 'NEW2.TST', 'MISSING.TST', 'demo:X', 'bad sym'], { onProgress: (done, total) => progress.push([done, total]) });
  c.off();
  assert.equal(market.version, v0 + 1);
  assert.equal(c.n, 1);
  assert.ok(market.lastRefresh > 0);
  const quoteCalls = srv.calls.filter((x) => x.startsWith('quotes'));
  assert.equal(quoteCalls.length, 2);
  assert.equal(quoteCalls[0].split('=')[1].split(',').length, 40);
  assert.equal(quoteCalls[1].split('=')[1].split(',').length, 5);
  for (const s of ['NEW1.TST', 'NEW2.TST', 'MISSING.TST', 'EURGBP=X']) assert.ok(srv.calls.includes(`chart?symbol=${s}&range=10y&interval=1d`), s);
  assert.equal(r.updated.length, 48); // 45 held + 2 new + FX
  assert.deepEqual(r.failed.sort(), ['MISSING.TST', 'bad sym']);
  const h0 = market.getHistory('S0.TST');
  assert.equal(h0.dates.length, 25);
  assert.equal(h0.close.at(-1), universe['S0.TST'].close.at(-1));
  assert.equal(h0.price, universe['S0.TST'].close.at(-1));
  assert.equal(market.getHistory('NEW1.TST').dates.length, 25);
  assert.ok(market.getHistory('EURGBP=X'));
  assert.deepEqual(progress.at(-1), [49, 49]);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i][0] >= progress[i - 1][0]);

  // Within 60 s: skipped without network, unless force
  srv.calls.length = 0;
  const again = await market.refresh(held);
  assert.equal(again.skipped, true);
  assert.equal(srv.calls.length, 0);
  const forced = await market.refresh(held, { force: true });
  assert.equal(forced.updated.length, 46); // + EURGBP=X
  assert.equal(srv.calls.filter((x) => x.startsWith('quotes')).length, 2);
  assert.equal(srv.calls.filter((x) => x.startsWith('chart')).length, 0);

  // Within 60 s a brand-new symbol is still downloaded
  universe['NEW3.TST'] = makeSeries('2026-02-02', 25);
  srv.calls.length = 0;
  const r3 = await market.refresh([...held, 'NEW3.TST']);
  assert.deepEqual(r3.updated, ['NEW3.TST']);
  assert.deepEqual(srv.calls, ['chart?symbol=NEW3.TST&range=10y&interval=1d']);
});

test('refresh: a gap since the last stored day or a split triggers a full download', async () => {
  const universe = { 'GAP.TST': makeSeries('2026-03-02', 30), 'SPL.TST': makeSeries('2026-03-02', 30, { base: 400 }) };
  const srv = fakeServer({ universe });
  await market.init({ apiBase: API });
  const gap = universe['GAP.TST'];
  market.inject('GAP.TST', { currency: 'EUR', dates: gap.dates.slice(0, 10), close: gap.close.slice(0, 10), adj: gap.adj.slice(0, 10), divs: [] });
  // Stored before a 4:1 split: old closes are 4× the new split-adjusted ones
  const spl = universe['SPL.TST'];
  market.inject('SPL.TST', { currency: 'EUR', dates: spl.dates.slice(0, 28), close: spl.close.slice(0, 28).map((x) => x * 4), adj: spl.adj.slice(0, 28).map((x) => x * 4), divs: [] });
  market.lastRefresh = 0;
  srv.calls.length = 0;
  const r = await market.refresh(['GAP.TST', 'SPL.TST']);
  assert.deepEqual(r.updated.sort(), ['GAP.TST', 'SPL.TST']);
  assert.ok(srv.calls.includes('chart?symbol=GAP.TST&range=10y&interval=1d'));
  assert.ok(srv.calls.includes('chart?symbol=SPL.TST&range=10y&interval=1d'));
  assert.equal(market.getHistory('GAP.TST').dates.length, 30);
  assert.deepEqual(market.getHistory('SPL.TST').close, spl.close);
});

test('mergeHistory: union by date, new wins, old adjusted closes rebased on a new dividend', () => {
  const old = { symbol: 'X', dates: ['2026-01-01', '2026-01-02', '2026-01-05'], close: [10, 11, 12], adj: [10, 11, 12], divs: [['2025-06-01', 0.1]], price: 12, prev: 11, time: 1000, fullAt: 5 };
  // A 1-unit dividend went ex on 01-06: the provider now reports adj = close × 0.9 before it
  const inc = { currency: 'EUR', name: 'X', type: 'etf', exchange: 'T', dates: ['2026-01-05', '2026-01-06'], close: [12.5, 11.5], adj: [11.25, 11.5], divs: [['2026-01-06', 1]], splits: [], price: 11.6, prev: 12.5, time: 2000 };
  const m = mergeHistory(old, inc, { symbol: 'X', now: 3000 });
  assert.deepEqual(m.dates, ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06']);
  assert.deepEqual(m.close, [10, 11, 12.5, 11.5]);
  assert.ok(Math.abs(m.adj[0] - 9) < 1e-9 && Math.abs(m.adj[1] - 9.9) < 1e-9);
  assert.deepEqual(m.adj.slice(2), [11.25, 11.5]);
  assert.deepEqual(m.divs, [['2025-06-01', 0.1], ['2026-01-06', 1]]);
  assert.equal(m.price, 11.6);
  assert.equal(m.time, 2000);
  assert.equal(m.fullAt, 5);
  assert.equal(m.updatedAt, 3000);
  assert.equal(m.type, 'etf');

  // An older answer (edge-cached) keeps the fresher last bar and quote
  const stale = { ...inc, dates: ['2026-01-06'], close: [11], adj: [11], divs: [], time: 1500 };
  const m2 = mergeHistory(m, stale, { symbol: 'X', now: 4000, full: true });
  assert.equal(m2.close.at(-1), 11.5);
  assert.equal(m2.price, 11.6);
  assert.equal(m2.fullAt, 4000);

  // A synthetic (demo) history is replaced, never merged
  const m3 = mergeHistory({ ...old, synthetic: true }, inc, { symbol: 'X', now: 1 });
  assert.deepEqual(m3.dates, inc.dates);
});

test('lookup: meta from a 5-day chart', async () => {
  fakeServer({ universe: { 'LK.TST': makeSeries('2026-01-05', 20, { base: 7 }) }, currencies: { 'LK.TST': 'GBP' } });
  await market.init({ apiBase: API });
  const m = await market.lookup('LK.TST');
  assert.equal(m.symbol, 'LK.TST');
  assert.equal(m.currency, 'GBP');
  assert.equal(m.price, 26);
  assert.equal(m.prev, 25);
  assert.equal(m.name, 'LK.TST name');
  assert.equal(await market.lookup('UNKNOWN.TST'), null);
});

test('clearCache: forgets downloaded prices, keeps demo data', async () => {
  fakeServer({ universe: { 'CC.TST': makeSeries('2026-01-05', 10) } });
  await market.init({ apiBase: API });
  await market.ensureHistory('CC.TST');
  market.inject('demo:CC.TST', { currency: 'EUR', dates: ['2026-01-05'], close: [1], adj: [1], divs: [], synthetic: true });
  const v0 = market.version;
  await market.clearCache();
  assert.equal(market.getHistory('CC.TST'), null);
  assert.ok(market.getHistory('demo:CC.TST'));
  assert.equal(market.lastRefresh, 0);
  assert.ok(market.version > v0);
});

/* ---------- Persistence with a fake IndexedDB ---------- */
function fakeIndexedDB(initial = []) {
  const data = new Map(initial.map((r) => [r.symbol, structuredClone(r)]));
  const writes = [];
  let created = initial.length > 0;
  const later = (fn) => setTimeout(fn, 0);
  const makeDb = () => ({
    objectStoreNames: { contains: (n) => n === 'histories' && created },
    createObjectStore() {
      created = true;
      return {};
    },
    close() {},
    transaction(_name, mode) {
      let aborted = false;
      const tx = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        abort() {
          aborted = true;
          later(() => tx.onabort && tx.onabort());
        },
        objectStore: () => ({
          getAll() {
            const req = { result: undefined };
            later(() => {
              req.result = [...data.values()].map((r) => structuredClone(r));
            });
            return req;
          },
          put(v) {
            if (mode !== 'readwrite') throw new Error('ReadOnlyError');
            writes.push(v.symbol);
            data.set(v.symbol, structuredClone(v));
            return { result: v.symbol };
          },
          clear() {
            data.clear();
            return { result: undefined };
          },
        }),
      };
      later(() => later(() => !aborted && tx.oncomplete && tx.oncomplete()));
      return tx;
    },
  });
  return {
    data,
    writes,
    open() {
      const req = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      later(() => {
        req.result = makeDb();
        if (!created && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('IndexedDB: loads stored histories once, never writes demo or memory-only histories', async () => {
  const stored = { symbol: 'OLD.TST', currency: 'EUR', dates: ['2026-01-05'], close: [5], adj: [5], divs: [], updatedAt: 1, fullAt: 1 };
  const idb = fakeIndexedDB([stored, { symbol: 'demo:BAD', dates: ['2026-01-05'], close: [1], adj: [1] }]);
  globalThis.indexedDB = idb;
  try {
    // A fresh module instance, so init opens the (fake) database
    const { market: m } = await import('../js/market.js?idb');
    fakeServer({ universe: { 'NEWDB.TST': makeSeries('2026-01-05', 10) } });
    let notified = 0;
    m.subscribe(() => notified++);
    await m.init({ apiBase: API });
    assert.equal(m.getHistory('OLD.TST').close[0], 5);
    assert.equal(m.getHistory('demo:BAD'), null);
    assert.equal(m.version, 1);
    assert.equal(notified, 2); // loaded data, then status online

    m.inject('demo:AAA', { currency: 'EUR', dates: ['2026-01-05'], close: [1], adj: [1], divs: [], synthetic: true }, { persist: true });
    m.inject('MEM.TST', { currency: 'EUR', dates: ['2026-01-05'], close: [1], adj: [1], divs: [] });
    m.inject('KEEP.TST', { currency: 'EUR', dates: ['2026-01-05'], close: [2], adj: [2], divs: [] }, { persist: true });
    await m.ensureHistory('NEWDB.TST');
    await settle();
    assert.deepEqual([...idb.writes].sort(), ['KEEP.TST', 'NEWDB.TST']);
    assert.equal(idb.data.get('NEWDB.TST').dates.length, 10);

    await m.clearCache();
    assert.equal(idb.data.size, 0);
    assert.ok(m.getHistory('demo:AAA'));
    assert.equal(m.getHistory('KEEP.TST'), null);
  } finally {
    delete globalThis.indexedDB;
  }
});
