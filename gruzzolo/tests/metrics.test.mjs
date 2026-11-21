import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump } from '../js/state.js';
import { market } from '../js/market.js';
import { addDays, dayDiff, stdev } from '../js/util.js';
import {
  periodBounds, periodStats, cumulative, drawdowns, maxDrawdown, monthlyReturns, activeMonthly, businessDays, rollingVol,
  benchReturns, xirr, annualize, regression, riskStats, backProjected, pricePoints, resolvePeriod, alignByDate,
  annualizedVolatility, downsideDeviation, positiveShare, isBusinessDay,
} from '../js/metrics.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a} (diff ${a - b})`);

// Fake engine Series: value follows value = (prev + flowIn) × (1 + ret) − flowOut, like the engine
function makeSeries(start, rets, { initial = 1000, deposits = {}, withdrawals = {}, income = {} } = {}) {
  const n = rets.length;
  const dates = [];
  for (let k = 0, d = start; k < n; k++, d = addDays(d, 1)) dates.push(d);
  const value = new Float64Array(n);
  const flowIn = new Float64Array(n);
  const flowOut = new Float64Array(n);
  const inc = new Float64Array(n);
  const ret = Float64Array.from(rets);
  let prev = 0;
  for (let k = 0; k < n; k++) {
    flowIn[k] = (k === 0 ? initial : 0) + (deposits[dates[k]] || 0);
    flowOut[k] = withdrawals[dates[k]] || 0;
    inc[k] = income[dates[k]] || 0;
    value[k] = (prev + flowIn[k]) * (1 + ret[k]) - flowOut[k];
    prev = value[k];
  }
  return {
    key: 'test', accIds: null, start: dates[0], end: dates[n - 1], dates, value, flowIn, flowOut, income: inc, ret,
    index(date) {
      if (date < dates[0]) return -1;
      return Math.min(dayDiff(dates[0], date), n - 1);
    },
  };
}

test('periodBounds: before start, inside, clamped end', () => {
  const s = makeSeries('2025-01-01', new Array(30).fill(0.001));
  let b = periodBounds(s, '2024-06-01', '2025-01-10');
  assert.deepEqual([b.i0, b.i1, b.startValue, b.from, b.to], [0, 9, 0, '2025-01-01', '2025-01-10']);
  b = periodBounds(s, '2025-01-01', null);
  assert.equal(b.i0, 0);
  assert.equal(b.startValue, 0);
  b = periodBounds(s, '2025-01-05', '2026-01-01');
  assert.equal(b.i0, 4);
  assert.equal(b.i1, 29);
  assert.equal(b.startValue, s.value[3]);
});

test('constant daily return: TWR, CAGR, IRR and sub-period', () => {
  const r = 0.001;
  const n = 100;
  const s = makeSeries('2025-01-01', new Array(n).fill(r));
  const st = periodStats(s, null, null, { rf: 0.02 });
  close(st.twr, (1 + r) ** n - 1, 1e-12);
  assert.equal(st.days, n);
  close(st.cagr, (1 + r) ** 365 - 1, 1e-9);
  close(st.startValue, 0);
  close(st.endValue, 1000 * (1 + r) ** n, 1e-9);
  close(st.netFlows, 1000);
  close(st.gain, st.endValue - 1000, 1e-9);
  // −1000 on day 0, end value 99 days later
  close(st.irr, ((1 + r) ** n) ** (365 / (n - 1)) - 1, 1e-6);
  // Constant calendar-day returns: Mondays carry the weekend (three days), so business-day
  // volatility is small but not zero; no drawdown, every day positive
  close(st.vol, annualizedVolatility(businessDays(s.dates, s.ret).ret), 1e-15);
  assert.ok(st.vol > 0 && st.vol < 0.02);
  assert.equal(st.maxDD, 0);
  assert.equal(st.maxDDFrom, null);
  assert.equal(st.positiveShare, 1);

  const sub = periodStats(s, '2025-01-11', '2025-01-20', { rf: 0 });
  close(sub.twr, (1 + r) ** 10 - 1, 1e-12);
  assert.equal(sub.days, 10);
  close(sub.startValue, s.value[9]);
  close(sub.endValue, s.value[19]);
  close(sub.irr, (1 + r) ** 365 - 1, 1e-6); // start value on 2025-01-10, end on 2025-01-20: 10 days, 10 returns
});

