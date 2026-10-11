import test from 'node:test';
import assert from 'node:assert/strict';
import { S, bump, migrate, hasDemo, TYPE_KEYS } from '../js/state.js';
import { market } from '../js/market.js';
import { getSeries, positions, realizedEvents, priceOn, historyFor, txnsFor } from '../js/engine.js';
import { incomeStats } from '../js/income.js';
import { todayISO, addMonths, dayDiff } from '../js/util.js';
import { demoData, installDemoMarket, removeDemo, DEMO_ACCOUNTS, DEMO_SYMBOLS, _test } from '../js/demo.js';

const T = todayISO();

function load(data) {
  S.data = migrate(data);
  bump();
}

test('demoData: flagged example data, deterministic, valid v2', () => {
  const d = demoData({ today: T });
  assert.equal(d.v, 2);
  assert.equal(d.settings.started, false);
  assert.deepEqual(migrate(d), d, 'already valid v2');
  assert.deepEqual(demoData({ today: T }), d, 'deterministic');
  assert.ok(d.accounts.length === 2 && d.accounts.every((a) => a.demo));
  assert.deepEqual(d.accounts.map((a) => [a.name, a.cashMode]), [['DEGIRO', 'track'], ['Scalable Capital', 'auto']]);
  assert.ok(Object.values(d.assets).every((a) => a.demo && TYPE_KEYS.includes(a.type)));
  assert.ok(d.txns.length > 80 && d.txns.every((t) => t.demo && t.id && t.acc && t.date <= T));
  assert.equal(new Set(d.txns.map((t) => t.id)).size, d.txns.length);
  assert.ok(d.watch.length === 3 && d.watch.every((w) => w.demo && w.symbol && w.price > 0 && w.target > 0));
  for (const a of Object.values(d.assets)) {
    if (a.type === 'bond') assert.equal(a.priceSource, 'manual');
    else assert.equal(a.priceSource, 'demo');
  }
  const ter = Object.fromEntries(Object.values(d.assets).map((a) => [a.ticker, a.ter]));
  assert.deepEqual([ter.VWCE, ter.EIMI, ter.VHYL], [0.0022, 0.0018, 0.0029]);
  const ext = Object.entries(d.settings.externalPL);
  assert.deepEqual(ext, [[String(Number(T.slice(0, 4)) - 3), -120]]);
  // About 2.5 years of history
  const first = d.txns[0].date;
  assert.ok(Math.abs(dayDiff(first, addMonths(T, -30))) < 20, first);
});

