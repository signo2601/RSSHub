import test from 'node:test';
import assert from 'node:assert/strict';
import { frontier, weeklyReturns, frontierCsv, portfolioFrontier, INSUFFICIENT_HISTORY } from '../js/markowitz.js';
import { S, blankData, bump } from '../js/state.js';
import { market } from '../js/market.js';
import { positions } from '../js/engine.js';
import { addDays } from '../js/util.js';

/* ---------- helpers ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  let u = 0;
  while (!u) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
// One-factor model of weekly returns
function factorData(N, T, seed) {
  const r = rng(seed);
  const beta = Array.from({ length: N }, () => 0.5 + r());
  const drift = Array.from({ length: N }, () => (r() * 0.25 - 0.03) / 52);
  const idio = Array.from({ length: N }, () => (0.1 + r() * 0.35) / Math.sqrt(52));
  const rows = [];
  for (let t = 0; t < T; t++) {
    const f = (gauss(r) * 0.15) / Math.sqrt(52);
    rows.push(beta.map((b, i) => drift[i] + b * f + idio[i] * gauss(r)));
  }
  return rows;
}
const names = (n) => Array.from({ length: n }, (_, i) => `Titolo ${i + 1}`);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const matVec = (C, w) => C.map((row) => sum(row.map((c, j) => c * w[j])));
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);

// KKT conditions of min ½wᵀCw s.t. Σw = 1, μᵀw = r, lo <= w <= hi:
// Cw = ν·1 + γ·μ + η_lo − η_hi with η >= 0 and γ >= 0 on the efficient branch.
function assertKkt(res, p, lo, hi, tol) {
  const w = p.weights;
  const g = matVec(res.cov, w);
  const mu = res.mu;
  const free = w.map((x, i) => i).filter((i) => w[i] > lo + 1e-6 && w[i] < hi - 1e-6);
  if (free.length < 3) return false; // too few free coordinates to identify ν and γ
  // least squares g_i = ν + γ μ_i over free coordinates
  const n = free.length;
  const sx = sum(free.map((i) => mu[i]));
  const sy = sum(free.map((i) => g[i]));
  const sxx = sum(free.map((i) => mu[i] * mu[i]));
  const sxy = sum(free.map((i) => mu[i] * g[i]));
  const den = n * sxx - sx * sx;
  const gamma = Math.abs(den) > 1e-18 ? (n * sxy - sx * sy) / den : 0;
  const nu = (sy - gamma * sx) / n;
  const scale = Math.max(...g.map(Math.abs));
  for (const i of free) close(g[i], nu + gamma * mu[i], tol * scale, `free residual i=${i}`);
  assert.ok(gamma >= -tol * scale, `gamma ${gamma} >= 0`);
  w.forEach((x, i) => {
    const resid = g[i] - nu - gamma * mu[i];
    if (x <= lo + 1e-6) assert.ok(resid >= -tol * scale * 10, `lower bound multiplier i=${i}: ${resid}`);
    if (x >= hi - 1e-6) assert.ok(resid <= tol * scale * 10, `upper bound multiplier i=${i}: ${resid}`);
  });
  return true;
}

/* ---------- frontier ---------- */
test('two uncorrelated assets: min-variance weights ∝ 1/σ², Ledoit–Wolf δ as expected', () => {
  // s1 = (+1, −1, +1, −1 …), s2 = (+1, +1, −1, −1 …) are orthogonal with zero mean over 4 weeks
  const T = 104;
  const a = 0.03;
  const b = 0.02;
  const returns = [];
  for (let t = 0; t < T; t++) {
    const s1 = t % 2 === 0 ? 1 : -1;
    const s2 = t % 4 < 2 ? 1 : -1;
    returns.push([0.002 + a * s1, 0.001 + b * s2]);
  }
  const res = frontier({ names: ['A', 'B'], returns, rf: 0.01, minW: 0, maxW: 1 });
  // d² = ((a² − b²)/2)², b̄² = a²b²/T
  const d2 = ((a * a - b * b) / 2) ** 2;
  const bb2 = (a * a * b * b) / T;
  close(res.shrinkage, bb2 / d2, 1e-12, 'shrinkage');
  assert.ok(res.shrinkage > 0 && res.shrinkage < 1);
  close(res.cov[0][1], 0, 1e-15, 'no correlation');
  const v0 = res.cov[0][0];
  const v1 = res.cov[1][1];
  const m = (a * a + b * b) / 2;
  close(v0, 52 * (res.shrinkage * m + (1 - res.shrinkage) * a * a), 1e-12, 'shrunk variance A');
  const expected0 = 1 / v0 / (1 / v0 + 1 / v1);
  close(res.minVar.weights[0], expected0, 1e-6, 'w_A');
  close(res.minVar.weights[1], 1 - expected0, 1e-6, 'w_B');
  close(res.mu[0], 0.002 * 52, 1e-12, 'annualized mean');
  close(res.assets[1].vol, Math.sqrt(v1), 1e-15, 'asset vol from shrunk diagonal');
  // Long only without caps: the top of the frontier is 100% in the best asset
  const top = res.frontier[res.frontier.length - 1];
  close(top.weights[0], 1, 1e-6, 'max-return corner');
});

