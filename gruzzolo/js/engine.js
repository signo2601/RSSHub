// Portfolio engine: transaction ledger, prices and FX lookups, positions (average cost)
// and the daily valuation series every report is built on. All results are memoized
// until the data or the market cache changes.
import { D, S, asset, cached } from './state.js';
import { market } from './market.js';
import { todayISO, addDays, dayDiff, iso } from './util.js';

// Order of the transactions of one day. Buys and sells share a rank, so they keep the order they
// were recorded in (imports are chronological): a sell-all-and-buy-back keeps its real average cost.
const TYPE_ORDER = { deposit: 0, buy: 1, sell: 1, div: 2, interest: 3, fee: 4, tax: 5, withdraw: 7 };
// Used only when no FX data exists at all (no market data, no trade rates)
const FX_FALLBACK = { USD: 1.1, GBP: 0.85, CHF: 0.95, JPY: 160, CAD: 1.5, AUD: 1.65, SEK: 11.3, NOK: 11.6, DKK: 7.46, HKD: 8.6, CNY: 7.9 };
const MIN_CAPITAL = 0.5; // EUR: below this a day has no capital to measure a return on

const keyOf = (accIds) => (accIds && accIds.length ? [...accIds].sort().join(',') : 'all');

// Numbers of a transaction: strings or missing fields (old backups, hand-edited files) never become NaN
const num = (x) => {
  const v = +x;
  return Number.isFinite(v) ? v : 0;
};
const qtyOf = (t) => Math.max(0, num(t.qty));
const priceOf = (t) => Math.max(0, num(t.price));

export function sortTxns(list) {
  const sorted = list
    .map((t, i) => [t, i])
    .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : (TYPE_ORDER[a[0].type] ?? 9) - (TYPE_ORDER[b[0].type] ?? 9) || a[1] - b[1]))
    .map((x) => x[0]);
  return sameDaySellsAfterBuys(sorted);
}

// A sell never runs before a same-day buy it needs: when the shares held so far in that account do
// not cover it, it waits for the last buy of that security on the same day (a day trade typed
// in the wrong order, or a buy added later).
function sameDaySellsAfterBuys(list) {
  const held = new Map();
  const out = [];
  const holdKey = (t) => t.acc + '|' + t.aid;
  const apply = (t) => {
    if (t.type !== 'buy' && t.type !== 'sell') return;
    const k = holdKey(t);
    const q = held.get(k) || 0;
    held.set(k, t.type === 'buy' ? q + qtyOf(t) : Math.max(0, q - qtyOf(t)));
  };
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j < list.length && list[j].date === list[i].date) j++;
    const lastBuy = new Map();
    for (let k = i; k < j; k++) if (list[k].type === 'buy') lastBuy.set(holdKey(list[k]), k);
    const waiting = new Map();
    for (let k = i; k < j; k++) {
      const t = list[k];
      const hk = t.type === 'buy' || t.type === 'sell' ? holdKey(t) : null;
      if (t.type === 'sell' && (lastBuy.get(hk) ?? -1) > k && qtyOf(t) > (held.get(hk) || 0) + 1e-9) {
        if (!waiting.has(hk)) waiting.set(hk, []);
        waiting.get(hk).push(t);
        continue;
      }
      out.push(t);
      apply(t);
      if (t.type === 'buy' && lastBuy.get(hk) === k && waiting.has(hk)) {
        for (const s of waiting.get(hk)) {
          out.push(s);
          apply(s);
        }
        waiting.delete(hk);
      }
    }
    i = j;
  }
  return out;
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
      if (t.aid !== aid || (t.type !== 'buy' && t.type !== 'sell') || !(priceOf(t) > 0)) continue;
      if (firstMarket && t.date >= firstMarket) continue;
      if (!map.has(t.date)) map.set(t.date, priceOf(t));
    }
    for (const [d, p] of D().prices[aid] || []) if (num(p) > 0) map.set(d, num(p));
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
      if (!(num(t.fx) > 0) || (t.type !== 'buy' && t.type !== 'sell')) continue;
      if (asset(t.aid).currency === ccy) map.set(t.date, num(t.fx));
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

