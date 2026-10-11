// Efficient frontier (Markowitz) on weekly returns.
// - Covariance: sample covariance shrunk toward a scaled identity (Ledoit–Wolf 2004).
// - Portfolios: long only, fully invested, per-instrument bounds lo <= w <= hi.
// - Solver: for lambda >= 0 minimize ½wᵀΣw − λ·μᵀw with accelerated projected gradient (FISTA
//   with adaptive restart); projection onto the capped simplex by bisection on the shift τ.
// frontier(), weeklyReturns() and frontierCsv() are pure: no DOM, no clock ("today" is a parameter).
// Only the convenience wrapper portfolioFrontier() at the bottom reads engine / market data.
import { addMonths, iso } from './util.js';
import { assetHistory, historyFor } from './engine.js';
import { market } from './market.js';
import { cached } from './state.js';

export const MIN_WEEKS_FRONTIER = 26; // common weekly returns the optimizer needs
export const MIN_WEEKS_ASSET = 52; // weekly prices an instrument needs to take part
export const INSUFFICIENT_HISTORY = 'Storico insufficiente: servono almeno 26 settimane comuni';

const MAX_ITER = 5000;
const TOL_F = 1e-10; // objective change
const TOL_X = 1e-8; // largest weight change in one step
const VOL_EPS = 1e-12;

/* ---------- Date helpers (timezone-free) ---------- */
const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5);
const fromDayNum = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
// Friday of the ISO week (Monday → Sunday) that contains day number n (1970-01-01 was a Thursday)
const fridayOf = (n) => n - ((((n + 3) % 7) + 7) % 7) + 4;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);

/* ---------- Weekly returns ---------- */
// Sorted day numbers and values of a History: dividend-adjusted close when available
// (otherwise close), plus the live quote when it is newer than the last bar.
function pricePoints(h, { adjusted = true } = {}) {
  const days = [];
  const values = [];
  if (!h || !Array.isArray(h.dates)) return { days, values };
  const close = Array.isArray(h.close) ? h.close : [];
  const adj = Array.isArray(h.adj) ? h.adj : [];
  const useAdj = adjusted && adj.some((x) => x > 0);
  let ratio = 1; // adj / close of the last bar, applied to the live quote
  for (let i = 0; i < h.dates.length; i++) {
    const v = +(useAdj ? adj[i] : close[i]);
    if (!(v > 0) || !Number.isFinite(v) || !isDate(h.dates[i])) continue;
    const d = dayNum(h.dates[i]);
    const last = days.length ? days[days.length - 1] : -Infinity;
    if (d < last) continue;
    if (d === last) values[values.length - 1] = v;
    else {
      days.push(d);
      values.push(v);
    }
    const c = +close[i];
    if (useAdj && c > 0) ratio = v / c;
  }
  if (h.price > 0 && h.time) {
    const d = dayNum(iso(new Date(h.time)));
    const last = days.length ? days[days.length - 1] : -Infinity;
    const v = h.price * (useAdj ? ratio : 1);
    if (d === last) values[values.length - 1] = v;
    else if (d > last) {
      days.push(d);
      values.push(v);
    }
  }
  return { days, values };
}

// Prices in EUR: local / fx, with fx (units per EUR) carried forward; before the first
// FX point the first known rate is used.
function toEur(pts, fx) {
  if (!fx || !fx.days.length) return pts;
  const values = new Array(pts.days.length);
  let j = -1;
  for (let i = 0; i < pts.days.length; i++) {
    while (j + 1 < fx.days.length && fx.days[j + 1] <= pts.days[i]) j++;
    values[i] = pts.values[i] / fx.values[Math.max(j, 0)];
  }
  return { days: pts.days, values };
}

// Last price of each ISO week inside [lo, hi] (day numbers), keyed by the week's Friday.
// Weeks that end after `hi` (the current, incomplete week) are left out.
function weeklyPrices(pts, lo, hi) {
  const weeks = [];
  const values = [];
  for (let i = 0; i < pts.days.length; i++) {
    const d = pts.days[i];
    if (d > hi) break;
    const w = fridayOf(d);
    if (w < lo || w > hi) continue;
    if (weeks.length && weeks[weeks.length - 1] === w) values[values.length - 1] = pts.values[i];
    else {
      weeks.push(w);
      values.push(pts.values[i]);
    }
  }
  return { weeks, values };
}