test('three correlated assets without binding bounds: closed-form minimum variance', () => {
  const r = rng(11);
  const T = 300;
  const returns = [];
  for (let t = 0; t < T; t++) {
    const f = gauss(r) * 0.02;
    returns.push([0.001 + f + gauss(r) * 0.02, 0.0015 + 0.8 * f + gauss(r) * 0.025, 0.0008 + 0.6 * f + gauss(r) * 0.022]);
  }
  const res = frontier({ names: names(3), returns, rf: 0.02, minW: 0, maxW: 1 });
  // w = Σ⁻¹1 / 1ᵀΣ⁻¹1 (3×3 inverse by cofactors)
  const [[a, b, c], [d, e, f], [g, h, i]] = res.cov;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const inv = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  const raw = inv.map((row) => sum(row));
  const tot = sum(raw);
  const expected = raw.map((x) => x / tot);
  assert.ok(expected.every((x) => x > 0.05), 'interior solution expected for this data');
  expected.forEach((x, k) => close(res.minVar.weights[k], x, 1e-6, `w${k}`));
});

test('random portfolio: bounds, budget, monotone frontier, max Sharpe, KKT optimality', () => {
  const N = 12;
  const returns = factorData(N, 260, 3);
  const res = frontier({ names: names(N), returns, rf: 0.02, points: 25 });
  const lo = 0.001;
  const hi = 0.2;
  assert.equal(res.maxWUsed, hi);
  assert.equal(res.minWUsed, lo);
  assert.equal(res.capRelaxed, false);
  assert.ok(res.shrinkage >= 0 && res.shrinkage <= 1);
  assert.ok(res.frontier.length >= 20 && res.frontier.length <= 25);
  const all = [...res.frontier, res.minVar, res.maxSharpe];
  for (const p of all) {
    assert.equal(p.weights.length, N);
    close(sum(p.weights), 1, 1e-9, 'budget');
    for (const w of p.weights) assert.ok(w >= lo - 1e-12 && w <= hi + 1e-12, `weight ${w} in bounds`);
    assert.ok(Number.isFinite(p.ret) && Number.isFinite(p.vol) && Number.isFinite(p.sharpe));
    close(p.sharpe, (p.ret - 0.02) / p.vol, 1e-12, 'sharpe definition');
  }
  // Sorted by vol, return non-decreasing (efficient branch only)
  for (let k = 1; k < res.frontier.length; k++) {
    assert.ok(res.frontier[k].vol >= res.frontier[k - 1].vol, 'sorted by vol');
    assert.ok(res.frontier[k].ret >= res.frontier[k - 1].ret - 1e-9, 'return grows with vol');
  }
  // Evenly spaced in return
  const steps = res.frontier.slice(1).map((p, k) => p.ret - res.frontier[k].ret);
  const step = (res.frontier[res.frontier.length - 1].ret - res.frontier[0].ret) / (res.frontier.length - 1);
  for (const s of steps) close(s, step, step * 0.01, 'even spacing');
  // Min variance is the first point and the least volatile
  close(res.frontier[0].vol, res.minVar.vol, 1e-12);
  for (const p of res.frontier) assert.ok(p.vol >= res.minVar.vol - 1e-9);
  // Max Sharpe dominates every frontier point
  for (const p of res.frontier) assert.ok(res.maxSharpe.sharpe >= p.sharpe - 1e-6, `${res.maxSharpe.sharpe} >= ${p.sharpe}`);
  // Max return corner matches the greedy allocation
  const order = res.mu.map((m, i) => [m, i]).sort((x, y) => y[0] - x[0]);
  let left = 1 - N * lo;
  const greedy = new Array(N).fill(lo);
  for (const [, i] of order) {
    const add = Math.min(hi - lo, left);
    greedy[i] += add;
    left -= add;
  }
  close(res.frontier[res.frontier.length - 1].ret, sum(greedy.map((w, i) => w * res.mu[i])), 1e-5, 'max return');
  // Optimality of the frontier points (KKT with budget and return multipliers)
  let checked = 0;
  for (const p of res.frontier) if (assertKkt(res, p, lo, hi, 1e-4)) checked++;
  assert.ok(checked >= res.frontier.length / 2, `KKT verified on ${checked} points`);
  // Tangency: at the max-Sharpe portfolio the return multiplier is γ = σ² / (r − rf)
  {
    const p = res.maxSharpe;
    const w = p.weights;
    const gr = matVec(res.cov, w);
    const free = w.map((x, i) => i).filter((i) => w[i] > lo + 1e-6 && w[i] < hi - 1e-6);
    assert.ok(free.length >= 2);
    const n = free.length;
    const sx = sum(free.map((i) => res.mu[i]));
    const sy = sum(free.map((i) => gr[i]));
    const sxx = sum(free.map((i) => res.mu[i] ** 2));
    const sxy = sum(free.map((i) => res.mu[i] * gr[i]));
    const gamma = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    close(gamma / (p.vol ** 2 / (p.ret - 0.02)), 1, 1e-5, 'tangency multiplier');
  }
  // Minimum variance: KKT with the budget multiplier only
  const g = matVec(res.cov, res.minVar.weights);
  const freeIdx = res.minVar.weights.map((x, i) => i).filter((i) => res.minVar.weights[i] > lo + 1e-6 && res.minVar.weights[i] < hi - 1e-6);
  const nu = sum(freeIdx.map((i) => g[i])) / freeIdx.length;
  for (const i of freeIdx) close(g[i], nu, 1e-7, 'min-var gradient equal on free weights');
  res.minVar.weights.forEach((w, i) => {
    if (w <= lo + 1e-6) assert.ok(g[i] >= nu - 1e-7);
    if (w >= hi - 1e-6) assert.ok(g[i] <= nu + 1e-7);
  });
});

