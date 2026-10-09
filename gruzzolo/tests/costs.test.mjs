import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump, FEE_KINDS } from '../js/state.js';
import { market } from '../js/market.js';
import { positions } from '../js/engine.js';
import { addDays } from '../js/util.js';
import { costStats, fiscalBackpack, terSnapshot, FISCAL_CLASS, _test } from '../js/costs.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a} (diff ${a - b})`);

function load(data) {
  S.data = data;
  bump();
}

const mk = (id, type = 'stock', extra = {}) => ({ id, name: 'Titolo ' + id, ticker: id.toUpperCase(), symbol: '', type, currency: 'EUR', priceSource: 'manual', ter: null, ...extra });

test('broker costs by kind, breakdown shares, monthly summary and events', () => {
  const data = blankData();
  data.accounts = [
    { id: 'dg', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'auto' },
    { id: 'sc', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'track' },
  ];
  data.assets.u = mk('u', 'stock', { currency: 'USD' });
  data.assets.e = mk('e', 'etf');
  data.txns = [
    { id: 'x0', acc: 'dg', type: 'fee', date: '2024-12-31', amount: 2.5, kind: 'connectivity', note: 'Connectivity 2024' }, // outside the period
    { id: 'b1', acc: 'dg', type: 'buy', aid: 'u', date: '2025-01-15', qty: 10, price: 100, fx: 1.1, fee: 2, fxFee: 1, ref: 'ORD-1' },
    { id: 'f1', acc: 'dg', type: 'fee', date: '2025-01-31', amount: 2.5, kind: 'connectivity', note: 'Connectivity 2025' },
    { id: 'd0', acc: 'sc', type: 'deposit', date: '2025-02-01', amount: 2000 },
    { id: 'b2', acc: 'sc', type: 'buy', aid: 'e', date: '2025-02-03', qty: 10, price: 100, fee: 0.99 },
    { id: 'v1', acc: 'dg', type: 'div', aid: 'u', date: '2025-03-10', amount: 7, tax: 3, fxFee: 0.3 },
    { id: 's1', acc: 'dg', type: 'sell', aid: 'u', date: '2025-04-20', qty: 5, price: 120, fx: 1.1, fee: 2, tax: 10 },
    { id: 'f2', acc: 'sc', type: 'fee', date: '2025-04-30', amount: 0.5, note: 'Costo vario' },
    { id: 't1', acc: 'sc', type: 'tax', date: '2025-05-05', amount: 4, kind: 'income' },
    { id: 't2', acc: 'sc', type: 'tax', date: '2025-05-06', amount: 1, kind: 'other' },
  ];
  load(data);

  const r = costStats({ accIds: null, from: '2025-01-01', to: '2025-06-30', today: '2025-06-30' });
  close(r.transaction, 2 + 0.99 + 2);
  close(r.autofx, 1 + 0.3);
  close(r.connectivity, 2.5);
  close(r.other, 0.5);
  close(r.totalBroker, 4.99 + 1.3 + 2.5 + 0.5);
  assert.deepEqual(r.breakdown.map((b) => b.key), ['transaction', 'autofx', 'connectivity', 'other']);
  assert.deepEqual(r.breakdown.map((b) => b.label), Object.values(FEE_KINDS));
  close(r.breakdown.reduce((s, b) => s + b.share, 0), 1);
  close(r.breakdown[0].share, 4.99 / 9.29);
  close(r.capitalTaxes, 10);
  close(r.incomeTaxes, 3 + 4);
  close(r.otherTaxes, 1);

  // Monthly rows: only months with broker costs or income taxes, most recent first
  assert.deepEqual(r.monthly.map((m) => m.month), ['2025-05', '2025-04', '2025-03', '2025-02', '2025-01']);
  const byMonth = Object.fromEntries(r.monthly.map((m) => [m.month, m]));
  close(byMonth['2025-01'].broker, 3 + 2.5);
  close(byMonth['2025-03'].broker, 0.3);
  close(byMonth['2025-03'].incomeTaxes, 3);
  close(byMonth['2025-03'].total, 3.3);
  close(byMonth['2025-05'].broker, 0);
  close(byMonth['2025-05'].incomeTaxes, 4);

  // Events: newest first, with account names and labels
  assert.equal(r.events.length, 7);
  assert.ok(r.events.every((e, i) => i === 0 || r.events[i - 1].date >= e.date));
  const first = r.events[0];
  assert.equal(first.date, '2025-04-30');
  assert.equal(first.accName, 'Scalable');
  assert.equal(first.label, FEE_KINDS.other);
  const fx = r.events.find((e) => e.kind === 'autofx' && e.date === '2025-01-15');
  assert.equal(fx.ref, 'ORD-1');
  assert.equal(fx.accName, 'DEGIRO');

  // Scope: one account only
  const sc = costStats({ accIds: ['sc'], from: '2025-01-01', to: '2025-06-30', today: '2025-06-30' });
  close(sc.totalBroker, 0.99 + 0.5);
  close(sc.breakdown[2].share, 0);
  close(sc.incomeTaxes, 4);
});