test('periodStats edge cases: no series, one day, everything sold', () => {
  assert.equal(periodStats(null, null, null), null);
  const one = periodStats(makeSeries('2026-10-08', [-0.002]), null, null, { rf: 0.02 });
  close(one.twr, -0.002, 1e-12);
  assert.equal(one.days, 1);
  assert.equal(one.shortPeriod, true);
  assert.equal(one.irr, null); // all flows on the same day
  assert.equal(one.vol, null);
  assert.equal(one.sharpe, null);
  // Bought, then sold everything: value goes to 0, the outflow carries the result
  const rets = new Array(400).fill(0);
  rets[1] = 0.1;
  const sold = makeSeries('2025-01-01', rets, { withdrawals: { '2026-01-01': 1100 } });
  const st = periodStats(sold, null, null, { rf: 0 });
  close(st.endValue, 0, 1e-9);
  close(st.twr, 0.1, 1e-12);
  close(st.outflows, 1100);
  close(st.gain, 100, 1e-9);
  close(st.irr, 0.1, 1e-6); // −1000 on 2025-01-01, +1100 on 2026-01-01
  // A gain of 10% in two days annualizes beyond +10000%: no IRR
  const fast = makeSeries('2025-01-01', [0, 0.1, 0], { withdrawals: { '2025-01-03': 1100 } });
  assert.equal(periodStats(fast, null, null).irr, null);
});

test('a deposit mid-period does not change TWR but changes IRR', () => {
  const rets = [];
  for (let k = 0; k < 200; k++) rets.push(k < 100 ? 0.002 : -0.001);
  const plain = makeSeries('2025-01-01', rets);
  const mid = plain.dates[100];
  const withDep = makeSeries('2025-01-01', rets, { deposits: { [mid]: 5000 } });
  const a = periodStats(plain, null, null, { rf: 0 });
  const b = periodStats(withDep, null, null, { rf: 0 });
  close(a.twr, b.twr, 1e-12);
  close(b.inflows, 6000);
  close(b.netFlows, 6000);
  assert.ok(a.irr > 0.1, `irr without deposit ${a.irr}`);
  assert.ok(b.irr < a.irr - 0.1, `irr with deposit ${b.irr} should be much lower than ${a.irr}`);
  // The deposit was put in just before the losing half: money-weighted return turns negative
  assert.ok(b.irr < 0);
});

test('xirr: known cases', () => {
  close(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 1100 }]), 0.1, 1e-6);
  // 2024 is a leap year: 366 days on a 365-day year convention (same as Excel XIRR)
  close(xirr([{ date: '2024-01-01', amount: -1000 }, { date: '2025-01-01', amount: 1100 }]), 1.1 ** (365 / 366) - 1, 1e-6);
  // Excel documentation example
  const ex = xirr([
    { date: '2008-01-01', amount: -10000 },
    { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 },
    { date: '2009-02-15', amount: 3250 },
    { date: '2009-04-01', amount: 2750 },
  ]);
  close(ex, 0.373362535, 1e-6);
  // Losing investment
  close(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: 500 }]), -0.5, 1e-6);
  // No sign change, single date, empty
  assert.equal(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2024-01-01', amount: -5 }]), null);
  assert.equal(xirr([{ date: '2023-01-01', amount: -1000 }, { date: '2023-01-01', amount: 1100 }]), null);
  assert.equal(xirr([]), null);
});