test('max Sharpe beats a dense scan of feasible random portfolios', () => {
  const N = 6;
  const returns = factorData(N, 156, 21);
  const res = frontier({ names: names(N), returns, rf: 0.015, minW: 0, maxW: 0.5 });
  const r = rng(5);
  const C = res.cov;
  for (let k = 0; k < 4000; k++) {
    // random point of the capped simplex (rejection sampling)
    const raw = Array.from({ length: N }, () => -Math.log(r() || 1e-12));
    const s = sum(raw);
    const w = raw.map((x) => x / s);
    if (w.some((x) => x > 0.5)) continue;
    const ret = sum(w.map((x, i) => x * res.mu[i]));
    const vol = Math.sqrt(sum(w.map((x, i) => x * matVec(C, w)[i])));
    assert.ok((ret - 0.015) / vol <= res.maxSharpe.sharpe + 1e-9);
    assert.ok(vol >= res.minVar.vol - 1e-9);
  }
});

test('shrinkage matches a direct implementation of the Ledoit–Wolf formulas', () => {
  const N = 5;
  const T = 60;
  const returns = factorData(N, T, 8);
  const res = frontier({ names: names(N), returns, rf: 0 });
  const mean = Array.from({ length: N }, (_, i) => sum(returns.map((row) => row[i])) / T);
  const X = returns.map((row) => row.map((x, i) => x - mean[i]));
  const Smat = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => sum(X.map((x) => x[i] * x[j])) / T));
  const m = sum(Smat.map((row, i) => row[i])) / N;
  let d2 = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d2 += (Smat[i][j] - (i === j ? m : 0)) ** 2;
  d2 /= N;
  let bb = 0;
  for (const x of X) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) bb += (x[i] * x[j] - Smat[i][j]) ** 2;
  bb = bb / (T * T) / N;
  const delta = Math.min(bb, d2) / d2;
  close(res.shrinkage, delta, 1e-10, 'delta');
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) close(res.cov[i][j], 52 * (delta * (i === j ? m : 0) + (1 - delta) * Smat[i][j]), 1e-12, `cov ${i},${j}`);
  }
});