test('stamp duty: securities value at 31/12 of the previous year', () => {
  const data = blankData();
  data.assets.s = mk('s');
  data.assets.c = mk('c', 'cash');
  data.assets.e = mk('e', 'etf');
  data.assets.z = mk('z');
  data.txns = [
    { id: 'z1', acc: 'acc1', type: 'buy', aid: 'z', date: '2024-01-10', qty: 3, price: 100 },
    { id: 'z2', acc: 'acc1', type: 'sell', aid: 'z', date: '2024-06-01', qty: 3, price: 110, tax: 2.6 }, // closed before 31/12
    { id: 's1', acc: 'acc1', type: 'buy', aid: 's', date: '2024-03-01', qty: 10, price: 100 },
    { id: 'c1', acc: 'acc1', type: 'buy', aid: 'c', date: '2024-03-01', qty: 1000, price: 1 }, // cash: excluded
    { id: 'e1', acc: 'acc1', type: 'buy', aid: 'e', date: '2025-02-01', qty: 5, price: 50 }, // bought after 31/12
    { id: 'st', acc: 'acc1', type: 'tax', date: '2025-03-31', amount: 2.5, kind: 'stamp' },
    { id: 'so', acc: 'acc1', type: 'tax', date: '2024-12-31', amount: 1, kind: 'stamp' },
  ];
  data.prices.s = [['2024-12-20', 150], ['2025-01-10', 200]];
  load(data);

  const r = costStats({ accIds: null, from: '2025-01-01', to: '2025-09-30', today: '2025-09-30' });
  assert.equal(r.stampDuty.refDate, '2024-12-31');
  assert.equal(r.stampDuty.year, 2025);
  close(r.stampDuty.base, 1500);
  close(r.stampDuty.amount, 3);
  close(r.stampDuty.recorded, 2.5); // only the stamp duty recorded in 2025
  close(r.stampTaxes, 2.5);
  // Previous year (2024): capital tax 2.6 + recorded stamp 1 → nothing estimated
  assert.equal(r.prevYear, 2024);
  close(r.totalTaxesPrevYear, 3.6);
  assert.equal(r.estimatedStamp, 0);

  // In 2026, with no stamp duty recorded for 2025, it is estimated from 31/12/2024
  data.txns = data.txns.filter((t) => t.id !== 'st');
  load(data);
  const r2 = costStats({ accIds: null, from: '2026-01-01', to: '2026-02-01', today: '2026-02-01' });
  assert.equal(r2.stampDuty.refDate, '2025-12-31');
  close(r2.stampDuty.base, 10 * 200 + 5 * 50);
  assert.equal(r2.prevYear, 2025);
  close(r2.estimatedStamp, 3);
  close(r2.totalTaxesPrevYear, 3);
  close(r2.prevYearTaxes.stamp, 0);

  // Custom stamp-duty rate from settings
  const r3 = costStats({ accIds: null, from: '2025-01-01', to: '2025-09-30', today: '2025-09-30', settings: { ...data.settings, stampDuty: 0.001 } });
  close(r3.stampDuty.amount, 1.5);
});

