// Portfolio engine: transaction ledger, prices and FX lookups, positions (average cost)
// and the daily valuation series every report is built on. All results are memoized
// until the data or the market cache changes.
import { D, S, asset, cached } from './state.js';
import { market } from './market.js';
import { todayISO, addDays, dayDiff, iso } from './util.js';

const TYPE_ORDER = { deposit: 0, buy: 1, div: 2, interest: 3, fee: 4, tax: 5, sell: 6, withdraw: 7 };
// Used only when no FX data exists at all (no market data, no trade rates)
const FX_FALLBACK = { USD: 1.1, GBP: 0.85, CHF: 0.95, JPY: 160, CAD: 1.5, AUD: 1.65, SEK: 11.3, NOK: 11.6, DKK: 7.46, HKD: 8.6, CNY: 7.9 };

const keyOf = (accIds) => (accIds && accIds.length ? [...accIds].sort().join(',') : 'all');

export function sortTxns(list) {
  return list
    .map((t, i) => [t, i])
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : (TYPE_ORDER[a[0].type] ?? 9) - (TYPE_ORDER[b[0].type] ?? 9) || a[1] - b[1]))
    .map((x) => x[0]);
}

export function txnsFor(accIds = null) {
  return cached('txns:' + keyOf(accIds), () => sortTxns(D().txns.filter((t) => !accIds || accIds.includes(t.acc))));
}

/* ---------- Market lookups ---------- */
// Real market history first, then the demo synthetic one
export function historyFor(symbol) {
  if (!symbol) return null;
  return market.getHistory(symbol) || market.getHistory('demo:' + symbol);
}
export function assetHistory(a) {
  if (!a.symbol || a.priceSource === 'manual') return null;
  if (a.priceSource === 'demo') return market.getHistory('demo:' + a.symbol) || null;
  return market.getHistory(a.symbol);
}

