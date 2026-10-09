// Performance and risk metrics: pure functions over daily valuation series and price histories.
// Conventions:
// - returns are decimals (0.05 = +5%); drawdowns are <= 0 (−0.12 = −12%);
// - growth rates (CAGR, IRR) use a 365-day year, volatility-type figures 252 business days;
// - "the period" [from, to] starts at the close of the day before `from` (its value is
//   `startValue`), so the return of `from` itself belongs to the period;
// - nothing here reads the clock: "today" is always a parameter. Undefined figures are null.
import { addDays, addMonths, dayDiff, iso, mean, quantile, stdev } from './util.js';
import { assetHistory, historyFor } from './engine.js';
import { market } from './market.js';

export const TRADING_DAYS = 252;
const SQRT_TD = Math.sqrt(TRADING_DAYS);
const MIN_BACK_DAYS = 60; // business days of data an asset needs to enter the back-projection

const fin = (x) => (Number.isFinite(x) ? x : null);
const num0 = (x) => (Number.isFinite(x) ? x : 0);

/* ---------- Date helpers (timezone-free, fast) ---------- */
// Days since 1970-01-01 for a 'YYYY-MM-DD' string
function dayNum(s) {
  return Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5);
}
const fromDayNum = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
// 0 = Sunday … 6 = Saturday (1970-01-01 was a Thursday)
const weekdayOf = (s) => (((dayNum(s) + 4) % 7) + 7) % 7;
export const isBusinessDay = (s) => {
  const w = weekdayOf(s);
  return w !== 0 && w !== 6;
};

// First index with dates[i] >= d (dates sorted ascending); dates.length when none
function lowerBound(dates, d) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
// Last index with dates[i] <= d; −1 when none
function lastAtOrBefore(dates, d) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= d) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

// Index range of a sorted date array inside [from, to] (null bounds = open)
export function rangeIndex(dates, from, to) {
  const n = dates ? dates.length : 0;
  const i0 = from ? lowerBound(dates, from) : 0;
  const i1 = to ? lastAtOrBefore(dates, to) : n - 1;
  return { i0, i1, empty: n === 0 || i0 > i1 || i0 >= n || i1 < 0 };
}

// Preset period of the report → { from, to }. The base of the period is the close of the day
// before `from`, so '1M' on 2026-10-08 measures from the close of 2026-09-08 (from = 2026-09-09).
export function resolvePeriod(period, { today, start = null, from = null, to = null } = {}) {
  const back = (months) => addDays(addMonths(today, -months), 1);
  let f;
  let t = today;
  switch (period) {
    case '1M': f = back(1); break;
    case '3M': f = back(3); break;
    case '6M': f = back(6); break;
    case '1Y': f = back(12); break;
    case 'YTD': f = today.slice(0, 4) + '-01-01'; break;
    case 'CUSTOM':
      f = from || start || today;
      t = to || today;
      if (f > t) [f, t] = [t, f];
      break;
    default: f = start || today; // 'ALL'
  }
  if (start && f < start) f = start;
  return { from: f, to: t };
}

/* ---------- Period of a Series ---------- */
// i0 = first index inside the period, i1 = last; startValue = value at the close before `from`
// (0 when the period starts on or before the first transaction, so day-0 flows count)
export function periodBounds(series, from, to) {
  const n = series.dates.length;
  if (from && to && from > to) [from, to] = [to, from];
  const idx = (d) => (typeof series.index === 'function' ? series.index(d) : lowerBound(series.dates, d));
  let i0 = 0;
  let startValue = 0;
  if (from && from > series.start) {
    i0 = Math.max(0, Math.min(idx(from), n - 1));
    startValue = i0 > 0 ? num0(series.value[i0 - 1]) : 0;
  }
  let i1 = to ? idx(to) : n - 1;
  i1 = Math.max(i0, Math.min(i1, n - 1));
  return { i0, i1, startValue, from: series.dates[i0], to: series.dates[i1] };
}