test('TER: value-weighted over securities, coverage of ETFs and funds', () => {
  const data = blankData();
  data.assets.e1 = mk('e1', 'etf', { ter: 0.002 });
  data.assets.e2 = mk('e2', 'etf', { ter: null });
  data.assets.f1 = mk('f1', 'fund', { ter: 0.01 });
  data.assets.s1 = mk('s1', 'stock');
  data.assets.c1 = mk('c1', 'cash', { ter: 0.5 }); // cash never counts
  data.txns = [
    { id: '1', acc: 'acc1', type: 'buy', aid: 'e1', date: '2025-01-02', qty: 10, price: 100 },
    { id: '2', acc: 'acc1', type: 'buy', aid: 'e2', date: '2025-01-02', qty: 10, price: 50 },
    { id: '3', acc: 'acc1', type: 'buy', aid: 's1', date: '2025-01-02', qty: 20, price: 100 },
    { id: '4', acc: 'acc1', type: 'buy', aid: 'c1', date: '2025-01-02', qty: 999, price: 1 },
    { id: '5', acc: 'acc1', type: 'buy', aid: 'f1', date: '2025-02-01', qty: 5, price: 100 },
  ];
  load(data);

  const r = costStats({ accIds: null, from: '2025-01-02', to: '2025-03-31', today: '2025-03-31' });
  const { ter } = r;
  assert.equal(ter.series.dates[0], '2025-01-02');
  assert.equal(ter.series.dates[1], '2025-01-09');
  assert.equal(ter.series.dates.at(-1), '2025-03-31');
  const before = 2 / 3500; // 1000 × 0.2% over 3500 € of securities
  const after = (2 + 5) / 4000;
  ter.series.dates.forEach((dt, i) => close(ter.series.ter[i], dt < '2025-02-01' ? before : after));
  close(ter.end, after);
  close(ter.average, ter.series.ter.reduce((s, x) => s + x, 0) / ter.series.ter.length);
  assert.ok(ter.average < ter.end);
  close(ter.coverage, 1500 / 2000); // e2 (500 €) has no TER
  close(ter.annualCost, 7);
  close(ter.value, 4000);
  assert.equal(ter.byAsset.length, 4);
  assert.equal(ter.byAsset[0].aid, 's1');

  // No ETF or fund at all → full coverage; a snapshot without positions is skipped
  const snap = terSnapshot([{ aid: 's1', qty: 1, value: 100, asset: { type: 'stock', ter: null } }]);
  assert.equal(snap.coverage, 1);
  assert.equal(snap.ter, 0);
  const none = costStats({ accIds: null, from: '2024-01-01', to: '2024-12-31', today: '2024-12-31' });
  assert.equal(none.ter.series.dates.length, 0);
  assert.equal(none.ter.end, 0);
});

