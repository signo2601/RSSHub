import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump, migrate } from '../js/state.js';
import { market } from '../js/market.js';
import { getSeries, positions, realizedEvents, priceOn, fxOn, cashAt } from '../js/engine.js';
import { todayISO, addDays } from '../js/util.js';

const T = todayISO();
const d = (n) => addDays(T, -n);

function load(data) {
  S.data = data;
  bump();
}

test('auto account: value, flows, TWR and realized P&L', () => {
  const data = blankData();
  data.assets.a1 = { id: 'a1', name: 'Test', symbol: '', type: 'stock', currency: 'EUR', priceSource: 'manual' };
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a1', date: d(10), qty: 10, price: 100, fee: 2 },
    { id: 't2', acc: 'acc1', type: 'sell', aid: 'a1', date: d(5), qty: 5, price: 120, fee: 1 },
    { id: 't3', acc: 'acc1', type: 'div', aid: 'a1', date: d(3), amount: 7 },
  ];
  data.prices.a1 = [[d(8), 110]];
  load(data);
  const s = getSeries('all');
  assert.equal(s.dates[0], d(10));
  assert.equal(s.value[0], 1000);
  assert.equal(s.flowIn[0], 1002);
  assert.ok(Math.abs(s.ret[0] - (1000 / 1002 - 1)) < 1e-12);
  const k8 = s.index(d(8));
  assert.equal(s.value[k8], 1100);
  const k5 = s.index(d(5));
  assert.equal(s.value[k5], 5 * 120); // without market data, trade prices are price points
  assert.equal(s.flowOut[k5], 599);
  const k3 = s.index(d(3));
  assert.equal(s.flowOut[k3], 7);
  assert.equal(s.income[k3], 7);
  const r = realizedEvents(null);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0].pl - (599 - 501)) < 1e-9);
  const p = positions({}).find((x) => x.aid === 'a1');
  assert.equal(p.qty, 5);
  assert.ok(Math.abs(p.cost - 501) < 1e-9);
  assert.equal(p.value, 600);
  assert.equal(p.income, 7);
  assert.equal(priceOn('a1', d(9)), 100);
});

test('track account: cash and deposits as external flows, FX conversion', () => {
  const data = blankData();
  data.accounts = [{ id: 'b', name: 'Broker', broker: 'DEGIRO', cashMode: 'track' }];
  data.assets.u = { id: 'u', name: 'US', symbol: 'USX', type: 'stock', currency: 'USD', priceSource: 'auto' };
  data.txns = [
    { id: 'd1', acc: 'b', type: 'deposit', date: d(6), amount: 2000 },
    { id: 'b1', acc: 'b', type: 'buy', aid: 'u', date: d(5), qty: 10, price: 110, fx: 1.1, fee: 1, fxFee: 0.5 },
  ];
  load(data);
  market.inject('USX', { currency: 'USD', dates: [d(5), d(1)], close: [110, 121], adj: [110, 121], divs: [] });
  market.inject('EURUSD=X', { currency: 'USD', dates: [d(5), d(1)], close: [1.1, 1.21], adj: [1.1, 1.21], divs: [] });
  const s = getSeries('b');
  assert.equal(s.flowIn[0], 2000);
  const k5 = s.index(d(5));
  assert.ok(Math.abs(s.value[k5] - (2000 - 1.5)) < 1e-9);
  assert.equal(s.flowIn[k5], 0);
  const k1 = s.index(d(1));
  assert.ok(Math.abs(s.value[k1] - (1000 + 2000 - 1000 - 1.5)) < 1e-9); // 10*121/1.21 = 1000
  assert.ok(Math.abs(cashAt(null, T) - 998.5) < 1e-9);
  assert.equal(fxOn('USD', T), 1.21);
  const p = positions({}).find((x) => x.aid === 'u');
  assert.ok(Math.abs(p.fxPL - (1000 - 1100)) < 1e-9); // 1210 USD now worth 1000 EUR instead of 1100 EUR at the buy rate
});

test('migrate v1 data', () => {
  const v1 = { v: 1, settings: { started: true }, portfolios: [{ id: 'p1', name: 'Conto' }], assets: { a: { id: 'a', name: 'X', ticker: 'X', type: 'etf' } }, txns: [{ id: 't', pid: 'p1', aid: 'a', type: 'buy', date: '2025-01-02', qty: 1, price: 10 }], prices: {}, watch: [] };
  const v2 = migrate(v1);
  assert.equal(v2.v, 2);
  assert.equal(v2.accounts[0].id, 'p1');
  assert.equal(v2.txns[0].acc, 'p1');
  assert.equal(v2.assets.a.priceSource, 'manual');
});