// Benchmark returns aligned to the series: same length, or realigned by date when the
// array carries its own `.dates` (as benchReturns() output does)
function alignedBench(benchRet, dates) {
  if (!benchRet) return null;
  if (benchRet.length === dates.length && (!benchRet.dates || benchRet.dates[0] === dates[0])) return benchRet;
  if (!Array.isArray(benchRet.dates) || !benchRet.dates.length) return null;
  const out = new Float64Array(dates.length);
  const off = dayNum(dates[0]) - dayNum(benchRet.dates[0]);
  for (let k = 0; k < dates.length; k++) {
    const j = k + off;
    out[k] = j >= 0 && j < benchRet.length && benchRet.dates[j] === dates[k] ? num0(benchRet[j]) : 0;
  }
  out.coverageStart = benchRet.coverageStart ?? null;
  return out;
}

// Headline figures of a period. benchRet: daily benchmark returns aligned to series.dates.
export function periodStats(series, from, to, { rf = 0, benchRet = null } = {}) {
  if (!series || !series.dates || !series.dates.length) return null;
  const { dates, value, ret } = series;
  const { i0, i1, startValue } = periodBounds(series, from, to);
  const effFrom = dates[i0];
  const effTo = dates[i1];
  const days = dayDiff(effFrom, effTo) + 1;

  let growth = 1;
  let inflows = 0;
  let outflows = 0;
  let income = 0;
  const flows = [];
  if (Math.abs(startValue) > 1e-9) flows.push({ date: addDays(effFrom, -1), amount: -startValue });
  for (let k = i0; k <= i1; k++) {
    growth *= 1 + num0(ret[k]);
    const fi = series.flowIn ? num0(series.flowIn[k]) : 0;
    const fo = series.flowOut ? num0(series.flowOut[k]) : 0;
    inflows += fi;
    outflows += fo;
    if (series.income) income += num0(series.income[k]);
    if (fi) flows.push({ date: dates[k], amount: -fi });
    if (fo) flows.push({ date: dates[k], amount: fo });
  }
  const endValue = num0(value[i1]);
  if (Math.abs(endValue) > 1e-9) flows.push({ date: effTo, amount: endValue });
  const netFlows = inflows - outflows;
  const twr = growth > 0 ? growth - 1 : -1;
  const cagr = annualize(twr, days);
  const irr = xirr(flows);

  const bd = businessDays(dates.slice(i0, i1 + 1), ret.slice(i0, i1 + 1));
  const vol = annualizedVolatility(bd.ret);
  const dd = downsideDeviation(bd.ret, rf);
  const sharpe = vol > 0 && cagr !== null ? (cagr - rf) / vol : null;
  const sortino = dd > 0 && cagr !== null ? (cagr - rf) / dd : null;
  const cum = cumulative(dates, ret, effFrom, effTo);
  const mdd = maxDrawdown(cum.cum, cum.dates);

  let benchTwr = null;
  let activeVsBench = null;
  let benchPartial = false;
  const b = alignedBench(benchRet, dates);
  // benchReturns() marks a benchmark without any data with coverageStart = null
  const noData = b && 'coverageStart' in b && (b.coverageStart === null || b.coverageStart > effTo);
  if (b && !noData) {
    let g = 1;
    for (let k = i0; k <= i1; k++) g *= 1 + num0(b[k]);
    benchTwr = g > 0 ? g - 1 : -1;
    activeVsBench = twr - benchTwr;
    benchPartial = Boolean(b.coverageStart && b.coverageStart > effFrom);
  }

  return {
    from: effFrom, to: effTo, days, i0, i1,
    shortPeriod: days < 365,                     // annualized figures (cagr, irr, sharpe…) extrapolate a short period
    startValue, endValue, netFlows, inflows, outflows, income,
    gain: endValue - startValue - netFlows,      // EUR result of the period (market moves + income − costs)
    twr, cagr, irr, vol, sharpe, sortino,
    maxDD: mdd.maxDD, maxDDFrom: mdd.from, maxDDTo: mdd.to,
    activeVsBench, benchTwr, benchPartial,
    positiveShare: positiveShare(bd.ret),
    n: bd.ret.length,                            // business-day observations behind vol/Sharpe
  };
}