test('annualize', () => {
  close(annualize(0.21, 730), 0.1, 1e-3);
  close(annualize(0.1, 365), 0.1, 1e-12);
  assert.equal(annualize(-1.2, 100), -1);
  assert.equal(annualize(0.05, 0), 0.05);
  assert.equal(annualize(NaN, 10), null);
});

test('cumulative: base point 0 and last point equal to TWR', () => {
  const s = makeSeries('2025-03-01', [0.01, 0.02, -0.03, 0.04, 0.05]);
  const c = cumulative(s.dates, s.ret, '2025-03-02', '2025-03-04');
  assert.deepEqual(c.dates, ['2025-03-02', '2025-03-03', '2025-03-04']);
  assert.equal(c.cum[0], 0);
  const st = periodStats(s, '2025-03-02', '2025-03-04');
  close(c.cum[2], st.twr, 1e-12);
  close(st.twr, 1.02 * 0.97 * 1.04 - 1, 1e-12);
  assert.deepEqual(cumulative(s.dates, s.ret, '2026-01-01', '2026-02-01'), { dates: [], cum: [] });
});

test('drawdowns and max drawdown', () => {
  const dd = drawdowns([0, 0.1, -0.01, 0.21, 0.1, null]);
  close(dd[0], 0);
  close(dd[1], 0);
  close(dd[2], 0.99 / 1.1 - 1);
  close(dd[3], 0);
  close(dd[4], 1.1 / 1.21 - 1);
  assert.equal(dd[5], null);
  // A first-day loss counts against the base
  close(drawdowns([-0.05])[0], -0.05);

  const s = makeSeries('2025-01-01', [0, 0.1, -0.2, 0.05, 0.3, -0.1]);
  const st = periodStats(s, null, null, { rf: 0 });
  close(st.maxDD, -0.2, 1e-12);
  assert.equal(st.maxDDFrom, '2025-01-02');
  assert.equal(st.maxDDTo, '2025-01-03');
  const m = maxDrawdown([0, 0.1, -0.12, 0.2], ['a', 'b', 'c', 'd']);
  assert.equal(m.recovery, 'd');
});

test('monthly returns compound inside each calendar month', () => {
  const s = makeSeries('2025-01-30', [0.01, 0.02, -0.01, 0.03]);
  const m = monthlyReturns(s.dates, s.ret, null, null);
  assert.equal(m.length, 2);
  assert.equal(m[0].month, '2025-01');
  close(m[0].r, 1.01 * 1.02 - 1, 1e-12);
  assert.equal(m[1].month, '2025-02');
  close(m[1].r, 0.99 * 1.03 - 1, 1e-12);
  // Partial first month
  const p = monthlyReturns(s.dates, s.ret, '2025-01-31', '2025-02-01');
  close(p[0].r, 0.02, 1e-12);
  close(p[1].r, -0.01, 1e-12);
  // Monthly returns chain back to the period TWR
  const st = periodStats(s, null, null);
  close(m.reduce((g, x) => g * (1 + x.r), 1) - 1, st.twr, 1e-12);
  const am = activeMonthly(s.dates, s.ret, Float64Array.from([0, 0.01, 0, 0]), null, null);
  close(am[0].b, 0.01, 1e-12);
  close(am[0].active, 1.01 * 1.02 - 1 - 0.01, 1e-12);
});

