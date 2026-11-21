import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump, migrate } from '../js/state.js';
import { market } from '../js/market.js';
import { getSeries, cashAt, positions } from '../js/engine.js';
import {
  firstDate, nthDate, indexAfter, amountAt, scheduleBetween, nextRun, pendingRuns, yearAhead, runPlans, replaceWithReal,
  deletePlan, resetPlan, planTotals, planSummary, execution,
} from '../js/plans.js';
import { demoData, installDemoMarket, removeDemo } from '../js/demo.js';
import { iso, parseISO, addDays, todayISO, fmt } from '../js/util.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const at = (d, h = 12) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00`).getTime();

// Weekdays from..to, without the holidays given
function weekdays(from, to, holidays = []) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const wd = parseISO(d).getDay();
    if (wd !== 0 && wd !== 6 && !holidays.includes(d)) out.push(d);
  }
  return out;
}
function inject(symbol, dates, price = (i) => 100 + i * 0.5, extra = {}) {
  const close = dates.map((_, i) => price(i));
  market.inject(symbol, { currency: 'EUR', dates, close, adj: close, divs: [], ...extra });
}
function load(data) {
  S.data = data;
  bump();
  return data;
}
const etf = (id, symbol, currency = 'EUR') => ({ id, name: `ETF ${id}`, ticker: symbol, symbol, isin: '', type: 'etf', currency, exchange: '', priceSource: 'auto' });
const plan = (over = {}) => ({ id: 'pac1', acc: 'acc1', aid: 'a1', amount: 100, every: 1, day: 1, start: '2026-01-01', sepa: true, ...over });

/* ---------- Schedule ---------- */
test('schedule: first date, k-th date, index after a date', () => {
  const p = plan({ start: '2026-01-15', day: 10 });
  assert.equal(firstDate(p), '2026-02-10', 'the 10th of January is before the start');
  assert.equal(nthDate(p, 1), '2026-03-10');
  assert.equal(indexAfter(p, '2026-02-09'), 0);
  assert.equal(indexAfter(p, '2026-02-10'), 1);
  assert.equal(indexAfter(p, ''), 0);
  const q = plan({ start: '2026-01-01', day: 5, every: 3 });
  assert.deepEqual([0, 1, 2].map((k) => nthDate(q, k)), ['2026-01-05', '2026-04-05', '2026-07-05']);
  assert.equal(indexAfter(q, '2026-04-04'), 1);
  assert.equal(indexAfter(q, '2026-04-05'), 2);
  assert.equal(indexAfter(q, '2027-01-04'), 4);
  assert.equal(firstDate(plan({ start: '2026-01-05', day: 5 })), '2026-01-05', 'the start day itself counts');
});

test('schedule: yearly increase at every anniversary, next and pending purchases', () => {
  const p = plan({ start: '2024-01-01', every: 6, step: 0.02 });
  assert.deepEqual([0, 1, 2, 3, 4].map((k) => amountAt(p, k)), [100, 100, 102, 102, 104.04]);
  const m = plan({ start: '2026-01-01', day: 5, every: 3 });
  assert.deepEqual(nextRun(m, '2026-04-05'), { k: 1, date: '2026-04-05', amount: 100 }, 'today is the next purchase');
  assert.equal(nextRun({ ...m, paused: true }, '2026-04-05'), null);
  assert.equal(nextRun({ ...m, end: '2026-03-31' }, '2026-04-01'), null, 'over');
  assert.deepEqual(pendingRuns(m, '2026-04-06').map((r) => r.date), ['2026-01-05', '2026-04-05'], 'nothing recorded yet');
  assert.deepEqual(pendingRuns({ ...m, done: '2026-01-05' }, '2026-04-06').map((r) => r.date), ['2026-04-05']);
  assert.deepEqual(scheduleBetween(m, '2026-01-05', '2026-07-04').map((r) => r.date), ['2026-01-05', '2026-04-05']);
  assert.equal(yearAhead(plan({ start: '2026-01-01' }), '2026-01-01'), 1200);
  assert.equal(yearAhead(plan({ start: '2026-01-01', every: 3, amount: 250 }), '2026-01-02'), 1000, 'Apr, Jul, Oct and 1 Jan');
  assert.equal(yearAhead(plan({ start: '2026-01-01', every: 3, amount: 250, end: '2026-12-31' }), '2026-01-02'), 750, 'ends before 1 Jan');
  assert.equal(yearAhead(plan({ paused: true }), '2026-01-02'), 0);
  fmt.hide = false;
  assert.equal(planSummary(plan({ amount: 50 }), '2026-03-01'), '50,00 € al mese');
});