test('edge cases: insufficient history, single asset, zero variance, infeasible cap', () => {
  assert.throws(() => frontier({ names: ['A'], returns: factorData(1, 20, 1) }), { message: INSUFFICIENT_HISTORY });
  assert.throws(() => frontier({ names: [], returns: [] }), { message: INSUFFICIENT_HISTORY });
  assert.throws(() => frontier({ names: [], returns: Array.from({ length: 30 }, () => []) }), /Storico insufficiente/);

  const one = frontier({ names: ['Solo'], returns: factorData(1, 40, 2), rf: 0.01 });
  assert.equal(one.frontier.length, 1);
  assert.deepEqual(one.frontier[0].weights, [1]);
  assert.deepEqual(one.minVar.weights, [1]);
  assert.deepEqual(one.maxSharpe.weights, [1]);
  close(one.frontier[0].ret, one.assets[0].ret, 1e-15);

  // A constant-price instrument next to two risky ones
  const rows = factorData(2, 80, 4).map((row) => [...row, 0]);
  const z = frontier({ names: ['A', 'B', 'Fermo'], returns: rows, rf: 0.02, minW: 0, maxW: 1 });
  const nums = [z.shrinkage, ...z.mu, ...z.cov.flat(), ...z.frontier.flatMap((p) => [p.ret, p.vol, ...p.weights]), z.minVar.vol, z.maxSharpe.ret];
  assert.ok(nums.every(Number.isFinite), 'no NaN with a zero-variance asset');
  assert.ok(z.minVar.weights[2] > 0.5, 'min variance leans on the flat asset');

  // Every instrument flat: no NaN, Sharpe undefined (null)
  const flat = frontier({ names: ['A', 'B'], returns: Array.from({ length: 30 }, () => [0, 0]), rf: 0.02 });
  assert.ok([flat.shrinkage, flat.minVar.vol, flat.minVar.ret, ...flat.minVar.weights].every(Number.isFinite));
  assert.equal(flat.minVar.sharpe, null);
  assert.equal(flat.frontier.length, 1);

  // 3 instruments cannot respect a 20% cap
  const three = factorData(3, 60, 9);
  const relaxed = frontier({ names: names(3), returns: three, rf: 0.02 });
  assert.equal(relaxed.capRelaxed, true);
  assert.equal(relaxed.maxWUsed, 1);
  assert.ok(relaxed.frontier.length > 5);
  assert.ok(relaxed.notes.some((s) => s.includes('peso massimo')));
  const equal = frontier({ names: names(3), returns: three, rf: 0.02, capFallback: 'equal' });
  close(equal.maxWUsed, 1 / 3, 1e-15);
  assert.equal(equal.frontier.length, 1);
  for (const w of equal.minVar.weights) close(w, 1 / 3, 1e-12);

  // Non-finite returns count as zero
  const holes = factorData(4, 40, 10);
  holes[3][1] = NaN;
  const h = frontier({ names: names(4), returns: holes, rf: 0, maxW: 0.5 });
  assert.ok(h.mu.every(Number.isFinite));
  assert.equal(h.notes.length, 1);
});