test('business days: weekends compounded into the next weekday', () => {
  assert.equal(isBusinessDay('2025-01-03'), true); // Friday
  assert.equal(isBusinessDay('2025-01-04'), false);
  // Fri, Sat, Sun, Mon, Tue
  const bd = businessDays(['2025-01-03', '2025-01-04', '2025-01-05', '2025-01-06', '2025-01-07'], [0.01, 0.02, 0.03, 0.04, 0.05]);
  assert.deepEqual(bd.dates, ['2025-01-03', '2025-01-06', '2025-01-07']);
  close(bd.ret[0], 0.01);
  close(bd.ret[1], 1.02 * 1.03 * 1.04 - 1, 1e-12);
  close(bd.ret[2], 0.05);
  // Leading weekend
  const lead = businessDays(['2025-01-04', '2025-01-05', '2025-01-06'], [0.01, 0.02, 0.03]);
  assert.deepEqual(lead.dates, ['2025-01-06']);
  close(lead.ret[0], 1.01 * 1.02 * 1.03 - 1, 1e-12);
  // Trailing weekend goes into the last weekday
  const trail = businessDays(['2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'], [0.01, 0.02, 0.03, -0.04]);
  assert.deepEqual(trail.dates, ['2025-01-02', '2025-01-03']);
  close(trail.ret[1], 1.02 * 1.03 * 0.96 - 1, 1e-12);
  // Only a weekend: one point on the last day
  const wk = businessDays(['2025-01-04', '2025-01-05'], [0.01, 0.01]);
  assert.deepEqual(wk.dates, ['2025-01-05']);
  close(wk.ret[0], 1.01 * 1.01 - 1, 1e-12);
});

test('volatility, Sharpe and Sortino on business days', () => {
  // Alternating +1% / −1% every calendar day for 8 weeks
  const rets = [];
  for (let k = 0; k < 56; k++) rets.push(k % 2 ? -0.01 : 0.01);
  const s = makeSeries('2025-01-06', rets); // a Monday
  const st = periodStats(s, null, null, { rf: 0.02 });
  const bd = businessDays(s.dates, s.ret);
  assert.equal(st.n, 40);
  close(st.vol, stdev(bd.ret) * Math.sqrt(252), 1e-12);
  close(st.vol, annualizedVolatility(bd.ret), 1e-12);
  close(st.sharpe, (st.cagr - 0.02) / st.vol, 1e-12);
  close(st.sortino, (st.cagr - 0.02) / downsideDeviation(bd.ret, 0.02), 1e-12);
  const rfd = 1.02 ** (1 / 252) - 1;
  const dd = Math.sqrt(bd.ret.reduce((a, r) => a + Math.min(0, r - rfd) ** 2, 0) / bd.ret.length) * Math.sqrt(252);
  close(downsideDeviation(bd.ret, 0.02), dd, 1e-12);
  close(positiveShare([0.1, 0, -0.1, 0.2]), 2 / 3, 1e-12);
  assert.equal(positiveShare([0, 0]), null);
});

test('rolling volatility: null until the window is filled', () => {
  const dates = [];
  const ret = [];
  for (let k = 0, d = '2025-01-06'; k < 28; k++, d = addDays(d, 1)) {
    dates.push(d);
    ret.push(Math.sin(k) / 100);
  }
  const rv = rollingVol(dates, ret, 5);
  const bd = businessDays(dates, ret);
  assert.equal(rv.dates.length, bd.dates.length);
  assert.deepEqual(rv.vol.slice(0, 4), [null, null, null, null]);
  close(rv.vol[4], stdev(Array.from(bd.ret.slice(0, 5))) * Math.sqrt(252), 1e-12);
  close(rv.vol[rv.vol.length - 1], stdev(Array.from(bd.ret.slice(-5))) * Math.sqrt(252), 1e-12);
  const trimmed = rollingVol(dates, ret, 5, { from: '2025-01-20' });
  assert.equal(trimmed.dates[0], '2025-01-20');
});

test('regression: beta 2 for rp = 2·rb', () => {
  const rb = [];
  for (let i = 0; i < 300; i++) rb.push(Math.sin(i * 1.3) / 100 + 0.0003);
  const rp = rb.map((x) => 2 * x);
  const g = regression(rp, rb, 0);
  close(g.beta, 2, 1e-12);
  close(g.corr, 1, 1e-12);
  close(g.alpha, 0, 1e-12);
  close(g.te, stdev(rb) * Math.sqrt(252), 1e-12);
  // With a risk-free rate, a levered benchmark earns the borrowing spread back as alpha
  close(regression(rp, rb, 0.02).alpha, 0.02, 1e-9);
  const same = regression(rb, rb, 0.03);
  close(same.beta, 1, 1e-12);
  close(same.alpha, 0, 1e-12);
  close(same.te, 0, 1e-12);
  assert.equal(regression([0.1], [0.1], 0).beta, null);
});