const txFx = (t) => (num(t.fx) > 0 ? num(t.fx) : fxOn(asset(t.aid).currency, t.date));

// Latest price and change versus the previous point, in the asset currency. Points dated after
// today (a trade typed with a future date) are not quotes yet. prevDate: date of the previous point.
export function lastQuote(aid) {
  return cached('quote:' + aid, () => {
    const a = asset(aid);
    if (a.type === 'cash') return { price: 1, date: null, prev: 1, prevDate: null, change: 0, changePct: 0, currency: a.currency || 'EUR', source: 'cash' };
    const all = priceSeries(aid);
    const today = todayISO();
    let end = all.length;
    while (end > 0 && all[end - 1][0] > today) end--;
    if (!end) return null;
    const [date, price] = all[end - 1];
    const h = assetHistory(a);
    let prev = end > 1 ? all[end - 2][1] : price;
    const prevDate = end > 1 ? all[end - 2][0] : date;
    if (h && h.prev > 0 && h.time && iso(new Date(h.time)) === date) prev = h.prev;
    const manual = (D().prices[aid] || []).some((p) => p[0] === date);
    return {
      price, date, prev, prevDate,
      change: price - prev,
      changePct: prev > 0 ? price / prev - 1 : 0,
      currency: a.currency || 'EUR',
      source: manual ? 'manual' : h ? 'market' : 'trade',
    };
  });
}