function normalizeItems(a, b) {
  // Contract form: weeklyReturns(histories, fxHistories, opts)
  if (Array.isArray(b)) {
    return (a || []).map((h, i) => ({ name: (h && (h.name || h.symbol)) || `Titolo ${i + 1}`, history: h || null, fxHistory: b[i] || null }));
  }
  return (a || []).map((it, i) => {
    if (it && !('history' in it) && Array.isArray(it.dates)) return { name: it.name || it.symbol || `Titolo ${i + 1}`, history: it, fxHistory: null };
    return { name: (it && it.name) || `Titolo ${i + 1}`, history: (it && it.history) || null, fxHistory: (it && it.fxHistory) || null };
  });
}

/**
 * Aligned weekly EUR total returns of several instruments.
 * weeklyReturns(items, { years = 10, today }) with items = [{ name, history, fxHistory }]
 * (fxHistory = EURxxx=X history, null for EUR instruments). The contract form
 * weeklyReturns(histories, fxHistories, { years, today }) is accepted too.
 * Without `today` the window ends at the latest price among the items (the clock is never read).
 * → { dates, names, returns (T×N), missing: [name], missingInfo: [{ index, name, reason, weeks }],
 *     included: [item index], start, end }
 */
export function weeklyReturns(a, b, c) {
  const opts = (Array.isArray(b) ? c : b) || {};
  const years = opts.years > 0 ? opts.years : 10;
  const items = normalizeItems(a, b);
  const prepared = items.map((it) => {
    const h = it.history;
    let pts = pricePoints(h);
    const ccy = h && h.currency;
    if (it.fxHistory && ccy !== 'EUR') pts = toEur(pts, pricePoints(it.fxHistory, { adjusted: false }));
    return { name: String(it.name), pts };
  });

  let endDay = isDate(opts.today) ? dayNum(opts.today) : -Infinity;
  if (!isDate(opts.today)) for (const p of prepared) if (p.pts.days.length) endDay = Math.max(endDay, p.pts.days[p.pts.days.length - 1]);
  const empty = (missingInfo) => ({
    dates: [], names: [], returns: [], missing: missingInfo.map((m) => m.name), missingInfo, included: [], start: null, end: Number.isFinite(endDay) ? fromDayNum(endDay) : null,
  });
  if (!Number.isFinite(endDay)) return empty(prepared.map((p, index) => ({ index, name: p.name, reason: 'nohistory', weeks: 0 })));
  const startDay = dayNum(addMonths(fromDayNum(endDay), -12 * years));

  const missingInfo = [];
  const usable = [];
  prepared.forEach((p, index) => {
    if (!p.pts.days.length) {
      missingInfo.push({ index, name: p.name, reason: 'nohistory', weeks: 0 });
      return;
    }
    const wk = weeklyPrices(p.pts, startDay, endDay);
    if (wk.weeks.length < MIN_WEEKS_ASSET) missingInfo.push({ index, name: p.name, reason: 'short', weeks: wk.weeks.length });
    else usable.push({ index, name: p.name, wk, first: p.pts.days[0] });
  });
  if (!usable.length) return empty(missingInfo);

  // Common window: from the latest first price among usable items (or today − years)
  let from = startDay;
  for (const u of usable) from = Math.max(from, u.first);
  const n = usable.length;
  const byWeek = new Map();
  usable.forEach((u, j) => {
    for (let k = 0; k < u.wk.weeks.length; k++) {
      const w = u.wk.weeks[k];
      if (w < fridayOf(from)) continue;
      let row = byWeek.get(w);
      if (!row) byWeek.set(w, (row = { count: 0, v: new Array(n) }));
      row.v[j] = u.wk.values[k];
      row.count++;
    }
  });
  const weeks = [...byWeek.keys()].filter((w) => byWeek.get(w).count === n).sort((x, y) => x - y);
  const dates = [];
  const returns = [];
  for (let k = 1; k < weeks.length; k++) {
    const p0 = byWeek.get(weeks[k - 1]).v;
    const p1 = byWeek.get(weeks[k]).v;
    dates.push(fromDayNum(weeks[k]));
    returns.push(p1.map((x, j) => x / p0[j] - 1));
  }
  return {
    dates,
    names: usable.map((u) => u.name),
    returns,
    missing: missingInfo.map((m) => m.name),
    missingInfo,
    included: usable.map((u) => u.index),
    start: weeks.length ? fromDayNum(weeks[0]) : null,
    end: weeks.length ? fromDayNum(weeks[weeks.length - 1]) : null,
  };
}