/* ---------- Execution ---------- */
const TODAY = '2026-03-18';
const DATES = weekdays('2025-12-01', '2026-03-17', ['2026-01-01', '2026-02-02']);

test('runPlans: buys at the close of the first market day on or after the scheduled day', () => {
  inject('PAC1.DE', DATES, undefined, { updatedAt: at(TODAY, 9) });
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC1.DE');
  data.plans = [plan()];
  const res = runPlans({ data, today: TODAY });
  assert.equal(res.added.length, 3);
  assert.deepEqual(res.added.map((t) => t.date), ['2026-01-02', '2026-02-03', '2026-03-02'], 'holiday and weekends move to the next market day');
  const i = DATES.indexOf('2026-01-02');
  const t = res.added[0];
  close(t.price, 100 + i * 0.5);
  close(t.qty, Math.round((100 / t.price) * 1e6) / 1e6);
  assert.equal(t.id, 'p-pac1-2026-01-01');
  assert.equal(t.type, 'buy');
  assert.ok(t.plan === 'pac1' && t.gen && t.sepa);
  assert.equal(data.plans[0].done, '2026-03-01');
  // nothing new: the next purchase (1 April) is in the future
  const again = runPlans({ data, today: TODAY });
  assert.equal(again.added.length, 0);
  assert.equal(again.changed, false);
  assert.equal(data.txns.length, 3);
  const tot = planTotals('pac1', data);
  assert.equal(tot.count, 3);
  close(tot.paid, 300, 0.01);
  assert.equal(tot.first, '2026-01-02');
});

test('runPlans: waits for the final close and for data that has not arrived', () => {
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC2.DE');
  // the 17th is the last day of the data, downloaded on the 17th itself: maybe not its final close
  inject('PAC2.DE', DATES, undefined, { updatedAt: at('2026-03-17', 15) });
  data.plans = [plan({ day: 17, start: '2026-03-01' })];
  let res = runPlans({ data, today: TODAY });
  assert.equal(res.added.length, 0);
  assert.equal(data.plans[0].done, undefined);
  assert.equal(execution(data.assets.a1, '2026-03-17', TODAY), 'wait');
  // downloaded the day after: final
  inject('PAC2.DE', DATES, undefined, { updatedAt: at(TODAY, 8) });
  bump();
  res = runPlans({ data, today: TODAY });
  assert.deepEqual(res.added.map((t) => t.date), ['2026-03-17']);
  // a purchase scheduled today waits for tomorrow
  data.plans = [plan({ id: 'pac2', day: 18, start: '2026-03-18' })];
  assert.equal(runPlans({ data, today: TODAY }).added.length, 0);
  // no market data yet for a linked security: wait
  data.assets.a2 = etf('a2', 'NODATA.DE');
  data.plans = [plan({ id: 'pac3', aid: 'a2' })];
  assert.equal(runPlans({ data, today: TODAY }).added.length, 0);
  assert.equal(data.plans[0].done, undefined);
});