/* ---------- Return series ---------- */
// Growth within [from, to]. The first point is the base (0) and is drawn on `from`; the return of
// `from` itself is folded into the second point, so the last point equals periodStats().twr.
export function cumulative(dates, ret, from, to) {
  const { i0, i1, empty } = rangeIndex(dates, from, to);
  if (empty) return { dates: [], cum: [] };
  const cum = new Array(i1 - i0 + 1);
  cum[0] = 0;
  let g = 1 + num0(ret[i0]);
  for (let k = i0 + 1; k <= i1; k++) {
    g *= 1 + num0(ret[k]);
    cum[k - i0] = g - 1;
  }
  return { dates: dates.slice(i0, i1 + 1), cum };
}

// (1 + cum) / runningMax(1 + cum) − 1, running max starting at the base (1). null stays null.
export function drawdowns(cum) {
  const out = new Array(cum.length);
  let peak = 1;
  for (let k = 0; k < cum.length; k++) {
    const c = cum[k];
    if (c === null || c === undefined || !Number.isFinite(c)) {
      out[k] = null;
      continue;
    }
    const g = 1 + c;
    if (g > peak) peak = g;
    out[k] = peak > 0 ? g / peak - 1 : 0;
  }
  return out;
}

// Deepest drawdown of a cumulative-return array: depth (<= 0), peak and trough positions,
// and the first date the previous peak was regained (null if not yet)
export function maxDrawdown(cum, dates = null) {
  let peak = 1;
  let peakIdx = -1;
  let best = 0;
  let fromIdx = -1;
  let toIdx = -1;
  for (let k = 0; k < cum.length; k++) {
    const c = cum[k];
    if (c === null || c === undefined || !Number.isFinite(c)) continue;
    const g = 1 + c;
    if (g >= peak) {
      peak = g;
      peakIdx = k;
    }
    const dd = peak > 0 ? g / peak - 1 : 0;
    if (dd < best - 1e-15) {
      best = dd;
      fromIdx = peakIdx;
      toIdx = k;
    }
  }
  let recIdx = -1;
  if (toIdx >= 0) {
    const level = fromIdx >= 0 ? 1 + cum[fromIdx] : 1;
    for (let k = toIdx + 1; k < cum.length; k++) {
      if (Number.isFinite(cum[k]) && 1 + cum[k] >= level - 1e-12) {
        recIdx = k;
        break;
      }
    }
  }
  const at = (i) => (dates && i >= 0 ? dates[i] : null);
  return { maxDD: best, fromIdx, toIdx, recoveryIdx: recIdx, from: at(fromIdx), to: at(toIdx), recovery: at(recIdx) };
}

// Compounded return of each calendar month inside [from, to] (partial months included)
export function monthlyReturns(dates, ret, from, to) {
  const { i0, i1, empty } = rangeIndex(dates, from, to);
  const out = [];
  if (empty) return out;
  let cur = null;
  let g = 1;
  let days = 0;
  for (let k = i0; k <= i1; k++) {
    const m = dates[k].slice(0, 7);
    if (m !== cur) {
      if (cur) out.push({ month: cur, r: g - 1, days });
      cur = m;
      g = 1;
      days = 0;
    }
    g *= 1 + num0(ret[k]);
    days++;
  }
  out.push({ month: cur, r: g - 1, days });
  return out;
}

// Monthly portfolio vs benchmark: [{ month, r, b, active = r − b }]
export function activeMonthly(dates, ret, benchRet, from, to) {
  const mp = monthlyReturns(dates, ret, from, to);
  const mb = new Map(monthlyReturns(dates, benchRet, from, to).map((x) => [x.month, x.r]));
  return mp.map((x) => {
    const b = mb.has(x.month) ? mb.get(x.month) : null;
    return { month: x.month, r: x.r, b, active: b === null ? null : x.r - b };
  });
}

// Calendar-day returns → business-day returns: weekend returns are compounded into the next
// weekday; a trailing weekend into the last weekday
export function businessDays(dates, ret) {
  const outDates = [];
  const out = [];
  let pending = 1;
  let hasPending = false;
  for (let k = 0; k < dates.length; k++) {
    const r = num0(ret[k]);
    if (!isBusinessDay(dates[k])) {
      pending *= 1 + r;
      hasPending = true;
      continue;
    }
    outDates.push(dates[k]);
    out.push(pending * (1 + r) - 1);
    pending = 1;
    hasPending = false;
  }
  if (hasPending) {
    if (out.length) out[out.length - 1] = (1 + out[out.length - 1]) * pending - 1;
    else {
      outDates.push(dates[dates.length - 1]);
      out.push(pending - 1);
    }
  }
  return { dates: outDates, ret: Float64Array.from(out) };
}