/* ---------- Covariance ---------- */
// Ledoit–Wolf (2004) shrinkage of the sample covariance toward m·I. X: centered rows (T×N flat).
// Sample covariance uses 1/T, as in the paper. Returns { S (shrunk, flat N×N), delta }.
function shrunkCovariance(X, T, N) {
  const S = new Float64Array(N * N);
  for (let t = 0; t < T; t++) {
    const o = t * N;
    for (let i = 0; i < N; i++) {
      const xi = X[o + i];
      if (xi === 0) continue;
      const r = i * N;
      for (let j = i; j < N; j++) S[r + j] += xi * X[o + j];
    }
  }
  for (let i = 0; i < N; i++) {
    for (let j = i; j < N; j++) {
      S[i * N + j] /= T;
      S[j * N + i] = S[i * N + j];
    }
  }
  let tr = 0;
  let fro2 = 0;
  for (let i = 0; i < N; i++) tr += S[i * N + i];
  for (let k = 0; k < N * N; k++) fro2 += S[k] * S[k];
  const m = tr / N;
  let d2 = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const e = S[i * N + j] - (i === j ? m : 0);
      d2 += e * e;
    }
  }
  d2 /= N;
  // Σ_t ||x_t x_tᵀ − S||²_F = Σ_t ||x_t||⁴ − T·||S||²_F
  let q = 0;
  for (let t = 0; t < T; t++) {
    let r2 = 0;
    for (let i = 0; i < N; i++) r2 += X[t * N + i] * X[t * N + i];
    q += r2 * r2;
  }
  const bBar2 = Math.max(0, (q - T * fro2) / (T * T) / N);
  const b2 = Math.min(bBar2, d2);
  const delta = d2 > 0 ? Math.min(1, Math.max(0, b2 / d2)) : 0;
  const out = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) out[k] = (1 - delta) * S[k];
  for (let i = 0; i < N; i++) out[i * N + i] += delta * m;
  return { S: out, delta };
}

// Largest eigenvalue of a symmetric positive semidefinite matrix (power iteration)
function largestEigen(C, N) {
  let v = new Float64Array(N).fill(1 / Math.sqrt(N));
  let u = new Float64Array(N);
  let lam = 0;
  for (let it = 0; it < 1000; it++) {
    matVec(C, v, u, N);
    let nrm = 0;
    for (let i = 0; i < N; i++) nrm += u[i] * u[i];
    nrm = Math.sqrt(nrm);
    if (!(nrm > 0)) return 0;
    for (let i = 0; i < N; i++) u[i] /= nrm;
    const done = Math.abs(nrm - lam) <= 1e-12 * nrm;
    lam = nrm;
    [v, u] = [u, v];
    if (done) break;
  }
  return lam;
}

