import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump } from '../js/state.js';
import { market } from '../js/market.js';
import { getSeries } from '../js/engine.js';
import { todayISO, addDays, addMonths } from '../js/util.js';
import { incomeStats, frequencyLabel, matchPayments, ccyLabel } from '../js/income.js';

const T = todayISO();
const Y = T.slice(0, 4);
const d = (n) => addDays(T, -n);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a} (diff ${a - b})`);

function load(data) {
  S.data = data;
  bump();
}

const stock = (id, extra = {}) => ({ id, name: id.toUpperCase(), ticker: id.toUpperCase(), symbol: '', type: 'stock', currency: 'EUR', priceSource: 'manual', ter: null, ...extra });

test('frequency labels and payment matching', () => {
  assert.equal(frequencyLabel(12), 'Mensile');
  assert.equal(frequencyLabel(10), 'Mensile');
  assert.equal(frequencyLabel(4), 'Trimestrale');
  assert.equal(frequencyLabel(5), 'Trimestrale');
  assert.equal(frequencyLabel(3), 'Trimestrale');
  assert.equal(frequencyLabel(2), 'Semestrale');
  assert.equal(frequencyLabel(1), 'Annuale');
  assert.equal(frequencyLabel(7), 'Irregolare');
  assert.equal(frequencyLabel(0), 'Irregolare');
  // One recorded payment explains only one ex-date (the first whose window contains it)
  assert.deepEqual(matchPayments(['2025-01-01', '2025-02-01'], ['2025-01-28']), ['2025-01-28', null]);
  assert.deepEqual(matchPayments(['2025-01-01', '2025-02-01'], ['2025-01-20', '2025-02-20']), ['2025-01-20', '2025-02-20']);
  assert.deepEqual(matchPayments(['2025-03-01'], ['2025-02-20', '2025-04-16']), [null]); // 9 days before, 46 days after
  assert.equal(ccyLabel('USD'), 'Dollaro USA (USD)');
  assert.equal(ccyLabel('XYZ'), 'XYZ');
});

test('period totals, trailing yield, return decomposition and currencies', () => {
  const data = blankData();
  data.assets.a1 = stock('a1');
  data.assets.b1 = stock('b1', { type: 'bond' });
  data.assets.u1 = stock('u1', { currency: 'USD' });
  data.txns = [
    { id: 't1', acc: 'acc1', type: 'buy', aid: 'a1', date: d(500), qty: 100, price: 10 },
    { id: 't2', acc: 'acc1', type: 'div', aid: 'a1', date: d(400), amount: 20, tax: 7 },
    { id: 't3', acc: 'acc1', type: 'buy', aid: 'b1', date: d(300), qty: 10, price: 100 },
    { id: 't4', acc: 'acc1', type: 'div', aid: 'a1', date: d(100), amount: 30, tax: 10 },
    { id: 't5', acc: 'acc1', type: 'div', aid: 'b1', date: d(50), amount: 15, tax: 2 },
    { id: 't6', acc: 'acc1', type: 'interest', date: d(20), amount: 5 },
    { id: 't7', acc: 'acc1', type: 'buy', aid: 'u1', date: d(90), qty: 10, price: 22, fx: 1.1 },
    { id: 't8', acc: 'acc1', type: 'div', aid: 'u1', date: d(30), amount: 4, tax: 1 },
  ];
  data.prices.a1 = [[d(500), 10], [d(10), 12]];
  data.prices.b1 = [[d(300), 100]];
  data.prices.u1 = [[d(90), 22]];
  load(data);

  const r = incomeStats({ accIds: null, from: d(200), to: T, today: T });
  close(r.total, 30 + 15 + 5 + 4);
  close(r.dividends, 34);
  close(r.coupons, 15);
  close(r.interest, 5);
  close(r.taxes, 10 + 2 + 1);
  assert.equal(r.count, 4);

  // Trailing 12 months: everything but the d(400) dividend, over today's value of open positions
  const value = 100 * 12 + 10 * 100 + (10 * 22) / 1.1;
  close(r.value, value);
  close(r.income12m, 54);
  close(r.yield12m, 54 / value);

  // Decomposition of the period TWR
  const s = getSeries('all');
  const i0 = s.index(d(200));
  const i1 = s.index(T);
  let g = 1;
  let sv = 0;
  for (let k = i0; k <= i1; k++) {
    g *= 1 + s.ret[k];
    sv += s.value[k];
  }
  const avg = sv / (i1 - i0 + 1);
  close(r.twr, g - 1);
  close(r.incomeReturn, 54 / avg);
  close(r.priceReturn, g - 1 - 54 / avg);
  close(r.yieldPeriod, ((54 / avg) * 365) / (i1 - i0 + 1));

  // By currency (interest without an asset counts as EUR), sorted by value
  assert.deepEqual(r.byCurrency.map((x) => [x.key, x.value]), [['EUR', 50], ['USD', 4]]);
  assert.equal(r.byCurrency[0].label, 'Euro (EUR)');
  assert.deepEqual(r.bondByCurrency.map((x) => [x.key, x.value]), [['EUR', 1000]]);

  // Cumulative lines over the period: dividends include interest, coupons apart
  assert.equal(r.cumulative.dates[0], d(200));
  assert.equal(r.cumulative.dates.at(-1), T);
  close(r.cumulative.dividends.at(-1), 39);
  close(r.cumulative.coupons.at(-1), 15);
  const kBefore = r.cumulative.dates.indexOf(d(51));
  close(r.cumulative.dividends[kBefore], 30);
  close(r.cumulative.coupons[kBefore], 0);

  // Single-account scope with no data: empty but well formed
  const other = incomeStats({ accIds: ['nope'], from: null, to: T, today: T });
  assert.equal(other.total, 0);
  assert.equal(other.yield12m, 0);
  assert.equal(other.calendar(+Y).length, 12);
  assert.deepEqual(other.cumulative.dates, []);

  // All-time period (from = null) includes the old dividend
  const all = incomeStats({ accIds: null, from: null, to: T, today: T });
  close(all.total, 74);
});

test('forecast from market dividends, payment lag and missing dividends', () => {
  const data = blankData();
  data.assets.u = stock('u', { symbol: 'DIVU', currency: 'USD', priceSource: 'auto' });
  data.txns = [{ id: 'b1', acc: 'acc1', type: 'buy', aid: 'u', date: d(600), qty: 50, price: 100, fx: 1.1 }];
  load(data);
  const exDates = [d(420), d(330), d(240), d(150), d(60)];
  market.inject('DIVU', { currency: 'USD', dates: [d(600), d(1)], close: [100, 110], adj: [100, 110], divs: exDates.map((x) => [x, 0.5]) });
  market.inject('EURUSD=X', { currency: 'USD', dates: [d(600), d(1)], close: [1.1, 1.25], adj: [1.1, 1.25], divs: [] });

  let r = incomeStats({ accIds: null, from: null, to: T, today: T });
  assert.equal(r.forecastByAsset.length, 1);
  const f = r.forecastByAsset[0];
  assert.equal(f.source, 'market');
  assert.equal(f.count, 4); // d(420) is older than 12 months
  assert.equal(f.frequency, 'Trimestrale');
  assert.equal(f.currency, 'USD');
  close(f.perShare, 2);
  close(f.amount, ((4 * 0.5 * 50) / 1.25) * (1 - 0.26));
  close(r.forecast12m, f.amount);
  assert.deepEqual(f.nextDates, exDates.slice(1).map((x) => addMonths(x, 12)));
  assert.equal(r.frequency.label, 'Trimestrale');
  assert.deepEqual(r.frequency.byAsset, [{ aid: 'u', label: 'Trimestrale', count: 4 }]);

  // Missing: every ex-date of the last 400 days (d(420) is too old), newest first
  assert.deepEqual(r.missing.map((m) => m.date), [d(60), d(150), d(240), d(330)]);
  const m = r.missing.at(-1);
  assert.equal(m.qty, 50);
  close(m.perShare, 0.5);
  close(m.gross, 25 / 1.1); // FX at the ex-date (trade rate, before the 1.25 point)
  close(m.net, (25 / 1.1) * 0.74);

  // Record two of them (paid 20 days after the ex-date): they leave the list, and the
  // projected payment dates move by the learned 20-day lag
  data.txns.push(
    { id: 'v1', acc: 'acc1', type: 'div', aid: 'u', date: addDays(d(330), 20), amount: 16.8, tax: 3 },
    { id: 'v2', acc: 'acc1', type: 'div', aid: 'u', date: addDays(d(150), 20), amount: 16.8, tax: 3 },
  );
  load(data);
  r = incomeStats({ accIds: null, from: null, to: T, today: T });
  assert.deepEqual(r.missing.map((x) => x.date), [d(60), d(240)]);
  assert.deepEqual(r.forecastByAsset[0].nextDates, exDates.slice(1).map((x) => addDays(addMonths(x, 12), 20)));

  // A position sold before an ex-date is not suggested
  data.txns.push({ id: 's1', acc: 'acc1', type: 'sell', aid: 'u', date: d(100), qty: 50, price: 105, fx: 1.2 });
  load(data);
  r = incomeStats({ accIds: null, from: null, to: T, today: T });
  assert.deepEqual(r.missing.map((x) => x.date), [d(240)]);
  assert.equal(r.forecastByAsset.length, 0); // nothing held any more
  assert.equal(r.frequency.label, 'Nessuna');
});

test('forecast from recorded payments and calendar forecast flags', () => {
  const data = blankData();
  data.assets.m = stock('m');
  data.assets.k = stock('k', { type: 'bond' });
  const xDate = addDays(addMonths(T, -12), 3); // ~1 year ago: projected again ~3 days from now
  data.txns = [
    { id: 'b1', acc: 'acc1', type: 'buy', aid: 'm', date: d(700), qty: 10, price: 50 },
    { id: 'v1', acc: 'acc1', type: 'div', aid: 'm', date: xDate, amount: 10, tax: 3.5 },
    { id: 'b2', acc: 'acc1', type: 'buy', aid: 'm', date: d(100), qty: 10, price: 50 }, // qty doubles
    { id: 'v2', acc: 'acc1', type: 'div', aid: 'm', date: T, amount: 30, tax: 10 },
    { id: 'b3', acc: 'acc1', type: 'buy', aid: 'k', date: d(700), qty: 5, price: 100 },
    { id: 'c1', acc: 'acc1', type: 'div', aid: 'k', date: d(800), amount: 9 }, // older than 12 months: no forecast
  ];
  data.prices.m = [[d(700), 50]];
  data.prices.k = [[d(700), 100]];
  load(data);

  const r = incomeStats({ accIds: null, from: null, to: T, today: T });
  assert.equal(r.forecastByAsset.length, 1);
  const f = r.forecastByAsset[0];
  assert.equal(f.source, 'recorded');
  assert.equal(f.frequency, 'Semestrale');
  close(f.perShare, 10 / 10 + 30 / 20); // net per share at each payment
  close(f.amount, 2.5 * 20); // × today's quantity
  assert.deepEqual(f.nextDates, [addMonths(xDate, 12), addMonths(T, 12)]);

  const cal = r.calendar(+Y);
  assert.equal(cal.length, 12);
  const items = cal.flatMap((x) => x.items);
  const recorded = items.filter((x) => !x.forecast);
  const projected = items.filter((x) => x.forecast);
  assert.ok(recorded.some((x) => x.date === T && x.amount === 30 && x.kind === 'dividend'));
  for (const x of recorded) assert.equal(x.date.slice(0, 4), Y);
  for (const x of projected) {
    assert.ok(x.date > T, 'projected payments are in the future');
    assert.equal(x.date.slice(0, 4), Y);
  }
  const nextX = addMonths(xDate, 12);
  if (nextX.slice(0, 4) === Y) {
    // ~3 days from now, still this year: one projected payment of 1 €/share × 20 shares
    assert.equal(projected.length, 1);
    assert.equal(projected[0].date, nextX);
    assert.equal(projected[0].aid, 'm');
    close(projected[0].amount, 20);
    const month = cal[+nextX.slice(5, 7) - 1];
    close(month.total, month.items.reduce((s, x) => s + x.amount, 0));
  } else {
    assert.equal(projected.length, 0);
  }
  // Other years show recorded payments only
  const past = r.calendar(+Y - 1).flatMap((x) => x.items);
  assert.ok(past.every((x) => !x.forecast));
  assert.ok(r.years.includes(+Y));
});

test('missing dividends respect the account scope', () => {
  const data = blankData();
  data.accounts = [
    { id: 'a', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'auto' },
    { id: 'b', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'auto' },
  ];
  data.assets.e = stock('e', { symbol: 'DEMOE', priceSource: 'demo', type: 'etf' });
  data.txns = [
    { id: 'b1', acc: 'a', type: 'buy', aid: 'e', date: d(300), qty: 10, price: 20 },
    { id: 'b2', acc: 'b', type: 'buy', aid: 'e', date: d(300), qty: 30, price: 20 },
    { id: 'v1', acc: 'a', type: 'div', aid: 'e', date: d(85), amount: 1.5 },
  ];
  load(data);
  market.inject('demo:DEMOE', { currency: 'EUR', dates: [d(300), d(1)], close: [20, 21], adj: [20, 21], divs: [[d(90), 0.2]], synthetic: true });

  // Account a recorded it; account b did not; all accounts: one recorded payment covers the ex-date
  assert.equal(incomeStats({ accIds: ['a'], from: null, to: T, today: T }).missing.length, 0);
  const mb = incomeStats({ accIds: ['b'], from: null, to: T, today: T }).missing;
  assert.equal(mb.length, 1);
  assert.equal(mb[0].qty, 30);
  close(mb[0].gross, 6);
  close(mb[0].net, 6 * 0.74);
  assert.equal(incomeStats({ accIds: null, from: null, to: T, today: T }).missing.length, 0);
  // Demo assets use their synthetic history for the forecast too
  const fa = incomeStats({ accIds: ['b'], from: null, to: T, today: T }).forecastByAsset[0];
  close(fa.amount, 0.2 * 30 * 0.74);
});
