// Independent cross-check of every number in the Report and the Portafoglio tab.
// The model below is a separate re-implementation written from the definitions in ARCHITECTURE.md
// and standard practice; it reads only raw transactions and raw market histories and never calls
// the app's analytics. Each test compares the app (engine, metrics, income, costs, markowitz and the
// report sheets' own helpers) with it, on the example portfolio and on hand-made edge cases:
//   E1 single EUR ETF, tracked cash, deposit mid-period    E2 USD stock, FX moves, AutoFX fees, USD benchmark
//   E3 full sell then re-buy, same-day switch (auto)        E4 dividends with withholding, bond coupons, interest, stamp duty
//   E5 period starting before the first transaction         E6 overdraft, oversell, sell-all-and-buy-back, day trade
//   E7 benchmark starting inside the period                 E8 crypto-assets and stocks (separate tax silos)
// Conventions shared on purpose (documented in engine.js): daily external flows are netted; a negative
// tracked balance is valued at 0 and its change is an external flow; shares sold beyond those recorded
// enter at the sale price; a day that starts empty measures its return on the money spent on buys;
// the drawdown base is labelled with the period start; TER "a fine periodo" is the last snapshot with holdings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { S, blankData, bump, migrate } from '../js/state.js';
import { market } from '../js/market.js';
import { assetHistory, cashAt, getSeries, historyFor, incomeEvents, positions, realizedEvents } from '../js/engine.js';
import { activeMonthly, monthlyReturns, rollingVol } from '../js/metrics.js';
import { incomeStats } from '../js/income.js';
import { costStats, fiscalBackpack } from '../js/costs.js';
import { portfolioFrontier } from '../js/markowitz.js';
import { demoData, installDemoMarket } from '../js/demo.js';
import { dayDiff, todayISO } from '../js/util.js';
import { buildCtx, renderReport } from '../js/views/report.js';
import { _test as SUM } from '../js/views/sheet-summary.js';
import { riskData } from '../js/views/sheet-risk.js';
import '../js/views/sheet-visual.js';
import '../js/views/sheet-composition.js';
import '../js/views/sheet-income.js';
import '../js/views/sheet-costs.js';
import { rangePoints, rangeStart } from '../js/views/home.js';

const T = todayISO();

/* ======================================================================
   Independent model
   ====================================================================== */
// Written from the definitions, not from the app's code: it reads only raw data (an S.data-like
// object) and raw market histories through a getter. Standard-practice choices: daily external
// flows netted (one net inflow or outflow per day); drawdown on the wealth index with base 1 at the
// close before the period, first day included; IRR by plain bisection on the NPV (365-day year).

// buys and sells of a day keep the recorded (chronological) order
const TYPE_ORDER = { deposit: 0, buy: 1, sell: 1, div: 2, interest: 3, fee: 4, tax: 5, withdraw: 7 };
const FX_FALLBACK = { USD: 1.1, GBP: 0.85, CHF: 0.95, JPY: 160, CAD: 1.5, AUD: 1.65, SEK: 11.3, NOK: 11.6, DKK: 7.46, HKD: 8.6, CNY: 7.9 };