function matVec(C, x, out, N) {
  for (let i = 0; i < N; i++) {
    let s = 0;
    const r = i * N;
    for (let j = 0; j < N; j++) s += C[r + j] * x[j];
    out[i] = s;
  }
}
const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/* ---------- Projection onto { Σw = 1, lo <= w <= hi } ---------- */
// w = clip(v − τ, lo, hi) with τ found by bisection on Σ clip(v − τ) = 1 (a non-increasing,
// piecewise linear function of τ). Each step also tries the exact τ of the current active set.
function makeProjector(N, lo, hi) {
  const sumAt = (v, tau) => {
    let s = 0;
    for (let i = 0; i < N; i++) {
      const x = v[i] - tau;
      s += x <= lo ? lo : x >= hi ? hi : x;
    }
    return s;
  };
  return (v, out) => {
    if (hi - lo <= 1e-15) {
      out.fill(lo);
      return out;
    }
    let vmin = Infinity;
    let vmax = -Infinity;
    for (let i = 0; i < N; i++) {
      if (v[i] < vmin) vmin = v[i];
      if (v[i] > vmax) vmax = v[i];
    }
    let a = vmin - hi; // sum = N·hi >= 1
    let b = vmax - lo; // sum = N·lo <= 1
    let tau = 0.5 * (a + b);
    for (let it = 0; it < 200; it++) {
      tau = 0.5 * (a + b);
      let fixed = 0;
      let freeSum = 0;
      let nFree = 0;
      for (let i = 0; i < N; i++) {
        const x = v[i] - tau;
        if (x <= lo) fixed += lo;
        else if (x >= hi) fixed += hi;
        else {
          freeSum += v[i];
          nFree++;
        }
      }
      const s = fixed + freeSum - nFree * tau;
      if (nFree > 0) {
        const t2 = (fixed + freeSum - 1) / nFree;
        if (t2 >= a && t2 <= b && Math.abs(sumAt(v, t2) - 1) <= 1e-14) {
          tau = t2;
          break;
        }
      }
      if (s > 1) a = tau;
      else b = tau;
      if (b - a <= 1e-16 * Math.max(1, Math.abs(a), Math.abs(b))) break;
    }
    for (let i = 0; i < N; i++) {
      const x = v[i] - tau;
      out[i] = x <= lo ? lo : x >= hi ? hi : x;
    }
    return out;
  };
}

/* ---------- Solver ---------- */
// FISTA with function-value restart for min ½wᵀCw − λ·μᵀw over the capped simplex.
function makeSolver(C, mu, N, L, project) {
  const step = 1 / (L > 0 ? L * (1 + 1e-9) : 1);
  const x = new Float64Array(N);
  const xNew = new Float64Array(N);
  const y = new Float64Array(N);
  const v = new Float64Array(N);
  const Cx = new Float64Array(N);
  const CxNew = new Float64Array(N);
  const Cy = new Float64Array(N);
  let iterations = 0;

  function solve(lambda, w0, { tolF = TOL_F, tolX = TOL_X, maxIter = MAX_ITER } = {}) {
    project(w0, x); // warm start, made feasible
    matVec(C, x, Cx, N);
    let f = 0.5 * dot(x, Cx) - lambda * dot(mu, x);
    y.set(x);
    Cy.set(Cx);
    let t = 1;
    let momentum = false; // y was extrapolated beyond x
    for (let it = 0; it < maxIter; it++) {
      iterations++;
      for (let i = 0; i < N; i++) v[i] = y[i] - step * (Cy[i] - lambda * mu[i]);
      project(v, xNew);
      matVec(C, xNew, CxNew, N);
      const fNew = 0.5 * dot(xNew, CxNew) - lambda * dot(mu, xNew);
      if (momentum && fNew > f + 1e-14 * Math.abs(f)) {
        // Momentum overshoot: restart from the last iterate (the next step is a plain,
        // monotone projected-gradient step)
        t = 1;
        momentum = false;
        y.set(x);
        Cy.set(Cx);
        continue;
      }
      let dx = 0;
      for (let i = 0; i < N; i++) dx = Math.max(dx, Math.abs(xNew[i] - x[i]));
      const tNew = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
      const beta = (t - 1) / tNew;
      momentum = beta > 0;
      for (let i = 0; i < N; i++) {
        y[i] = xNew[i] + beta * (xNew[i] - x[i]);
        Cy[i] = CxNew[i] + beta * (CxNew[i] - Cx[i]);
      }
      const df = Math.abs(f - fNew);
      x.set(xNew);
      Cx.set(CxNew);
      f = fNew;
      t = tNew;
      if (df <= tolF && dx <= tolX) break;
    }
    return Float64Array.from(x);
  }
  solve.iterations = () => iterations;
  return solve;
}