function lastIndexAtOrBefore(points, date) {
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Merged price points in the asset currency: market closes, trade prices where market data
// does not reach, manual points (they win on the same day)
export function priceSeries(aid) {
  return cached('px:' + aid, () => {
    const a = asset(aid);
    if (a.type === 'cash') return [['0000-01-01', 1]];
    const map = new Map();
    const h = assetHistory(a);
    const firstMarket = h && h.dates.length ? h.dates[0] : null;
    if (h) {
      for (let i = 0; i < h.dates.length; i++) if (Number.isFinite(h.close[i]) && h.close[i] > 0) map.set(h.dates[i], h.close[i]);
      if (h.price > 0 && h.time) {
        const qd = iso(new Date(h.time));
        if (!h.dates.length || qd >= h.dates[h.dates.length - 1]) map.set(qd, h.price);
      }
    }
    for (const t of D().txns) {
      if (t.aid !== aid || (t.type !== 'buy' && t.type !== 'sell') || !(t.price > 0)) continue;
      if (firstMarket && t.date >= firstMarket) continue;
      if (!map.has(t.date)) map.set(t.date, t.price);
    }
    for (const [d, p] of D().prices[aid] || []) if (p > 0) map.set(d, p);
    return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  });
}

export function priceOn(aid, date) {
  const s = priceSeries(aid);
  const i = lastIndexAtOrBefore(s, date);
  return i >= 0 ? s[i][1] : null;
}

// FX points (units per EUR): market rates, plus rates recorded on trades as fallback
export function fxSeries(ccy) {
  return cached('fx:' + ccy, () => {
    const map = new Map();
    for (const t of D().txns) {
      if (!(t.fx > 0) || (t.type !== 'buy' && t.type !== 'sell')) continue;
      if (asset(t.aid).currency === ccy) map.set(t.date, t.fx);
    }
    const h = historyFor(market.fxSymbol(ccy));
    if (h) {
      for (let i = 0; i < h.dates.length; i++) if (h.close[i] > 0) map.set(h.dates[i], h.close[i]);
      if (h.price > 0 && h.time) map.set(iso(new Date(h.time)), h.price);
    }
    return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  });
}

export function fxOn(ccy, date) {
  if (!ccy || ccy === 'EUR') return 1;
  const s = fxSeries(ccy);
  if (!s.length) return FX_FALLBACK[ccy] || 1;
  const i = lastIndexAtOrBefore(s, date);
  return i >= 0 ? s[i][1] : s[0][1];
}

const txFx = (t) => (t.fx > 0 ? t.fx : fxOn(asset(t.aid).currency, t.date));

// Latest price and change versus the previous point, in the asset currency
export function lastQuote(aid) {
  return cached('quote:' + aid, () => {
    const a = asset(aid);
    if (a.type === 'cash') return { price: 1, date: null, prev: 1, change: 0, changePct: 0, currency: a.currency || 'EUR', source: 'cash' };
    const s = priceSeries(aid);
    if (!s.length) return null;
    const [date, price] = s[s.length - 1];
    const h = assetHistory(a);
    let prev = s.length > 1 ? s[s.length - 2][1] : price;
    if (h && h.prev > 0 && h.time && iso(new Date(h.time)) === date) prev = h.prev;
    const manual = (D().prices[aid] || []).some((p) => p[0] === date);
    return {
      price, date, prev,
      change: price - prev,
      changePct: prev > 0 ? price / prev - 1 : 0,
      currency: a.currency || 'EUR',
      source: manual ? 'manual' : h ? 'market' : 'trade',
    };
  });
}

/* ---------- Cash effect of a transaction ---------- */
function cashDelta(t, fx) {
  const fee = +t.fee || 0;
  const fxFee = +t.fxFee || 0;
  const tax = +t.tax || 0;
  const amount = +t.amount || 0;
  switch (t.type) {
    case 'buy': return -((t.qty * t.price) / fx + fee + fxFee);
    case 'sell': return (t.qty * t.price) / fx - fee - fxFee - tax;
    case 'div':
    case 'interest':
    case 'deposit': return amount;
    case 'withdraw':
    case 'fee':
    case 'tax': return -amount;
    default: return 0;
  }
}

/* ---------- Daily valuation series ---------- */
export function getSeries(key = 'all') {
  return cached('series:' + key, () => computeSeries(key === 'all' ? null : [key], key));
}

function computeSeries(accIds, key) {
  const txns = txnsFor(accIds);
  if (!txns.length) return null;
  const today = todayISO();
  const start = txns[0].date;
  const end = txns[txns.length - 1].date > today ? txns[txns.length - 1].date : today;
  const n = dayDiff(start, end) + 1;
  const modeOf = new Map(D().accounts.map((a) => [a.id, a.cashMode === 'track' ? 'track' : 'auto']));

  const aids = [...new Set(txns.filter((t) => t.type === 'buy' || t.type === 'sell').map((t) => t.aid))];
  const aIdx = new Map(aids.map((a, i) => [a, i]));
  const meta = aids.map((aid) => {
    const a = asset(aid);
    return { type: a.type || 'other', ccy: a.currency || 'EUR', px: priceSeries(aid), ptr: -1, fx: a.currency && a.currency !== 'EUR' ? fxSeries(a.currency) : null, fxPtr: -1 };
  });
  const qty = new Float64Array(aids.length);
  const costLocal = new Float64Array(aids.length);
  const holdings = new Map(); // `${acc}|${aid}` → { qty, cost, costLocal }
  const cashByAcc = new Map();
  let investedTotal = 0;

  const value = new Float64Array(n);
  const cash = new Float64Array(n);
  const invested = new Float64Array(n);
  const flowIn = new Float64Array(n);
  const flowOut = new Float64Array(n);
  const income = new Float64Array(n);
  const ret = new Float64Array(n);
  const byType = { cash: new Float64Array(n) };
  for (const m of meta) byType[m.type] ||= new Float64Array(n);
  const dates = new Array(n);

  let ti = 0;
  let prevValue = 0;
  let d = start;
  for (let k = 0; k < n; k++) {
    dates[k] = d;
    let fin = 0;
    let fout = 0;
    let inc = 0;
    while (ti < txns.length && txns[ti].date <= d) {
      const t = txns[ti++];
      const mode = modeOf.get(t.acc) || 'auto';
      if (mode === 'auto' && (t.type === 'deposit' || t.type === 'withdraw')) continue;
      const fx = t.type === 'buy' || t.type === 'sell' ? txFx(t) : 1;
      const delta = cashDelta(t, fx);
      if (t.type === 'buy' || t.type === 'sell') {
        const hk = t.acc + '|' + t.aid;
        const h = holdings.get(hk) || { qty: 0, cost: 0, costLocal: 0 };
        const i = aIdx.get(t.aid);
        if (t.type === 'buy') {
          h.qty += t.qty;
          h.cost += -delta;
          h.costLocal += t.qty * t.price;
          qty[i] += t.qty;
          costLocal[i] += t.qty * t.price;
          investedTotal += -delta;
        } else if (h.qty > 0) {
          const q = Math.min(t.qty, h.qty);
          const ratio = q / h.qty;
          const out = h.cost * ratio;
          const outLocal = h.costLocal * ratio;
          h.qty -= q;
          h.cost -= out;
          h.costLocal -= outLocal;
          qty[i] -= q;
          costLocal[i] -= outLocal;
          investedTotal -= out;
          if (h.qty < 1e-9) {
            h.qty = 0;
            h.cost = 0;
            h.costLocal = 0;
          }
          if (qty[i] < 1e-9) {
            qty[i] = 0;
            costLocal[i] = 0;
          }
        }
        holdings.set(hk, h);
      }
      if (t.type === 'div' || t.type === 'interest') inc += +t.amount || 0;
      if (mode === 'track') {
        cashByAcc.set(t.acc, (cashByAcc.get(t.acc) || 0) + delta);
        if (t.type === 'deposit') fin += +t.amount || 0;
        if (t.type === 'withdraw') fout += +t.amount || 0;
      } else if (delta < 0) fin += -delta;
      else fout += delta;
    }

    let v = 0;
    for (let i = 0; i < aids.length; i++) {
      const m = meta[i];
      while (m.ptr + 1 < m.px.length && m.px[m.ptr + 1][0] <= d) m.ptr++;
      if (m.fx) while (m.fxPtr + 1 < m.fx.length && m.fx[m.fxPtr + 1][0] <= d) m.fxPtr++;
      if (qty[i] <= 0) continue;
      const price = m.ptr >= 0 ? m.px[m.ptr][1] : costLocal[i] / qty[i];
      const rate = m.ccy === 'EUR' ? 1 : m.fx && m.fx.length ? m.fx[Math.max(m.fxPtr, 0)][1] : FX_FALLBACK[m.ccy] || 1;
      const val = (qty[i] * price) / rate;
      v += val;
      byType[m.type][k] += val;
    }
    let c = 0;
    for (const x of cashByAcc.values()) c += x;
    v += c;
    byType.cash[k] += Math.max(c, 0);

    value[k] = v;
    cash[k] = c;
    invested[k] = investedTotal;
    flowIn[k] = fin;
    flowOut[k] = fout;
    income[k] = inc;
    const denom = prevValue + fin;
    ret[k] = denom > 0.5 ? (v + fout) / denom - 1 : 0;
    prevValue = v;
    d = addDays(d, 1);
  }

  return {
    key, accIds, start, end, dates, value, cash, invested, flowIn, flowOut, income, ret, byType,
    index(date) {
      if (date < start) return -1;
      return Math.min(dayDiff(start, date), n - 1);
    },
  };
}

/* ---------- Positions (replay up to a date) ---------- */
function replay(accIds, date) {
  const per = new Map(); // `${acc}|${aid}`
  const cashByAcc = new Map();
  const realized = [];
  const modeOf = new Map(D().accounts.map((a) => [a.id, a.cashMode === 'track' ? 'track' : 'auto']));
  for (const t of txnsFor(accIds)) {
    if (t.date > date) break;
    const fx = t.type === 'buy' || t.type === 'sell' ? txFx(t) : 1;
    if (modeOf.get(t.acc) === 'track') cashByAcc.set(t.acc, (cashByAcc.get(t.acc) || 0) + cashDelta(t, fx));
    if (!t.aid) continue;
    const hk = t.acc + '|' + t.aid;
    const p = per.get(hk) || { acc: t.acc, aid: t.aid, qty: 0, cost: 0, costLocal: 0, costNoFee: 0, realized: 0, income: 0, fees: 0, taxes: 0 };
    const fee = +t.fee || 0;
    const fxFee = +t.fxFee || 0;
    const tax = +t.tax || 0;
    if (t.type === 'buy') {
      p.qty += t.qty;
      p.cost += (t.qty * t.price) / fx + fee + fxFee;
      p.costLocal += t.qty * t.price;
      p.costNoFee += (t.qty * t.price) / fx;
      p.fees += fee + fxFee;
    } else if (t.type === 'sell') {
      const q = Math.min(t.qty, p.qty);
      const ratio = p.qty > 0 ? q / p.qty : 0;
      const out = p.cost * ratio;
      const proceeds = (t.qty * t.price) / fx - fee - fxFee;
      const pl = proceeds - out;
      realized.push({ date: t.date, acc: t.acc, aid: t.aid, qty: t.qty, proceeds, cost: out, pl, fee, fxFee, tax, txId: t.id });
      p.realized += pl;
      p.fees += fee + fxFee;
      p.taxes += tax;
      p.qty -= q;
      p.cost -= out;
      p.costLocal -= p.costLocal * ratio;
      p.costNoFee -= p.costNoFee * ratio;
      if (p.qty < 1e-9) {
        p.qty = 0;
        p.cost = 0;
        p.costLocal = 0;
        p.costNoFee = 0;
      }
    } else if (t.type === 'div' || t.type === 'interest') {
      p.income += +t.amount || 0;
      p.taxes += tax;
      p.fees += fxFee;
    } else if (t.type === 'fee') {
      p.fees += +t.amount || 0;
    } else if (t.type === 'tax') {
      p.taxes += +t.amount || 0;
    }
    per.set(hk, p);
  }
  return { per, cashByAcc, realized };
}

export function positions({ accIds = null, date = null } = {}) {
  const day = date || todayISO();
  return cached('pos:' + keyOf(accIds) + ':' + day, () => {
    const { per } = replay(accIds, day);
    const byAid = new Map();
    for (const p of per.values()) {
      const x = byAid.get(p.aid) || { aid: p.aid, qty: 0, cost: 0, costLocal: 0, costNoFee: 0, realized: 0, income: 0, fees: 0, taxes: 0, accounts: [] };
      x.qty += p.qty;
      x.cost += p.cost;
      x.costLocal += p.costLocal;
      x.costNoFee += p.costNoFee;
      x.realized += p.realized;
      x.income += p.income;
      x.fees += p.fees;
      x.taxes += p.taxes;
      if (p.qty > 0) x.accounts.push(p.acc);
      byAid.set(p.aid, x);
    }
    const isToday = day >= todayISO();
    const out = [];
    for (const x of byAid.values()) {
      const a = asset(x.aid);
      const ccy = a.currency || 'EUR';
      const fx = fxOn(ccy, day);
      const qp = isToday ? lastQuote(x.aid) : null;
      let priceLocal = isToday && qp ? qp.price : priceOn(x.aid, day);
      const priceDate = isToday && qp ? qp.date : null;
      const avgLocal = x.qty > 0 ? x.costLocal / x.qty : 0;
      if (!(priceLocal > 0)) priceLocal = avgLocal;
      const valueLocal = x.qty * priceLocal;
      const value = valueLocal / fx;
      const unreal = x.qty > 0 ? value - x.cost : 0;
      const fxPL = x.qty > 0 && x.costLocal > 0 ? value - valueLocal * (x.costNoFee / x.costLocal) : 0;
      const dayChange = isToday && qp && x.qty > 0 ? (x.qty * qp.change) / fx : 0;
      out.push({
        aid: x.aid, asset: a, qty: x.qty, priceLocal, priceDate, currency: ccy, fx,
        value, cost: x.cost, costLocal: x.costLocal, avgLocal, avgEUR: x.qty > 0 ? x.cost / x.qty : 0,
        unreal, unrealPct: x.cost > 0 ? unreal / x.cost : 0, fxPL,
        realized: x.realized, income: x.income, fees: x.fees, taxes: x.taxes,
        dayChange, dayChangePct: isToday && qp ? qp.changePct : 0,
        weight: 0, accounts: x.accounts,
      });
    }
    const total = out.reduce((s, p) => s + (p.qty > 0 ? p.value : 0), 0);
    for (const p of out) p.weight = total > 0 && p.qty > 0 ? p.value / total : 0;
    return out;
  });
}

/* ---------- Event lists ---------- */
export function realizedEvents(accIds = null) {
  return cached('realized:' + keyOf(accIds), () => replay(accIds, '9999-12-31').realized);
}

export function incomeEvents(accIds = null) {
  return cached('income:' + keyOf(accIds), () => {
    const out = [];
    for (const t of txnsFor(accIds)) {
      if (t.type !== 'div' && t.type !== 'interest') continue;
      const type = t.aid ? asset(t.aid).type : 'cash';
      const kind = t.type === 'interest' || type === 'cash' ? 'interest' : type === 'bond' ? 'coupon' : 'dividend';
      const net = +t.amount || 0;
      const tax = +t.tax || 0;
      out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, net, tax, gross: t.gross > 0 ? t.gross : net + tax, fxFee: +t.fxFee || 0, txId: t.id });
    }
    return out;
  });
}