/* ---------- dates (UTC day numbers) ---------- */
const dn = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 864e5;
const ds = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const plusDays = (s, k) => ds(dn(s) + k);
const weekday = (s) => new Date(dn(s) * 864e5).getUTCDay();
const isBiz = (s) => weekday(s) !== 0 && weekday(s) !== 6;
function minusMonths(s, m) {
  let y = +s.slice(0, 4);
  let mo = +s.slice(5, 7) - m;
  while (mo < 1) { mo += 12; y--; }
  while (mo > 12) { mo -= 12; y++; }
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const d = Math.min(+s.slice(8, 10), last);
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const localISO = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- stats ---------- */
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function sd(a) {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function q5(a) {
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * 0.05;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// XIRR by bisection on a fine grid of brackets
function irrBisect(flows) {
  const f = flows.filter((x) => Math.abs(x.amount) > 1e-9);
  if (f.length < 2 || !f.some((x) => x.amount > 0) || !f.some((x) => x.amount < 0)) return null;
  const d0 = Math.min(...f.map((x) => dn(x.date)));
  const npv = (r) => f.reduce((s, x) => s + x.amount * Math.pow(1 + r, -(dn(x.date) - d0) / 365), 0);
  const grid = [];
  for (let r = -0.9999; r < 100; r = r < 1 ? r + 0.01 : r * 1.1) grid.push(r);
  for (let i = 0; i < grid.length - 1; i++) {
    let lo = grid[i];
    let hi = grid[i + 1];
    let flo = npv(lo);
    const fhi = npv(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) continue;
    for (let k = 0; k < 300; k++) {
      const m = (lo + hi) / 2;
      const fm = npv(m);
      if (flo * fm <= 0) hi = m;
      else { lo = m; flo = fm; }
    }
    return (lo + hi) / 2;
  }
  return null;
}

/* ---------- model ---------- */
function model({ data, getHistory, today }) {
  const historyFor = (sym) => (sym ? getHistory(sym) || getHistory('demo:' + sym) : null);
  const assetOf = (aid) => data.assets[aid] || { id: aid, name: '?', type: 'other', currency: 'EUR', priceSource: 'manual', symbol: '' };
  const assetHist = (a) => (!a.symbol || a.priceSource === 'manual' ? null : a.priceSource === 'demo' ? getHistory('demo:' + a.symbol) : getHistory(a.symbol));
  const modeOf = (acc) => ((data.accounts.find((a) => a.id === acc) || {}).cashMode === 'track' ? 'track' : 'auto');

  // carry-forward lookup on sorted [date, value] pairs
  const lookup = (pts, d) => {
    let lo = 0;
    let hi = pts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (pts[m][0] <= d) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  };

  const pxCache = new Map();
  function pricePts(aid) {
    if (pxCache.has(aid)) return pxCache.get(aid);
    const a = assetOf(aid);
    let out;
    if (a.type === 'cash') out = [['0000-01-01', 1]];
    else {
      const m = new Map();
      const h = assetHist(a);
      const first = h && h.dates.length ? h.dates[0] : null;
      if (h) {
        h.dates.forEach((d, i) => { if (h.close[i] > 0) m.set(d, h.close[i]); });
        if (h.price > 0 && h.time) {
          const q = localISO(h.time);
          if (!h.dates.length || q >= h.dates[h.dates.length - 1]) m.set(q, h.price);
        }
      }
      for (const t of data.txns) {
        if (t.aid !== aid || (t.type !== 'buy' && t.type !== 'sell') || !(t.price > 0)) continue;
        if (first && t.date >= first) continue;
        if (!m.has(t.date)) m.set(t.date, t.price);
      }
      for (const [d, p] of data.prices[aid] || []) if (p > 0) m.set(d, p);
      out = [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    }
    pxCache.set(aid, out);
    return out;
  }
  const priceAt = (aid, d) => {
    const p = pricePts(aid);
    const i = lookup(p, d);
    return i >= 0 ? p[i][1] : null;
  };
  const lastPrice = (aid) => {
    const p = pricePts(aid);
    return p.length ? p[p.length - 1][1] : null;
  };

  const fxCache = new Map();
  function fxPts(ccy) {
    if (fxCache.has(ccy)) return fxCache.get(ccy);
    const m = new Map();
    for (const t of data.txns) if ((t.type === 'buy' || t.type === 'sell') && t.fx > 0 && assetOf(t.aid).currency === ccy) m.set(t.date, t.fx);
    const h = historyFor('EUR' + ccy + '=X');
    if (h) {
      h.dates.forEach((d, i) => { if (h.close[i] > 0) m.set(d, h.close[i]); });
      if (h.price > 0 && h.time) m.set(localISO(h.time), h.price);
    }
    const out = [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
    fxCache.set(ccy, out);
    return out;
  }
  const fxAt = (ccy, d) => {
    if (!ccy || ccy === 'EUR') return 1;
    const p = fxPts(ccy);
    if (!p.length) return FX_FALLBACK[ccy] || 1;
    const i = lookup(p, d);
    return i >= 0 ? p[i][1] : p[0][1];
  };
  const tradeFx = (t) => (t.fx > 0 ? t.fx : fxAt(assetOf(t.aid).currency, t.date));

  const sorted = (accIds) => data.txns
    .map((t, i) => [t, i])
    .filter(([t]) => !accIds || accIds.includes(t.acc))
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : (TYPE_ORDER[a[0].type] ?? 9) - (TYPE_ORDER[b[0].type] ?? 9) || a[1] - b[1]))
    .map((x) => x[0]);

  function cashDeltaOf(t) {
    const fee = +t.fee || 0;
    const fxFee = +t.fxFee || 0;
    const tax = +t.tax || 0;
    const amt = +t.amount || 0;
    if (t.type === 'buy') return -(t.qty * t.price / tradeFx(t) + fee + fxFee);
    if (t.type === 'sell') return t.qty * t.price / tradeFx(t) - fee - fxFee - tax;
    if (t.type === 'div' || t.type === 'interest' || t.type === 'deposit') return amt;
    if (t.type === 'withdraw' || t.type === 'fee' || t.type === 'tax') return -amt;
    return 0;
  }

  // Ledger replay up to date (inclusive): holdings per account+asset, cash per track account, realized list
  function ledger(accIds, upTo) {
    const hold = new Map();
    const cash = new Map();
    const realized = [];
    for (const t of sorted(accIds)) {
      if (t.date > upTo) break;
      if (modeOf(t.acc) === 'track') cash.set(t.acc, (cash.get(t.acc) || 0) + cashDeltaOf(t));
      if (t.type !== 'buy' && t.type !== 'sell') continue;
      const k = t.acc + '|' + t.aid;
      const h = hold.get(k) || { acc: t.acc, aid: t.aid, qty: 0, cost: 0, costLocal: 0, costNoFee: 0 };
      const fx = tradeFx(t);
      const fees = (+t.fee || 0) + (+t.fxFee || 0);
      if (t.type === 'buy') {
        h.qty += t.qty;
        h.cost += t.qty * t.price / fx + fees;
        h.costLocal += t.qty * t.price;
        h.costNoFee += t.qty * t.price / fx;
      } else {
        const q = Math.min(t.qty, h.qty);
        const share = h.qty > 0 ? q / h.qty : 0;
        const costOut = h.cost * share + Math.max(0, t.qty - q) * t.price / fx;
        const proceeds = t.qty * t.price / fx - fees;
        realized.push({ date: t.date, aid: t.aid, acc: t.acc, pl: proceeds - costOut, proceeds, cost: costOut, qty: t.qty, held: q });
        h.qty -= q;
        h.cost -= h.cost * share;
        h.costLocal -= h.costLocal * share;
        h.costNoFee -= h.costNoFee * share;
        if (h.qty < 1e-9) Object.assign(h, { qty: 0, cost: 0, costLocal: 0, costNoFee: 0 });
      }
      hold.set(k, h);
    }
    return { hold, cash, realized };
  }

  function positionsAt(accIds, d) {
    const { hold } = ledger(accIds, d);
    const by = new Map();
    for (const h of hold.values()) {
      const x = by.get(h.aid) || { aid: h.aid, qty: 0, cost: 0, costLocal: 0, costNoFee: 0 };
      x.qty += h.qty; x.cost += h.cost; x.costLocal += h.costLocal; x.costNoFee += h.costNoFee;
      by.set(h.aid, x);
    }
    const out = [];
    for (const x of by.values()) {
      if (!(x.qty > 0)) continue;
      const a = assetOf(x.aid);
      const ccy = a.currency || 'EUR';
      let px = d >= today ? lastPrice(x.aid) : priceAt(x.aid, d);
      if (!(px > 0)) px = x.costLocal / x.qty;
      const fx = fxAt(ccy, d);
      const valueLocal = x.qty * px;
      const value = valueLocal / fx;
      out.push({ ...x, asset: a, ccy, px, fx, value, unreal: value - x.cost, fxPL: x.costLocal > 0 ? value - valueLocal * x.costNoFee / x.costLocal : 0 });
    }
    return out;
  }

  // Daily valuation with NET daily external flows
  function series(accIds) {
    const txns = sorted(accIds);
    if (!txns.length) return null;
    const start = txns[0].date;
    const end = txns[txns.length - 1].date > today ? txns[txns.length - 1].date : today;
    const n = dn(end) - dn(start) + 1;
    const dates = [];
    const value = [];
    const ret = [];
    const fin = [];
    const fout = [];
    const gin = [];
    const gout = [];
    const income = [];
    const cashArr = [];
    const qty = new Map(); // aid → qty (all accounts)
    const costLocal = new Map();
    const hold = new Map();
    const cash = new Map();
    const shortOf = new Map();
    let ti = 0;
    let prev = 0;
    for (let k = 0; k < n; k++) {
      const d = ds(dn(start) + k);
      let ext = 0;
      let gi = 0;
      let go = 0;
      let inc = 0;
      let boughtToday = 0;
      while (ti < txns.length && txns[ti].date <= d) {
        const t = txns[ti++];
        const mode = modeOf(t.acc);
        if (mode === 'auto' && (t.type === 'deposit' || t.type === 'withdraw')) continue;
        const delta = cashDeltaOf(t);
        if (t.type === 'buy' || t.type === 'sell') {
          const key = t.acc + '|' + t.aid;
          const h = hold.get(key) || { qty: 0, costLocal: 0 };
          if (t.type === 'buy') {
            h.qty += t.qty;
            h.costLocal += t.qty * t.price;
            qty.set(t.aid, (qty.get(t.aid) || 0) + t.qty);
            costLocal.set(t.aid, (costLocal.get(t.aid) || 0) + t.qty * t.price);
            boughtToday += -delta;
          } else {
            const q = Math.min(t.qty, h.qty);
            // convention: shares sold beyond those recorded arrive from outside at the sale price
            if (t.qty - q > 1e-9) ext += (t.qty - q) * t.price / tradeFx(t);
            if (h.qty > 0) {
            const outL = h.costLocal * (q / h.qty);
            h.qty -= q;
            h.costLocal -= outL;
            if (h.qty < 1e-9) { h.qty = 0; h.costLocal = 0; }
            qty.set(t.aid, (qty.get(t.aid) || 0) - q);
            costLocal.set(t.aid, (costLocal.get(t.aid) || 0) - outL);
            if (qty.get(t.aid) < 1e-9) { qty.set(t.aid, 0); costLocal.set(t.aid, 0); }
            }
          }
          hold.set(key, h);
        }
        if (t.type === 'div' || t.type === 'interest') inc += +t.amount || 0;
        if (mode === 'track') {
          cash.set(t.acc, (cash.get(t.acc) || 0) + delta);
          if (t.type === 'deposit') { ext += +t.amount || 0; gi += +t.amount || 0; }
          if (t.type === 'withdraw') { ext -= +t.amount || 0; go += +t.amount || 0; }
        } else {
          ext += -delta;
          if (delta < 0) gi += -delta;
          else go += delta;
        }
      }
      let v = 0;
      for (const [aid, q] of qty) {
        if (!(q > 0)) continue;
        const a = assetOf(aid);
        let px = priceAt(aid, d);
        if (!(px > 0)) px = costLocal.get(aid) / q;
        v += q * px / fxAt(a.currency || 'EUR', d);
      }
      // convention: a negative tracked balance is valued at 0; its change is money from/to outside
      let c = 0;
      for (const [acc, x] of cash) {
        const short = Math.max(-x, 0);
        ext += short - (shortOf.get(acc) || 0);
        shortOf.set(acc, short);
        c += Math.max(x, 0);
      }
      v += c;
      const inF = Math.max(ext, 0);
      const outF = Math.max(-ext, 0);
      const den = prev + inF;
      const spent = boughtToday;
      dates.push(d);
      value.push(v);
      cashArr.push(c);
      fin.push(inF);
      fout.push(outF);
      gin.push(gi);
      gout.push(go);
      income.push(inc);
      ret.push(den > 0.5 ? (v + outF) / den - 1 : spent > 0.5 ? (v - prev - ext) / spent : 0);
      prev = v;
    }
    return { start, end, dates, value, ret, fin, fout, gin, gout, income, cash: cashArr, idx: (d) => Math.min(dn(d) - dn(start), n - 1) };
  }

  function resolve(period, start, custom = {}) {
    let from;
    let to = today;
    if (period === '1M') from = plusDays(minusMonths(today, 1), 1);
    else if (period === '3M') from = plusDays(minusMonths(today, 3), 1);
    else if (period === '6M') from = plusDays(minusMonths(today, 6), 1);
    else if (period === '1Y') from = plusDays(minusMonths(today, 12), 1);
    else if (period === 'YTD') from = today.slice(0, 4) + '-01-01';
    else if (period === 'CUSTOM') { from = custom.from; to = custom.to; }
    else from = start;
    if (from < start) from = start;
    return { from, to };
  }

  // Business-day returns: weekend days compounded into the next weekday; trailing weekend into the last weekday
  function bizReturns(dates, rets) {
    const out = [];
    const od = [];
    let acc = 1;
    let pend = false;
    for (let k = 0; k < dates.length; k++) {
      if (!isBiz(dates[k])) { acc *= 1 + rets[k]; pend = true; continue; }
      out.push(acc * (1 + rets[k]) - 1);
      od.push(dates[k]);
      acc = 1;
      pend = false;
    }
    if (pend) {
      if (out.length) out[out.length - 1] = (1 + out[out.length - 1]) * acc - 1;
      else { out.push(acc - 1); od.push(dates[dates.length - 1]); }
    }
    return { dates: od, ret: out };
  }

  // Benchmark EUR total-return price (adj close / fx) carried forward
  function benchPrice(h, fxh) {
    const useAdj = Array.isArray(h.adj) && h.adj.some((x) => x > 0);
    const pts = [];
    h.dates.forEach((d, i) => {
      const v = useAdj ? h.adj[i] : h.close[i];
      if (v > 0) pts.push([d, v]);
    });
    if (h.price > 0 && h.time) {
      const q = localISO(h.time);
      const lastI = h.dates.length - 1;
      const ratio = useAdj && h.close[lastI] > 0 ? h.adj[lastI] / h.close[lastI] : 1;
      if (!pts.length || q > pts[pts.length - 1][0]) pts.push([q, h.price * ratio]);
      else if (q === pts[pts.length - 1][0]) pts[pts.length - 1][1] = h.price * ratio;
    }
    const fpts = [];
    if (fxh && h.currency && h.currency !== 'EUR') fxh.dates.forEach((d, i) => { if (fxh.close[i] > 0) fpts.push([d, fxh.close[i]]); });
    return (d) => {
      const i = lookup(pts, d);
      if (i < 0) return null;
      let r = 1;
      if (fpts.length) {
        const j = lookup(fpts, d);
        r = fpts[Math.max(j, 0)][1];
      }
      return pts[i][1] / r;
    };
  }

  function periodStats(s, from, to, { rf = 0.02, bench = null } = {}) {
    const i0 = from > s.start ? s.idx(from) : 0;
    const i1 = Math.max(i0, s.idx(to));
    const startValue = i0 > 0 ? s.value[i0 - 1] : 0;
    const endValue = s.value[i1];
    let g = 1;
    let inflows = 0;
    let outflows = 0;
    let grossIn = 0;
    let grossOut = 0;
    let income = 0;
    const flows = [];
    if (Math.abs(startValue) > 1e-9) flows.push({ date: plusDays(s.dates[i0], -1), amount: -startValue });
    // wealth index for the drawdown: base 1 at the close before the period
    let peak = 1;
    let peakDate = s.dates[i0]; // the base (close before the period) is labelled with the period start
    let mdd = 0;
    let ddFrom = null;
    let ddTo = null;
    for (let k = i0; k <= i1; k++) {
      g *= 1 + s.ret[k];
      inflows += s.fin[k];
      outflows += s.fout[k];
      grossIn += s.gin[k];
      grossOut += s.gout[k];
      income += s.income[k];
      const net = s.fin[k] - s.fout[k];
      if (net) flows.push({ date: s.dates[k], amount: -net });
      if (g > peak) { peak = g; peakDate = s.dates[k]; }
      const dd = g / peak - 1;
      if (dd < mdd - 1e-15) { mdd = dd; ddFrom = peakDate; ddTo = s.dates[k]; }
    }
    if (Math.abs(endValue) > 1e-9) flows.push({ date: s.dates[i1], amount: endValue });
    const twr = g - 1;
    const days = dn(s.dates[i1]) - dn(s.dates[i0]) + 1;
    const cagr = twr <= -1 ? -1 : Math.pow(1 + twr, 365 / days) - 1;
    const irr = irrBisect(flows);
    const bd = bizReturns(s.dates.slice(i0, i1 + 1), s.ret.slice(i0, i1 + 1));
    const vol = bd.ret.length >= 2 ? sd(bd.ret) * Math.sqrt(252) : null;
    const rfd = Math.pow(1 + rf, 1 / 252) - 1;
    const dsd = bd.ret.length ? Math.sqrt(avg(bd.ret.map((r) => Math.min(0, r - rfd) ** 2))) * Math.sqrt(252) : null;
    const sharpe = vol > 0 ? (cagr - rf) / vol : null;
    const sortino = dsd > 0 ? (cagr - rf) / dsd : null;
    let benchTwr = null;
    let benchPartial = false;
    if (bench) {
      const p = benchPrice(bench.history, bench.fx);
      const base = p(plusDays(s.dates[i0], -1));
      const endP = p(s.dates[i1]);
      if (endP !== null) {
        if (base !== null) benchTwr = endP / base - 1;
        else {
          // history starts inside the period: from its first point
          let first = null;
          for (const d of bench.history.dates) if (d >= s.dates[i0]) { first = p(d); break; }
          benchTwr = first ? endP / first - 1 : null;
          benchPartial = true;
        }
      }
    }
    // monthly returns
    const months = [];
    let cur = null;
    let mg = 1;
    for (let k = i0; k <= i1; k++) {
      const m = s.dates[k].slice(0, 7);
      if (m !== cur) {
        if (cur) months.push({ month: cur, r: mg - 1 });
        cur = m;
        mg = 1;
      }
      mg *= 1 + s.ret[k];
    }
    months.push({ month: cur, r: mg - 1 });
    return {
      from: s.dates[i0], to: s.dates[i1], days, i0, i1, startValue, endValue, inflows, outflows, grossIn, grossOut, netFlows: inflows - outflows, income,
      twr, cagr, irr, vol, sharpe, sortino, maxDD: mdd, maxDDFrom: ddFrom, maxDDTo: ddTo,
      benchTwr, activeVsBench: benchTwr === null ? null : twr - benchTwr, benchPartial, months, nBiz: bd.ret.length,
    };
  }

  function summary(accIds, from, to) {
    const pos = positionsAt(accIds, to);
    const { cash, realized } = ledger(accIds, to);
    let cashBal = 0;
    for (const v of cash.values()) cashBal += v;
    const inv = pos.filter((p) => p.asset.type !== 'cash');
    return {
      liquidity: cashBal + pos.filter((p) => p.asset.type === 'cash').reduce((s, p) => s + p.value, 0),
      cashBal,
      unreal: inv.reduce((s, p) => s + p.unreal, 0),
      cost: inv.reduce((s, p) => s + p.cost, 0),
      fxPL: inv.filter((p) => p.ccy !== 'EUR').reduce((s, p) => s + p.fxPL, 0),
      realized: realized.filter((e) => e.date >= from && e.date <= to).reduce((s, e) => s + e.pl, 0),
      realizedCount: realized.filter((e) => e.date >= from && e.date <= to).length,
      value: pos.reduce((s, p) => s + p.value, 0),
    };
  }

  const kindOfIncome = (t) => {
    const ty = t.aid ? assetOf(t.aid).type : 'cash';
    return t.type === 'interest' || ty === 'cash' ? 'interest' : ty === 'bond' ? 'coupon' : 'dividend';
  };

  function income(accIds, from, to) {
    const out = { dividends: 0, coupons: 0, interest: 0, total: 0, taxes: 0, income12m: 0 };
    const lo12 = plusDays(today, -365);
    for (const t of sorted(accIds)) {
      if (t.type !== 'div' && t.type !== 'interest') continue;
      const amt = +t.amount || 0;
      // 12-month yield: dividends and coupons only (INFO "dividendYield12m"), over the securities
      if (t.date > lo12 && t.date <= today && kindOfIncome(t) !== 'interest') out.income12m += amt;
      if (t.date < from || t.date > to) continue;
      const k = kindOfIncome(t);
      if (k === 'dividend') out.dividends += amt;
      else if (k === 'coupon') out.coupons += amt;
      else out.interest += amt;
      out.total += amt;
      out.taxes += +t.tax || 0;
    }
    const value = positionsAt(accIds, today).filter((p) => p.asset.type !== 'cash').reduce((s, p) => s + p.value, 0);
    out.value = value;
    out.yield12m = value > 0 ? out.income12m / value : 0;
    return out;
  }

  function costs(accIds, from, to, rate = 0.002) {
    const c = { transaction: 0, autofx: 0, connectivity: 0, other: 0, capital: 0, incomeTax: 0, stamp: 0, otherTax: 0 };
    for (const t of sorted(accIds)) {
      if (t.date < from || t.date > to) continue;
      if (t.type === 'buy' || t.type === 'sell') {
        c.transaction += +t.fee || 0;
        c.autofx += +t.fxFee || 0;
        if (t.type === 'sell') c.capital += +t.tax || 0;
      } else if (t.type === 'div') {
        c.autofx += +t.fxFee || 0;
        c.incomeTax += +t.tax || 0;
      } else if (t.type === 'interest') {
        c.incomeTax += +t.tax || 0;
      } else if (t.type === 'fee') {
        const k = ['transaction', 'autofx', 'connectivity'].includes(t.kind) ? t.kind : 'other';
        c[k] += +t.amount || 0;
      } else if (t.type === 'tax') {
        const k = t.kind === 'capital' ? 'capital' : t.kind === 'income' ? 'incomeTax' : t.kind === 'stamp' ? 'stamp' : 'otherTax';
        c[k] += +t.amount || 0;
      }
    }
    c.totalBroker = c.transaction + c.autofx + c.connectivity + c.other;
    const ref = `${+to.slice(0, 4) - 1}-12-31`;
    c.stampRef = ref;
    c.stampBase = positionsAt(accIds, ref).filter((p) => p.asset.type !== 'cash').reduce((s, p) => s + p.value, 0);
    c.stampAmount = c.stampBase * rate;
    // TER at the end (value-weighted over non-cash securities; missing TER counts as 0)
    const pos = positionsAt(accIds, to).filter((p) => p.asset.type !== 'cash' && p.value > 0);
    const tv = pos.reduce((s, p) => s + p.value, 0);
    const tc = pos.reduce((s, p) => s + p.value * (Number.isFinite(+p.asset.ter) && p.asset.ter !== null && p.asset.ter !== '' ? +p.asset.ter : 0), 0);
    c.terEnd = tv > 0 ? tc / tv : 0;
    c.terCost = tc;
    return c;
  }

  // Italian "zaino fiscale": yearly netting of redditi diversi, ETF/fund gains excluded,
  // losses carried 4 years, oldest used first; crypto-assets (art. 67 c-sexies TUIR) in a silo of their own
  const CLS = { etf: 'capitale', fund: 'capitale', cash: 'escluso', realestate: 'escluso', crypto: 'cripto' };
  function carry(net, year) {
    const years = [...net.keys()].sort((x, y) => x - y);
    const lots = [];
    for (const y of years) {
      const v = net.get(y);
      if (v < -0.005) lots.push({ year: y, rem: -v, exp: y + 4 });
      else if (v > 0.005) {
        let g = v;
        for (const l of lots) {
          if (l.exp < y || l.rem <= 0 || g <= 0) continue;
          const take = Math.min(g, l.rem);
          l.rem -= take;
          g -= take;
        }
      }
    }
    return { lots, available: lots.filter((l) => l.exp >= year).reduce((q, l) => q + (l.rem > 0.005 ? l.rem : 0), 0) };
  }
  function backpack(accIds, ext = {}) {
    const year = +today.slice(0, 4);
    const { realized } = ledger(accIds, '9999-12-31');
    const net = new Map();
    const cnet = new Map();
    for (const e of realized) {
      const y = +e.date.slice(0, 4);
      if (y > year) continue;
      const cls = CLS[assetOf(e.aid).type] || 'diversi';
      if (cls === 'escluso' || (cls === 'capitale' && e.pl > 0)) continue;
      const m = cls === 'cripto' ? cnet : net;
      m.set(y, (m.get(y) || 0) + e.pl);
    }
    for (const [y, v] of Object.entries(ext)) if (+y <= year) net.set(+y, (net.get(+y) || 0) + +v);
    const { lots, available } = carry(net, year);
    const expiredShown = lots.filter((l) => l.exp < year && l.year >= year - 5).reduce((q, l) => q + (l.rem > 0.005 ? l.rem : 0), 0);
    const rows = [];
    for (let y = year - 5; y <= year; y++) {
      const l = lots.find((x) => x.year === y);
      rows.push({ year: y, net: net.get(y) || 0, remaining: l && l.rem > 0.005 ? l.rem : 0 });
    }
    return { available, expired: expiredShown, rows, lots, cryptoAvailable: carry(cnet, year).available };
  }

  // Constant-weight back-projection of today's open non-cash positions on daily business days
  function backProjection(accIds, { years = 5, bench = null, rf = 0.02 } = {}) {
    const pos = positionsAt(accIds, today).filter((p) => p.asset.type !== 'cash' && p.value > 0);
    const windowStart = minusMonths(today, 12 * years);
    const cands = [];
    for (const p of pos) {
      const h = assetHist(p.asset);
      if (!h || !h.dates.length) continue;
      const pr = benchPrice(h, (h.currency || p.asset.currency) !== 'EUR' ? historyFor('EUR' + (h.currency || p.asset.currency) + '=X') : null);
      const count = h.dates.filter((d, i) => d >= windowStart && d <= today && isBiz(d) && (h.adj[i] > 0 || h.close[i] > 0)).length;
      if (count < 60) continue;
      cands.push({ p, h, pr, first: h.dates.find((d, i) => (h.adj && h.adj.some((x) => x > 0) ? h.adj[i] : h.close[i]) > 0) });
    }
    if (!cands.length) return null;
    let start = windowStart;
    for (const c of cands) if (c.first > start) start = c.first;
    const tot = cands.reduce((s, c) => s + c.p.value, 0);
    const dates = [];
    for (let k = dn(start) + 1; k <= dn(today); k++) if (isBiz(ds(k))) dates.push(ds(k));
    const ret = dates.map(() => 0);
    for (const c of cands) {
      const w = c.p.value / tot;
      let prev = c.pr(start);
      dates.forEach((d, k) => {
        const px = c.pr(d);
        if (prev > 0 && px > 0) ret[k] += w * (px / prev - 1);
        if (px > 0) prev = px;
      });
    }
    const n = ret.length;
    let g = 1;
    let peak = 1;
    let mdd = 0;
    for (const r of ret) {
      g *= 1 + r;
      peak = Math.max(peak, g);
      mdd = Math.min(mdd, g / peak - 1);
    }
    const ann = Math.pow(g, 252 / n) - 1;
    const vol = sd(ret) * Math.sqrt(252);
    const q = q5(ret);
    const out = {
      n, start, annReturn: ann, vol, maxDD: mdd, var95: -q, cvar95: -avg(ret.filter((x) => x <= q)), sharpe: (ann - rf) / vol,
      weights: cands.map((c) => ({ aid: c.p.aid, w: c.p.value / tot })),
    };
    const rfd = Math.pow(1 + rf, 1 / 252) - 1;
    out.sortino = (ann - rf) / (Math.sqrt(avg(ret.map((r) => Math.min(0, r - rfd) ** 2))) * Math.sqrt(252));
    const gains = ret.filter((x) => x > 0);
    const losses = ret.filter((x) => x < 0);
    out.gainLoss = losses.length ? avg(gains) / Math.abs(avg(losses)) : null;
    out.positiveShare = gains.length / (gains.length + losses.length);
    if (bench) {
      const bp = benchPrice(bench.history, bench.fx);
      let prev = bp(start);
      const b = dates.map((d) => {
        const px = bp(d);
        const r = prev > 0 && px > 0 ? px / prev - 1 : 0;
        if (px > 0) prev = px;
        return r;
      });
      // only where the benchmark has data
      let k0 = 0;
      if (!(bp(start) > 0)) while (k0 < n && !(bp(dates[k0]) > 0)) k0++;
      if (!(bp(start) > 0)) k0++;
      const rp = ret.slice(k0);
      const rb = b.slice(k0);
      const mp = avg(rp);
      const mb = avg(rb);
      let cov = 0;
      let vb = 0;
      let vp = 0;
      for (let i = 0; i < rp.length; i++) {
        cov += (rp[i] - mp) * (rb[i] - mb);
        vb += (rb[i] - mb) ** 2;
        vp += (rp[i] - mp) ** 2;
      }
      out.beta = cov / vb;
      out.corr = cov / Math.sqrt(vp * vb);
      out.alpha = Math.pow(1 + (mp - rfd) - out.beta * (mb - rfd), 252) - 1;
      out.te = sd(rp.map((x, i) => x - rb[i])) * Math.sqrt(252);
    }
    return out;
  }

  return { series, periodStats, resolve, summary, income, costs, backpack, backProjection, positionsAt, ledger, priceAt, fxAt, bizReturns, benchPrice, pricePts, assetHist, sd };
}

/* ======================================================================
   Edge-case portfolios and synthetic market histories
   ====================================================================== */
// Deterministic pseudo-random numbers
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// Business-day history from `from` to `to`; divs: [[date, perShare]] (ex-dates moved to business days)
function mkHist({ currency = 'EUR', from, to, p0, seed = 1, vol = 0.2, drift = 0.05, divs = [], decimals = 2, name = 'X' }) {
  const rand = rng(seed);
  const dates = [];
  const close = [];
  let p = p0;
  for (let k = dn(from); k <= dn(to); k++) {
    const d = ds(k);
    if (!isBiz(d)) continue;
    if (dates.length) {
      const z = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
      p *= Math.exp((drift - 0.5 * vol * vol) / 252 + (vol / Math.sqrt(252)) * z);
    }
    dates.push(d);
    close.push(r2(p, decimals));
  }
  const exDivs = divs.map(([d, a]) => [dates.find((x) => x >= d), a]).filter(([d]) => d);
  const adj = new Array(close.length);
  let f = 1;
  const ex = new Map(exDivs);
  for (let k = close.length - 1; k >= 0; k--) {
    adj[k] = close[k] * f;
    const a = ex.get(dates[k]);
    if (a && k > 0) f *= 1 - a / close[k - 1];
  }
  const n = close.length;
  const [y, m, dd] = dates[n - 1].split('-').map(Number);
  return { currency, name, dates, close, adj, divs: exDivs, price: close[n - 1], prev: close[n - 2], time: new Date(y, m - 1, dd, 17, 35).getTime() };
}
const closeOn = (h, d) => {
  let v = null;
  for (let i = 0; i < h.dates.length && h.dates[i] <= d; i++) v = h.close[i];
  return v;
};
const bizOnOrAfter = (d) => {
  let x = d;
  while (!isBiz(x)) x = plusDays(x, 1);
  return x;
};

const asset = (id, extra) => ({ id, name: 'Titolo ' + id, ticker: id.toUpperCase(), symbol: '', isin: '', type: 'stock', currency: 'EUR', exchange: '', sector: '', region: '', ter: null, priceSource: 'auto', ...extra });

function baseData(accounts) {
  return {
    v: 2, updatedAt: 0,
    settings: { started: true, riskFree: 0.02, benchmark: { symbol: 'BENCH.DE', name: 'Bench' }, taxRate: 0.26, govTaxRate: 0.125, stampDuty: 0.002, externalPL: {}, apiBase: '', theme: 'auto' },
    accounts, assets: {}, txns: [], prices: {}, watch: [],
  };
}

function scenarios(T) {
  const histStart = plusDays(T, -900);
  const bench = mkHist({ from: histStart, to: T, p0: 100, seed: 99, vol: 0.15, drift: 0.07, name: 'Bench' });
  const common = { 'BENCH.DE': bench };
  const out = [];
  let id = 0;
  const tx = (t) => ({ id: 'x' + ++id, ...t });

  /* E1: single EUR ETF in a track account, deposit in the middle of the period */
  {
    const h = mkHist({ from: histStart, to: T, p0: 50, seed: 11, vol: 0.18, drift: 0.06 });
    const data = baseData([{ id: 'trk', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }]);
    data.assets.e = asset('e', { symbol: 'ETF1.MI', type: 'etf', ter: 0.002 });
    const d1 = bizOnOrAfter(plusDays(T, -400));
    const d2 = bizOnOrAfter(plusDays(T, -399));
    const d3 = bizOnOrAfter(plusDays(T, -150));
    const d4 = bizOnOrAfter(plusDays(T, -140));
    const d5 = bizOnOrAfter(plusDays(T, -60));
    data.txns = [
      tx({ acc: 'trk', type: 'deposit', date: d1, amount: 10000 }),
      tx({ acc: 'trk', type: 'buy', aid: 'e', date: d2, qty: 150, price: closeOn(h, d2), fee: 2 }),
      tx({ acc: 'trk', type: 'deposit', date: d3, amount: 9000 }),
      tx({ acc: 'trk', type: 'buy', aid: 'e', date: d4, qty: 80, price: closeOn(h, d4), fee: 2 }),
      tx({ acc: 'trk', type: 'sell', aid: 'e', date: d5, qty: 40, price: closeOn(h, d5), fee: 2 }),
      tx({ acc: 'trk', type: 'interest', date: bizOnOrAfter(plusDays(T, -30)), amount: 3.21 }),
    ];
    out.push({ name: 'E1 track+deposit', data, hist: { ...common, 'ETF1.MI': h } });
  }

  /* E2: USD stock with FX moves and AutoFX fees (track account) */
  {
    const h = mkHist({ currency: 'USD', from: histStart, to: T, p0: 180, seed: 21, vol: 0.3, drift: 0.1, divs: [[plusDays(T, -300), 0.9], [plusDays(T, -120), 0.95]] });
    const fx = mkHist({ currency: 'USD', from: histStart, to: T, p0: 1.05, seed: 22, vol: 0.12, drift: 0.04, decimals: 4 });
    const data = baseData([{ id: 'dg', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }]);
    data.assets.u = asset('u', { symbol: 'USX', currency: 'USD' });
    const d1 = bizOnOrAfter(plusDays(T, -500));
    const d2 = bizOnOrAfter(plusDays(T, -499));
    const d3 = bizOnOrAfter(plusDays(T, -200));
    const d4 = bizOnOrAfter(plusDays(T, -90));
    const fxOn = (d) => closeOn(fx, d);
    const buy = (date, qty) => {
      const price = closeOn(h, date);
      const eur = (qty * price) / fxOn(date);
      return tx({ acc: 'dg', type: 'buy', aid: 'u', date, qty, price, fx: fxOn(date), fee: 2, fxFee: r2(eur * 0.0025) });
    };
    data.txns = [
      tx({ acc: 'dg', type: 'deposit', date: d1, amount: 8000 }),
      buy(d2, 30),
      buy(d3, 10),
    ];
    // dividends with 15% US withholding, AutoFX fee on the net
    for (const [ex, ps] of h.divs) {
      const pay = bizOnOrAfter(plusDays(ex, 10));
      if (pay > T) continue;
      const held = 30 + (ex > d3 ? 10 : 0);
      const gross = r2((held * ps) / fxOn(pay));
      const tax = r2(gross * 0.15);
      const fxFee = r2((gross - tax) * 0.0025);
      data.txns.push(tx({ acc: 'dg', type: 'div', aid: 'u', date: pay, amount: r2(gross - tax - fxFee), gross, tax, fxFee }));
    }
    const sp = closeOn(h, d4);
    data.txns.push(tx({ acc: 'dg', type: 'sell', aid: 'u', date: d4, qty: 15, price: sp, fx: fxOn(d4), fee: 2, fxFee: r2(((15 * sp) / fxOn(d4)) * 0.0025) }));
    data.txns.push(tx({ acc: 'dg', type: 'fee', kind: 'connectivity', date: bizOnOrAfter(plusDays(T, -270)), amount: 2.5 }));
    data.settings.benchmark = { symbol: 'BENCHUS', name: 'Bench USD' };
    const bus = mkHist({ currency: 'USD', from: histStart, to: T, p0: 400, seed: 23, vol: 0.16, drift: 0.08 });
    out.push({ name: 'E2 USD+FX', data, hist: { ...common, USX: h, 'EURUSD=X': fx, BENCHUS: bus } });
  }

  /* E3: full sell then re-buy (auto account), plus a same-day switch between two securities */
  {
    const a = mkHist({ from: histStart, to: T, p0: 20, seed: 31, vol: 0.25, drift: 0.02 });
    const b = mkHist({ from: histStart, to: T, p0: 75, seed: 32, vol: 0.22, drift: 0.08 });
    const data = baseData([{ id: 'sc', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'auto' }]);
    data.assets.a = asset('a', { symbol: 'AAA.MI' });
    data.assets.b = asset('b', { symbol: 'BBB.DE', type: 'etf', ter: 0.0012 });
    const d1 = bizOnOrAfter(plusDays(T, -330));
    const d2 = bizOnOrAfter(plusDays(T, -200));
    const d3 = bizOnOrAfter(plusDays(T, -170));
    const d4 = bizOnOrAfter(plusDays(T, -45));
    const sellA = closeOn(a, d4);
    data.txns = [
      tx({ acc: 'sc', type: 'buy', aid: 'a', date: d1, qty: 300, price: closeOn(a, d1), fee: 0.99 }),
      tx({ acc: 'sc', type: 'sell', aid: 'a', date: d2, qty: 300, price: closeOn(a, d2), fee: 0.99, tax: 0 }),
      tx({ acc: 'sc', type: 'buy', aid: 'a', date: d3, qty: 200, price: closeOn(a, d3), fee: 0.99 }),
      // same-day switch: sell all of A, buy B with the proceeds
      tx({ acc: 'sc', type: 'sell', aid: 'a', date: d4, qty: 200, price: sellA, fee: 0.99 }),
      tx({ acc: 'sc', type: 'buy', aid: 'b', date: d4, qty: Math.floor((200 * sellA - 0.99) / closeOn(b, d4)), price: closeOn(b, d4), fee: 0.99 }),
    ];
    out.push({ name: 'E3 sell+rebuy+switch', data, hist: { ...common, 'AAA.MI': a, 'BBB.DE': b } });
  }

  /* E4: dividends with withholding, a bond with coupons (manual prices), cash interest and stamp duty */
  {
    const s = mkHist({ from: histStart, to: T, p0: 9, seed: 41, vol: 0.2, drift: 0.03, decimals: 3, divs: [[plusDays(T, -380), 0.2], [plusDays(T, -200), 0.22], [plusDays(T, -20), 0.23]] });
    const data = baseData([{ id: 'dg', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }]);
    data.assets.s = asset('s', { symbol: 'ENX.MI' });
    data.assets.bond = asset('bond', { type: 'bond', priceSource: 'manual', symbol: '', name: 'BTP 4% 2031' });
    const d0 = bizOnOrAfter(plusDays(T, -450));
    const d1 = bizOnOrAfter(plusDays(T, -449));
    data.txns = [
      tx({ acc: 'dg', type: 'deposit', date: d0, amount: 20000 }),
      tx({ acc: 'dg', type: 'buy', aid: 's', date: d1, qty: 1000, price: closeOn(s, d1), fee: 4.9 }),
      tx({ acc: 'dg', type: 'buy', aid: 'bond', date: d1, qty: 100, price: 98.5, fee: 7 }),
    ];
    data.prices.bond = [[d1, 98.5], [plusDays(T, -300), 99.1], [plusDays(T, -150), 97.8], [plusDays(T, -5), 100.4]];
    for (const [ex, ps] of s.divs) {
      if (ex <= d1) continue;
      const pay = bizOnOrAfter(plusDays(ex, 2));
      if (pay > T) continue;
      const gross = r2(1000 * ps);
      const tax = r2(gross * 0.26);
      data.txns.push(tx({ acc: 'dg', type: 'div', aid: 's', date: pay, amount: r2(gross - tax), gross, tax }));
    }
    for (const c of [plusDays(T, -400), plusDays(T, -217), plusDays(T, -35)]) {
      const pay = bizOnOrAfter(c);
      if (pay <= d1) continue;
      data.txns.push(tx({ acc: 'dg', type: 'div', aid: 'bond', date: pay, amount: r2(200 * 0.875), gross: 200, tax: 25 }));
    }
    data.txns.push(tx({ acc: 'dg', type: 'interest', date: bizOnOrAfter(plusDays(T, -100)), amount: 12.4, tax: 3.22 }));
    data.txns.push(tx({ acc: 'dg', type: 'tax', kind: 'stamp', date: bizOnOrAfter(plusDays(T, -250)), amount: 30 }));
    out.push({ name: 'E4 income+bond', data, hist: { ...common, 'ENX.MI': s } });
  }

  /* E5: period that starts before the first transaction (auto account, custom period) */
  {
    const h = mkHist({ from: histStart, to: T, p0: 30, seed: 51, vol: 0.2, drift: 0.05 });
    const data = baseData([{ id: 'p', name: 'Principale', broker: 'Altro', cashMode: 'auto' }]);
    data.assets.x = asset('x', { symbol: 'XXX.MI', type: 'etf', ter: 0.0007 });
    const d1 = bizOnOrAfter(plusDays(T, -200));
    const d2 = bizOnOrAfter(plusDays(T, -100));
    data.txns = [
      tx({ acc: 'p', type: 'buy', aid: 'x', date: d1, qty: 100, price: closeOn(h, d1), fee: 1 }),
      tx({ acc: 'p', type: 'buy', aid: 'x', date: d2, qty: 50, price: closeOn(h, d2), fee: 1 }),
    ];
    out.push({ name: 'E5 before-first', data, hist: { ...common, 'XXX.MI': h }, custom: { from: plusDays(T, -400), to: plusDays(T, -10) } });
  }
  /* E6: robustness conventions - overdraft of a tracked account, a sell larger than the shares
     recorded, a same-day sell-all-and-buy-back (tax-loss harvesting) and a day trade */
  {
    const h = mkHist({ from: histStart, to: T, p0: 40, seed: 61, vol: 0.25, drift: 0.0 });
    const g = mkHist({ from: histStart, to: T, p0: 12, seed: 62, vol: 0.3, drift: 0.05 });
    const data = baseData([
      { id: 'trk', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' },
      { id: 'au', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'auto' },
    ]);
    data.assets.h = asset('h', { symbol: 'HHH.MI' });
    data.assets.g = asset('g', { symbol: 'GGG.MI', type: 'etf', ter: 0.003 });
    const d1 = bizOnOrAfter(plusDays(T, -260));
    const d2 = bizOnOrAfter(plusDays(T, -230));
    const d3 = bizOnOrAfter(plusDays(T, -150));
    const d4 = bizOnOrAfter(plusDays(T, -100));
    const d5 = bizOnOrAfter(plusDays(T, -60));
    const d6 = bizOnOrAfter(plusDays(T, -20));
    data.txns = [
      // tracked account: buy with too little cash (overdraft), deposit later pays it back
      tx({ acc: 'trk', type: 'deposit', date: d1, amount: 2000 }),
      tx({ acc: 'trk', type: 'buy', aid: 'h', date: d1, qty: 100, price: closeOn(h, d1), fee: 2 }),
      tx({ acc: 'trk', type: 'deposit', date: d2, amount: 3000 }),
      // same-day sell everything and buy back (realizes the loss/gain, keeps the position)
      tx({ acc: 'trk', type: 'sell', aid: 'h', date: d3, qty: 100, price: closeOn(h, d3), fee: 2 }),
      tx({ acc: 'trk', type: 'buy', aid: 'h', date: d3, qty: 100, price: closeOn(h, d3), fee: 2 }),
      // auto account: sell more than recorded (bought before the imported period)
      tx({ acc: 'au', type: 'buy', aid: 'g', date: d4, qty: 50, price: closeOn(g, d4), fee: 1 }),
      tx({ acc: 'au', type: 'sell', aid: 'g', date: d5, qty: 80, price: closeOn(g, d5), fee: 1 }),
      // day trade from an empty account
      tx({ acc: 'au', type: 'buy', aid: 'g', date: d6, qty: 40, price: closeOn(g, d6), fee: 1 }),
      tx({ acc: 'au', type: 'sell', aid: 'g', date: d6, qty: 40, price: closeOn(g, d6) * 1.02, fee: 1 }),
    ];
    out.push({ name: 'E6 conventions', data, hist: { ...common, 'HHH.MI': h, 'GGG.MI': g } });
  }

  /* E7: benchmark history that starts after the portfolio (partial comparison) */
  {
    const h = mkHist({ from: histStart, to: T, p0: 25, seed: 71, vol: 0.2, drift: 0.04 });
    const late = mkHist({ from: plusDays(T, -120), to: T, p0: 80, seed: 72, vol: 0.15, drift: 0.05 });
    const data = baseData([{ id: 'p', name: 'Principale', broker: 'Altro', cashMode: 'auto' }]);
    data.settings.benchmark = { symbol: 'LATE.DE', name: 'Late bench' };
    data.assets.x = asset('x', { symbol: 'LLL.MI', type: 'etf' });
    const d1 = bizOnOrAfter(plusDays(T, -300));
    data.txns = [tx({ acc: 'p', type: 'buy', aid: 'x', date: d1, qty: 100, price: closeOn(h, d1), fee: 1 })];
    out.push({ name: 'E7 partial bench', data, hist: { ...common, 'LLL.MI': h, 'LATE.DE': late } });
  }
  /* E8: crypto-assets and stocks sold at a gain and at a loss (separate tax silos) */
  {
    const c = mkHist({ from: histStart, to: T, p0: 30000, seed: 81, vol: 0.6, drift: 0.1, decimals: 0 });
    const k = mkHist({ from: histStart, to: T, p0: 60, seed: 82, vol: 0.25, drift: 0.05 });
    const data = baseData([{ id: 'sc', name: 'Scalable', broker: 'Scalable Capital', cashMode: 'auto' }]);
    data.assets.c = asset('c', { symbol: 'CRY-EUR', type: 'crypto' });
    data.assets.k = asset('k', { symbol: 'KKK.DE' });
    const dts = [-700, -560, -420, -300, -200, -80].map((n) => bizOnOrAfter(plusDays(T, n)));
    data.txns = [
      tx({ acc: 'sc', type: 'buy', aid: 'c', date: dts[0], qty: 0.2, price: closeOn(c, dts[0]), fee: 1 }),
      tx({ acc: 'sc', type: 'sell', aid: 'c', date: dts[1], qty: 0.1, price: closeOn(c, dts[1]), fee: 1 }),
      tx({ acc: 'sc', type: 'buy', aid: 'k', date: dts[1], qty: 100, price: closeOn(k, dts[1]), fee: 1 }),
      tx({ acc: 'sc', type: 'sell', aid: 'k', date: dts[2], qty: 50, price: closeOn(k, dts[2]), fee: 1 }),
      tx({ acc: 'sc', type: 'sell', aid: 'c', date: dts[3], qty: 0.05, price: closeOn(c, dts[3]), fee: 1 }),
      tx({ acc: 'sc', type: 'sell', aid: 'k', date: dts[4], qty: 50, price: closeOn(k, dts[4]), fee: 1 }),
      tx({ acc: 'sc', type: 'sell', aid: 'c', date: dts[5], qty: 0.05, price: closeOn(c, dts[5]), fee: 1 }),
    ];
    data.settings.externalPL = { [String(+T.slice(0, 4) - 2)]: -150 };
    out.push({ name: 'E8 crypto+stocks', data, hist: { ...common, 'CRY-EUR': c, 'KKK.DE': k } });
  }
  return out;
}

/* ======================================================================
   Runner: app modules vs the independent model
   ====================================================================== */
const PRESETS = ['1M', '3M', '6M', '1Y', 'YTD', 'ALL'];
const isDemoData = () => S.data.txns.some((t) => t.demo);

function benchFor(symbol) {
  const bh = (isDemoData() && market.getHistory('demo:' + symbol)) || historyFor(symbol);
  if (!bh) return null;
  const ccy = bh.currency || 'EUR';
  const fx = ccy !== 'EUR' ? (isDemoData() && market.getHistory('demo:EUR' + ccy + '=X')) || historyFor('EUR' + ccy + '=X') : null;
  return { history: bh, fx };
}

function makeChecker() {
  const rows = [];
  const cmp = (scn, metric, app, ind, tol = 1e-6) => {
    let ok;
    if (app === null || app === undefined || ind === null || ind === undefined) ok = (app ?? null) === (ind ?? null);
    else if (typeof app === 'string' || typeof ind === 'string') ok = app === ind;
    else ok = Math.abs(app - ind) <= tol * Math.max(1, Math.abs(ind));
    rows.push({ scn, metric, app, ind, ok });
  };
  const fmtV = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? v.toPrecision(10) : String(v));
  const report = () => rows.filter((r) => !r.ok).map((r) => `${r.scn} | ${r.metric} | app=${fmtV(r.app)} | indep=${fmtV(r.ind)}`);
  return { rows, cmp, report };
}

// Every period, every scope: Riepilogo KPIs, monthly returns, income, costs, zaino, risk, positions
function checkScenario(name, { cmp }, { custom = null, rf = 0.02 } = {}) {
  const ind = model({ data: S.data, getHistory: (s) => market.getHistory(s), today: T });
  const bench = benchFor(S.data.settings.benchmark.symbol);
  const scopes = [['all', null], ...(S.data.accounts.length > 1 ? S.data.accounts.map((a) => [a.id, [a.id]]) : [])];
  for (const [scope, accIds] of scopes) {
    const tag = scope === 'all' ? name : `${name} [${scope}]`;
    S.ui.scope = scope;
    const s = ind.series(accIds);
    if (!s) continue;
    for (const P of custom ? [...PRESETS, 'CUSTOM'] : PRESETS) {
      S.ui.period = P;
      S.ui.from = custom ? custom.from : null;
      S.ui.to = custom ? custom.to : null;
      const ctx = buildCtx(T);
      const d = SUM.summaryData(ctx);
      const st = d.st;
      const { from, to } = ind.resolve(P, s.start, custom || {});
      const x = ind.periodStats(s, from, to, { rf, bench });
      const sm = ind.summary(accIds, x.from, x.to);
      const p = `${tag} ${P}`;
      cmp(p, 'from', ctx.from, from);
      cmp(p, 'to', ctx.to, to);
      cmp(p, 'startValue', st.startValue, x.startValue);
      cmp(p, 'endValue', st.endValue, x.endValue);
      cmp(p, 'inflows', st.inflows, x.inflows);
      cmp(p, 'outflows', st.outflows, x.outflows);
      cmp(p, 'netFlows', st.netFlows, x.netFlows);
      cmp(p, 'income(series)', st.income, x.income);
      cmp(p, 'TWR', st.twr, x.twr, 1e-9);
      cmp(p, 'CAGR', st.cagr, x.cagr, 1e-9);
      cmp(p, 'IRR', st.irr, x.irr, 1e-6);
      cmp(p, 'vol', st.vol, x.vol, 1e-9);
      cmp(p, 'sharpe', st.sharpe, x.sharpe, 1e-9);
      cmp(p, 'sortino', st.sortino, x.sortino, 1e-9);
      cmp(p, 'maxDD', st.maxDD, x.maxDD, 1e-9);
      cmp(p, 'maxDDFrom', st.maxDDFrom, x.maxDDFrom);
      cmp(p, 'maxDDTo', st.maxDDTo, x.maxDDTo);
      cmp(p, 'benchTwr', st.benchTwr, x.benchTwr, 1e-9);
      cmp(p, 'activeVsBench', st.activeVsBench, x.activeVsBench, 1e-9);
      cmp(p, 'liquidity', d.snap.liquidity, sm.liquidity);
      cmp(p, 'unrealized', d.snap.unreal, sm.unreal);
      cmp(p, 'fxPL', d.snap.fxPL, sm.fxPL);
      cmp(p, 'realized', d.realized.pl, sm.realized);
      const mApp = monthlyReturns(ctx.series.dates, ctx.series.ret, ctx.from, ctx.to);
      const mi = new Map(x.months.map((m) => [m.month, m.r]));
      cmp(p, 'monthly.count', mApp.length, x.months.length, 0);
      let worst = 0;
      for (const m of mApp) worst = Math.max(worst, Math.abs(m.r - (mi.has(m.month) ? mi.get(m.month) : Infinity)));
      cmp(p, 'monthly.maxDiff', worst, 0, 1e-9);
      const inc = incomeStats({ accIds: ctx.accIds, from: ctx.from, to: ctx.to, today: T, settings: S.data.settings });
      const ii = ind.income(accIds, x.from, x.to);
      cmp(p, 'dividends', inc.dividends, ii.dividends);
      cmp(p, 'coupons', inc.coupons, ii.coupons);
      cmp(p, 'interest', inc.interest, ii.interest);
      cmp(p, 'income.taxes', inc.taxes, ii.taxes);
      cmp(p, 'yield12m', inc.yield12m, ii.yield12m, 1e-9);
      const cs = costStats({ accIds: ctx.accIds, from: ctx.from, to: ctx.to, today: T, settings: S.data.settings });
      const ci = ind.costs(accIds, x.from, x.to, S.data.settings.stampDuty);
      for (const k of ['transaction', 'autofx', 'connectivity', 'other', 'totalBroker']) cmp(p, 'cost.' + k, cs[k], ci[k]);
      cmp(p, 'capitalTaxes', cs.capitalTaxes, ci.capital);
      cmp(p, 'incomeTaxes', cs.incomeTaxes, ci.incomeTax);
      cmp(p, 'stamp.refDate', cs.stampDuty.refDate, ci.stampRef);
      cmp(p, 'stamp.base', cs.stampDuty.base, ci.stampBase);
      // TER "a fine periodo" is the last snapshot with holdings (shown with its date)
      if (ci.terCost > 0 || cs.ter.date === x.to) cmp(p, 'ter.end', cs.ter.end, ci.terEnd, 1e-9);
    }
    const fb = fiscalBackpack({ accIds, today: T, settings: S.data.settings });
    const bi = ind.backpack(accIds, S.data.settings.externalPL || {});
    cmp(tag, 'zaino.available', fb.available, bi.available);
    cmp(tag, 'zaino.expired', fb.expired, bi.expired);
    for (const r of fb.rows) {
      const o = bi.rows.find((q) => q.year === r.year);
      cmp(tag, `zaino.${r.year}.net`, r.net, o.net);
      cmp(tag, `zaino.${r.year}.remaining`, r.remaining, o.remaining);
    }
    cmp(tag, 'zaino.crypto.available', fb.crypto.available, bi.cryptoAvailable);
    S.ui.period = 'ALL';
    const ctx = buildCtx(T);
    const rd = riskData(ctx);
    const bp = ind.backProjection(accIds, { years: 5, bench: ctx.bench.history ? benchFor(S.data.settings.benchmark.symbol) : null, rf });
    cmp(tag, 'back.available', Boolean(rd.rs), Boolean(bp));
    if (rd.rs && bp) {
      cmp(tag, 'back.n', rd.bp.n, bp.n, 0);
      for (const k of ['annReturn', 'vol', 'maxDD', 'var95', 'cvar95', 'sharpe', 'sortino', 'gainLoss', 'positiveShare', 'beta', 'alpha', 'corr', 'te']) cmp(tag, 'back.' + k, rd.rs[k], bp[k], 1e-9);
    }
    const pa = positions({ accIds, date: T }).filter((q) => q.qty > 0);
    const pi = ind.positionsAt(accIds, T);
    cmp(tag, 'positions.count', pa.length, pi.length, 0);
    for (const q of pa) {
      const o = pi.find((z) => z.aid === q.aid) || {};
      cmp(tag, `pos.${q.aid}.value`, q.value, o.value);
      cmp(tag, `pos.${q.aid}.cost`, q.cost, o.cost);
      cmp(tag, `pos.${q.aid}.fxPL`, q.fxPL, o.fxPL);
    }
  }
}

// Remaining numbers of the total scope: benchmark and rolling volatility, active monthly return,
// income decomposition, cost tables, TER average, stamp duty, previous-year taxes, Portafoglio tab
function checkExtras(name, { cmp }, { rf = 0.02 } = {}) {
  const ind = model({ data: S.data, getHistory: (s) => market.getHistory(s), today: T });
  S.ui.scope = 'all';
  const s = ind.series(null);
  if (!s) return;
  const bench = benchFor(S.data.settings.benchmark.symbol);
  const bp = bench ? ind.benchPrice(bench.history, bench.fx) : null;
  for (const P of ['3M', '1Y', 'ALL']) {
    S.ui.period = P;
    S.ui.from = null;
    S.ui.to = null;
    const ctx = buildCtx(T);
    const d = SUM.summaryData(ctx);
    const p = `${name} ${P}`;
    const x = ind.periodStats(s, ctx.from, ctx.to, { rf });
    if (bp) {
      const days = s.dates.slice(x.i0, x.i1 + 1).filter((dd) => bp(dd) !== null);
      const br = [];
      let prev = bp(plusDays(days[0], -1));
      for (const dd of days) {
        const px = bp(dd);
        br.push(prev > 0 ? px / prev - 1 : 0);
        prev = px;
      }
      cmp(p, 'bench.vol', d.bvol ?? null, days.length > 10 ? ind.sd(ind.bizReturns(days, br).ret) * Math.sqrt(252) : null, 1e-9);
      const am = activeMonthly(ctx.series.dates, ctx.series.ret, ctx.bench.ret, ctx.from, ctx.to);
      let worst = 0;
      for (const m of am) {
        const inMonth = s.dates.slice(x.i0, x.i1 + 1).filter((dd) => dd.startsWith(m.month));
        const b0 = bp(plusDays(inMonth[0], -1));
        if (m.active === null || !(b0 > 0)) continue;
        const pm = x.months.find((q) => q.month === m.month).r;
        worst = Math.max(worst, Math.abs(m.active - (pm - (bp(inMonth[inMonth.length - 1]) / b0 - 1))));
      }
      cmp(p, 'activeMonthly.maxDiff', worst, 0, 1e-9);
    }
    const rv = rollingVol(ctx.series.dates, ctx.series.ret, 60, { from: ctx.from, to: ctx.to });
    const bdAll = ind.bizReturns(s.dates.slice(0, x.i1 + 1), s.ret.slice(0, x.i1 + 1));
    cmp(p, 'rollingVol.end', rv.vol.length ? rv.vol[rv.vol.length - 1] : null, bdAll.ret.length >= 60 ? ind.sd(bdAll.ret.slice(-60)) * Math.sqrt(252) : null, 1e-9);
    const inc = incomeStats({ accIds: null, from: ctx.from, to: ctx.to, today: T, settings: S.data.settings });
    const ii = ind.income(null, x.from, x.to);
    let sv = 0;
    for (let k = x.i0; k <= x.i1; k++) sv += s.value[k];
    const avgV = sv / (x.i1 - x.i0 + 1);
    cmp(p, 'income.total', inc.total, ii.total);
    cmp(p, 'income.incomeReturn', inc.incomeReturn, ii.total / avgV, 1e-9);
    cmp(p, 'income.priceReturn', inc.priceReturn, x.twr - ii.total / avgV, 1e-9);
    cmp(p, 'income.yieldPeriod', inc.yieldPeriod, ((ii.total / avgV) * 365) / (x.i1 - x.i0 + 1), 1e-9);
    cmp(p, 'income.cumulative.end', (inc.cumulative.dividends.at(-1) || 0) + (inc.cumulative.coupons.at(-1) || 0), ii.total);
    const cs = costStats({ accIds: null, from: ctx.from, to: ctx.to, today: T, settings: S.data.settings });
    cmp(p, 'cost.monthly.sum', cs.monthly.reduce((q, m) => q + m.broker, 0), cs.totalBroker);
    cmp(p, 'cost.events.sum', cs.events.reduce((q, e) => q + e.amount, 0), cs.totalBroker);
    const ci = ind.costs(null, x.from, x.to, S.data.settings.stampDuty);
    cmp(p, 'stamp.amount', cs.stampDuty.amount, ci.stampBase * S.data.settings.stampDuty);
    const step = Math.max(7, Math.ceil(dayDiff(x.from, x.to) / 600));
    const snaps = [];
    for (let dd = x.from; dd <= x.to; dd = plusDays(dd, step)) snaps.push(dd);
    if (snaps[snaps.length - 1] !== x.to) snaps.push(x.to);
    const ters = [];
    for (const dd of snaps) {
      const pos = ind.positionsAt(null, dd).filter((q) => q.asset.type !== 'cash' && q.value > 0);
      const tv = pos.reduce((q, z) => q + z.value, 0);
      if (tv > 1e-9) ters.push(pos.reduce((q, z) => q + z.value * (z.asset.ter > 0 ? z.asset.ter : 0), 0) / tv);
    }
    cmp(p, 'ter.average', cs.ter.average, ters.length ? ters.reduce((q, z) => q + z, 0) / ters.length : 0, 1e-9);
  }
  const cs = costStats({ accIds: null, from: null, to: T, today: T, settings: S.data.settings });
  const py = +T.slice(0, 4) - 1;
  const cPrev = ind.costs(null, `${py}-01-01`, `${py}-12-31`, S.data.settings.stampDuty);
  const est = cPrev.stamp > 0.005 ? 0 : ind.positionsAt(null, `${py - 1}-12-31`).filter((q) => q.asset.type !== 'cash').reduce((q, z) => q + z.value, 0) * S.data.settings.stampDuty;
  cmp(name, 'taxes.prevYear', cs.totalTaxesPrevYear, cPrev.capital + cPrev.incomeTax + cPrev.stamp + cPrev.otherTax + est);

  // Portafoglio tab
  const all = positions({ accIds: null });
  const open = all.filter((q) => q.qty > 0);
  const pi = ind.positionsAt(null, T);
  cmp(name, 'home.capitaleInvestito', open.reduce((q, z) => q + z.cost, 0), pi.reduce((q, z) => q + z.cost, 0));
  cmp(name, 'home.latente', open.reduce((q, z) => q + z.unreal, 0), pi.reduce((q, z) => q + z.unreal, 0));
  cmp(name, 'home.realizzata', all.reduce((q, z) => q + z.realized, 0), ind.ledger(null, '9999-12-31').realized.reduce((q, e) => q + e.pl, 0));
  cmp(name, 'home.dividendiCedole', incomeEvents(null).reduce((q, e) => q + e.net, 0), S.data.txns.filter((t) => t.type === 'div' || t.type === 'interest').reduce((q, t) => q + (+t.amount || 0), 0));
  let cashLedger = 0;
  for (const v of ind.ledger(null, T).cash.values()) cashLedger += v;
  cmp(name, 'home.liquidita', cashAt(null, T), cashLedger);
  for (const range of ['1M', '1A', 'MAX']) {
    const R = rangePoints(getSeries('all'), range, T);
    const base = rangeStart(range, T);
    const x = ind.periodStats(s, base && base >= s.start ? plusDays(base, 1) : s.start, T, { rf });
    cmp(name, `home.${range}.value`, R.valueEnd, x.endValue);
    cmp(name, `home.${range}.gain`, R.gainTotal, x.endValue - x.startValue - x.netFlows);
    cmp(name, `home.${range}.perf`, R.perfTotal, x.twr, 1e-9);
  }
  let appDay = 0;
  let indDay = 0;
  for (const q of open) {
    const h = ind.assetHist(q.asset);
    if (!h || !h.dates.length) continue;
    const pts = ind.pricePts(q.aid);
    const pLast = pts[pts.length - 1][1];
    const [dPrev, pPrev0] = pts[pts.length - 2];
    const pPrev = h.prev > 0 ? h.prev : pPrev0;
    appDay += q.dayChange;
    indDay += q.qty * (pLast / ind.fxAt(q.asset.currency, T) - pPrev / ind.fxAt(q.asset.currency, dPrev));
  }
  cmp(name, 'home.dayChangeEUR', appDay, indDay);
}

function loadScenario(sc) {
  for (const [sym, h] of Object.entries(sc.hist || {})) market.inject(sym, h);
  S.data = migrate(sc.data);
  bump();
  S.loaded = true;
}
function loadDemo() {
  S.data = migrate(demoData({ today: T }));
  installDemoMarket({ today: T });
  bump();
  S.loaded = true;
}

/* ======================================================================
   Tests
   ====================================================================== */
test('cross-check: example portfolio (all scopes, all periods)', () => {
  loadDemo();
  const c = makeChecker();
  checkScenario('DEMO', c);
  checkExtras('DEMO', c);
  assert.ok(c.rows.length > 900, `only ${c.rows.length} comparisons`);
  assert.deepEqual(c.report(), []);
});

for (const sc of scenarios(T)) {
  test(`cross-check: ${sc.name}`, () => {
    loadScenario(sc);
    const c = makeChecker();
    checkScenario(sc.name, c, { custom: sc.custom });
    checkExtras(sc.name, c);
    assert.ok(c.rows.length > 150, `only ${c.rows.length} comparisons`);
    assert.deepEqual(c.report(), []);
  });
}

test('cross-check: the edge cases exercise what they are meant to', () => {
  const byName = Object.fromEntries(scenarios(T).map((sc) => [sc.name.split(' ')[0], sc]));
  // E3: the same-day switch happens in an auto account and nets to a small outflow
  loadScenario(byName.E3);
  let s = getSeries('all');
  const sw = byName.E3.data.txns[3].date;
  assert.ok(s.flowOut[s.index(sw)] > 0 && s.flowOut[s.index(sw)] < 100 && s.flowIn[s.index(sw)] === 0);
  // E6: overdraft repaid by the later deposit, oversell, day trade from an empty account
  loadScenario(byName.E6);
  s = getSeries('trk');
  const [dep0, buy0, dep1] = byName.E6.data.txns;
  assert.ok(s.flowIn[s.index(buy0.date)] > dep0.amount, 'the shortfall counts as money in');
  assert.equal(s.flowIn[s.index(dep1.date)], 0, 'the deposit repays the shortfall');
  assert.ok(realizedEvents(['au']).some((e) => e.missingQty > 0));
  // E7: the benchmark starts inside the period
  loadScenario(byName.E7);
  S.ui.scope = 'all';
  S.ui.period = 'ALL';
  const st = SUM.summaryData(buildCtx(T)).st;
  assert.equal(st.benchPartial, true);
  assert.ok(Number.isFinite(st.benchTwr));
});

test('cross-check: efficient frontier of the example portfolio', () => {
  loadDemo();
  const open = positions({}).filter((p) => p.qty > 0 && p.value > 0 && p.asset.type !== 'cash');
  const res = portfolioFrontier(open, { today: T, rf: 0.02 });
  assert.equal(res.ok, true);
  // Independent weekly EUR returns (last price of each Monday–Sunday week, keyed by its Friday)
  const friday = (d) => {
    const n = dn(d);
    return ds(n - ((new Date(n * 864e5).getUTCDay() + 6) % 7) + 4);
  };
  const lo = friday(minusMonths(T, 120));
  const weekly = res.aids.map((aid) => {
    const p = open.find((q) => q.aid === aid);
    const h = assetHistory(p.asset);
    const fxh = h.currency !== 'EUR' ? historyFor('EUR' + h.currency + '=X') : null;
    const fxAt = (d) => {
      if (!fxh) return 1;
      let r = fxh.close[0];
      for (let i = 0; i < fxh.dates.length && fxh.dates[i] <= d; i++) r = fxh.close[i];
      return r;
    };
    const m = new Map();
    h.dates.forEach((d, i) => {
      if (d > T || !(h.adj[i] > 0) || friday(d) < lo || friday(d) > T) return;
      m.set(friday(d), h.adj[i] / fxAt(d));
    });
    return { m, first: friday(h.dates[0]) };
  });
  let from = lo;
  for (const w of weekly) if (w.first > from) from = w.first;
  const weeks = [...weekly[0].m.keys()].filter((w) => w >= from && weekly.every((x) => x.m.has(w))).sort();
  const R = [];
  for (let k = 1; k < weeks.length; k++) R.push(weekly.map((x) => x.m.get(weeks[k]) / x.m.get(weeks[k - 1]) - 1));
  assert.equal(R.length, res.weekly.weeks);
  const N = R[0].length;
  const mean = Array.from({ length: N }, (_, j) => R.reduce((q, r) => q + r[j], 0) / R.length);
  for (let j = 0; j < N; j++) assert.ok(Math.abs(mean[j] * 52 - res.mu[j]) < 1e-12, 'annualized mean');
  // Ledoit–Wolf: off-diagonal = (1 − δ) × sample covariance (1/T, annualized)
  const cov = (i, j) => (R.reduce((q, r) => q + (r[i] - mean[i]) * (r[j] - mean[j]), 0) / R.length) * 52;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) assert.ok(Math.abs(res.cov[i][j] - (1 - res.shrinkage) * cov(i, j)) < 1e-12);
  // Minimum variance: projected gradient on the same covariance and bounds
  const C = res.cov;
  const [lw, hw] = [res.minWUsed, res.maxWUsed];
  const project = (v) => {
    let a = Math.min(...v) - hw;
    let b = Math.max(...v) - lw;
    for (let it = 0; it < 100; it++) {
      const tau = (a + b) / 2;
      if (v.reduce((q, x) => q + Math.min(hw, Math.max(lw, x - tau)), 0) > 1) a = tau;
      else b = tau;
    }
    return v.map((x) => Math.min(hw, Math.max(lw, x - (a + b) / 2)));
  };
  const variance = (w) => w.reduce((q, wi, i) => q + wi * C[i].reduce((z, c, j) => z + c * w[j], 0), 0);
  let w = new Array(N).fill(1 / N);
  for (let it = 0; it < 20000; it++) {
    const g = C.map((row) => 2 * row.reduce((z, c, j) => z + c * w[j], 0));
    w = project(w.map((x, i) => x - 0.05 * g[i]));
  }
  assert.ok(Math.abs(res.minVar.vol - Math.sqrt(variance(w))) < 1e-6, `min variance ${res.minVar.vol} vs ${Math.sqrt(variance(w))}`);
  // Max Sharpe: no random feasible portfolio does better
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 5000; k++) {
    const raw = Array.from({ length: N }, () => -Math.log(rnd() + 1e-12));
    const sum = raw.reduce((q, z) => q + z, 0);
    const x = project(raw.map((z) => z / sum));
    const sharpe = (x.reduce((q, xi, i) => q + xi * res.mu[i], 0) - 0.02) / Math.sqrt(variance(x));
    assert.ok(sharpe <= res.maxSharpe.sharpe + 1e-9);
  }
  // The current portfolio: today's weights
  const tot = res.aids.reduce((q, aid) => q + open.find((p) => p.aid === aid).value, 0);
  const wc = res.aids.map((aid) => open.find((p) => p.aid === aid).value / tot);
  assert.ok(Math.abs(res.current.vol - Math.sqrt(variance(wc))) < 1e-12);
});

// Odd data must not throw nor show NaN/Infinity anywhere in the Report or in the numbers behind it
function nonFinite(obj, path = '', out = [], seen = new Set()) {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) out.push(`${path}=${obj}`);
    return out;
  }
  if (typeof obj !== 'object' || seen.has(obj)) return out;
  seen.add(obj);
  if (ArrayBuffer.isView(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (!Number.isFinite(obj[i])) {
        out.push(`${path}[${i}]=${obj[i]}`);
        break;
      }
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'asset' && k !== 'history') nonFinite(v, path + '.' + k, out, seen);
  return out;
}