test('installDemoMarket: synthetic histories for assets, benchmark, FX and watchlist', () => {
  const syms = installDemoMarket({ today: T });
  for (const s of ['VWCE.DE', 'EURUSD=X', 'ASML.AS', 'RACE.MI', 'SGLD.MI', 'ENEL.MI', 'ALV.DE', 'AAPL', 'VHYL.MI', 'EIMI.MI', 'BTC-EUR']) {
    assert.ok(syms.includes('demo:' + s), s);
    const h = market.getHistory('demo:' + s);
    assert.ok(h.synthetic);
    assert.equal(h.dates.length, h.close.length);
    assert.equal(h.adj.length, h.close.length);
    assert.ok(h.dates[h.dates.length - 1] <= T);
    assert.ok(dayDiff(h.dates[0], T) > 365 * 7.9, 'eight years of closes');
    assert.ok(h.dates.every((x) => ![0, 6].includes(new Date(x + 'T12:00:00').getDay())), 'business days only');
    assert.ok(h.close.every((v) => v > 0));
  }
  assert.deepEqual(DEMO_SYMBOLS.map((s) => 'demo:' + s), syms);
  // Dividend schedules
  const months = (s) => [...new Set(market.getHistory('demo:' + s).divs.map(([d]) => Number(d.slice(5, 7))))].sort((a, b) => a - b);
  assert.deepEqual(months('ENEL.MI'), [1, 7]);
  assert.deepEqual(months('ALV.DE'), [5]);
  assert.deepEqual(months('AAPL'), [2, 5, 8, 11]);
  assert.deepEqual(months('VHYL.MI'), [3, 6, 9, 12]);
  assert.equal(market.getHistory('demo:VWCE.DE').divs.length, 0, 'VWCE accumulates');
  // Adjusted closes: equal to close after the last dividend, lower before it
  const enel = market.getHistory('demo:ENEL.MI');
  const lastEx = enel.divs[enel.divs.length - 1][0];
  const k = enel.dates.indexOf(lastEx);
  assert.ok(Math.abs(enel.adj[enel.adj.length - 1] - enel.close[enel.close.length - 1]) < 1e-9);
  assert.ok(enel.adj[k - 1] < enel.close[k - 1]);
  // Realistic volatility: ETF ≈ 15%, BTC ≈ 60%
  const vol = (s) => {
    const c = market.getHistory('demo:' + s).close;
    const r = [];
    for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt((r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * 252);
  };
  assert.ok(vol('VWCE.DE') > 0.11 && vol('VWCE.DE') < 0.22, 'VWCE vol ' + vol('VWCE.DE'));
  assert.ok(vol('BTC-EUR') > 0.45 && vol('BTC-EUR') < 0.85, 'BTC vol ' + vol('BTC-EUR'));
  assert.ok(vol('EURUSD=X') < 0.12);
});

test('synthetic prices are tied to the calendar: the same day has the same close whatever today is', () => {
  const a = _test.buildMarket('2026-10-09');
  const b = _test.buildMarket('2026-03-02');
  const day = '2025-06-02';
  assert.equal(a.close('VWCE.DE', day), b.close('VWCE.DE', day));
  assert.equal(a.close('AAPL', day), b.close('AAPL', day));
});

test('demo portfolio through the engine: positive values, consistent positions, DEGIRO cash never negative', () => {
  load(demoData({ today: T }));
  installDemoMarket({ today: T });
  assert.ok(hasDemo());
  const all = getSeries('all');
  assert.ok(all);
  assert.equal(all.end, T);
  for (let i = 0; i < all.value.length; i++) assert.ok(all.value[i] > 0, 'value > 0 on ' + all.dates[i]);
  for (let i = 0; i < all.ret.length; i++) assert.ok(Math.abs(all.ret[i]) < 0.25, 'no absurd daily return on ' + all.dates[i]);
  const deg = getSeries(DEMO_ACCOUNTS.degiro);
  for (let i = 0; i < deg.cash.length; i++) assert.ok(deg.cash[i] >= -1e-6, 'DEGIRO cash on ' + deg.dates[i] + ' = ' + deg.cash[i]);
  const sc = getSeries(DEMO_ACCOUNTS.scalable);
  assert.ok(sc.cash.every((c) => c === 0), 'auto account has no cash');
  assert.ok(sc.flowIn.reduce((a, b) => a + b, 0) > 5000, 'savings plans are inflows');

  // Trades at the synthetic close of their day
  for (const t of txnsFor(null)) {
    if (t.type === 'buy' || t.type === 'sell') assert.ok(Math.abs(priceOn(t.aid, t.date) - t.price) < 1e-9, `${t.aid} ${t.date}`);
  }
  const usd = S.data.txns.filter((t) => t.aid === 'demo-aapl' && (t.type === 'buy' || t.type === 'sell'));
  assert.ok(usd.length >= 2);
  for (const t of usd) {
    assert.ok(Math.abs(t.fx - historyFor('EURUSD=X').close[historyFor('EURUSD=X').dates.indexOf(t.date)]) < 1e-9);
    assert.ok(t.fxFee > 0, 'AutoFX fee on USD trades');
  }
  // Holdings replayed: quantities never negative
  const held = new Map();
  for (const t of txnsFor(null)) {
    if (t.type !== 'buy' && t.type !== 'sell') continue;
    const k = t.acc + '|' + t.aid;
    held.set(k, (held.get(k) || 0) + (t.type === 'buy' ? t.qty : -t.qty));
    assert.ok(held.get(k) >= -1e-9, 'oversold ' + k);
  }

  const pos = positions({});
  const open = pos.filter((p) => p.qty > 0);
  assert.equal(open.length, 8);
  for (const p of open) {
    assert.ok(p.value > 0 && p.cost > 0 && p.priceLocal > 0, p.aid);
    assert.ok(Math.abs(p.value - (p.qty * p.priceLocal) / p.fx) < 1e-6);
  }
  assert.ok(Math.abs(open.reduce((s, p) => s + p.weight, 0) - 1) < 1e-9);
  const total = open.reduce((s, p) => s + p.value, 0) + deg.cash[deg.cash.length - 1];
  assert.ok(Math.abs(total - all.value[all.value.length - 1]) < 1e-6, 'positions + cash = series value');

  // One sell with a gain and one with a loss
  const pls = realizedEvents(null).map((e) => e.pl);
  assert.equal(pls.length, 2);
  assert.ok(pls.some((x) => x > 0) && pls.some((x) => x < 0), pls.join(', '));

  // Income: dividends with withholding, BTP coupons, interest; nothing "missing" versus the synthetic market
  const types = new Set(S.data.txns.map((t) => (t.type === 'fee' ? 'fee:' + t.kind : t.type)));
  for (const k of ['deposit', 'buy', 'sell', 'div', 'interest', 'withdraw', 'fee:connectivity']) assert.ok(types.has(k), k);
  const divs = S.data.txns.filter((t) => t.type === 'div');
  assert.ok(divs.some((t) => t.aid === 'demo-btp' && t.tax > 0));
  assert.ok(divs.filter((t) => t.aid !== 'demo-vhyl').every((t) => t.tax > 0 && Math.abs(t.gross - t.tax - (t.fxFee || 0) - t.amount) < 0.011));
  assert.ok(S.data.txns.filter((t) => t.type === 'fee' && t.kind === 'connectivity').every((t) => t.amount === 2.5));
  const inc = incomeStats({ accIds: null, from: null, to: null, today: T, settings: S.data.settings });
  assert.equal(inc.missing.length, 0);
  assert.ok(inc.total > 0);

  // BTP: manual prices, consistent with its trades
  const btpPrices = S.data.prices['demo-btp'];
  assert.ok(btpPrices.length >= 10);
  assert.ok(btpPrices.every(([, p]) => p > 85 && p < 115));
});

test('removeDemo: clean dataset, user transactions keep their account and asset', () => {
  const clean = removeDemo(demoData({ today: T }));
  assert.equal(clean.settings.started, true);
  assert.deepEqual(clean.txns, []);
  assert.deepEqual(clean.assets, {});
  assert.deepEqual(clean.prices, {});
  assert.deepEqual(clean.watch, []);
  assert.deepEqual(clean.settings.externalPL, {});
  assert.equal(clean.settings.demoMarks, undefined);
  assert.equal(clean.accounts.length, 1);
  assert.ok(!clean.accounts[0].demo);
  load(clean);
  assert.equal(hasDemo(), false);
  assert.equal(getSeries('all'), null);

  // The user added a trade to the demo DEGIRO account on a demo asset, an own external P&L and an own watch item
  const d = demoData({ today: T });
  d.txns.push({ id: 'mine', acc: DEMO_ACCOUNTS.degiro, date: T, type: 'buy', aid: 'demo-enel', qty: 10, price: 8, fee: 1 });
  d.txns.push({ id: 'mine2', acc: DEMO_ACCOUNTS.degiro, date: T, type: 'buy', aid: 'demo-btp', qty: 1, price: 99, fee: 1 });
  d.settings.externalPL['2020'] = -50;
  d.watch.push({ id: 'w-mine', symbol: 'MSFT', ticker: 'MSFT', name: 'Microsoft', currency: 'USD', price: 0, target: 0, note: '' });
  const kept = removeDemo(d);
  assert.deepEqual(kept.txns.map((t) => t.id), ['mine', 'mine2']);
  assert.deepEqual(kept.accounts.map((a) => a.id), [DEMO_ACCOUNTS.degiro]);
  assert.equal(kept.accounts[0].demo, undefined);
  assert.deepEqual(Object.keys(kept.assets).sort(), ['demo-btp', 'demo-enel']);
  assert.equal(kept.assets['demo-enel'].priceSource, 'auto', 'live prices from now on');
  assert.equal(kept.assets['demo-enel'].demo, undefined);
  assert.equal(kept.assets['demo-btp'].priceSource, 'manual');
  assert.equal(kept.prices['demo-btp'], undefined, 'synthetic manual prices removed');
  assert.deepEqual(kept.settings.externalPL, { 2020: -50 });
  assert.deepEqual(kept.watch.map((w) => w.id), ['w-mine']);
  assert.ok(!JSON.stringify(kept).includes('"demo":true'));
  load(kept);
  assert.equal(hasDemo(), false);
});