test('runPlans: holes in the market data and days before it starts', () => {
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC3.DE');
  const dates = DATES.filter((d) => d <= '2026-01-28' || d >= '2026-02-20');
  inject('PAC3.DE', dates, (i) => 50 + i, { updatedAt: at(TODAY, 8) });
  data.plans = [plan({ start: '2025-06-01' })];
  const res = runPlans({ data, today: TODAY });
  // June-November 2025 come before the data: skipped; February falls in the hole: last close before it
  assert.deepEqual(res.added.map((t) => t.date), ['2025-12-01', '2026-01-02', '2026-02-02', '2026-03-02']);
  assert.equal(data.plans[0].skipped, 6);
  close(res.added[2].price, 50 + dates.indexOf('2026-01-28'));
});

test('runPlans: securities without market data buy at their last price, on the day', () => {
  const data = load(blankData());
  data.assets.m1 = { id: 'm1', name: 'Fondo', ticker: '', symbol: '', isin: '', type: 'fund', currency: 'EUR', priceSource: 'manual' };
  data.prices.m1 = [['2025-12-20', 50]];
  data.plans = [plan({ aid: 'm1', day: 7, fee: 2 })];
  const res = runPlans({ data, today: TODAY });
  assert.deepEqual(res.added.map((t) => t.date), ['2026-01-07', '2026-02-09', '2026-03-09']);
  for (const t of res.added) {
    close(t.qty, 98 / 50);
    assert.equal(t.fee, 2);
  }
});

test('runPlans: securities in another currency are bought with the exchange rate of the day', () => {
  const data = load(blankData());
  data.assets.u1 = etf('u1', 'PACUS', 'USD');
  inject('PACUS', DATES, () => 220, { currency: 'USD', updatedAt: at(TODAY, 8) });
  inject(market.fxSymbol('USD'), DATES, () => 1.1, { currency: 'USD', updatedAt: at(TODAY, 8) });
  data.plans = [plan({ aid: 'u1', start: '2026-03-01' })];
  const [t] = runPlans({ data, today: TODAY }).added;
  close(t.qty, 0.5);
  assert.equal(t.fx, 1.1);
  close(t.price, 220);
});

test('runPlans: a paused plan skips its purchases; an existing purchase joins the plan', () => {
  inject('PAC4.DE', DATES, () => 100, { updatedAt: at(TODAY, 8) });
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC4.DE');
  data.plans = [plan({ paused: true })];
  const res = runPlans({ data, today: TODAY });
  assert.equal(res.added.length, 0);
  assert.equal(res.changed, true);
  assert.equal(data.plans[0].done, '2026-03-01');
  // the purchase of January was imported from the broker: it is not recorded twice
  data.plans = [plan()];
  data.txns = [{ id: 'real1', acc: 'acc1', aid: 'a1', type: 'buy', date: '2026-01-02', qty: 1.005, price: 100 }];
  bump();
  const r2 = runPlans({ data, today: TODAY });
  assert.deepEqual(r2.added.map((t) => t.date), ['2026-02-03', '2026-03-02']);
  assert.equal(data.txns.find((t) => t.id === 'real1').plan, 'pac1');
  assert.equal(data.txns.find((t) => t.id === 'real1').gen, undefined);
  assert.equal(planTotals('pac1', data).count, 3);
});

/* ---------- Money: SEPA purchases never use the cash of the account ---------- */
test('engine: SEPA purchases leave the cash of a tracked account alone and count as money in', () => {
  inject('PAC5.DE', DATES, () => 100, { updatedAt: at(TODAY, 8) });
  for (const sepa of [true, false]) {
    const data = load(blankData());
    data.accounts = [{ id: 'acc1', name: 'Broker', broker: 'Altro', cashMode: 'track' }];
    data.assets.a1 = etf('a1', 'PAC5.DE');
    data.txns = [{ id: 'd1', acc: 'acc1', type: 'deposit', date: '2025-12-15', amount: 1000 }];
    data.plans = [plan({ sepa })];
    runPlans({ data, today: TODAY });
    bump();
    assert.equal(data.txns.filter((t) => t.plan).length, 3);
    close(cashAt(null, TODAY), sepa ? 1000 : 700);
    const s = getSeries('all');
    const k = s.index('2026-01-02');
    close(s.flowIn[k], sepa ? 100 : 0);
    const pos = positions({}).find((p) => p.aid === 'a1');
    close(pos.qty, 3);
  }
});