/* ---------- Regression tests from the analytics audit ---------- */
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a} (diff ${a - b})`);
const mk = (id, extra = {}) => ({ id, name: 'T ' + id, ticker: id, symbol: '', type: 'stock', currency: 'EUR', priceSource: 'manual', ter: null, ...extra });

test('auto account: a same-day switch is not an external flow (daily flows are netted)', () => {
  const data = blankData();
  data.assets.a = mk('a');
  data.assets.b = mk('b');
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: d(10), qty: 10, price: 100 },
    // A rises 10% and is switched into B at the close
    { id: 't2', acc: 'acc1', type: 'sell', aid: 'a', date: d(5), qty: 10, price: 110 },
    { id: 't3', acc: 'acc1', type: 'buy', aid: 'b', date: d(5), qty: 11, price: 100 },
  ];
  data.prices.a = [[d(10), 100], [d(6), 100]];
  data.prices.b = [[d(5), 100]];
  load(data);
  const s = getSeries('all');
  const k = s.index(d(5));
  // The day's true return is A's +10%; gross flows (in 1100, out 1100) would have given +4,76%
  close(s.ret[k], 0.1);
  close(s.flowIn[k], 0);
  close(s.flowOut[k], 0);
  close(s.value[k], 1100);
});

test('day trade in an empty account: return on the capital used that day', () => {
  const data = blankData();
  data.assets.a = mk('a');
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: d(3), qty: 10, price: 100, fee: 1 },
    { id: 't2', acc: 'acc1', type: 'sell', aid: 'a', date: d(3), qty: 10, price: 103, fee: 1 },
  ];
  load(data);
  const s = getSeries('all');
  const k = s.index(d(3));
  close(s.flowOut[k], 1030 - 1 - 1001); // the 28 € gain leaves the account
  close(s.ret[k], 28 / 1001);
  close(realizedEvents(null)[0].pl, 28);
});

test('tracked account overdraft: the shortfall is money in, a later deposit pays it back', () => {
  const data = blankData();
  data.accounts = [{ id: 'b', name: 'Broker', broker: 'DEGIRO', cashMode: 'track' }];
  data.assets.a = mk('a');
  data.txns = [
    { id: 't1', acc: 'b', type: 'buy', aid: 'a', date: d(20), qty: 10, price: 100, fee: 2 },
    { id: 't2', acc: 'b', type: 'deposit', date: d(15), amount: 1500 },
  ];
  data.prices.a = [[d(20), 100], [d(17), 125]];
  load(data);
  const s = getSeries('all');
  const k0 = s.index(d(20));
  // No deposit yet: the cash is −1002 on the ledger, valued at 0, and 1002 € came from outside
  assert.equal(s.cash[k0], 0);
  close(s.value[k0], 1000);
  close(s.flowIn[k0], 1002);
  close(s.ret[k0], 1000 / 1002 - 1);
  // The deposit first repays the shortfall: only 498 € are new money
  const k1 = s.index(d(15));
  close(s.flowIn[k1], 498);
  close(s.cash[k1], 498);
  close(s.value[k1], 1748);
  // The return is the asset's +25% (less the fee), not a leveraged +150% on a negative balance
  let g = 1;
  for (const r of s.ret) g *= 1 + r;
  close(g - 1, 1250 / 1002 - 1, 1e-12);
  close(cashAt(null, T), 498); // the ledger balance after the deposit
});

test('sell larger than the shares recorded: the missing shares enter at the sale price', () => {
  const data = blankData();
  data.assets.a = mk('a');
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: d(50), qty: 10, price: 100 },
    { id: 't2', acc: 'acc1', type: 'sell', aid: 'a', date: d(20), qty: 15, price: 110, fee: 1 },
  ];
  load(data);
  const [e] = realizedEvents(null);
  assert.equal(e.qty, 15);
  assert.equal(e.missingQty, 5);
  close(e.proceeds, 1649);
  close(e.cost, 1000 + 550);
  close(e.pl, 99); // 10 × (110 − 100) − 1, not 649 of phantom gain
  const s = getSeries('all');
  const k = s.index(d(20));
  close(s.flowOut[k], 1649 - 550);
  close(s.ret[k], 0.1 - 0.001); // the asset's +10% minus the fee, not +65%
});

test('same-day sell all and buy back keeps the real cost; a sell typed before its buy waits for it', () => {
  const data = blankData();
  data.assets.a = mk('a');
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: d(100), qty: 10, price: 100 },
    // Tax-loss harvesting: sell everything at 60 and buy back right away
    { id: 't2', acc: 'acc1', type: 'sell', aid: 'a', date: d(50), qty: 10, price: 60 },
    { id: 't3', acc: 'acc1', type: 'buy', aid: 'a', date: d(50), qty: 10, price: 60 },
    // A day trade recorded in the wrong order (sell first): the sell waits for the buy
    { id: 't4', acc: 'acc1', type: 'sell', aid: 'a', date: d(10), qty: 15, price: 70 },
    { id: 't5', acc: 'acc1', type: 'buy', aid: 'a', date: d(10), qty: 5, price: 65 },
  ];
  load(data);
  const r = realizedEvents(null);
  close(r[0].pl, -400); // the whole loss, not half of it (buy-first gave −200)
  assert.equal(r[1].txId, 't4');
  assert.equal(r[1].missingQty, 0);
  close(r[1].pl, 10 * (70 - 60) + 5 * (70 - 65));
  const p = positions({ date: d(60) }).find((x) => x.aid === 'a');
  assert.equal(p.qty, 10);
  const p2 = positions({ date: d(40) }).find((x) => x.aid === 'a');
  close(p2.avgEUR, 60);
});

test('strings and missing numbers in transactions never become NaN', () => {
  const data = blankData();
  data.accounts = [{ id: 'b', name: 'Broker', broker: 'Altro', cashMode: 'track' }];
  data.assets.a = mk('a');
  data.txns = [
    { id: 't0', acc: 'b', type: 'deposit', date: d(60), amount: '2000' },
    { id: 't1', acc: 'b', type: 'buy', aid: 'a', date: d(50), qty: '10', price: '100', fee: 'x' },
    { id: 't2', acc: 'b', type: 'buy', aid: 'a', date: d(40), price: 100 },
    { id: 't3', acc: 'b', type: 'div', aid: 'a', date: d(30), amount: 'abc', gross: '5' },
    { id: 't4', acc: 'b', type: 'fee', date: d(20) },
  ];
  load(data);
  const s = getSeries('all');
  for (const arr of [s.value, s.cash, s.ret, s.flowIn, s.flowOut, s.income, s.invested]) assert.ok(arr.every(Number.isFinite));
  close(s.value[s.value.length - 1], 2000);
  const p = positions({}).find((x) => x.aid === 'a');
  assert.equal(p.qty, 10);
  close(p.cost, 1000);
  assert.ok(Number.isFinite(p.value) && Number.isFinite(p.unreal));
  close(cashAt(null, T), 1000);
});

test('a future-dated trade is not today\'s price; the day change includes the FX move', () => {
  const data = blankData();
  data.assets.a = mk('a');
  data.assets.u = mk('u', { symbol: 'UUU', currency: 'USD', priceSource: 'auto' });
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: d(50), qty: 10, price: 100 },
    { id: 't2', acc: 'acc1', type: 'buy', aid: 'a', date: addDays(T, 30), qty: 10, price: 150 },
    { id: 't3', acc: 'acc1', type: 'buy', aid: 'u', date: d(10), qty: 10, price: 200, fx: 1.1 },
  ];
  load(data);
  market.inject('UUU', { currency: 'USD', dates: [d(10), d(1), T], close: [200, 200, 202], adj: [200, 200, 202], divs: [] });
  market.inject('EURUSD=X', { currency: 'USD', dates: [d(10), d(1), T], close: [1.1, 1.1, 1.12], adj: [1.1, 1.1, 1.12], divs: [] });
  const pa = positions({}).find((x) => x.aid === 'a');
  assert.equal(pa.qty, 10);
  assert.equal(pa.priceLocal, 100); // not the 150 of the trade dated next month
  const pu = positions({}).find((x) => x.aid === 'u');
  close(pu.dayChangePct, 0.01); // the security's own move, in USD
  close(pu.dayChange, 10 * (202 / 1.12 - 200 / 1.1)); // EUR: −15,58 €, although the stock rose 1%
  assert.ok(pu.dayChange < 0);
});