// Rolling annualized volatility on business days; null until `window` returns are available.
// Optional { from, to } trims the output after computing on the whole history.
export function rollingVol(dates, ret, window = 60, { from = null, to = null } = {}) {
  const bd = businessDays(dates, ret);
  const n = bd.ret.length;
  const vol = new Array(n).fill(null);
  for (let k = window - 1; k < n; k++) {
    if (window < 2) break;
    let s = 0;
    for (let j = k - window + 1; j <= k; j++) s += bd.ret[j];
    const m = s / window;
    let v = 0;
    for (let j = k - window + 1; j <= k; j++) v += (bd.ret[j] - m) ** 2;
    vol[k] = Math.sqrt(v / (window - 1)) * SQRT_TD;
  }
  if (!from && !to) return { dates: bd.dates, vol };
  const { i0, i1, empty } = rangeIndex(bd.dates, from, to);
  if (empty) return { dates: [], vol: [] };
  return { dates: bd.dates.slice(i0, i1 + 1), vol: vol.slice(i0, i1 + 1) };
}

// Values of `srcDates` placed on `targetDates` (null where the source has no point)
export function alignByDate(targetDates, srcDates, values) {
  const pos = new Map();
  for (let i = 0; i < srcDates.length; i++) pos.set(srcDates[i], i);
  return targetDates.map((d) => {
    const i = pos.get(d);
    return i === undefined ? null : values[i] ?? null;
  });
}

/* ---------- Price histories ---------- */
// Sorted [date, price] arrays of a History: dividend-adjusted close when the history has it
// (otherwise close), plus the latest quote when it is newer than the last bar.
export function pricePoints(h, { adjusted = true } = {}) {
  const dates = [];
  const values = [];
  if (!h || !Array.isArray(h.dates)) return { dates, values };
  const close = Array.isArray(h.close) ? h.close : [];
  const adj = Array.isArray(h.adj) ? h.adj : [];
  const useAdj = adjusted && adj.some((x) => x > 0);
  let ratio = 1; // adj / close of the last bar, applied to the live quote
  for (let i = 0; i < h.dates.length; i++) {
    const c = +close[i];
    const v = useAdj ? +adj[i] : c;
    if (!(v > 0) || !Number.isFinite(v)) continue;
    const d = h.dates[i];
    const last = dates.length ? dates[dates.length - 1] : '';
    if (d < last) continue;
    if (d === last) values[values.length - 1] = v;
    else {
      dates.push(d);
      values.push(v);
    }
    if (useAdj && c > 0) ratio = v / c;
  }
  if (h.price > 0 && h.time) {
    const qd = iso(new Date(h.time));
    const last = dates.length ? dates[dates.length - 1] : '';
    const v = h.price * (useAdj ? ratio : 1);
    if (qd === last) values[values.length - 1] = v;
    else if (qd > last) {
      dates.push(qd);
      values.push(v);
    }
  }
  return { dates, values };
}

// Carry-forward price in EUR; call with non-decreasing dates. fx: units per EUR points (or null → 1).
// Before the first FX point the first known rate is used.
function eurCursor(pts, fx) {
  let i = -1;
  let j = -1;
  return (d) => {
    while (i + 1 < pts.dates.length && pts.dates[i + 1] <= d) i++;
    if (i < 0) return null;
    let rate = 1;
    if (fx && fx.dates.length) {
      while (j + 1 < fx.dates.length && fx.dates[j + 1] <= d) j++;
      rate = fx.values[Math.max(j, 0)];
    }
    return pts.values[i] / rate;
  };
}

const fxPointsFor = (currency, fxHistory) => (currency && currency !== 'EUR' && fxHistory ? pricePoints(fxHistory, { adjusted: false }) : null);