export function costEvents(accIds = null) {
  return cached('costs:' + keyOf(accIds), () => {
    const out = [];
    for (const t of txnsFor(accIds)) {
      const name = t.aid ? asset(t.aid).name : '';
      const label = { buy: 'Acquisto', sell: 'Vendita', div: 'Dividendo' }[t.type] || '';
      if ((t.type === 'buy' || t.type === 'sell') && +t.fee > 0) {
        out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'transaction', amount: +t.fee, txId: t.id, ref: t.ref || '', desc: `${label} ${name}`.trim() });
      }
      if ((t.type === 'buy' || t.type === 'sell' || t.type === 'div') && +t.fxFee > 0) {
        out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'autofx', amount: +t.fxFee, txId: t.id, ref: t.ref || '', desc: `Cambio valuta · ${label} ${name}`.trim() });
      }
      if (t.type === 'fee') {
        const kind = ['transaction', 'autofx', 'connectivity'].includes(t.kind) ? t.kind : 'other';
        out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, amount: +t.amount || 0, txId: t.id, ref: t.ref || '', desc: t.note || name || '' });
      }
    }
    return out;
  });
}

export function taxEvents(accIds = null) {
  return cached('taxes:' + keyOf(accIds), () => {
    const out = [];
    for (const t of txnsFor(accIds)) {
      if (t.type === 'sell' && +t.tax > 0) out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'capital', amount: +t.tax, txId: t.id });
      if ((t.type === 'div' || t.type === 'interest') && +t.tax > 0) out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind: 'income', amount: +t.tax, txId: t.id });
      if (t.type === 'tax') {
        const kind = ['capital', 'income', 'stamp'].includes(t.kind) ? t.kind : 'other';
        out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, amount: +t.amount || 0, txId: t.id });
      }
    }
    return out;
  });
}

export function cashAt(accIds = null, date = null) {
  const { cashByAcc } = replay(accIds, date || todayISO());
  let c = 0;
  for (const v of cashByAcc.values()) c += v;
  return c;
}

export function qtyAt(accIds, aid, date) {
  let q = 0;
  for (const t of txnsFor(accIds)) {
    if (t.date > date) break;
    if (t.aid !== aid) continue;
    if (t.type === 'buy') q += t.qty;
    else if (t.type === 'sell') q = Math.max(0, q - t.qty);
  }
  return q;
}

// Symbols the app should keep fresh: linked assets with a position or on the watchlist, FX, benchmark
export function trackedSymbols() {
  const syms = new Set();
  const ccys = new Set();
  for (const a of Object.values(D().assets)) {
    if (a.symbol && a.priceSource === 'auto') {
      syms.add(a.symbol);
      if (a.currency && a.currency !== 'EUR') ccys.add(a.currency);
    }
  }
  for (const w of D().watch) if (w.symbol) syms.add(w.symbol);
  const b = D().settings.benchmark;
  if (b && b.symbol) syms.add(b.symbol);
  for (const c of ccys) syms.add(market.fxSymbol(c));
  return [...syms];
}

export const _test = { cashDelta, computeSeries, replay, S };