// Highest-return portfolio over the capped simplex: everything at `lo`, the rest to the best μ up to `hi`
function maxReturnWeights(mu, N, lo, hi) {
  const w = new Float64Array(N).fill(lo);
  let left = 1 - N * lo;
  const order = [...mu.keys()].sort((i, j) => mu[j] - mu[i]);
  for (const i of order) {
    if (left <= 0) break;
    const add = Math.min(hi - lo, left);
    w[i] += add;
    left -= add;
  }
  return w;
}

const sharpeKey = (p) => (p && Number.isFinite(p.sharpe) ? p.sharpe : -Infinity);

/**
 * Efficient frontier of long-only portfolios.
 * input: { names, returns (T×N periodic returns), rf, periodsPerYear = 52, minW = 0.001, maxW = 0.2,
 *          points = 30, current?: weights, capFallback = 'none' | 'equal' }
 * When N·maxW < 1 the cap cannot be respected: capFallback 'none' (default) drops the cap
 * (hi = 1), 'equal' uses hi = 1/N (only the equal-weight portfolio is then feasible).
 * Throws Error(INSUFFICIENT_HISTORY) with N = 0 or fewer than 26 return rows.
 */
export function frontier(input = {}) {
  const {
    returns = [], rf: rfIn = 0, periodsPerYear = 52, minW = 0.001, maxW = 0.2, points = 30, current = null, capFallback = 'none',
  } = input;
  const T = Array.isArray(returns) ? returns.length : 0;
  const N = T && returns[0] ? returns[0].length : 0;
  if (!N || T < MIN_WEEKS_FRONTIER) throw new Error(INSUFFICIENT_HISTORY);
  const ppy = periodsPerYear > 0 ? periodsPerYear : 52;
  const rf = Number.isFinite(rfIn) ? rfIn : 0;
  const names = Array.from({ length: N }, (_, i) => String((input.names && input.names[i]) ?? `Titolo ${i + 1}`));
  const notes = [];

  // Means and centered returns (non-finite values count as 0)
  const R = new Float64Array(T * N);
  const meanP = new Float64Array(N);
  let bad = 0;
  for (let t = 0; t < T; t++) {
    const row = returns[t] || [];
    for (let i = 0; i < N; i++) {
      let r = +row[i];
      if (!Number.isFinite(r)) {
        r = 0;
        bad++;
      }
      R[t * N + i] = r;
      meanP[i] += r / T;
    }
  }
  if (bad) notes.push(`${bad} rendimenti non validi sono stati considerati pari a zero.`);
  for (let t = 0; t < T; t++) for (let i = 0; i < N; i++) R[t * N + i] -= meanP[i];

  const { S, delta } = shrunkCovariance(R, T, N);
  const C = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) C[k] = S[k] * ppy;
  const mu = Float64Array.from(meanP, (m) => m * ppy);

  // Bounds (long only)
  const lo = Math.max(0, Math.min(Number.isFinite(minW) ? minW : 0, 1 / N));
  let hi = Math.min(1, Number.isFinite(maxW) && maxW > 0 ? maxW : 1);
  let capRelaxed = false;
  if (hi * N < 1 - 1e-12) {
    capRelaxed = true;
    hi = capFallback === 'equal' ? 1 / N : 1;
    notes.push(
      capFallback === 'equal'
        ? `Con ${N} strumenti il peso massimo del ${pctIt(maxW)} non si può rispettare: si usa ${pctIt(hi)} per ciascuno.`
        : `Con ${N} strumenti il peso massimo del ${pctIt(maxW)} non si può rispettare: il limite non viene applicato.`,
    );
  }

  const evalW = (w) => {
    const Cw = new Float64Array(N);
    matVec(C, w, Cw, N);
    const ret = dot(mu, w);
    const vol = Math.sqrt(Math.max(0, dot(w, Cw)));
    return { ret, vol, sharpe: vol > VOL_EPS ? (ret - rf) / vol : null, weights: Array.from(w) };
  };

  const base = {
    names, n: N, t: T, periodsPerYear: ppy, rf,
    mu: Array.from(mu),
    cov: Array.from({ length: N }, (_, i) => Array.from(C.subarray(i * N, (i + 1) * N))),
    shrinkage: delta,
    assets: names.map((name, i) => ({ name, ret: mu[i], vol: Math.sqrt(Math.max(0, C[i * N + i])) })),
    minWUsed: lo, maxWUsed: hi, capRelaxed,
  };
  const currentPoint = evalCurrent(current, N, evalW);

  if (N === 1) {
    const p = evalW(Float64Array.of(1));
    return { ...base, frontier: [p], minVar: p, maxSharpe: p, current: currentPoint, notes };
  }

  const L = largestEigen(C, N);
  const project = makeProjector(N, lo, hi);
  const solve = makeSolver(C, mu, N, L, project);
  const equal = new Float64Array(N).fill(1 / N);

  // 1. Minimum variance (λ = 0)
  const wMin = solve(0, equal, { tolF: 1e-14, tolX: 1e-10 });
  const minVar = evalW(wMin);

  // 2. Geometric λ sweep up to the maximum-return corner
  const retMaxExact = dot(mu, maxReturnWeights(mu, N, lo, hi));
  let muMin = Infinity;
  let muMax = -Infinity;
  for (const m of mu) {
    muMin = Math.min(muMin, m);
    muMax = Math.max(muMax, m);
  }
  const spread = muMax - muMin;
  const sweep = [{ lam: 0, w: wMin, ret: minVar.ret }];
  const span = retMaxExact - minVar.ret;
  const tolR = Math.max(1e-10, 1e-6 * Math.abs(span));
  if (spread > 1e-12 && span > tolR) {
    let lam = (1e-4 * Math.max(L, 1e-12)) / spread;
    let w = wMin;
    let flat = 0;
    for (let k = 0; k < 90; k++) {
      w = solve(lam, w);
      const ret = dot(mu, w);
      const prev = sweep[sweep.length - 1].ret;
      sweep.push({ lam, w, ret });
      if (ret >= retMaxExact - tolR) break;
      flat = ret - prev <= 1e-3 * tolR ? flat + 1 : 0;
      if (flat >= 6) break;
      lam *= 2;
    }
  }
  // Sweep returns are non-decreasing in λ in theory; enforce it against solver noise
  for (let k = 1; k < sweep.length; k++) if (sweep[k].ret < sweep[k - 1].ret) sweep[k].ret = sweep[k - 1].ret;
  const top = sweep[sweep.length - 1];
  const retTop = top.ret;

  // 3. Points evenly spaced in return between min variance and max return
  const pts = [{ lam: 0, w: wMin }];
  const nPts = Math.max(2, Math.round(points) || 30);
  if (retTop - minVar.ret > tolR) {
    for (let j = 1; j < nPts - 1; j++) {
      const target = minVar.ret + ((retTop - minVar.ret) * j) / (nPts - 1);
      let k = 1;
      while (k < sweep.length - 1 && sweep[k].ret < target) k++;
      pts.push(solveForReturn(target, sweep[k - 1], sweep[k], solve, mu, tolR));
    }
    pts.push(top);
  }
  let curve = pts.map((p) => ({ ...evalW(p.w), lam: p.lam }));
  curve.sort((p, q) => p.vol - q.vol || p.ret - q.ret);
  curve = curve.filter((p, i) => i === 0 || Math.abs(p.ret - curve[i - 1].ret) > 1e-9 || Math.abs(p.vol - curve[i - 1].vol) > 1e-9);

  // 4. Maximum Sharpe: best λ among the sweep, golden-section search around it, polish
  let best = minVar;
  let bestLam = 0;
  let bestW = wMin;
  for (const s of sweep) {
    const p = evalW(s.w);
    if (sharpeKey(p) > sharpeKey(best)) {
      best = p;
      bestLam = s.lam;
      bestW = s.w;
    }
  }
  if (sweep.length > 1 && Number.isFinite(best.sharpe)) {
    const k = sweep.findIndex((s) => s.lam === bestLam);
    const lo3 = sweep[Math.max(0, k - 1)];
    const hi3 = sweep[Math.min(sweep.length - 1, k + 1)];
    const g = golden(lo3.lam, hi3.lam, bestW, solve, evalW);
    if (sharpeKey(g.p) > sharpeKey(best)) {
      best = g.p;
      bestLam = g.lam;
      bestW = g.w;
    }
  }
  for (const p of curve) {
    if (sharpeKey(p) > sharpeKey(best)) {
      best = p;
      bestLam = p.lam;
      bestW = Float64Array.from(p.weights);
    }
  }
  const polished = evalW(solve(bestLam, bestW, { tolF: 1e-15, tolX: 1e-11 }));
  const maxSharpe = sharpeKey(polished) >= sharpeKey(best) ? polished : best;

  curve = curve.map(({ lam: _lam, ...p }) => p);
  return { ...base, frontier: curve, minVar, maxSharpe: stripLam(maxSharpe), current: currentPoint, notes };
}

