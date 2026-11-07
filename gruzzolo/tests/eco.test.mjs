// Mercati tab: data layer (js/eco.js) with a mocked network, the maths of the pages (yield changes,
// heatmap colors, macro steps and periods) and smoke renders of the four pages with small fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { S } from '../js/state.js';
import { eco } from '../js/eco.js';
import { chartData } from '../js/charts.js';
import { curveChart } from '../js/charts.js';
import { fmtNum, fmtBp, fmtBig, fmtPctSigned, flag, prefs, DEFAULTS } from '../js/views/eco-common.js';
import { renderOverview, yieldAt, _test as ov } from '../js/views/eco-overview.js';
import { renderHeatmap, bucket, weightedChange, weightShare, sectorName } from '../js/views/eco-heatmap.js';
import { renderCurves, tenorShort, tenorLong, slopeOf } from '../js/views/eco-curves.js';
import { renderMacro, valuesOf, step, periodText, INDICATORS } from '../js/views/eco-macro.js';
import { renderMarket } from '../js/views/market.js';

const realFetch = globalThis.fetch;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const NOW_SEC = Math.round(Date.now() / 1000);

/* ---------- Fixtures (shapes of functions/api/[[path]].js) ---------- */
const OVERVIEW = {
  at: Date.now(),
  cols: ['price', 'chg', 'chgAbs', 'w', 'm1', 'm3', 'm6', 'ytd', 'y', 'time', 'ccy', 'name', 'ytm', 'maturity'],
  rows: {
    'TVC:FTMIB': [50052.95, -0.8968, -452.93, 0.7653, -1.6992, -6.9759, 2.0638, 11.2281, 15.0688, NOW_SEC, 'EUR', 'MILANO ITALIA BORSA INDEX', null, null],
    'SP:SPX': [7413.18, 0.81, 59.4, -3.05, -5.07, -4.36, 0.47, 7.55, 8.99, NOW_SEC, null, 'S&P 500', null, null],
    'FX_IDC:EURUSD': [1.11389, -0.6918, -0.00776, -0.332, -1.0588, -3.3098, -4.9728, -5.1686, -3.0684, NOW_SEC, 'USD', 'EURO / U.S. DOLLAR', null, null],
    'TVC:GOLD': [4061.49, -0.6278, -25.66, 0.9999, -2.533, -4.2034, -13.3604, -5.9464, 2.0477, NOW_SEC, 'USD', 'Gold', null, null],
    'BONDSCOM:XS1001749289': [99.9265, 0.0676, 0.0675, null, null, null, null, null, null, NOW_SEC, null, 'Microsoft Corporation 3.125% 06-DEC-2028', 3.1609, '2028-12-06'],
  },
};
const YIELDS = {
  at: Date.now(),
  cols: ['months', 'yield', 'chgAbs', 'w', 'm1', 'ytd', 'y', 'time'],
  curves: {
    IT: [[3, 2.675, 0.006, 1.66, -0.3, 30.1, 33.68, NOW_SEC], [24, 3.5045, 0.0876, 0.48, 0.95, 50.2, 59.1, NOW_SEC], [120, 4.3564, -0.0013, -3.564, -5.2565, 22.567, 27.4397, NOW_SEC], [360, 4.9511, 0.01, 1, 1, 1, 1, NOW_SEC]],
    DE: [[3, 2.58, 0, 0, 0, 0, 0, NOW_SEC], [24, 2.9986, 0.038, 1, 1, 1, 1, NOW_SEC], [120, 3.2525, 0.0137, 0.42, 0.5, 0.6, 0.7, NOW_SEC]],
    US: [[1, 3.943, 0.027, 0, 0, 0, 0, NOW_SEC], [24, 4.514, 0.043, 0.96, 0, 0, 0, NOW_SEC], [120, 4.855, 0.012, -1.6217, -8.3648, 15.79, 16.855, NOW_SEC]],
    JP: [[24, 1.72, -0.01, 0, 0, 0, 0, NOW_SEC], [120, 2.632, -0.137, 0, 0, 0, 0, NOW_SEC]],
  },
};
const CRYPTO = {
  at: Date.now(),
  cols: ['symbol', 'code', 'name', 'logo', 'price', 'chg', 'w', 'm1', 'ytd', 'y', 'mcap', 'time'],
  rows: [['CRYPTO:BTCUSD', 'BTC', 'Bitcoin', 'crypto/XTVCBTC', 75783.71, -0.2979, -2.72, -11.4, -13.4, -27.05, 1523764, NOW_SEC]],
};
const HEATMAP = {
  at: Date.now(),
  index: 'SPX',
  cols: ['symbol', 'name', 'sector', 'industry', 'mcap', 'price', 'ccy', 'chg', 'w', 'm1', 'm3', 'm6', 'ytd', 'y', 'logo'],
  rows: [
    ['NASDAQ:AAPL', 'Apple Inc.', 'Electronic Technology', 'Telecommunications Equipment', 4997908, 343.92, 'USD', -0.35, -0.8, 2.07, 10.4, 18.6, 26.3, 28.4, 'apple'],
    ['NASDAQ:NVDA', 'NVIDIA Corporation', 'Electronic Technology', 'Semiconductors', 4517545, 187.45, 'USD', 3.22, -10.3, -21.1, -1.3, -4.6, 0, 1, 'nvidia'],
    ['NASDAQ:MSFT', 'Microsoft Corporation', 'Technology Services', 'Packaged Software', 3964770, 533.89, 'USD', -0.79, 1.64, 0.6, 10.2, 5.6, 1, 2, 'microsoft'],
    ['NYSE:JPM', 'JPMorgan Chase & Co.', 'Finance', 'Major Banks', 800000, 300.1, 'USD', null, 1, 1, 1, 1, 1, 1, ''],
  ],
};
const MACRO = {
  at: Date.now(),
  cols: ['value', 'prev', 'time'],
  data: {
    IRYY: { IT: [5.4, 4.2, 1793404800], US: [3.7, 3.4, 1790726400], DE: [2.8, 3.3, 1793404800], YE: [10, 9, 1498780800], EU: [2.9, 2.8, 1793404800], SG: [1.1, 1, 1790726400] },
    INTR: { IT: [2.65, 2.65, 1793232000], US: [4, 4, 1793232000] },
    GDP: { IT: [2551556954100.35, 2383435562458.12, 1767139200], US: [30769700000000, 29298013000000, 1767139200], WW: [118400000000000, 110000000000000, 1767139200] },
    GDPYY: { IT: [0.8, 1, 1790726400] },
    UR: { IT: [6.3, 6.2, 1790726400] },
    GDG: { IT: [137.1, 134.7, 1767139200] },
  },
};