test('riskStats: VaR, CVaR, gain/loss on a known vector', () => {
  const r = [];
  for (let i = 0; i < 20; i++) r.push((i - 10) / 100); // −0.10 … +0.09
  const st = riskStats(r, { rf: 0 });
  assert.equal(st.n, 20);
  close(st.var95, 0.0905, 1e-12); // interpolated 5% quantile: −0.10 + 0.95 × 0.01
  close(st.cvar95, 0.1, 1e-12);
  close(st.gainLoss, 0.05 / 0.055, 1e-12); // mean of +0.01…+0.09 vs mean of −0.01…−0.10
  close(st.positiveShare, 9 / 19, 1e-12);
  const g = r.reduce((a, x) => a * (1 + x), 1);
  close(st.annReturn, g ** (252 / 20) - 1, 1e-12);
  close(st.vol, stdev(r) * Math.sqrt(252), 1e-12);
  close(st.sharpe, st.annReturn / st.vol, 1e-12);
  assert.ok(st.maxDD < 0);
  assert.equal(st.best, 0.09);
  assert.equal(st.worst, -0.1);
  assert.equal(st.beta, null);
  const withBench = riskStats(r, { rf: 0, benchRet: r.map((x) => x / 2) });
  close(withBench.beta, 2, 1e-12);
  assert.equal(riskStats([], {}).annReturn, null);
});

test('benchReturns: EUR total return with FX and carry-forward', () => {
  const history = {
    symbol: 'SPY', currency: 'USD',
    dates: ['2025-01-02', '2025-01-03', '2025-01-06'],
    close: [200, 204, 202], // ignored: adjusted close wins
    adj: [100, 102, 101],
    divs: [],
  };
  const fxH = { symbol: 'EURUSD=X', currency: 'USD', dates: ['2025-01-02', '2025-01-06'], close: [1.1, 1.05], adj: [1.1, 1.05], divs: [] };
  const dates = [];
  for (let d = '2025-01-01'; d <= '2025-01-07'; d = addDays(d, 1)) dates.push(d);
  const r = benchReturns(history, fxH, dates);
  assert.ok(r instanceof Float64Array);
  assert.equal(r.coverageStart, '2025-01-02');
  close(r[0], 0); // before the history
  close(r[1], 0); // first price: nothing to compare with
  close(r[2], 102 / 100 - 1, 1e-12); // FX carried forward (1.1)
  close(r[3], 0); // weekend: carry-forward
  close(r[4], 0);
  close(r[5], (101 / 1.05) / (102 / 1.1) - 1, 1e-12);
  close(r[6], 0);
  // Missing FX history → local currency returns; EUR benchmark ignores FX
  const local = benchReturns(history, null, dates);
  close(local[5], 101 / 102 - 1, 1e-12);
  // History starting before the dates: the first day compares with the previous close
  const r2 = benchReturns(history, fxH, ['2025-01-03', '2025-01-04']);
  close(r2[0], 102 / 100 - 1, 1e-12);
  assert.equal(r2.coverageStart, '2025-01-03');
  // No adjusted close → close
  const noAdj = benchReturns({ ...history, currency: 'EUR', adj: undefined }, null, dates);
  close(noAdj[2], 204 / 200 - 1, 1e-12);
  // No history
  const none = benchReturns(null, null, dates);
  assert.equal(none.length, dates.length);
  assert.equal(none.coverageStart, null);
});

