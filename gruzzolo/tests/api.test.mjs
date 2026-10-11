// Server function tests: input validation, read-only routes (no sync, no storage), Yahoo payload
// conversion with a mocked fetch, edge cache, and live checks against Yahoo Finance (skipped when unreachable).
// Behind an HTTPS proxy run with: NODE_USE_ENV_PROXY=1 node --test tests/api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/[[path]].js';

const realFetch = globalThis.fetch;

async function call(path, { method = 'GET', body, env = {}, headers } = {}) {
  const request = new Request('https://gruzzolo.test' + path, { method, body, headers });
  const res = await onRequest({ request, env });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

// Is Yahoo Finance reachable from here?
async function probeYahoo() {
  try {
    const res = await realFetch('https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    return res.status === 200 || res.status === 429 ? true : `Yahoo ha risposto ${res.status}`;
  } catch (e) {
    const hint = process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY ? ' (dietro proxy: imposta NODE_USE_ENV_PROXY=1)' : '';
    return `rete non disponibile: ${e.cause ? e.cause.code || e.cause.message : e.message}${hint}`;
  }
}
const probe = await probeYahoo();
const live = probe === true ? {} : { skip: probe };

/* ---------- No network needed ---------- */
test('health, CORS and preflight', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // A storage binding left over from the old sync setup changes nothing
  const withKv = await call('/api/health', { env: { GRUZZOLO_KV: { get: async () => null, put: async () => {} } } });
  assert.deepEqual(withKv.json, { ok: true });
  const pre = await call('/api/quotes', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('input validation → 400 / 404 / 405 with Italian JSON errors', async () => {
  const cases = [
    ['/api/chart?symbol=' + encodeURIComponent('bad symbol'), 400],
    ['/api/chart?symbol=' + 'A'.repeat(33), 400],
    ['/api/chart', 400],
    ['/api/chart?symbol=AAPL&range=7y', 400],
    ['/api/chart?symbol=AAPL&interval=1h', 400],
    ['/api/search?q=', 400],
    ['/api/search?q=' + 'x'.repeat(65), 400],
    ['/api/quotes', 400],
    ['/api/quotes?symbols=' + Array.from({ length: 51 }, (_, i) => 'S' + i).join(','), 400],
    ['/api/quotes?symbols=AAPL,' + encodeURIComponent('<script>'), 400],
    ['/api/nothing', 404],
  ];
  for (const [path, status] of cases) {
    const r = await call(path);
    assert.equal(r.status, status, path);
    assert.equal(typeof r.json.error, 'string', path);
    assert.ok(r.json.error.length > 5, path);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', path);
  }
  const post = await call('/api/chart?symbol=AAPL', { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
});

test('no sync and no storage: /api/sync is gone, writes are refused, nothing reaches a KV', async () => {
  const touched = [];
  const kv = new Proxy({}, { get: (_, k) => async () => { touched.push(String(k)); return null; } });
  const env = { GRUZZOLO_KV: kv };
  const id = 'ab'.repeat(32);
  const blob = JSON.stringify({ updatedAt: 1760000000000, iv: 'aXY=', ct: 'Y2lwaGVy' });
  for (const [path, method, body] of [
    ['/api/sync/' + id, 'GET'],
    ['/api/sync/' + id, 'PUT', blob],
    ['/api/sync/' + id, 'DELETE'],
    ['/api/sync', 'GET'],
    ['/api/health/extra', 'GET'],
    ['/api/chart/AAPL', 'GET'],
    ['/api/constructor', 'GET'],
    ['/api/__proto__', 'GET'],
  ]) {
    const r = await call(path, { method, body, env });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.match(r.json.error, /sconosciuto/, path);
    assert.equal(r.headers.get('access-control-allow-origin'), '*', path);
  }
  // Known routes accept only GET
  for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
    const r = await call('/api/health', { method, body: method === 'DELETE' ? undefined : '{}', env });
    assert.equal(r.status, 405, method);
  }
  assert.deepEqual(touched, [], 'the function never uses a storage binding');
});

/* ---------- Yahoo payload conversion with a mocked upstream ---------- */
// Daily bars stamped at 08:00 London time (07:00 UTC in summer, 08:00 UTC in winter)
const T = (iso, hourUtc) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), hourUtc) / 1000;
function yahooChart() {
  return {
    chart: {
      result: [{
        meta: {
          currency: 'GBp', symbol: 'TEST.L', exchangeName: 'LSE', fullExchangeName: 'LSE', instrumentType: 'EQUITY',
          gmtoffset: 0, exchangeTimezoneName: 'Europe/London', regularMarketPrice: 210.5, regularMarketTime: T('2026-10-08', 15),
          longName: 'Test plc', shortName: 'TEST', chartPreviousClose: 150,
        },
        // Summer bar at 23:00 UTC belongs to the next London day; a duplicate live bar for 10-08
        timestamp: [T('2026-01-02', 8), T('2026-07-01', 23), T('2026-10-05', 7), T('2026-10-06', 7), T('2026-10-07', 7), T('2026-10-08', 7), T('2026-10-08', 15)],
        indicators: {
          quote: [{ close: [150.00000610351562, 190, null, 205.69999694824219, 208, 209, 210.5] }],
          adjclose: [{ adjclose: [140, 185, null, 205.69999694824219, 208, 209, 210.5] }],
        },
        events: { dividends: { b: { amount: 3.5, date: T('2026-07-02', 7) }, a: { amount: 2, date: T('2026-03-05', 8) } }, splits: {} },
      }],
      error: null,
    },
  };
}

function mockYahoo(responder) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return responder(String(url), calls.length);
  };
  return calls;
}
const yjson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('chart conversion: pence → GBP, exchange-local dates, null rows dropped, duplicates merged', async () => {
  mockYahoo(() => yjson(yahooChart()));
  try {
    const r = await call('/api/chart?symbol=TEST.L&range=1y&interval=1d');
    assert.equal(r.status, 200);
    const c = r.json;
    assert.equal(c.symbol, 'TEST.L');
    assert.equal(c.currency, 'GBP');
    assert.equal(c.name, 'Test plc');
    assert.equal(c.type, 'stock');
    assert.equal(c.exchange, 'LSE');
    // 2026-07-01 23:00 UTC is midnight of 07-02 in London (BST), even though meta.gmtoffset is 0 now
    assert.deepEqual(c.dates, ['2026-01-02', '2026-07-02', '2026-10-06', '2026-10-07', '2026-10-08']);
    assert.deepEqual(c.close, [1.5, 1.9, 2.057, 2.08, 2.105]);
    assert.deepEqual(c.adj, [1.4, 1.85, 2.057, 2.08, 2.105]);
    assert.deepEqual(c.divs, [['2026-03-05', 0.02], ['2026-07-02', 0.035]]);
    assert.equal(c.price, 2.105);
    assert.equal(c.prev, 2.08); // second-to-last close (the last bar is today's)
    assert.equal(c.time, T('2026-10-08', 15) * 1000);
    assert.match(r.headers.get('cache-control'), /max-age=43200/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('chart: second Yahoo host after 429, 503 when both refuse, 404 for unknown symbols', async () => {
  try {
    const calls = mockYahoo((url) => (url.startsWith('https://query1.') ? new Response('Too Many Requests', { status: 429 }) : yjson(yahooChart())));
    const ok = await call('/api/chart?symbol=TEST.L&range=5d');
    assert.equal(ok.status, 200);
    assert.ok(calls[1].startsWith('https://query2.finance.yahoo.com/v8/finance/chart/TEST.L?range=5d&interval=1d&events=div,split&includeAdjustedClose=true'));
    assert.match(ok.headers.get('cache-control'), /max-age=300/);

    mockYahoo(() => new Response('Too Many Requests', { status: 429 }));
    const limited = await call('/api/chart?symbol=TEST.L');
    assert.equal(limited.status, 503);
    assert.equal(limited.headers.get('cache-control'), 'no-store');

    mockYahoo(() => Promise.reject(new TypeError('network down')));
    assert.equal((await call('/api/chart?symbol=TEST.L')).status, 502);

    mockYahoo(() => yjson({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 404));
    const missing = await call('/api/chart?symbol=NOPE.L');
    assert.equal(missing.status, 404);
    assert.match(missing.json.error, /NOPE\.L/);

    // Quotes: one unknown symbol does not fail the others
    mockYahoo((url) => (url.includes('/NOPE.L?') ? yjson({ chart: { result: null, error: { code: 'Not Found' } } }, 404) : yjson(yahooChart())));
    const q = await call('/api/quotes?symbols=TEST.L,NOPE.L');
    assert.equal(q.status, 200);
    assert.deepEqual(Object.keys(q.json.quotes), ['TEST.L']);
    assert.ok(q.json.errors['NOPE.L']);
    assert.equal(q.json.quotes['TEST.L'].currency, 'GBP');
    assert.match(q.headers.get('cache-control'), /max-age=60/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('search mapping and edge cache (caches.default)', async () => {
  const store = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        store.set(req.url, res);
      },
    },
  };
  try {
    const calls = mockYahoo(() => yjson({
      quotes: [
        { symbol: 'ENEL.MI', longname: 'Enel SpA', shortname: 'ENEL', exchDisp: 'Milano', quoteType: 'EQUITY', typeDisp: 'Azione', sectorDisp: 'Utenze', industryDisp: 'Servizi', isYahooFinance: true },
        { symbol: 'X1', shortname: 'Hidden', quoteType: 'EQUITY', isYahooFinance: false },
        { shortname: 'No symbol', quoteType: 'EQUITY' },
        { symbol: 'BTC-EUR', shortname: 'Bitcoin EUR', exchDisp: 'CCC', quoteType: 'CRYPTOCURRENCY', typeDisp: 'Criptovaluta', isYahooFinance: true },
      ],
    }));
    const r1 = await call('/api/search?q=Enel');
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.results, [
      { symbol: 'ENEL.MI', name: 'Enel SpA', exchange: 'Milano', type: 'stock', typeDisp: 'Azione', sector: 'Utenze', industry: 'Servizi' },
      { symbol: 'BTC-EUR', name: 'Bitcoin EUR', exchange: 'CCC', type: 'crypto', typeDisp: 'Criptovaluta', sector: '', industry: '' },
    ]);
    assert.match(calls[0], /v1\/finance\/search\?q=Enel&quotesCount=20&newsCount=0&listsCount=0&lang=it-IT&region=IT/);
    assert.match(r1.headers.get('cache-control'), /max-age=3600/);
    const r2 = await call('/api/search?q=enel');
    assert.equal(r2.status, 200);
    assert.equal(calls.length, 1); // served by the edge cache
    assert.deepEqual(r2.json, r1.json);
    // Errors and health answers are never stored in the edge cache
    await call('/api/health');
    await call('/api/nothing');
    assert.deepEqual([...store.keys()], ['https://gruzzolo.test/api/search?q=enel']);
  } finally {
    delete globalThis.caches;
    globalThis.fetch = realFetch;
  }
});

/* ---------- Live Yahoo Finance ---------- */
test('live: search by ISIN IE00BK5BQT80 finds VWCE.DE', live, async () => {
  const r = await call('/api/search?q=IE00BK5BQT80');
  assert.equal(r.status, 200);
  const symbols = r.json.results.map((x) => x.symbol);
  assert.ok(symbols.includes('VWCE.DE'), symbols.join(', '));
  const vwce = r.json.results.find((x) => x.symbol === 'VWCE.DE');
  assert.equal(vwce.type, 'etf');
  assert.match(vwce.name, /Vanguard FTSE All-World/);
});

test('live: search by name', live, async () => {
  const r = await call('/api/search?q=enel');
  assert.equal(r.status, 200);
  assert.ok(r.json.results.some((x) => x.symbol === 'ENEL.MI'));
});

test('live: chart VWCE.DE 1y', live, async () => {
  const r = await call('/api/chart?symbol=VWCE.DE&range=1y&interval=1d');
  assert.equal(r.status, 200);
  const c = r.json;
  assert.equal(c.currency, 'EUR');
  assert.equal(c.type, 'etf');
  assert.ok(c.dates.length > 200, `${c.dates.length} dates`);
  assert.equal(c.close.length, c.dates.length);
  assert.equal(c.adj.length, c.dates.length);
  for (let i = 1; i < c.dates.length; i++) assert.ok(c.dates[i] > c.dates[i - 1]);
  assert.ok(c.dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
  assert.ok(c.close.every((x) => x > 50 && x < 1000));
  assert.ok(c.price > 0 && c.prev > 0 && c.time > 0);
});

test('live: dividends on a 2y chart (ENEL.MI)', live, async () => {
  const r = await call('/api/chart?symbol=ENEL.MI&range=2y&interval=1d');
  assert.equal(r.status, 200);
  assert.ok(r.json.divs.length >= 2);
  for (let i = 0; i < r.json.divs.length; i++) {
    const [d, amount] = r.json.divs[i];
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(amount > 0 && amount < 2);
    if (i) assert.ok(d > r.json.divs[i - 1][0]);
  }
});

test('live: quotes for a stock, an Italian stock, a currency and a crypto', live, async () => {
  const r = await call('/api/quotes?symbols=AAPL,ENEL.MI,EURUSD=X,BTC-EUR');
  assert.equal(r.status, 200);
  const q = r.json.quotes;
  assert.deepEqual(Object.keys(q).sort(), ['AAPL', 'BTC-EUR', 'ENEL.MI', 'EURUSD=X']);
  assert.equal(q.AAPL.currency, 'USD');
  assert.equal(q['ENEL.MI'].currency, 'EUR');
  assert.equal(q['EURUSD=X'].currency, 'USD');
  assert.equal(q['BTC-EUR'].currency, 'EUR');
  assert.ok(q['EURUSD=X'].price > 0.7 && q['EURUSD=X'].price < 1.7);
  assert.equal(q['BTC-EUR'].type, 'crypto');
  for (const x of Object.values(q)) {
    assert.ok(x.dates.length >= 1 && x.dates.length <= 8);
    assert.ok(x.price > 0 && x.prev > 0);
  }
});

test('live: London prices in pence come back in GBP (LLOY.L)', live, async () => {
  const r = await call('/api/chart?symbol=LLOY.L&range=5d');
  assert.equal(r.status, 200);
  assert.equal(r.json.currency, 'GBP');
  assert.ok(r.json.price > 0.1 && r.json.price < 10, `price ${r.json.price}`);
  assert.ok(r.json.close.every((x) => x > 0.1 && x < 10));
});

test('live: unknown symbol → 404', live, async () => {
  const r = await call('/api/chart?symbol=ZZZNOTREAL123.MI&range=5d');
  assert.equal(r.status, 404);
});