test('fiscal backpack: carry-forward, FIFO, expiry, ETF rule, external P&L', () => {
  assert.equal(FISCAL_CLASS.etf, 'capitale');
  assert.equal(FISCAL_CLASS.stock, 'diversi');
  const data = blankData();
  data.assets.st = mk('st');
  data.assets.et = mk('et', 'etf');
  data.assets.cs = mk('cs', 'cash');
  const round = (aid, buyDate, sellDate, buy, sell, id) => [
    { id: id + 'b', acc: 'acc1', type: 'buy', aid, date: buyDate, qty: 10, price: buy },
    { id: id + 's', acc: 'acc1', type: 'sell', aid, date: sellDate, qty: 10, price: sell },
  ];
  data.txns = [
    ...round('st', '2021-02-01', '2021-06-01', 200, 100, 'r1'), // −1000 (2021)
    ...round('st', '2022-02-01', '2022-07-01', 100, 70, 'r2'), // −300 (2022)
    ...round('et', '2022-01-10', '2023-05-01', 100, 150, 'r3'), // +500 ETF gain (2023): ignored
    ...round('st', '2023-01-10', '2023-03-01', 100, 120, 'r4'), // +200 (2023) → uses 2021
    ...round('et', '2024-01-10', '2024-06-01', 100, 85, 'r5'), // −150 ETF loss (2024): counts
    ...round('cs', '2024-01-01', '2024-02-01', 100, 120, 'r6'), // cash: excluded
    ...round('st', '2026-01-10', '2026-05-01', 100, 140, 'r7'), // +400 (2026)
  ];
  data.settings.externalPL = { 2025: 100 }; // gain realized elsewhere in 2025 → uses 2021
  load(data);

  // Seen from 2025: the 2021 loss is still usable through 2025
  const y25 = fiscalBackpack({ accIds: null, today: '2025-06-01' });
  assert.deepEqual(y25.rows.map((r) => r.year), [2020, 2021, 2022, 2023, 2024, 2025]);
  const r25 = Object.fromEntries(y25.rows.map((r) => [r.year, r]));
  assert.equal(r25[2020].status, 'nessun movimento');
  assert.equal(r25[2021].status, 'usabile entro 2025');
  close(r25[2021].remaining, 700);
  assert.equal(r25[2021].expires, 2025);
  assert.equal(r25[2025].status, 'in corso');
  close(r25[2025].external, 100);
  close(r25[2025].net, 100);
  close(y25.available, 700 + 300 + 150);
  close(y25.expired, 0);

  // Seen from 2026: 2021 expired, the 2026 gain uses 2022 (FIFO) then part of 2024
  const y26 = fiscalBackpack({ accIds: null, today: '2026-10-08' });
  assert.deepEqual(y26.rows.map((r) => r.year), [2021, 2022, 2023, 2024, 2025, 2026]);
  const r = Object.fromEntries(y26.rows.map((x) => [x.year, x]));
  close(r[2021].portfolio, -1000);
  close(r[2021].net, -1000);
  close(r[2021].remaining, 700);
  assert.equal(r[2021].status, 'scaduta');
  assert.deepEqual(r[2021].usedBy.map((u) => [u.year, u.amount]), [[2023, 200], [2025, 100]]);
  assert.equal(r[2022].status, 'compensata');
  close(r[2022].remaining, 0);
  close(r[2023].portfolio, 200); // the ETF gain is left out
  close(r[2023].ignored, 500);
  assert.equal(r[2023].status, 'anno positivo');
  assert.equal(r[2023].expires, null);
  close(r[2024].portfolio, -150); // ETF loss counts; the cash gain does not
  assert.equal(r[2024].status, 'usabile entro 2028');
  close(r[2024].remaining, 50);
  assert.equal(r[2025].status, 'anno positivo');
  close(r[2025].portfolio, 0);
  close(r[2025].external, 100);
  assert.equal(r[2026].status, 'in corso');
  close(r[2026].net, 400);
  assert.deepEqual(r[2026].used.map((u) => [u.year, u.amount]), [[2022, 300], [2024, 100]]);
  close(y26.available, 50);
  close(y26.potentialSaving, 50 * 0.26);
  close(y26.expired, 700);
  assert.ok(y26.notes.length >= 5);
  assert.ok(y26.notes.some((n) => n.includes('48,08%')));
  assert.ok(y26.notes.some((n) => n.includes('26%')));

  // External loss creates a lot too
  data.settings.externalPL = { 2025: -80 };
  load(data);
  const ext = fiscalBackpack({ accIds: null, today: '2026-10-08' });
  const e25 = ext.rows.find((x) => x.year === 2025);
  close(e25.net, -80);
  assert.equal(e25.expires, 2029);
  // 2026 gain 400: 2022 (300) then 2024 (100 of 150) — 2025 lot untouched
  close(e25.remaining, 80);
  assert.equal(e25.status, 'usabile entro 2029');
  close(ext.available, 50 + 80);
  close(ext.expired, 800); // 2021 lot: only 200 used in 2023

  // Explicit settings override the stored ones
  const own = fiscalBackpack({ accIds: null, today: '2026-10-08', settings: { taxRate: 0.3, externalPL: {} } });
  close(own.potentialSaving, own.available * 0.3);
});