function mockApi(map, calls = []) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    for (const [part, body] of Object.entries(map)) {
      if (u.includes(part)) return typeof body === 'function' ? body(u) : json(body);
    }
    return json({ error: 'non trovato' }, 404);
  };
  return calls;
}

async function loadAll() {
  mockApi({ '/api/eco/quotes': OVERVIEW, '/api/eco/yields': YIELDS, '/api/eco/crypto': CRYPTO, '/api/eco/heatmap': HEATMAP, '/api/eco/macro': MACRO });
  await eco.load('overview', '/eco/quotes?t=x', { force: true });
  await eco.load('yields', '/eco/yields', { force: true });
  await eco.load('crypto', '/eco/crypto', { force: true });
  await eco.load('heatmap:SPX', '/eco/heatmap?index=SPX', { force: true });
  await eco.load('macro', '/eco/macro', { force: true });
  globalThis.fetch = realFetch;
}

/* ---------- Data layer ---------- */
test('eco.load: downloads once, keeps fresh answers, backs off after a failure, force retries', async () => {
  await eco.clear();
  let n = 0;
  const calls = mockApi({ '/api/eco/yields': () => { n++; return json(YIELDS); } });
  let notified = 0;
  const off = eco.subscribe(() => notified++);
  try {
    const e = await eco.load('yields', '/eco/yields', { maxAge: 60e3 });
    assert.ok(e && e.data.curves.IT);
    assert.equal(n, 1);
    assert.ok(notified >= 1);
    await eco.load('yields', '/eco/yields', { maxAge: 60e3 });
    assert.equal(n, 1, 'fresh: not downloaded again');
    // Same key, different path (a new app version asks for more): downloads
    await eco.load('yields', '/eco/yields?v=2', { maxAge: 60e3 });
    assert.equal(n, 2);
    // Failure: the old copy stays, the error is recorded, no automatic retry for a while
    mockApi({ '/api/eco/yields': () => json({ error: 'TradingView non risponde' }, 502) });
    const kept = await eco.load('yields', '/eco/yields', { maxAge: 0 });
    assert.ok(kept && kept.data.curves.IT, 'the last answer is kept');
    assert.equal(eco.failure('yields').message, 'TradingView non risponde');
    assert.equal(eco.failure('yields').offline, false);
    const calls2 = mockApi({ '/api/eco/yields': () => json(YIELDS) });
    await eco.load('yields', '/eco/yields', { maxAge: 0 });
    assert.equal(calls2.length, 0, 'waits before retrying');
    await eco.load('yields', '/eco/yields', { maxAge: 0, force: true });
    assert.equal(calls2.length, 1, 'force retries now');
    assert.equal(eco.failure('yields'), null);
    // Network down → offline failure; an HTML page (no API) counts as offline too
    globalThis.fetch = async () => { throw new TypeError('network down'); };
    await eco.load('macro', '/eco/macro', { force: true });
    assert.equal(eco.failure('macro').offline, true);
    mockApi({ '/api/eco/macro': () => new Response('<html></html>', { status: 200 }) });
    await eco.load('macro', '/eco/macro', { force: true });
    assert.equal(eco.failure('macro').offline, true);
    assert.equal(eco.data('macro'), null);
    assert.ok(calls.length >= 1);
    assert.equal(eco.logoUrl('crypto/XTVCBTC'), '/api/eco/logo?id=crypto%2FXTVCBTC');
  } finally {
    off();
    globalThis.fetch = realFetch;
  }
});