// Daily EUR total return of a benchmark on calendar `dates` (e.g. series.dates).
// Price carried forward (0 return without a new price), 0 before the history starts.
// The result carries .coverageStart (first date with data, or null) and .dates.
export function benchReturns(history, fxHistory, dates) {
  const n = dates ? dates.length : 0;
  const out = new Float64Array(n);
  out.coverageStart = null;
  out.dates = dates || [];
  if (!history || !n) return out;
  const pts = pricePoints(history);
  if (!pts.dates.length) return out;
  const price = eurCursor(pts, fxPointsFor(history.currency, fxHistory));
  let prev = price(addDays(dates[0], -1));
  for (let k = 0; k < n; k++) {
    const p = price(dates[k]);
    if (p !== null && out.coverageStart === null) out.coverageStart = dates[k];
    out[k] = prev > 0 && p > 0 ? p / prev - 1 : 0;
    if (p > 0) prev = p;
  }
  return out;
}

/* ---------- Money-weighted return ---------- */
// Annual internal rate of return (365-day year). amount < 0: the investor pays; > 0: receives.
// Newton's method, bisection fallback on (−99.99%, +10000%); null when there is no solution.
export function xirr(flows) {
  const list = (flows || []).filter((f) => f && f.date && Number.isFinite(f.amount) && Math.abs(f.amount) > 1e-9);
  if (list.length < 2) return null;
  if (!list.some((f) => f.amount > 0) || !list.some((f) => f.amount < 0)) return null;
  let d0 = list[0].date;
  for (const f of list) if (f.date < d0) d0 = f.date;
  const t = list.map((f) => dayDiff(d0, f.date) / 365);
  const a = list.map((f) => f.amount);
  if (t.every((x) => x === 0)) return null;
  const scale = a.reduce((s, x) => s + Math.abs(x), 0);
  const npv = (r) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] / Math.pow(1 + r, t[i]);
    return s;
  };
  const dnpv = (r) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) if (t[i]) s -= (t[i] * a[i]) / Math.pow(1 + r, t[i] + 1);
    return s;
  };
  const LO = -0.9999;
  const HI = 100;
  const ok = (r) => Math.abs(npv(r)) <= 1e-9 * scale;

  for (const guess of [0.1, 0, -0.5, 1, 5]) {
    let r = guess;
    for (let it = 0; it < 60; it++) {
      const f = npv(r);
      const df = dnpv(r);
      if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) break;
      const next = r - f / df;
      if (!(next > LO && next < HI)) break;
      if (Math.abs(next - r) < 1e-12) {
        r = next;
        break;
      }
      r = next;
    }
    if (r > LO && r < HI && ok(r)) return r;
  }

  // Bisection on the first bracket with a sign change
  const grid = [LO, -0.99, -0.95, -0.9, -0.75, -0.5, -0.25, 0, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, HI];
  for (let g = 0; g < grid.length - 1; g++) {
    let lo = grid[g];
    let hi = grid[g + 1];
    let flo = npv(lo);
    const fhi = npv(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi)) continue;
    if (flo === 0) return lo;
    if (flo * fhi > 0) continue;
    for (let it = 0; it < 200; it++) {
      const mid = (lo + hi) / 2;
      const fm = npv(mid);
      if (flo * fm <= 0) hi = mid;
      else {
        lo = mid;
        flo = fm;
      }
      if (hi - lo < 1e-13) break;
    }
    return (lo + hi) / 2;
  }
  return null;
}

/* ---------- Statistics ---------- */
// (1 + twr)^(365 / days) − 1; twr itself for periods shorter than a day; −100% stays −100%
export function annualize(twr, days) {
  if (!Number.isFinite(twr)) return null;
  if (twr <= -1) return -1;
  if (!(days >= 1)) return twr;
  return Math.pow(1 + twr, 365 / days) - 1;
}

// Sample standard deviation of daily returns × √252
export function annualizedVolatility(ret) {
  if (!ret || ret.length < 2) return null;
  return fin(stdev(ret) * SQRT_TD);
}

// √(mean(min(0, r − rfDaily)²)) × √252, rfDaily = (1 + rf)^(1/252) − 1
export function downsideDeviation(ret, rf = 0) {
  if (!ret || !ret.length) return null;
  const rfd = Math.pow(1 + rf, 1 / TRADING_DAYS) - 1;
  let s = 0;
  for (const r of ret) {
    const x = Math.min(0, r - rfd);
    s += x * x;
  }
  return Math.sqrt(s / ret.length) * SQRT_TD;
}