test('robustness: odd data never throws nor leaks NaN/Infinity into the Report', () => {
  const dd = (n) => plusDays(T, -n);
  const base = () => {
    const x = blankData();
    x.settings.started = true;
    return x;
  };
  const A = (id, extra = {}) => ({ id, name: 'T ' + id, ticker: id, symbol: '', type: 'stock', currency: 'EUR', priceSource: 'manual', ter: null, ...extra });
  const cases = [];
  cases.push(['empty', base()]);
  {
    const x = base();
    x.assets.a = A('a');
    x.txns = [{ id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: T, qty: 10, price: 100, fee: 1 }];
    cases.push(['single day', x]);
  }
  {
    const x = base();
    x.assets.a = A('a');
    x.assets.b = A('b');
    x.txns = [
      { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: dd(40), qty: 0, price: 100 },
      { id: 't2', acc: 'acc1', type: 'buy', aid: 'b', date: dd(30), qty: 5, price: 0 },
      { id: 't3', acc: 'acc1', type: 'div', aid: 'b', date: dd(20), amount: 0 },
      { id: 't4', acc: 'acc1', type: 'sell', aid: 'b', date: dd(10), qty: 5, price: 0 },
    ];
    cases.push(['zero values', x]);
  }
  {
    const x = base();
    x.accounts = [{ id: 'trk', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }];
    x.assets.a = A('a');
    x.txns = [{ id: 't1', acc: 'trk', type: 'buy', aid: 'a', date: dd(100), qty: 10, price: 100, fee: 2 }];
    x.prices.a = [[dd(80), 110], [dd(40), 120], [dd(20), 125]];
    cases.push(['negative cash', x]);
  }
  {
    const x = base();
    x.assets.u = A('u', { currency: 'USD' });
    x.txns = [{ id: 't1', acc: 'acc1', type: 'buy', aid: 'u', date: dd(50), qty: 10, price: 100 }];
    cases.push(['missing FX', x]);
  }
  {
    const x = base();
    x.assets.a = A('a', { symbol: 'NOPE.MI', priceSource: 'auto' });
    x.assets.m = A('m');
    x.txns = [
      { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: dd(50), qty: 10, price: 100 },
      { id: 't2', acc: 'acc1', type: 'buy', aid: 'm', date: dd(50), qty: 10 },
    ];
    cases.push(['no prices', x]);
  }
  {
    const x = base();
    x.assets.a = A('a');
    x.txns = [
      { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: dd(50), qty: 10, price: 100 },
      { id: 't2', acc: 'acc1', type: 'sell', aid: 'a', date: dd(20), qty: 15, price: 110 },
    ];
    cases.push(['oversell', x]);
  }
  {
    const x = base();
    x.assets.a = A('a');
    x.txns = [
      { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: dd(50), qty: 10, price: 100 },
      { id: 't2', acc: 'acc1', type: 'buy', aid: 'a', date: plusDays(T, 30), qty: 10, price: 150 },
      { id: 't3', acc: 'acc1', type: 'div', aid: 'a', date: plusDays(T, 10), amount: 5 },
    ];
    cases.push(['future dates', x]);
  }
  {
    const x = base();
    x.assets.a = A('a');
    x.txns = [{ id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: plusDays(T, 30), qty: 10, price: 150 }];
    cases.push(['only future', x]);
  }
  {
    const x = base();
    x.assets.a = A('a');
    x.txns = [
      { id: 't1', acc: 'acc1', type: 'buy', aid: 'a', date: dd(50), qty: '10', price: '100', fee: 'x' },
      { id: 't2', acc: 'acc1', type: 'buy', aid: 'a', date: dd(40), price: 100 },
      { id: 't3', acc: 'acc1', type: 'div', aid: 'a', date: dd(30), amount: 'abc' },
      { id: 't4', acc: 'acc1', type: 'fee', date: dd(20) },
    ];
    cases.push(['text and missing numbers', x]);
  }
  {
    const x = base();
    x.accounts = [{ id: 'trk', name: 'T', broker: 'Altro', cashMode: 'track' }];
    x.assets.a = A('a');
    x.txns = [
      { id: 't0', acc: 'trk', type: 'deposit', date: dd(60), amount: 1000 },
      { id: 't1', acc: 'trk', type: 'buy', aid: 'a', date: dd(60), qty: 10, price: 100 },
      { id: 't2', acc: 'trk', type: 'deposit', date: dd(10), amount: 500 },
    ];
    x.prices.a = [[dd(30), 0.0001]];
    cases.push(['wipe-out', x]);
  }
  const problems = [];
  for (const [name, data] of cases) {
    S.data = migrate(data);
    bump();
    S.loaded = true;
    const check = (label, fn) => {
      try {
        problems.push(...nonFinite(fn(), `${name}: ${label}`).slice(0, 3));
      } catch (e) {
        problems.push(`${name}: ${label} throws ${e.message}`);
      }
    };
    check('series', () => getSeries('all'));
    check('positions', () => positions({}));
    for (const P of ['1M', 'YTD', 'ALL']) {
      Object.assign(S.ui, { scope: 'all', period: P, from: null, to: null });
      const ctx = buildCtx(T);
      if (!ctx) continue;
      check(`summary ${P}`, () => SUM.summaryData(ctx));
      check(`income ${P}`, () => {
        const r = incomeStats({ accIds: null, from: ctx.from, to: ctx.to, today: T });
        return { ...r, calendar: r.calendar(+T.slice(0, 4)) };
      });
      check(`costs ${P}`, () => costStats({ accIds: null, from: ctx.from, to: ctx.to, today: T }));
      check(`risk ${P}`, () => riskData(ctx));
    }
    check('zaino', () => fiscalBackpack({ accIds: null, today: T }));
    for (let i = 0; i < 6; i++) {
      Object.assign(S.ui, { tab: 'report', sheet: i, period: 'ALL' });
      let html = '';
      try {
        html = renderReport();
      } catch (e) {
        problems.push(`${name}: sheet ${i} throws ${e.message}`);
      }
      if (/error-card/.test(html)) problems.push(`${name}: sheet ${i} shows an error card`);
      const text = html.replace(/<[^>]+>/g, ' ');
      if (/NaN|Infinity|undefined/.test(text)) problems.push(`${name}: sheet ${i} text: ${text.match(/.{0,40}(NaN|Infinity|undefined).{0,20}/)[0]}`);
    }
  }
  assert.deepEqual(problems, []);
});