test('eco.load: concurrent calls share one download; only 6 heatmaps are kept', async () => {
  await eco.clear();
  let n = 0;
  mockApi({ '/api/eco/heatmap': () => { n++; return json(HEATMAP); } });
  try {
    const [a, b] = await Promise.all([eco.load('heatmap:SPX', '/eco/heatmap?index=SPX'), eco.load('heatmap:SPX', '/eco/heatmap?index=SPX')]);
    assert.equal(n, 1);
    assert.equal(a, b);
    for (const k of ['NDX', 'DJI', 'DAX', 'CAC', 'AEX', 'SMI', 'UKX']) await eco.load(`heatmap:${k}`, `/eco/heatmap?index=${k}`);
    const kept = ['SPX', 'NDX', 'DJI', 'DAX', 'CAC', 'AEX', 'SMI', 'UKX'].filter((k) => eco.entry(`heatmap:${k}`));
    assert.equal(kept.length, 6);
    assert.ok(eco.entry('heatmap:UKX'), 'the newest stays');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ---------- Formats ---------- */
test('formats: grouping on 4 digits, basis points, big amounts, signed percents, flags', () => {
  assert.equal(fmtNum(7413.18), '7.413,18');
  assert.equal(fmtNum(50052.95), '50.052,95');
  assert.equal(fmtNum(0.1825), '0,1825');
  assert.equal(fmtNum(1.11389, 4), '1,1139');
  assert.equal(fmtBp(0.0876), '+8,8 pb');
  assert.equal(fmtBp(-0.137), '−13,7 pb');
  assert.equal(fmtBp(0), '0 pb');
  assert.equal(fmtBig(2551556954100, '$'), '2,55 mila mld $');
  assert.equal(fmtBig(30769700000000, '$'), '30,8 mila mld $');
  assert.equal(fmtBig(53203449429, '€'), '53,2 mld €');
  assert.equal(fmtPctSigned(-0.896), '−0,90%');
  assert.equal(fmtPctSigned(3.22), '+3,22%');
  assert.equal(flag('IT'), '🇮🇹');
  assert.equal(flag('EU'), '🇪🇺');
  assert.equal(flag('x'), '');
});

/* ---------- Maths ---------- */
test('yield changes: 1 day in points; other periods undo TradingView\'s % change of the yield', () => {
  const p = [120, 4.853, 0.01, -1.6217, -8.3648, 15.7958, 16.8553, NOW_SEC];
  close(ov.yieldChange(p, '1D'), 0.01);
  const weekAgo = 4.853 / (1 - 0.016217);
  close(ov.yieldChange(p, '1W'), 4.853 - weekAgo);
  close(ov.yieldBefore(p, '1W'), weekAgo);
  close(ov.yieldBefore(p, '1Y'), 4.853 / 1.168553);
  assert.equal(ov.yieldChange(p, '6M'), null, 'no 6-month data for yields');
  assert.equal(ov.yieldChange([120, 1, 0, -100, 0, 0, 0, 0], '1W'), null, 'a positive yield cannot come from a −100% change');
  assert.equal(ov.yieldChange([120, 1, null, null, null, null, null, 0], '1D'), null);
});

test('yield changes across zero: TradingView divides by the absolute old level (Swiss bills)', () => {
  // Real answers of /api/eco/yields for Switzerland: [months, yield, chgAbs, w, m1, ytd, y, time]
  const m1 = [1, -0.11, 0, 0, 8.3333, 42.1053, -1200, 0];
  const m2 = [2, -0.1, 0, 16.6667, 0, 37.5, 16.6667, 0];
  const m3 = [3, -0.08, 0, -100, 0, -300, -60, 0];
  close(ov.yieldBefore(m1, 'YTD'), -0.19, 1e-6); // was negative: y = old · (1 − r)
  close(ov.yieldBefore(m2, '1W'), -0.12, 1e-6);
  close(ov.yieldBefore(m2, 'YTD'), -0.16, 1e-6);
  close(ov.yieldBefore(m3, '1W'), -0.04, 1e-6); // −100%: from −0,04 to −0,08
  close(ov.yieldBefore(m3, '1Y'), -0.05, 1e-6);
  // Beyond ±100% both readings can fit: the one on the 4-decimal grid wins, else the smaller move
  close(ov.yieldBefore(m1, '1Y'), 0.01, 1e-6); // +0,01 → −0,11 is −1200%
  close(ov.yieldBefore(m3, 'YTD'), 0.04, 1e-6);
  close(ov.yieldChange(m1, 'YTD'), 0.08, 1e-6, 'the yield rose 8 bp, it did not fall');
  close(ov.yieldBefore([12, 0.15, -0.03, -42.3077, 200, 150, 200, 0], '1M'), 0.05, 1e-6);
});

test('crypto in euro: a dollar change seen through the EUR/USD change of the same period', async () => {
  await loadAll();
  // EUR/USD fell 0,6918% today: a crypto flat in dollars gained in euro
  close(ov.inEuro(0, 'chg'), (1 / (1 - 0.006918) - 1) * 100, 1e-9);
  close(ov.inEuro(-0.2979, 'chg'), ((1 - 0.002979) / (1 - 0.006918) - 1) * 100, 1e-9);
  assert.equal(ov.inEuro(null, 'chg'), null);
  assert.equal(ov.inEuro(1, 'nope'), null);
});

test('heatmap: color steps scale with the period, cap-weighted change, Italian sectors', () => {
  assert.equal(bucket(3, '1D'), 'p4');
  assert.equal(bucket(9, '1D'), 'p4');
  assert.equal(bucket(0.4, '1D'), 'p1');
  assert.equal(bucket(-0.2, '1D'), '0');
  assert.equal(bucket(-1.6, '1D'), 'n2');
  assert.equal(bucket(-1.6, '1Y'), '0', 'the same move is small over a year');
  assert.equal(bucket(null, '1D'), 'na');
  const list = [{ mcap: 3, price: 10, row: [0, 0, 0, 0, 0, 0, 0, 2] }, { mcap: 1, price: 30, row: [0, 0, 0, 0, 0, 0, 0, -2] }, { mcap: 5, price: 1, row: [0, 0, 0, 0, 0, 0, 0, null] }];
  close(weightedChange(list, '1D'), 1);
  close(weightedChange(list, '1D', 'price'), (10 * 2 - 30 * 2) / 40, 1e-9, 'Dow and Nikkei weigh by price');
  assert.equal(weightedChange([], '1D'), null);
  close(weightShare(list[1], list, 'cap'), 1 / 9);
  close(weightShare(list[1], list, 'price'), 30 / 41);
  assert.equal(sectorName('Electronic Technology'), 'Tecnologia elettronica');
  assert.equal(sectorName('Something New'), 'Something New');
});

test('curves: tenor labels and slope (10 years minus 2 years)', async () => {
  await loadAll();
  assert.equal(tenorShort(3), '3M');
  assert.equal(tenorShort(120), '10A');
  assert.equal(tenorLong(1), '1 mese');
  assert.equal(tenorLong(12), '1 anno');
  assert.equal(tenorLong(360), '30 anni');
  close(slopeOf('IT'), 4.3564 - 3.5045);
  close(yieldAt('IT', 120, '1D').change, -0.0013);
  assert.equal(slopeOf('ZZ'), null);
});

test('macro: stale observations left out, color steps, periods by indicator', async () => {
  await loadAll();
  const v = valuesOf('IRYY');
  assert.ok(v.IT && v.US && v.EU);
  assert.equal(valuesOf('GDP').WW, undefined, 'the world total is not a country');
  assert.equal(v.YE, undefined, 'Yemen 2017: too old');
  assert.deepEqual(v.IT, { value: 5.4, prev: 4.2, time: 1793404800 });
  const t = INDICATORS[0][5];
  assert.equal(step(-1, t), 0);
  assert.equal(step(0, t), 1);
  assert.equal(step(5.4, t), 4);
  assert.equal(step(40, t), 6);
  assert.equal(step(null, t), -1);
  assert.equal(periodText(1793404800, 'IRYY'), 'ott 2026');
  assert.equal(periodText(1767139200, 'GDP'), '2025');
  assert.equal(periodText(1790726400, 'GDPYY'), '3° trim. 2026');
});

/* ---------- Smoke renders ---------- */
const clean = (html) => {
  assert.equal(typeof html, 'string');
  assert.ok(!/undefined|NaN|\[object/.test(html), html.match(/.{40}(undefined|NaN|\[object).{40}/)?.[0]);
};

test('pages render with data: overview, heatmap, curves, macro', async () => {
  await loadAll();
  S.ui.eco = null;
  const p = prefs();
  assert.equal(p.page, DEFAULTS.page);
  const o = renderOverview();
  clean(o);
  assert.ok(o.includes('50.052,95'), 'FTSE MIB');
  assert.ok(o.includes('Spread BTP-Bund') && o.includes('110 pb'), 'BTP-Bund spread in the highlights');
  assert.ok(o.includes('Microsoft 3,125% 2028') && o.includes('3,16%'), 'AAA bond with its yield');
  assert.ok(o.includes(`${fmtNum(75783.71 / 1.11389)} €`), 'crypto converted to euro with EUR/USD');
  p.period = '1W';
  clean(renderOverview());

  p.hmIndex = 'SPX';
  p.hmPeriod = '1D';
  const h = renderHeatmap();
  clean(h);
  assert.ok(h.includes('data-s="NASDAQ:AAPL"') && h.includes('hm-tile'));
  assert.ok(h.includes('Tecnologia elettronica'));
  assert.ok(h.includes('<span>Indice</span><b class="num">+0,81%</b>'), 'the real change of the S&P 500 from the quotes');
  p.hmSector = 'Finance';
  clean(renderHeatmap());
  p.hmSector = 'Nope';
  renderHeatmap();
  assert.equal(p.hmSector, null, 'an unknown sector zooms out');
  p.hmSize = 'equal';
  p.hmGroup = false;
  clean(renderHeatmap());

  p.ycCountries = ['IT', 'DE', 'ZZ'];
  p.ycCompare = '1M';
  const c = renderCurves();
  clean(c);
  assert.ok(c.includes('eco-yc') && c.includes('Spread Bund'));
  assert.equal(chartData('eco-yc').type, 'line');
  p.ycCountries = [];
  renderCurves();
  assert.deepEqual(p.ycCountries, ['IT', 'DE', 'US'], 'never an empty chart');

  for (const [code] of INDICATORS) {
    p.mcInd = code;
    for (const region of ['g20', 'europe', 'euro', 'world']) {
      p.mcRegion = region;
      clean(renderMacro());
    }
  }
  p.mcInd = 'GDP';
  p.mcRegion = 'world';
  assert.ok(!renderMacro().includes('data-cc="WW"'), 'no world total in the ranking');
  p.mcInd = 'IRYY';
  p.mcSel = 'IT';
  const m = renderMacro();
  clean(m);
  assert.ok(m.includes('mc-sel-outline') && m.includes('Italia'));
  p.mcRegion = 'euro';
  assert.ok(renderMacro().includes('Area euro nel complesso'));

  for (const page of ['overview', 'heatmap', 'curves', 'macro', 'nope']) {
    p.page = page;
    clean(renderMarket());
  }
  assert.equal(p.page, 'overview', 'an unknown page falls back to Panoramica');
});

test('pages without data: loading placeholder, then the reason with a retry button', async () => {
  await eco.clear();
  S.ui.eco = null;
  const p = prefs();
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    assert.ok(renderOverview().includes('Carico'));
    await eco.load('overview', '/eco/quotes?t=x', { force: true });
    await eco.load('macro', '/eco/macro', { force: true });
    const o = renderOverview();
    assert.ok(o.includes('Sei offline') || o.includes('Carico'));
    p.page = 'macro';
    const m = renderMacro();
    assert.ok(m.includes('Sei offline') && m.includes('data-act="eco-retry"'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('curveChart: lines bridge missing points, tooltip data registered as a line chart', () => {
  const html = curveChart('t-curve', {
    cats: [{ short: '1M', long: '1 mese' }, { short: '1A', long: '1 anno' }, { short: '10A', long: '10 anni' }],
    series: [{ name: 'A', values: [1, null, 3] }, { name: 'B', values: [2, 2.5, null], dash: true }],
    w: 320,
    h: 200,
  });
  assert.ok(html.includes('<svg'));
  const paths = html.match(/<path class="chart-line" d="([^"]+)"/g);
  assert.equal(paths.length, 2);
  assert.ok(paths.some((d) => (d.match(/L/g) || []).length === 1 && !d.includes('M', 30)), 'A: one segment from 1M to 10A');
  const reg = chartData('t-curve');
  assert.equal(reg.type, 'line');
  assert.deepEqual(reg.dates, ['1 mese', '1 anno', '10 anni']);
  assert.ok(html.includes('stroke-dasharray'));
  assert.ok(curveChart('t-empty', { cats: [], series: [] }).includes('Nessun dato'));
});