// Share of positive returns among the non-zero ones (null if all are zero)
export function positiveShare(ret) {
  let pos = 0;
  let nz = 0;
  for (const r of ret || []) {
    if (!Number.isFinite(r) || r === 0) continue;
    nz++;
    if (r > 0) pos++;
  }
  return nz ? pos / nz : null;
}

// Daily portfolio vs benchmark (business days, same length): beta, Jensen's alpha (annualized),
// correlation and tracking error (annualized). Pairs with a missing value are skipped.
export function regression(rp, rb, rf = 0) {
  const none = { beta: null, alpha: null, corr: null, te: null };
  if (!rp || !rb) return none;
  const p = [];
  const b = [];
  const len = Math.min(rp.length, rb.length);
  for (let i = 0; i < len; i++) {
    if (Number.isFinite(rp[i]) && Number.isFinite(rb[i])) {
      p.push(rp[i]);
      b.push(rb[i]);
    }
  }
  const n = p.length;
  if (n < 2) return none;
  const mp = mean(p);
  const mb = mean(b);
  let cov = 0;
  let vp = 0;
  let vb = 0;
  const diff = new Array(n);
  for (let i = 0; i < n; i++) {
    cov += (p[i] - mp) * (b[i] - mb);
    vp += (p[i] - mp) ** 2;
    vb += (b[i] - mb) ** 2;
    diff[i] = p[i] - b[i];
  }
  const beta = vb > 0 ? cov / vb : null;
  const corr = vp > 0 && vb > 0 ? cov / Math.sqrt(vp * vb) : null;
  const rfd = Math.pow(1 + rf, 1 / TRADING_DAYS) - 1;
  let alpha = null;
  if (beta !== null) {
    const daily = 1 + (mp - rfd) - beta * (mb - rfd);
    alpha = daily > 0 ? Math.pow(daily, TRADING_DAYS) - 1 : -1;
  }
  return { beta, alpha, corr, te: fin(stdev(diff) * SQRT_TD) };
}

// Risk profile of daily business-day returns. Optional benchRet (same length) adds
// beta/alpha/corr/te; optional dates add the drawdown's peak and trough dates.
export function riskStats(ret, { rf = 0, benchRet = null, dates = null } = {}) {
  const r = Array.from(ret || [], num0);
  const n = r.length;
  const out = {
    annReturn: null, vol: null, maxDD: null, maxDDFrom: null, maxDDTo: null, sharpe: null, sortino: null,
    var95: null, cvar95: null, gainLoss: null, positiveShare: null,
    beta: null, alpha: null, corr: null, te: null, best: null, worst: null, n,
  };
  if (!n) return out;
  let g = 1;
  const cum = new Array(n);
  for (let k = 0; k < n; k++) {
    g *= 1 + r[k];
    cum[k] = g - 1;
  }
  out.annReturn = g > 0 ? Math.pow(g, TRADING_DAYS / n) - 1 : -1;
  out.vol = annualizedVolatility(r);
  const mdd = maxDrawdown(cum, dates);
  out.maxDD = mdd.maxDD;
  out.maxDDFrom = mdd.from;
  out.maxDDTo = mdd.to;
  out.sharpe = out.vol > 0 ? (out.annReturn - rf) / out.vol : null;
  const dd = downsideDeviation(r, rf);
  out.sortino = dd > 0 ? (out.annReturn - rf) / dd : null;
  const q = quantile(r, 0.05);
  out.var95 = -q;
  out.cvar95 = -mean(r.filter((x) => x <= q));
  const gains = r.filter((x) => x > 0);
  const losses = r.filter((x) => x < 0);
  out.gainLoss = losses.length ? (gains.length ? mean(gains) / Math.abs(mean(losses)) : 0) : null;
  out.positiveShare = positiveShare(r);
  out.best = r.reduce((m, x) => (x > m ? x : m), -Infinity);
  out.worst = r.reduce((m, x) => (x < m ? x : m), Infinity);
  if (benchRet && benchRet.length === n) Object.assign(out, regression(r, benchRet, rf));
  return out;
}

