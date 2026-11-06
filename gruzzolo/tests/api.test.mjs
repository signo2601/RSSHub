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

/* ---------- Mercati tab: TradingView screener routes (mocked upstream) ---------- */
// Records every screener query and answers with rows built by `answer(market, body)`
function mockScanner(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = u.match(/^https:\/\/scanner\.tradingview\.com\/([a-z0-9]+)\/scan$/);
    if (!m) return new Response('unexpected ' + u, { status: 500 });
    const body = JSON.parse(init.body);
    calls.push({ market: m[1], body, method: init.method });
    const out = answer(m[1], body);
    return out instanceof Response ? out : yjson({ totalCount: out.length, data: out });
  };
  return calls;
}

test('eco quotes: one POST for all tickers, pence → GBP, dates, unknown tickers left out', async () => {
  try {
    const calls = mockScanner((market, body) => {
      assert.equal(market, 'global');
      assert.deepEqual(body.symbols.tickers, ['TVC:FTMIB', 'LSE:HSBA', 'BONDSCOM:XS1001749289', 'NOPE:NOPE']);
      return [
        { s: 'TVC:FTMIB', d: [50052.95, -0.896786671, -452.93, 0.76534, -1.69, -6.97, 2.06, 11.2281104, 15.07, 1793952000, 'EUR', 'MILANO ITALIA BORSA INDEX', null, null] },
        { s: 'LSE:HSBA', d: [1304.6, 0.5, 6.5, 1, 2, 3, 4, 5, 6, 1793952000, 'GBX', 'HSBC Holdings Plc', null, null] },
        { s: 'BONDSCOM:XS1001749289', d: [99.9265, 0.0676, 0.0675, null, null, null, null, null, null, 1793926800, null, 'Microsoft Corporation 3.125% 06-DEC-2028', 3.160858847, 20281206, null] },
      ];
    });
    const r = await call('/api/eco/quotes?t=TVC:FTMIB,LSE:HSBA,BONDSCOM:XS1001749289,NOPE:NOPE');
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    const { rows, cols } = r.json;
    assert.deepEqual(cols, ['price', 'chg', 'chgAbs', 'w', 'm1', 'm3', 'm6', 'ytd', 'y', 'time', 'ccy', 'name', 'ytm', 'maturity']);
    assert.deepEqual(Object.keys(rows), ['TVC:FTMIB', 'LSE:HSBA', 'BONDSCOM:XS1001749289']);
    assert.deepEqual(rows['TVC:FTMIB'].slice(0, 3), [50052.95, -0.8968, -452.93]);
    assert.equal(rows['TVC:FTMIB'][7], 11.2281);
    assert.deepEqual(rows['LSE:HSBA'].slice(0, 3), [13.046, 0.5, 0.065]);
    assert.equal(rows['LSE:HSBA'][10], 'GBP');
    assert.equal(rows['BONDSCOM:XS1001749289'][12], 3.1609);
    assert.equal(rows['BONDSCOM:XS1001749289'][13], '2028-12-06');
    assert.ok(r.json.at > 0);
    assert.match(r.headers.get('cache-control'), /max-age=60/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco routes: input validation and upstream failures', async () => {
  try {
    const calls = mockScanner(() => []);
    const cases = [
      ['/api/eco/quotes', 400],
      ['/api/eco/quotes?t=bad', 400],
      ['/api/eco/quotes?t=TVC:A,' + encodeURIComponent('<x>:y'), 400],
      ['/api/eco/quotes?t=' + Array.from({ length: 201 }, (_, i) => `TVC:A${i}`).join(','), 400],
      ['/api/eco/heatmap', 400],
      ['/api/eco/heatmap?index=NOPE', 400],
      ['/api/eco/logo', 400],
      ['/api/eco/logo?id=' + encodeURIComponent('../secret'), 400],
      ['/api/eco/logo?id=' + encodeURIComponent('https://evil.example/x'), 400],
      ['/api/eco', 404],
      ['/api/eco/nothing', 404],
      ['/api/eco/quotes/extra', 404],
    ];
    for (const [path, status] of cases) {
      const r = await call(path);
      assert.equal(r.status, status, path);
      assert.equal(typeof r.json.error, 'string', path);
    }
    assert.equal(calls.length, 0, 'invalid requests never reach TradingView');
    assert.equal((await call('/api/eco/macro', { method: 'POST', body: '{}' })).status, 405);

    mockScanner(() => new Response('Too Many Requests', { status: 429 }));
    const limited = await call('/api/eco/yields');
    assert.equal(limited.status, 503);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    mockScanner(() => new Response('<html>oops</html>', { status: 200 }));
    assert.equal((await call('/api/eco/crypto')).status, 502);
    globalThis.fetch = async () => { throw new TypeError('network down'); };
    assert.equal((await call('/api/eco/macro')).status, 502);
    // An empty answer is an error, never an empty page cached for minutes
    mockScanner(() => []);
    assert.equal((await call('/api/eco/heatmap?index=SPX')).status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco heatmap: index constituents by market cap in USD millions, rows without market cap dropped', async () => {
  try {
    const calls = mockScanner((market, body) => {
      assert.equal(market, 'global');
      assert.deepEqual(body.symbols, { symbolset: ['SYML:INDEX;FTSEMIB'] });
      assert.deepEqual(body.sort, { sortBy: 'market_cap_basic', sortOrder: 'desc' });
      return [
        { s: 'MIL:UCG', d: ['UniCredit S.p.A.', 'Finance', 'Major Banks', 132602369150.55, 85.1, 'EUR', 1.23456, 2, 3, 4, 5, 6, 7, 'unicredit'] },
        { s: 'MIL:XYZ', d: ['No cap', 'Finance', 'Banks', null, 1, 'EUR', 0, 0, 0, 0, 0, 0, 0, ''] },
        { s: 'LSE:TEST', d: ['Pence plc', 'Utilities', 'Electric Utilities', 2e9, 250, 'GBX', -0.5, null, null, null, null, null, null, ''] },
      ];
    });
    const r = await call('/api/eco/heatmap?index=ftsemib');
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(r.json.index, 'FTSEMIB');
    assert.deepEqual(r.json.rows, [
      ['MIL:UCG', 'UniCredit S.p.A.', 'Finance', 'Major Banks', 132602, 85.1, 'EUR', 1.2346, 2, 3, 4, 5, 6, 7, 'unicredit'],
      ['LSE:TEST', 'Pence plc', 'Utilities', 'Electric Utilities', 2000, 2.5, 'GBP', -0.5, null, null, null, null, null, null, ''],
    ]);
    assert.equal(r.json.cols.length, r.json.rows[0].length);
    assert.match(r.headers.get('cache-control'), /max-age=120/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco yields: month tenors read as …MY tickers, curves sorted by maturity', async () => {
  try {
    mockScanner((market, body) => {
      const t = body.symbols.tickers;
      assert.ok(t.includes('TVC:US03MY') && t.includes('TVC:US10Y') && t.includes('TVC:IT50Y'));
      assert.ok(!t.includes('TVC:US03M') && !t.includes('TVC:US10YY'));
      return [
        { s: 'TVC:IT10Y', d: [4.3564, -0.0013, -3.56, -5.26, 22.57, 27.44, 1793952000] },
        { s: 'TVC:IT03MY', d: [2.675, 0.006, 1.66, -0.3, 30.1, 33.68, 1793952000] },
        { s: 'TVC:IT02Y', d: [3.5045, 0.0876, 0.48, 0.95, 50.2, 59.1, 1793952000] },
        { s: 'TVC:US10Y', d: [4.855, 0.012, -1.62, -8.36, 15.8, 16.86, 1793952000] },
        { s: 'TVC:XX10Y', d: [1, 0, 0, 0, 0, 0, 0] }, // not asked: ignored
        { s: 'TVC:DE10Y', d: [null, null, null, null, null, null, null] },
      ];
    });
    const r = await call('/api/eco/yields');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.curves).sort(), ['IT', 'US']);
    assert.deepEqual(r.json.curves.IT.map((p) => p[0]), [3, 24, 120]);
    assert.deepEqual(r.json.curves.IT[2], [120, 4.3564, -0.0013, -3.56, -5.26, 22.57, 27.44, 1793952000]);
    assert.deepEqual(r.json.cols, ['months', 'yield', 'chgAbs', 'w', 'm1', 'ytd', 'y', 'time']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco macro: indicators by country with the previous value; aggregates and other series left out', async () => {
  try {
    mockScanner((market, body) => {
      assert.equal(market, 'economics2');
      assert.equal(body.filter[0].right, '^[A-Z]{2}(IRYY|INTR|GDP|GDPYY|UR|GDG)$');
      return [
        { s: 'ECONOMICS:ITIRYY', d: ['ITIRYY', 5.4, 1.2, 1793404800, 'IT'] },
        { s: 'ECONOMICS:ITGDP', d: ['ITGDP', 2551556954100.35, 168121391642.23, 1767139200, 'IT'] },
        { s: 'ECONOMICS:EUINTR', d: ['EUINTR', 2.65, 0, 1793232000, 'EU'] },
        { s: 'ECONOMICS:PLHIRYY', d: ['PLHIRYY', 3, 0.1, 1793404800, 'PL'] },
        { s: 'ECONOMICS:FRIRYY', d: ['FRIRYY', 3.4, null, 1793404800, 'FR'] },
        { s: 'ECONOMICS:DEUR', d: ['DEUR', 6.1, 0, 1793404800, 'AT'] }, // country code mismatch
      ];
    });
    const r = await call('/api/eco/macro');
    assert.equal(r.status, 200);
    const { data } = r.json;
    assert.deepEqual(Object.keys(data), ['IRYY', 'INTR', 'GDP', 'GDPYY', 'UR', 'GDG']);
    assert.deepEqual(data.IRYY.IT, [5.4, 4.2, 1793404800]);
    assert.deepEqual(data.IRYY.FR, [3.4, null, 1793404800]);
    assert.equal(data.IRYY.PL, undefined);
    assert.deepEqual(data.INTR.EU, [2.65, 2.65, 1793232000]);
    assert.equal(data.GDP.IT[0], 2551556954100.35);
    assert.deepEqual(data.UR, {});
    assert.match(r.headers.get('cache-control'), /max-age=21600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco crypto: ranked by market cap, stablecoins left out, at most 15', async () => {
  try {
    mockScanner((market, body) => {
      assert.equal(market, 'coin');
      assert.deepEqual(body.sort, { sortBy: 'crypto_total_rank', sortOrder: 'asc' });
      const rows = [
        { s: 'CRYPTO:BTCUSD', d: ['BTC', 'Bitcoin', 'crypto/XTVCBTC', 75783.71, -0.2979, -2.7, -11.4, -13.4, -27, 1523764000000, ['cryptocurrencies'], 1793923200] },
        { s: 'CRYPTO:USDTUSD', d: ['USDT', 'Tether USDt', 'crypto/XTVCUSDT', 0.9986, 0, 0, 0, 0, 0, 177e9, ['stablecoins'], 1793923200] },
      ];
      for (let i = 0; i < 20; i++) rows.push({ s: `CRYPTO:C${i}USD`, d: [`C${i}`, `Coin ${i}`, '', 1 + i, 0, 0, 0, 0, 0, 1e9, ['layer-1'], 1793923200] });
      return rows;
    });
    const r = await call('/api/eco/crypto');
    assert.equal(r.status, 200);
    assert.equal(r.json.rows.length, 15);
    assert.deepEqual(r.json.rows[0], ['CRYPTO:BTCUSD', 'BTC', 'Bitcoin', 'crypto/XTVCBTC', 75783.71, -0.2979, -2.7, -11.4, -13.4, -27, 1523764, 1793923200]);
    assert.ok(!r.json.rows.some((x) => x[1] === 'USDT'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('eco logo: SVG from our origin, sandboxed, long cache; non-SVG answers are 404', async () => {
  try {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes('apple')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } });
      if (String(url).includes('crypto/XTVCBTC')) return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } });
      return new Response('<Error>AccessDenied</Error>', { status: 403, headers: { 'Content-Type': 'application/xml' } });
    };
    const r = await call('/api/eco/logo?id=apple');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    assert.match(r.headers.get('cache-control'), /max-age=2592000/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(seen[0], 'https://s3-symbol-logo.tradingview.com/apple--big.svg');
    assert.equal((await call('/api/eco/logo?id=crypto/XTVCBTC')).status, 200);
    assert.equal(seen[1], 'https://s3-symbol-logo.tradingview.com/crypto/XTVCBTC.svg');
    assert.equal((await call('/api/eco/logo?id=nothing-here')).status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- Live TradingView screener ---------- */
async function probeTradingView() {
  try {
    const res = await realFetch('https://scanner.tradingview.com/global/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: ['close'], symbols: { tickers: ['TVC:US10Y'] }, range: [0, 1] }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok ? true : `TradingView ha risposto ${res.status}`;
  } catch (e) {
    const hint = process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY ? ' (dietro proxy: imposta NODE_USE_ENV_PROXY=1)' : '';
    return `rete non disponibile: ${e.cause ? e.cause.code || e.cause.message : e.message}${hint}`;
  }
}
const tvProbe = await probeTradingView();
const tvLive = tvProbe === true ? {} : { skip: tvProbe };

test('live: eco heatmap S&P 500 has about 500 stocks with sectors', tvLive, async () => {
  const r = await call('/api/eco/heatmap?index=SPX');
  assert.equal(r.status, 200);
  assert.ok(r.json.rows.length > 450 && r.json.rows.length < 520, `${r.json.rows.length} rows`);
  const sectors = new Set(r.json.rows.map((x) => x[2]));
  assert.ok(sectors.size >= 10 && sectors.size <= 25, [...sectors].join(', '));
  assert.ok(r.json.rows.every((x) => x[4] > 0 && typeof x[0] === 'string'));
});

test('live: eco yields and macro cover the main countries', tvLive, async () => {
  const y = await call('/api/eco/yields');
  assert.equal(y.status, 200);
  for (const cc of ['US', 'DE', 'IT', 'FR', 'GB', 'JP']) {
    const curve = y.json.curves[cc];
    assert.ok(curve && curve.length >= 8, cc);
    const ten = curve.find((p) => p[0] === 120);
    assert.ok(ten && ten[1] > -1 && ten[1] < 15, `${cc} 10Y ${ten && ten[1]}`);
  }
  const m = await call('/api/eco/macro');
  assert.equal(m.status, 200);
  for (const code of ['IRYY', 'INTR', 'GDP', 'GDPYY', 'UR', 'GDG']) assert.ok(Object.keys(m.json.data[code]).length > 100, code);
  assert.ok(m.json.data.IRYY.IT && m.json.data.IRYY.US);
});

test('live: eco quotes for an index, a currency, a commodity, a bond yield and crypto', tvLive, async () => {
  const r = await call('/api/eco/quotes?t=TVC:FTMIB,FX_IDC:EURUSD,TVC:GOLD,TVC:IT10Y,CRYPTO:BTCUSD');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json.rows).sort(), ['CRYPTO:BTCUSD', 'FX_IDC:EURUSD', 'TVC:FTMIB', 'TVC:GOLD', 'TVC:IT10Y']);
  assert.ok(r.json.rows['FX_IDC:EURUSD'][0] > 0.7 && r.json.rows['FX_IDC:EURUSD'][0] < 1.7);
  const c = await call('/api/eco/crypto');
  assert.equal(c.status, 200);
  assert.equal(c.json.rows[0][1], 'BTC');
});