/* ---------- Cash effect of a transaction ---------- */
function cashDelta(t, fx) {
  const fee = num(t.fee);
  const fxFee = num(t.fxFee);
  const tax = num(t.tax);
  const amount = num(t.amount);
  switch (t.type) {
    case 'buy': return -((qtyOf(t) * priceOf(t)) / fx + fee + fxFee);
    case 'sell': return (qtyOf(t) * priceOf(t)) / fx - fee - fxFee - tax;
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

// External flows of a day are netted: a sale and a purchase on the same day in an 'auto' account
// (a switch from one security to another) is money that stays invested, not a deposit plus a
// withdrawal. Two more cases count as money from outside: shares sold beyond those recorded
// (they enter at the sale price) and the overdraft of a tracked account (its cash is valued at
// 0 and the shortfall is money that must have come in; a later deposit pays it back).
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
  const cashByAcc = new Map(); // ledger cash of tracked accounts (can be negative)
  const overdraft = new Map(); // tracked account → shortfall already counted as an inflow
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
    let ext = 0; // net external flow of the day: > 0 money in, < 0 money out
    let bought = 0; // EUR spent on purchases (capital at risk on a day that starts empty)
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
        const tq = qtyOf(t);
        if (t.type === 'buy') {
          h.qty += tq;
          h.cost += -delta;
          h.costLocal += tq * priceOf(t);
          qty[i] += tq;
          costLocal[i] += tq * priceOf(t);
          investedTotal += -delta;
          bought += -delta;
        } else {
          const q = Math.min(tq, h.qty);
          if (tq - q > 1e-9) ext += ((tq - q) * priceOf(t)) / fx; // unrecorded shares, valued at the sale price
          if (h.qty > 0) {
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
        }
        holdings.set(hk, h);
      }
      if (t.type === 'div' || t.type === 'interest') inc += num(t.amount);
      if (mode === 'track') {
        cashByAcc.set(t.acc, (cashByAcc.get(t.acc) || 0) + delta);
        if (t.type === 'deposit') ext += num(t.amount);
        if (t.type === 'withdraw') ext -= num(t.amount);
      } else ext -= delta; // auto: the investor pays for purchases and costs, and receives proceeds and income
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
    // Tracked cash: a negative balance is valued at 0 and its change is an external flow
    let c = 0;
    for (const [acc, x] of cashByAcc) {
      const short = x < 0 ? -x : 0;
      ext += short - (overdraft.get(acc) || 0);
      overdraft.set(acc, short);
      if (x > 0) c += x;
    }
    v += c;
    byType.cash[k] += c;

    const fin = ext > 0 ? ext : 0;
    const fout = ext < 0 ? -ext : 0;
    value[k] = v;
    cash[k] = c;
    invested[k] = investedTotal;
    flowIn[k] = fin;
    flowOut[k] = fout;
    income[k] = inc;
    const denom = prevValue + fin;
    if (denom > MIN_CAPITAL) ret[k] = (v + fout) / denom - 1;
    else if (bought > MIN_CAPITAL) ret[k] = (v - prevValue - ext) / bought; // bought and sold within a day that started empty
    else ret[k] = 0;
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
    const fee = num(t.fee);
    const fxFee = num(t.fxFee);
    const tax = num(t.tax);
    const tq = qtyOf(t);
    const price = priceOf(t);
    if (t.type === 'buy') {
      p.qty += tq;
      p.cost += (tq * price) / fx + fee + fxFee;
      p.costLocal += tq * price;
      p.costNoFee += (tq * price) / fx;
      p.fees += fee + fxFee;
    } else if (t.type === 'sell') {
      const q = Math.min(tq, p.qty);
      const ratio = p.qty > 0 ? q / p.qty : 0;
      // Shares sold beyond those recorded (e.g. bought before the imported period): their cost is
      // unknown, so they count at the sale price and only the fees show up as a loss on them
      const missingQty = tq - q > 1e-9 ? tq - q : 0;
      const out = p.cost * ratio + (missingQty * price) / fx;
      const proceeds = (tq * price) / fx - fee - fxFee;
      const pl = proceeds - out;
      realized.push({ date: t.date, acc: t.acc, aid: t.aid, qty: tq, proceeds, cost: out, pl, fee, fxFee, tax, txId: t.id, missingQty });
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
      p.income += num(t.amount);
      p.taxes += tax;
      p.fees += fxFee;
    } else if (t.type === 'fee') {
      p.fees += num(t.amount);
    } else if (t.type === 'tax') {
      p.taxes += num(t.amount);
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
      // EUR change versus the previous close, exchange-rate move included
      const fxPrev = qp && qp.prevDate ? fxOn(ccy, qp.prevDate) : fx;
      const dayChange = isToday && qp && x.qty > 0 ? x.qty * (qp.price / fx - qp.prev / fxPrev) : 0;
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
      const net = num(t.amount);
      const tax = num(t.tax);
      out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, net, tax, gross: num(t.gross) > 0 ? num(t.gross) : net + tax, fxFee: num(t.fxFee), txId: t.id });
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
      if ((t.type === 'buy' || t.type === 'sell') && num(t.fee) > 0) {
        out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'transaction', amount: num(t.fee), txId: t.id, ref: t.ref || '', desc: `${label} ${name}`.trim() });
      }
      if ((t.type === 'buy' || t.type === 'sell' || t.type === 'div') && num(t.fxFee) > 0) {
        out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'autofx', amount: num(t.fxFee), txId: t.id, ref: t.ref || '', desc: `Cambio valuta · ${label} ${name}`.trim() });
      }
      if (t.type === 'fee') {
        const kind = ['transaction', 'autofx', 'connectivity'].includes(t.kind) ? t.kind : 'other';
        out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, amount: num(t.amount), txId: t.id, ref: t.ref || '', desc: t.note || name || '' });
      }
    }
    return out;
  });
}

export function taxEvents(accIds = null) {
  return cached('taxes:' + keyOf(accIds), () => {
    const out = [];
    for (const t of txnsFor(accIds)) {
      if (t.type === 'sell' && num(t.tax) > 0) out.push({ date: t.date, acc: t.acc, aid: t.aid, kind: 'capital', amount: num(t.tax), txId: t.id });
      if ((t.type === 'div' || t.type === 'interest') && num(t.tax) > 0) out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind: 'income', amount: num(t.tax), txId: t.id });
      if (t.type === 'tax') {
        const kind = ['capital', 'income', 'stamp'].includes(t.kind) ? t.kind : 'other';
        out.push({ date: t.date, acc: t.acc, aid: t.aid || null, kind, amount: num(t.amount), txId: t.id });
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
    if (t.type === 'buy') q += qtyOf(t);
    else if (t.type === 'sell') q = Math.max(0, q - qtyOf(t));
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

export const _test = { cashDelta, computeSeries, replay, S, num };