test('current portfolio is normalized and evaluated without bounds', () => {
  const returns = factorData(4, 52, 12);
  const res = frontier({ names: names(4), returns, rf: 0.02, maxW: 0.5, current: [2, 2, 0, 4] });
  assert.deepEqual(res.current.weights, [0.25, 0.25, 0, 0.5]);
  close(res.current.ret, 0.25 * res.mu[0] + 0.25 * res.mu[1] + 0.5 * res.mu[3], 1e-12);
  assert.equal(frontier({ names: names(4), returns, current: [1, 2] }).current, null);
  assert.equal(frontier({ names: names(4), returns }).current, null);
});

test('performance: 40 instruments × 520 weeks in < 1.5 s', () => {
  const returns = factorData(40, 520, 1);
  const t0 = performance.now();
  const res = frontier({ names: names(40), returns, rf: 0.02, current: new Array(40).fill(1) });
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  assert.equal(res.frontier.length, 30);
  for (const p of res.frontier) for (const w of p.weights) assert.ok(w >= 0.001 - 1e-12 && w <= 0.2 + 1e-12);
});

/* ---------- weeklyReturns ---------- */
// Business-day history from `start` to `end` with price(dayIndex, date)
function hist(start, end, price, { currency = 'EUR', skip = () => false, name } = {}) {
  const dates = [];
  const close = [];
  for (let d = start, k = 0; d <= end; d = addDays(d, 1), k++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || skip(d)) continue;
    dates.push(d);
    close.push(price(k, d));
  }
  return { symbol: name, name, currency, dates, close, adj: close.slice(), divs: [] };
}
const fxRate = (k) => 1.1 + 0.05 * Math.sin(k / 30);
const isFriday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 5;