test('periodStats with benchmark: benchTwr and active return', () => {
  const s = makeSeries('2025-01-01', [0.01, 0.02, 0.03, 0.01]);
  const bench = Float64Array.from([0.005, 0.01, 0.01, 0.0]);
  const st = periodStats(s, '2025-01-02', null, { rf: 0, benchRet: bench });
  close(st.benchTwr, 1.01 * 1.01 * 1.0 - 1, 1e-12);
  close(st.activeVsBench, st.twr - st.benchTwr, 1e-12);
  const noBench = periodStats(s, null, null, { rf: 0 });
  assert.equal(noBench.benchTwr, null);
  assert.equal(noBench.activeVsBench, null);
  // Benchmark computed on a longer calendar (total series) realigned by date for an account series
  const longDates = [];
  for (let d = '2024-12-30'; d <= '2025-01-04'; d = addDays(d, 1)) longDates.push(d);
  const hist = { currency: 'EUR', dates: longDates, close: [100, 101, 102, 103, 104, 105], adj: [100, 101, 102, 103, 104, 105] };
  const br = benchReturns(hist, null, longDates);
  const acc = periodStats(s, null, null, { rf: 0, benchRet: br });
  close(acc.benchTwr, 105 / 101 - 1, 1e-12); // close of 2024-12-31 → close of 2025-01-04
});

test('pricePoints: live quote appended with the adjustment ratio', () => {
  const t = new Date(2025, 0, 7, 15, 0).getTime();
  const p = pricePoints({ dates: ['2025-01-03', '2025-01-06'], close: [50, 52], adj: [25, 26], price: 54, time: t });
  assert.deepEqual(p.dates, ['2025-01-03', '2025-01-06', '2025-01-07']);
  close(p.values[2], 27, 1e-12);
});

test('resolvePeriod and alignByDate', () => {
  assert.deepEqual(resolvePeriod('1M', { today: '2026-10-08', start: '2020-01-01' }), { from: '2026-09-09', to: '2026-10-08' });
  assert.deepEqual(resolvePeriod('YTD', { today: '2026-10-08', start: '2020-01-01' }), { from: '2026-01-01', to: '2026-10-08' });
  assert.deepEqual(resolvePeriod('1Y', { today: '2026-10-08', start: '2026-03-01' }), { from: '2026-03-01', to: '2026-10-08' });
  assert.deepEqual(resolvePeriod('ALL', { today: '2026-10-08', start: '2024-05-05' }), { from: '2024-05-05', to: '2026-10-08' });
  assert.deepEqual(resolvePeriod('CUSTOM', { today: '2026-10-08', start: '2024-05-05', from: '2025-06-01', to: '2025-01-01' }), { from: '2025-01-01', to: '2025-06-01' });
  assert.deepEqual(alignByDate(['a', 'b', 'c'], ['b', 'c', 'd'], [1, 2, 3]), [null, 1, 2]);
});

/* ---------- backProjected (histories injected into the market cache) ---------- */
function weekdaysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isBusinessDay(d)) out.push(d);
  return out;
}
function hist(symbol, currency, dates, fn) {
  const close = dates.map((d, i) => fn(i));
  return { symbol, currency, name: symbol, dates, close, adj: close.slice(), divs: [] };
}