test('fiscal backpack walks back far enough for FIFO order', () => {
  const data = blankData();
  data.assets.st = mk('st');
  let n = 0;
  const round = (buyDate, sellDate, buy, sell) => {
    n++;
    return [
      { id: 'b' + n, acc: 'acc1', type: 'buy', aid: 'st', date: buyDate, qty: 1, price: buy },
      { id: 's' + n, acc: 'acc1', type: 'sell', aid: 'st', date: sellDate, qty: 1, price: sell },
    ];
  };
  data.txns = [
    ...round('2012-01-02', '2012-02-01', 300, 100), // −200 (2012, valid through 2016)
    ...round('2014-01-02', '2014-02-01', 100, 50), // −50 (2014)
    ...round('2016-01-02', '2016-02-01', 100, 300), // +200 (2016): uses 2012 entirely
    ...round('2018-01-02', '2018-02-01', 100, 130), // +30 (2018): uses 2014 (2012 is expired anyway)
  ];
  data.settings.externalPL = {};
  load(data);
  const r = fiscalBackpack({ accIds: null, today: '2019-03-01' });
  const row14 = r.rows.find((x) => x.year === 2014);
  close(row14.remaining, 20);
  assert.equal(row14.status, 'scaduta');
  close(r.expired, 20);
  close(r.available, 0);
  assert.equal(r.rows.find((x) => x.year === 2016).status, 'anno positivo');
});

test('TER snapshots: the incremental valuation matches engine.positions()', () => {
  const data = blankData();
  data.accounts = [
    { id: 'a', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'auto' },
    { id: 'b', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'track' },
  ];
  data.assets.u = mk('u', 'stock', { currency: 'USD', symbol: 'TERU', priceSource: 'auto' });
  data.assets.e = mk('e', 'etf', { ter: 0.0022 });
  data.assets.f = mk('f', 'fund', { ter: 0.015 });
  data.txns = [
    { id: '1', acc: 'a', type: 'buy', aid: 'u', date: '2025-01-03', qty: 10, price: 100, fx: 1.08 },
    { id: '2', acc: 'b', type: 'buy', aid: 'u', date: '2025-01-20', qty: 4, price: 104, fx: 1.05 },
    { id: '3', acc: 'a', type: 'buy', aid: 'e', date: '2025-02-01', qty: 7, price: 90 },
    { id: '4', acc: 'a', type: 'sell', aid: 'u', date: '2025-03-01', qty: 12, price: 120, fx: 1.1 }, // more than account a holds
    { id: '5', acc: 'b', type: 'buy', aid: 'f', date: '2025-03-15', qty: 3, price: 200 },
    { id: '6', acc: 'b', type: 'sell', aid: 'e', date: '2025-04-01', qty: 1, price: 95 }, // nothing held in b
    { id: '7', acc: 'a', type: 'sell', aid: 'e', date: '2025-05-02', qty: 3, price: 99 },
  ];
  data.prices.e = [['2025-03-10', 92], ['2025-04-20', 97]];
  load(data);
  market.inject('TERU', { currency: 'USD', dates: ['2025-02-10', '2025-04-01', '2025-05-20'], close: [110, 125, 118], adj: [110, 125, 118], divs: [] });
  market.inject('EURUSD=X', { currency: 'USD', dates: ['2025-02-10', '2025-04-15'], close: [1.07, 1.12], adj: [1.07, 1.12], divs: [] });

  const walk = _test.holdingsWalker(null);
  for (let d = '2025-01-01'; d <= '2025-06-30'; d = addDays(d, 3)) {
    const mine = new Map(walk(d).map((p) => [p.aid, p]));
    const ref = positions({ accIds: null, date: d }).filter((p) => p.qty > 1e-9);
    assert.equal(mine.size, ref.length, `positions on ${d}`);
    for (const p of ref) {
      close(mine.get(p.aid).qty, p.qty, 1e-9);
      close(mine.get(p.aid).value, p.value, 1e-7);
    }
  }
  const r = costStats({ accIds: null, from: '2025-01-01', to: '2025-06-30', today: '2025-06-30' });
  r.ter.series.dates.forEach((d, i) => close(r.ter.series.ter[i], terSnapshot(positions({ accIds: null, date: d })).ter, 1e-12));
  const rb = costStats({ accIds: ['b'], from: '2025-01-01', to: '2025-06-30', today: '2025-06-30' });
  rb.ter.series.dates.forEach((d, i) => close(rb.ter.series.ter[i], terSnapshot(positions({ accIds: ['b'], date: d })).ter, 1e-12));
});