test('weeklyReturns: Friday keys, EUR conversion with carried-forward FX, alignment, short items', () => {
  const today = '2024-06-12'; // a Wednesday: the current week is incomplete and left out
  const gapWeek = (d) => d >= '2022-06-06' && d <= '2022-06-10';
  const a = hist('2020-01-01', today, (k) => 100 * (1 + 0.001 * k) + 3 * Math.sin(k / 7), { name: 'A', skip: gapWeek });
  const b = hist('2021-03-17', today, () => 50, { name: 'B', currency: 'USD' }); // constant USD price
  const fx = hist('2019-06-03', today, (k) => fxRate(k), { name: 'EURUSD=X', currency: 'USD' });
  // FX has a hole on Fridays in March 2022: the rate of Thursday is carried forward
  const fxHoles = { ...fx, dates: [], close: [], adj: [] };
  fx.dates.forEach((d, i) => {
    if (d.startsWith('2022-03') && isFriday(d)) return;
    fxHoles.dates.push(d);
    fxHoles.close.push(fx.close[i]);
  });
  fxHoles.adj = fxHoles.close.slice();
  const short = hist('2024-01-02', today, (k) => 10 + k * 0.01, { name: 'Corto' });

  const items = [
    { name: 'A', history: a, fxHistory: null },
    { name: 'B', history: b, fxHistory: fxHoles },
    { name: 'Corto', history: short, fxHistory: null },
  ];
  const wk = weeklyReturns(items, { years: 10, today });
  assert.deepEqual(wk.names, ['A', 'B']);
  assert.deepEqual(wk.missing, ['Corto']);
  assert.equal(wk.missingInfo[0].reason, 'short');
  assert.deepEqual(wk.included, [0, 1]);
  assert.equal(wk.returns.length, wk.dates.length);
  assert.ok(wk.dates.every(isFriday), 'dates are Fridays');
  assert.equal(wk.start, '2021-03-19'); // week of B's first price
  assert.equal(wk.dates[0], '2021-03-26');
  assert.equal(wk.end, '2024-06-07'); // last complete week before today
  assert.ok(!wk.dates.includes('2022-06-10'), 'week without prices of A is skipped');
  assert.ok(wk.dates.includes('2022-06-17'));

  const fxOn = (d) => {
    let v = null;
    for (let i = 0; i < fxHoles.dates.length && fxHoles.dates[i] <= d; i++) v = fxHoles.close[i];
    return v;
  };
  const priceA = (d) => a.close[a.dates.lastIndexOf(a.dates.filter((x) => x <= d).pop())];
  for (let k = 1; k < wk.dates.length; k++) {
    const d0 = wk.dates[k - 1];
    const d1 = wk.dates[k];
    close(wk.returns[k][1], fxOn(d0) / fxOn(d1) - 1, 1e-12, `B return ${d1}`);
    close(wk.returns[k][0], priceA(d1) / priceA(d0) - 1, 1e-12, `A return ${d1}`);
  }
  // The 2-week return across the gap
  const kGap = wk.dates.indexOf('2022-06-17');
  assert.equal(wk.dates[kGap - 1], '2022-06-03');

  // Contract signature (histories, fxHistories, opts) gives the same numbers
  const wk2 = weeklyReturns([a, b, short], [null, fxHoles, null], { years: 10, today });
  assert.deepEqual(wk2.dates, wk.dates);
  assert.deepEqual(wk2.returns, wk.returns);

  // Shorter window
  const wk1 = weeklyReturns(items.slice(0, 2), { years: 1, today });
  assert.ok(wk1.returns.length >= 50 && wk1.returns.length <= 52, `${wk1.returns.length} weeks`);
  assert.ok(wk1.start >= '2023-06-12');

  // Without today: ends at the latest price; no clock involved
  const wk3 = weeklyReturns(items.slice(0, 2));
  assert.equal(wk3.end, '2024-06-07');

  // Dividend-adjusted close wins over close; a newer live quote is used (scaled by adj/close)
  const flatClose = { ...a, close: a.close.map(() => 100), adj: a.close.slice() };
  const wkAdj = weeklyReturns([{ name: 'A', history: flatClose }], { years: 10, today });
  close(wkAdj.returns[5][0], priceA(wkAdj.dates[5]) / priceA(wkAdj.dates[4]) - 1, 1e-12, 'adjusted close');
  const live = { ...a, price: 200, time: Date.UTC(2024, 5, 14, 15) }; // Friday 14 June 2024
  const wkLive = weeklyReturns([{ name: 'A', history: live }], { years: 10, today: '2024-06-15' });
  assert.equal(wkLive.end, '2024-06-14');
  close(wkLive.returns[wkLive.returns.length - 1][0], 200 / priceA('2024-06-07') - 1, 1e-12, 'live quote');

  // Nothing usable
  const none = weeklyReturns([{ name: 'X', history: null }, { name: 'Y', history: short }], { today });
  assert.deepEqual(none.returns, []);
  assert.deepEqual(none.missing, ['X', 'Y']);
  assert.equal(none.missingInfo[0].reason, 'nohistory');
});

test('weeklyReturns feeds frontier', () => {
  const today = '2025-12-31';
  const r = rng(77);
  const mk = (name, vol) => {
    let p = 100;
    return hist('2019-01-01', today, () => (p *= 1 + 0.0003 + vol * gauss(r)), { name });
  };
  const items = [mk('X', 0.01), mk('Y', 0.015), mk('Z', 0.008), mk('W', 0.02), mk('V', 0.012), mk('U', 0.011)].map((h) => ({ name: h.name, history: h, fxHistory: null }));
  const wk = weeklyReturns(items, { years: 5, today });
  const res = frontier({ names: wk.names, returns: wk.returns, rf: 0.02 });
  assert.equal(res.names.length, 6);
  assert.ok(res.frontier.length > 1);
});