test('backProjected: constant weights, FX conversion, missing assets', () => {
  const data = blankData();
  const mk = (id, symbol, currency, extra = {}) => ({ id, name: 'Asset ' + id, ticker: id, symbol, isin: '', type: 'etf', currency, exchange: '', sector: '', region: '', ter: null, priceSource: 'auto', ...extra });
  data.assets = {
    A: mk('A', 'T_AAA', 'EUR'),
    B: mk('B', 'T_BBB', 'USD'),
    C: mk('C', 'T_CCC', 'EUR'), // too short
    M: mk('M', '', 'EUR', { priceSource: 'manual' }),
    K: mk('K', '', 'EUR', { type: 'cash', priceSource: 'manual' }),
  };
  S.data = data;
  bump();
  const long = weekdaysBetween('2024-01-01', '2025-06-30');
  market.inject('T_AAA', hist('T_AAA', 'EUR', long, (i) => 100 * (1 + 0.01 * Math.sin(i / 3)) * (1 + i / 2000)));
  market.inject('T_BBB', hist('T_BBB', 'USD', long, (i) => 50 + (i % 7) - 3 + i / 50));
  market.inject('EURUSD=X', hist('EURUSD=X', 'USD', long.filter((_, i) => i % 3 !== 1), (i) => 1.08 + 0.02 * Math.cos(i / 5)));
  market.inject('T_CCC', hist('T_CCC', 'EUR', weekdaysBetween('2025-05-20', '2025-06-30'), (i) => 10 + i / 10));
  market.inject('T_BENCH', hist('T_BENCH', 'EUR', long, (i) => 80 + i / 10));

  const pos = (id, value, qty = 1) => ({ aid: id, asset: data.assets[id], qty, value });
  const positions = [pos('A', 600), pos('B', 400), pos('C', 1000), pos('M', 100), pos('K', 50), pos('A', 0, 0)];
  const bp = backProjected(positions, { years: 1, today: '2025-06-30', benchHistory: market.getHistory('T_BENCH') });

  assert.deepEqual(bp.missing.sort(), ['C', 'M']);
  assert.equal(bp.missingInfo.find((m) => m.aid === 'C').reason, 'short');
  assert.equal(bp.missingInfo.find((m) => m.aid === 'M').reason, 'nohistory');
  assert.deepEqual(bp.weights.map((w) => [w.aid, w.weight]), [['A', 0.6], ['B', 0.4]]);
  assert.equal(bp.start, '2024-06-30');
  assert.equal(bp.dates[0], '2024-07-01');
  assert.equal(bp.dates[bp.dates.length - 1], '2025-06-30');
  assert.ok(bp.dates.every(isBusinessDay));
  assert.equal(bp.ret.length, bp.dates.length);
  assert.deepEqual(bp.fxMissing, []);

  // Recompute one day by hand: EUR prices with carried-forward FX
  const hA = market.getHistory('T_AAA');
  const hB = market.getHistory('T_BBB');
  const hFx = market.getHistory('EURUSD=X');
  const at = (h, d) => {
    let v = null;
    for (let i = 0; i < h.dates.length && h.dates[i] <= d; i++) v = h.adj[i];
    return v;
  };
  const fxAt = (d) => at(hFx, d) ?? hFx.close[0];
  const k = 100;
  const d = bp.dates[k];
  const p = bp.dates[k - 1];
  const rA = at(hA, d) / at(hA, p) - 1;
  const rB = (at(hB, d) / fxAt(d)) / (at(hB, p) / fxAt(p)) - 1;
  close(bp.ret[k], 0.6 * rA + 0.4 * rB, 1e-12);
  // First return measured from the base date (a Sunday: Friday's prices carried forward)
  const r0A = at(hA, '2024-07-01') / at(hA, '2024-06-28') - 1;
  const r0B = (at(hB, '2024-07-01') / fxAt('2024-07-01')) / (at(hB, '2024-06-28') / fxAt('2024-06-28')) - 1;
  close(bp.ret[0], 0.6 * r0A + 0.4 * r0B, 1e-12);

  // Benchmark aligned to the same dates
  assert.equal(bp.bench.length, bp.dates.length);
  const hb = market.getHistory('T_BENCH');
  close(bp.bench[k], at(hb, d) / at(hb, p) - 1, 1e-12);
  assert.equal(bp.benchStart, '2024-06-30');

  // Risk profile on top of it
  const rs = riskStats(bp.ret, { rf: 0.02, benchRet: bp.bench, dates: bp.dates });
  assert.equal(rs.n, bp.dates.length);
  assert.ok(Number.isFinite(rs.beta) && Number.isFinite(rs.vol));
});

