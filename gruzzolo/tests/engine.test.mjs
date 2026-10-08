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