/* ---------- CSV ---------- */
test('frontierCsv: header, rows, Italian decimals, quoting', () => {
  const returns = factorData(6, 80, 15);
  const nm = ['Alfa', 'Beta; Gamma', 'Delta "D"', 'Eta', 'Theta', 'Iota'];
  const res = frontier({ names: nm, returns, rf: 0.02, points: 10, current: [1, 1, 1, 1, 1, 1] });
  const csv = frontierCsv(res);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], 'Portafoglio;Rendimento atteso %;Volatilità %;Sharpe;Alfa;"Beta; Gamma";"Delta ""D""";Eta;Theta;Iota');
  assert.equal(lines.length, 1 + res.frontier.length + 3);
  assert.equal(lines[1].split(';')[0], 'Frontiera 1');
  assert.equal(lines[res.frontier.length].split(';')[0], `Frontiera ${res.frontier.length}`);
  assert.deepEqual(lines.slice(-3).map((l) => l.split(';')[0]), ['Minima varianza', 'Massimo Sharpe', 'Attuale']);
  for (const l of lines.slice(1)) {
    const cells = l.split(';');
    assert.equal(cells.length, 4 + 6);
    for (const c of cells.slice(1)) assert.match(c, /^-?\d+,\d{2}$/);
  }
  const ms = lines[lines.length - 2].split(';');
  assert.equal(ms[1], (res.maxSharpe.ret * 100).toFixed(2).replace('.', ','));
  assert.equal(ms[3], res.maxSharpe.sharpe.toFixed(2).replace('.', ','));
  const weights = ms.slice(4).map((c) => Number(c.replace(',', '.')));
  close(sum(weights), 100, 0.05);
  // Without current portfolio and without BOM
  const noCur = frontierCsv({ ...res, current: null }, { bom: false });
  assert.ok(noCur.startsWith('Portafoglio;'));
  assert.ok(!noCur.includes('Attuale'));
});

/* ---------- Wrapper on engine positions ---------- */
test('portfolioFrontier: open positions with market histories (EUR and USD)', () => {
  const today = '2025-06-30';
  const data = blankData();
  data.accounts = [{ id: 'acc', name: 'Conto', broker: 'DEGIRO', cashMode: 'auto' }];
  const r = rng(99);
  const syms = ['AAA.DE', 'BBB.DE', 'CCC.DE', 'DDD.DE', 'EEE.DE', 'UUU'];
  syms.forEach((s, i) => {
    let p = 50 + i * 10;
    const h = hist('2018-01-01', today, () => (p *= 1 + 0.0002 * (i + 1) + 0.01 * gauss(r)), { name: s, currency: s === 'UUU' ? 'USD' : 'EUR' });
    market.inject(s, h);
    data.assets[s] = { id: s, name: `Titolo ${s}`, ticker: s, symbol: s, type: 'etf', currency: h.currency, priceSource: 'auto' };
    data.txns.push({ id: 't' + i, acc: 'acc', type: 'buy', aid: s, date: '2025-01-02', qty: 10 + i, price: h.close[h.dates.indexOf('2025-01-02')], fx: s === 'UUU' ? 1.1 : undefined });
  });
  market.inject('EURUSD=X', hist('2018-01-01', today, (k) => fxRate(k), { name: 'EURUSD=X', currency: 'USD' }));
  data.assets.man = { id: 'man', name: 'Manuale', ticker: 'MAN', symbol: '', type: 'bond', currency: 'EUR', priceSource: 'manual' };
  data.txns.push({ id: 'tm', acc: 'acc', type: 'buy', aid: 'man', date: '2025-01-02', qty: 1, price: 100 });
  data.prices.man = [['2025-03-01', 101]];
  S.data = data;
  bump();
  const pos = positions({ date: today });
  const res = portfolioFrontier(pos, { today, years: 5, rf: 0.02 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.n, 6);
  assert.deepEqual([...res.aids].sort(), [...syms].sort());
  assert.deepEqual(res.missing.map((m) => m.aid), ['man']);
  assert.equal(res.missing[0].reason, 'manual');
  assert.ok(res.current && Math.abs(sum(res.current.weights) - 1) < 1e-12);
  assert.ok(res.weekly.weeks > 200);
  assert.equal(portfolioFrontier(pos, { today, years: 5, rf: 0.02 }), res, 'memoized');
  // Too little history in the window
  const few = portfolioFrontier(pos, { today: addDays('2018-01-01', 100), years: 5, rf: 0.02 });
  assert.equal(few.ok, false);
  assert.equal(few.error, INSUFFICIENT_HISTORY);
});