/* ---------- Import, delete, recompute ---------- */
test('replaceWithReal: the purchases from the broker take the place of the simulated ones', () => {
  inject('PAC6.DE', DATES, () => 100, { updatedAt: at(TODAY, 8) });
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC6.DE');
  data.plans = [plan()];
  runPlans({ data, today: TODAY });
  const imported = [
    { id: 'imp1', acc: 'acc1', aid: 'a1', type: 'buy', date: '2026-02-03', qty: 0.99, price: 101, src: 'x' },
    { id: 'imp2', acc: 'acc1', aid: 'a1', type: 'buy', date: '2026-02-20', qty: 5, price: 100, src: 'x' },
  ];
  const n = replaceWithReal(data, imported);
  assert.equal(n, 1);
  assert.equal(imported[0].plan, 'pac1');
  assert.equal(imported[1].plan, undefined, 'a different purchase stays as it is');
  assert.ok(!data.txns.some((t) => t.id === 'p-pac1-2026-02-01'));
  assert.equal(data.txns.length, 2);
});

test('deletePlan and resetPlan', () => {
  inject('PAC7.DE', DATES, () => 100, { updatedAt: at(TODAY, 8) });
  const data = load(blankData());
  data.assets.a1 = etf('a1', 'PAC7.DE');
  data.plans = [plan(), plan({ id: 'pac9', day: 15 })];
  data.txns = [{ id: 'real1', acc: 'acc1', aid: 'a1', type: 'buy', date: '2026-01-02', qty: 1, price: 100 }];
  runPlans({ data, today: TODAY });
  assert.equal(data.txns.filter((t) => t.plan === 'pac1').length, 3);
  // recompute: the purchases it recorded go, the ones it adopted stay
  const p = data.plans[0];
  p.amount = 200;
  assert.equal(resetPlan(data, p), 2);
  assert.equal(p.done, undefined);
  const again = runPlans({ data, today: TODAY, only: 'pac1' });
  assert.deepEqual(again.added.map((t) => t.date), ['2026-02-03', '2026-03-02']);
  close(again.added[0].qty, 2);
  // delete keeping the purchases: they become ordinary ones
  assert.equal(deletePlan(data, 'pac1'), 0);
  assert.equal(data.plans.length, 1);
  assert.ok(data.txns.every((t) => t.plan !== 'pac1'));
  assert.equal(data.txns.filter((t) => t.acc === 'acc1').length, 3 + 3);
  // delete with the purchases: only those it recorded
  assert.equal(deletePlan(data, 'pac9', { purchases: true }), 3);
  assert.equal(data.txns.length, 3);
});

/* ---------- Data model ---------- */
test('migrate keeps valid plans; the example has two plans and loses them with the example', () => {
  const data = blankData();
  data.plans = [plan(), null, { amount: 5 }];
  assert.deepEqual(migrate(data).plans.map((p) => p.id), ['pac1']);
  assert.deepEqual(migrate({ v: 2, txns: [] }).plans, []);
  const T = todayISO();
  const d = demoData({ today: T });
  assert.deepEqual(d.plans.map((p) => [p.id, p.amount]), [['demo-pac-vwce', 200], ['demo-pac-eimi', 50]]);
  assert.ok(d.txns.filter((t) => t.plan === 'demo-pac-vwce').length > 20);
  assert.ok(d.txns.filter((t) => t.plan).every((t) => t.gen && t.sepa && t.demo && t.id.startsWith('p-demo-pac-')));
  // up to date: running the plans on the example records nothing new
  installDemoMarket({ today: T });
  load(migrate(d));
  const res = runPlans({ data: S.data, today: T });
  assert.equal(res.added.length, 0);
  const clean = removeDemo(d);
  assert.deepEqual(clean.plans, []);
  assert.equal(iso(parseISO(T)), T);
});