/* ---------- Back-projection of the current allocation ---------- */
// Daily EUR returns the CURRENT open positions would have produced in the past, holding today's
// weights constant (rebalanced daily). Assets without a market history or with fewer than 60
// business days of data in the window are left out (`missing`) and the weights renormalized.
export function backProjected(positions, { years = 5, today = null, benchHistory = null, benchFxHistory = null } = {}) {
  const missing = [];
  const missingInfo = [];
  const fxMissing = [];
  const cands = [];
  for (const p of positions || []) {
    const a = p.asset || {};
    if (!(p.qty > 0) || !(p.value > 0) || a.type === 'cash') continue;
    const h = assetHistory(a);
    const pts = h ? pricePoints(h) : null;
    if (!pts || !pts.dates.length) {
      missing.push(p.aid);
      missingInfo.push({ aid: p.aid, name: a.name || '', reason: 'nohistory' });
      continue;
    }
    const ccy = h.currency || a.currency || 'EUR';
    let fx = null;
    if (ccy !== 'EUR') {
      const fh = historyFor(market.fxSymbol(ccy));
      fx = fh ? pricePoints(fh, { adjusted: false }) : null;
      if (!fx || !fx.dates.length) {
        fx = null;
        fxMissing.push(p.aid);
      }
    }
    cands.push({ p, a, pts, fx });
  }

  // Without `today`, end at the most recent price among the candidates (never read the clock)
  let end = today;
  if (!end) {
    for (const c of cands) {
      const last = c.pts.dates[c.pts.dates.length - 1];
      if (!end || last > end) end = last;
    }
  }
  const empty = () => ({ dates: [], ret: new Float64Array(0), bench: null, benchStart: null, weights: [], start: null, end, missing, missingInfo, fxMissing, n: 0 });
  if (!end) return empty();
  const windowStart = addMonths(end, -12 * years);

  const included = [];
  for (const c of cands) {
    const { dates } = c.pts;
    const i0 = lowerBound(dates, windowStart);
    const i1 = lastAtOrBefore(dates, end);
    let count = 0;
    for (let i = i0; i <= i1; i++) if (isBusinessDay(dates[i])) count++;
    if (count >= MIN_BACK_DAYS) included.push(c);
    else {
      missing.push(c.p.aid);
      missingInfo.push({ aid: c.p.aid, name: c.a.name || '', reason: 'short', days: count });
    }
  }
  if (!included.length) return empty();

  let start = windowStart;
  for (const c of included) if (c.pts.dates[0] > start) start = c.pts.dates[0];
  const total = included.reduce((s, c) => s + c.p.value, 0);
  const weights = included.map((c) => ({
    aid: c.p.aid, symbol: c.a.symbol || '', name: c.a.name || '', weight: c.p.value / total, value: c.p.value, currency: c.a.currency || 'EUR',
  }));

  // Business days after the base date `start`, up to `end`
  const dates = [];
  for (let k = dayNum(start) + 1, last = dayNum(end); k <= last; k++) {
    const d = fromDayNum(k);
    if (isBusinessDay(d)) dates.push(d);
  }
  const n = dates.length;
  const ret = new Float64Array(n);
  included.forEach((c, i) => {
    const w = weights[i].weight;
    const price = eurCursor(c.pts, c.fx);
    let prev = price(start);
    for (let k = 0; k < n; k++) {
      const px = price(dates[k]);
      if (prev > 0 && px > 0) ret[k] += w * (px / prev - 1);
      if (px > 0) prev = px;
    }
  });

  let bench = null;
  let benchStart = null;
  if (benchHistory) {
    const bp = pricePoints(benchHistory);
    if (bp.dates.length) {
      bench = new Float64Array(n);
      const price = eurCursor(bp, fxPointsFor(benchHistory.currency, benchFxHistory));
      let prev = price(start);
      if (prev > 0) benchStart = start;
      for (let k = 0; k < n; k++) {
        const px = price(dates[k]);
        if (px > 0 && !benchStart) benchStart = dates[k];
        bench[k] = prev > 0 && px > 0 ? px / prev - 1 : 0;
        if (px > 0) prev = px;
      }
    }
  }

  return { dates, ret, bench, benchStart, weights, start, end, missing, missingInfo, fxMissing, n };
}