const stripLam = ({ lam: _lam, ...p }) => p;
const pctIt = (x) => `${(Math.round(x * 1000) / 10).toString().replace('.', ',')}%`;

function evalCurrent(current, N, evalW) {
  if (!Array.isArray(current) && !ArrayBuffer.isView(current)) return null;
  if (current.length !== N) return null;
  const w = Float64Array.from(current, (x) => (Number.isFinite(+x) && +x > 0 ? +x : 0));
  const s = w.reduce((acc, x) => acc + x, 0);
  if (!(s > 0)) return null;
  for (let i = 0; i < N; i++) w[i] /= s;
  return evalW(w);
}

// λ whose solution has return `target` (regula falsi, Illinois variant, on the monotone
// piecewise-linear map λ → return), starting from the convex combination of the brackets.
function solveForReturn(target, A, B, solve, mu, tolR) {
  let a = { lam: A.lam, w: A.w, ret: A.ret };
  let b = { lam: B.lam, w: B.w, ret: B.ret };
  let best = Math.abs(a.ret - target) <= Math.abs(b.ret - target) ? a : b;
  let side = 0;
  let fa = a.ret - target;
  let fb = b.ret - target;
  for (let it = 0; it < 30; it++) {
    if (Math.abs(fb - fa) <= 1e-18) break;
    const theta = Math.min(1, Math.max(0, -fa / (fb - fa)));
    const lam = a.lam + theta * (b.lam - a.lam);
    // Warm start: the (feasible) mix of the brackets whose return is exactly the target
    const mix = Math.min(1, Math.max(0, (target - a.ret) / (b.ret - a.ret || 1)));
    const w = solve(lam, Float64Array.from(a.w, (x, i) => (1 - mix) * x + mix * b.w[i]));
    const ret = dot(mu, w);
    const p = { lam, w, ret };
    if (Math.abs(ret - target) < Math.abs(best.ret - target)) best = p;
    if (Math.abs(ret - target) <= tolR) return p;
    const fp = ret - target;
    if (fp < 0) {
      a = p;
      fa = fp;
      if (side === -1) fb /= 2;
      side = -1;
    } else {
      b = p;
      fb = fp;
      if (side === 1) fa /= 2;
      side = 1;
    }
    if (b.lam - a.lam <= 1e-14 * Math.max(1, b.lam)) break;
  }
  return best;
}