test('backProjected: window starts at the latest first date among included assets', () => {
  const data = blankData();
  const mk = (id, symbol) => ({ id, name: id, ticker: id, symbol, type: 'stock', currency: 'EUR', priceSource: 'auto' });
  data.assets = { X: mk('X', 'T_XXX'), Y: mk('Y', 'T_YYY'), U: mk('U', 'T_UUU') };
  data.assets.U.currency = 'NOK'; // no FX history: returns stay in local currency, flagged
  S.data = data;
  bump();
  market.inject('T_XXX', hist('T_XXX', 'EUR', weekdaysBetween('2020-01-01', '2025-06-30'), (i) => 100 + i / 10));
  market.inject('T_YYY', hist('T_YYY', 'EUR', weekdaysBetween('2025-03-03', '2025-06-30'), (i) => 20 + i / 100));
  market.inject('T_UUU', hist('T_UUU', 'NOK', weekdaysBetween('2020-01-01', '2025-06-30'), (i) => 300 + (i % 5)));
  const positions = ['X', 'Y', 'U'].map((id) => ({ aid: id, asset: data.assets[id], qty: 1, value: 100 }));
  const bp = backProjected(positions, { years: 5, today: '2025-06-30' });
  assert.equal(bp.start, '2025-03-03');
  assert.equal(bp.dates[0], '2025-03-04');
  assert.deepEqual(bp.missing, []);
  assert.deepEqual(bp.fxMissing, ['U']);
  bp.weights.forEach((w) => close(w.weight, 1 / 3, 1e-12));
  assert.equal(bp.bench, null);

  // Nothing usable
  const none = backProjected([{ aid: 'M', asset: { type: 'stock', priceSource: 'manual' }, qty: 1, value: 10 }], { today: '2025-06-30' });
  assert.equal(none.dates.length, 0);
  assert.deepEqual(none.missing, ['M']);
  assert.equal(riskStats(none.ret, {}).vol, null);
});

test('periodStats drawdown: the first day of the period counts, the peak is dated on its first day', () => {
  // Day 1 of the period +5%, day 2 −10%: the fall from the day-1 close is −10%
  // (cumulative() draws its base on day 1, which would only show −5,5%)
  const s = makeSeries('2025-03-01', [0.01, 0.05, -0.1, 0.01]);
  const st = periodStats(s, '2025-03-02', '2025-03-04', { rf: 0 });
  close(st.maxDD, -0.1, 1e-12);
  assert.equal(st.maxDDFrom, '2025-03-02');
  assert.equal(st.maxDDTo, '2025-03-03');
  // A loss on the first day itself counts against the base (the close before the period)
  const s2 = makeSeries('2025-03-01', [0.01, -0.08, 0.03]);
  const st2 = periodStats(s2, '2025-03-02', '2025-03-03', { rf: 0 });
  close(st2.maxDD, -0.08, 1e-12);
  assert.equal(st2.maxDDFrom, '2025-03-02'); // the base is labelled with the period start
  assert.equal(st2.maxDDTo, '2025-03-02');
  // A flat weekend after a top: the peak is the Friday, not the Sunday
  // 2025-01-03 is a Friday; Saturday and Sunday are flat, Monday falls
  const s3 = makeSeries('2025-01-01', [0, 0.02, 0.03, 0, 0, -0.04, 0.01]);
  const st3 = periodStats(s3, null, null, { rf: 0 });
  close(st3.maxDD, -0.04, 1e-12);
  assert.equal(st3.maxDDFrom, '2025-01-03');
  assert.equal(st3.maxDDTo, '2025-01-06');
  // maxDrawdown alone: ties keep the first peak, a base-level start is index 0
  const m = maxDrawdown([0, 0, -0.1], ['a', 'b', 'c']);
  assert.equal(m.from, 'a');
  assert.equal(m.to, 'c');
});