// Golden-section search of the Sharpe ratio over λ ∈ [a, b] (unimodal along the frontier)
function golden(a, b, w0, solve, evalW) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let w = w0;
  const at = (lam) => {
    w = solve(lam, w);
    const p = evalW(w);
    return { lam, w, p, s: sharpeKey(p) };
  };
  let c = at(b - phi * (b - a));
  let d = at(a + phi * (b - a));
  for (let it = 0; it < 40 && b - a > 1e-9 * Math.max(1, b); it++) {
    if (c.s >= d.s) {
      b = d.lam;
      d = c;
      c = at(b - phi * (b - a));
    } else {
      a = c.lam;
      c = d;
      d = at(a + phi * (b - a));
    }
  }
  return c.s >= d.s ? c : d;
}

/* ---------- CSV ---------- */
const csvNum = (x, scale = 1) => {
  if (!Number.isFinite(x)) return '';
  const s = (x * scale).toFixed(2);
  return (s === '-0.00' ? '0.00' : s).replace('.', ',');
};
const csvText = (s) => {
  const t = String(s ?? '');
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/**
 * Frontier portfolios as CSV for spreadsheets: ';' separated, Italian decimal comma, 2 decimals,
 * percentages for return, volatility and weights. Starts with a UTF-8 BOM (bom: false to omit)
 * so Excel shows accented letters correctly; rows end with CRLF.
 */
export function frontierCsv(result, { bom = true } = {}) {
  const names = (result && (result.names || (result.assets || []).map((a) => a.name))) || [];
  const lines = [['Portafoglio', 'Rendimento atteso %', 'Volatilità %', 'Sharpe', ...names.map(csvText)].join(';')];
  const row = (label, p) => {
    if (!p) return;
    const w = p.weights || [];
    lines.push([csvText(label), csvNum(p.ret, 100), csvNum(p.vol, 100), csvNum(p.sharpe), ...names.map((_, i) => csvNum(w[i], 100))].join(';'));
  };
  ((result && result.frontier) || []).forEach((p, i) => row(`Frontiera ${i + 1}`, p));
  row('Minima varianza', result && result.minVar);
  row('Massimo Sharpe', result && result.maxSharpe);
  row('Attuale', result && result.current);
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

/* ---------- Convenience wrapper (reads engine / market) ---------- */
/**
 * Frontier of the CURRENT open positions (engine Position[]), memoized until data or market change.
 * → { ok: true, ...frontier(), aids, symbols, weekly: { start, end, weeks }, missing: [{ aid, name, reason, weeks }], fxMissing: [aid] }
 *   or { ok: false, error, missing, fxMissing } when there is not enough common history.
 */
export function portfolioFrontier(positions, { today, years = 10, rf = 0.02, minW = 0.001, maxW = 0.2, points = 30, capFallback = 'none' } = {}) {
  const open = (positions || []).filter((p) => p && p.qty > 0 && p.value > 0 && (p.asset || {}).type !== 'cash');
  const key = ['mkw', today, years, rf, minW, maxW, points, capFallback, ...open.map((p) => `${p.aid}=${Math.round(p.value * 100)}`)].join('|');
  return cached(key, () => {
    const missing = [];
    const fxMissing = [];
    const items = [];
    const refs = [];
    for (const p of open) {
      const a = p.asset || {};
      const name = a.name || a.ticker || a.symbol || p.aid;
      const h = assetHistory(a);
      if (!h || !Array.isArray(h.dates) || !h.dates.length) {
        missing.push({ aid: p.aid, name, reason: a.symbol && a.priceSource !== 'manual' ? 'nohistory' : 'manual', weeks: 0 });
        continue;
      }
      let ccy = h.currency || a.currency || 'EUR';
      if (ccy === 'GBp' || ccy === 'GBX') ccy = 'GBP'; // pence: same returns as pounds
      let fxHistory = null;
      if (ccy !== 'EUR') {
        fxHistory = historyFor(market.fxSymbol(ccy));
        if (!fxHistory) fxMissing.push(p.aid);
      }
      items.push({ name, history: h, fxHistory });
      refs.push(p);
    }
    const wk = weeklyReturns(items, { years, today });
    for (const m of wk.missingInfo) missing.push({ aid: refs[m.index].aid, name: m.name, reason: m.reason, weeks: m.weeks });
    const inc = wk.included.map((i) => refs[i]);
    if (!inc.length || wk.returns.length < MIN_WEEKS_FRONTIER) {
      return { ok: false, error: INSUFFICIENT_HISTORY, missing, fxMissing, weekly: { start: wk.start, end: wk.end, weeks: wk.returns.length } };
    }
    try {
      const res = frontier({ names: wk.names, returns: wk.returns, rf, minW, maxW, points, capFallback, current: inc.map((p) => p.value) });
      return {
        ok: true, ...res,
        aids: inc.map((p) => p.aid),
        symbols: inc.map((p) => (p.asset || {}).symbol || ''),
        weekly: { start: wk.start, end: wk.end, weeks: wk.returns.length },
        missing, fxMissing,
      };
    } catch (e) {
      return { ok: false, error: e.message, missing, fxMissing, weekly: { start: wk.start, end: wk.end, weeks: wk.returns.length } };
    }
  });
}
