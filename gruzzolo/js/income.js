// Dividends, coupons and interest: period totals, yields, return decomposition, a 12-month
// forecast, the monthly payment calendar and market dividends not yet recorded.
// Pure analytics: no DOM, no clock. "today" is always a parameter (results memoized via cached()).
//
// Conventions:
// - amounts are EUR and NET of withholding unless the field says gross;
// - the period [from, to] follows metrics.js: when `from` is on or before the first transaction
//   the period starts at index 0 of the series, otherwise at series.index(from);
// - "last 12 months" is the window (today − 365, today].
import { D, asset, cached } from './state.js';
import { assetHistory, fxOn, getSeries, incomeEvents, positions, qtyAt } from './engine.js';
import { addDays, addMonths, dayDiff } from './util.js';

const EPS = 1e-9;
const YEAR_DAYS = 365;
const MISSING_LOOKBACK = 400; // days of market dividends checked against the recorded ones
const MATCH_BEFORE = 7; // a recorded payment explains an ex-date when dated in [ex − 7, ex + 45]
const MATCH_AFTER = 45;
const LAG_LOOKBACK = 3 * YEAR_DAYS; // ex-date → payment delay learned from this much history

export const CCY_NAMES = {
  EUR: 'Euro', USD: 'Dollaro USA', GBP: 'Sterlina', CHF: 'Franco svizzero', JPY: 'Yen', CAD: 'Dollaro canadese',
  AUD: 'Dollaro australiano', SEK: 'Corona svedese', NOK: 'Corona norvegese', DKK: 'Corona danese',
  HKD: 'Dollaro di Hong Kong', CNY: 'Yuan cinese',
};
export const ccyLabel = (c) => (CCY_NAMES[c] ? `${CCY_NAMES[c]} (${c})` : c);

export const KIND_LABEL = { dividend: 'Dividendo', coupon: 'Cedola', interest: 'Interessi' };

// Payments in the last 12 months → how often the security pays
export function frequencyLabel(count) {
  if (count >= 10) return 'Mensile';
  if (count >= 3 && count <= 5) return 'Trimestrale';
  if (count === 2) return 'Semestrale';
  if (count === 1) return 'Annuale';
  return 'Irregolare';
}

const normIds = (accIds) => (Array.isArray(accIds) && accIds.length ? accIds : null);
const seriesKey = (accIds) => (accIds ? accIds[0] : 'all');
const kindOf = (a) => (a.type === 'bond' ? 'coupon' : a.type === 'cash' ? 'interest' : 'dividend');
const rateFor = (a, settings) => {
  const r = a.type === 'bond' ? settings.govTaxRate : settings.taxRate;
  return Number.isFinite(r) ? r : 0;
};
const yearOf = (d) => d.slice(0, 4);
const fin = (x) => (Number.isFinite(x) ? x : 0);

// Latest transaction date: fallback "today" when a caller passes none (never the clock)
function lastTxnDate() {
  let d = '1970-01-01';
  for (const t of D().txns) if (t.date > d) d = t.date;
  return d;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Index range of the report period inside a Series (same convention as metrics.periodBounds)
function periodRange(series, from, to) {
  const n = series.dates.length;
  let i0 = 0;
  if (from && from > series.start) i0 = Math.max(0, Math.min(series.index(from), n - 1));
  let i1 = to ? series.index(to) : n - 1;
  i1 = Math.max(i0, Math.min(i1, n - 1));
  return { i0, i1 };
}

// Pair market ex-dates with recorded payments (both sorted ascending). Each recorded payment
// explains at most one ex-date: the first whose window [ex − 7, ex + 45] contains it.
// Returns, per ex-date, the matched payment date or null.
export function matchPayments(exDates, paidDates) {
  const used = new Array(paidDates.length).fill(false);
  return exDates.map((ex) => {
    const lo = addDays(ex, -MATCH_BEFORE);
    const hi = addDays(ex, MATCH_AFTER);
    for (let j = 0; j < paidDates.length; j++) {
      if (used[j] || paidDates[j] < lo) continue;
      if (paidDates[j] > hi) break;
      used[j] = true;
      return paidDates[j];
    }
    return null;
  });
}

// Market dividends of an asset while it was held: [{ date, perShare, qty }] ascending
function heldDivs(h, accIds, aid, fromDate, today) {
  const out = [];
  if (!h || !Array.isArray(h.divs)) return out;
  for (const [d, v] of h.divs) {
    if (typeof d !== 'string' || d <= fromDate || d > today || !(v > 0)) continue;
    const qty = qtyAt(accIds, aid, addDays(d, -1));
    if (qty > EPS) out.push({ date: d, perShare: v, qty });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// Typical delay (days, 0..45) between ex-date and the recorded payment of one asset
function paymentLag(h, accIds, aid, paidDates, today) {
  if (!paidDates.length) return 0;
  const divs = heldDivs(h, accIds, aid, addDays(today, -LAG_LOOKBACK), today);
  const matched = matchPayments(divs.map((x) => x.date), paidDates);
  const lags = [];
  matched.forEach((paid, i) => {
    if (paid) lags.push(dayDiff(divs[i].date, paid));
  });
  return Math.max(0, Math.min(MATCH_AFTER, Math.round(median(lags))));
}

// Next-12-months forecast of one open position, or null when it paid nothing in the last 12 months.
// Market dividends (gross per share, local currency) win; otherwise recorded net payments per share.
function forecastPosition(p, { accIds, today, settings, eventsByAid }) {
  const a = p.asset;
  const lo = addDays(today, -YEAR_DAYS);
  const recorded = eventsByAid.get(p.aid) || [];
  const paidDates = [...new Set(recorded.map((e) => e.date))].sort();
  const h = assetHistory(a);
  const marketDivs = h && Array.isArray(h.divs) ? h.divs.filter(([d, v]) => typeof d === 'string' && d > lo && d <= today && v > 0) : [];
  const ccy = a.currency || 'EUR';
  let payments;
  let source;
  let currency;
  if (marketDivs.length) {
    const fxNow = fxOn(ccy, today) || 1;
    const keep = 1 - rateFor(a, settings);
    const lag = paymentLag(h, accIds, p.aid, paidDates, today);
    payments = marketDivs
      .map(([d, v]) => ({ date: d, next: addDays(addMonths(d, 12), lag), perShare: v, amount: ((v * p.qty) / fxNow) * keep }))
      .sort((x, y) => (x.date < y.date ? -1 : 1));
    source = 'market';
    currency = ccy;
  } else {
    // Net EUR received per share on each payment date (several accounts can pay the same day)
    const perDate = new Map();
    for (const e of recorded) {
      if (e.date <= lo || e.date > today) continue;
      let q = qtyAt(accIds, p.aid, e.date);
      if (!(q > EPS)) q = qtyAt(accIds, p.aid, addDays(e.date, -MATCH_AFTER)); // sold between ex-date and payment
      if (!(q > EPS)) continue;
      perDate.set(e.date, (perDate.get(e.date) || 0) + e.net / q);
    }
    payments = [...perDate.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([d, ps]) => ({ date: d, next: addMonths(d, 12), perShare: ps, amount: ps * p.qty }));
    source = 'recorded';
    currency = 'EUR';
  }
  if (!payments.length) return null;
  const count = payments.length;
  return {
    aid: p.aid,
    kind: kindOf(a),
    amount: payments.reduce((s, x) => s + x.amount, 0),
    perShare: payments.reduce((s, x) => s + x.perShare, 0), // 12 months, in `currency` (market: gross; recorded: net EUR)
    currency,
    source,
    qty: p.qty,
    count,
    frequency: frequencyLabel(count),
    nextDates: payments.map((x) => x.next).sort(),
    payments, // [{ date (last 12 months), next (projected), perShare, amount (net EUR) }]
  };
}

function groupItems(map) {
  return [...map.entries()]
    .filter(([, v]) => Math.abs(v) > EPS)
    .map(([key, value]) => ({ key, label: ccyLabel(key), value }))
    .sort((a, b) => b.value - a.value);
}

function emptyCalendar() {
  return Array.from({ length: 12 }, (_, month) => ({ month, items: [], total: 0 }));
}

/**
 * Income analytics of a scope (accIds: null = all accounts, else [accountId]) over [from, to].
 * settings defaults to the stored ones (taxRate, govTaxRate for the forecast and suggestions).
 */
export function incomeStats({ accIds = null, from = null, to = null, today, settings = null } = {}) {
  const ids = normIds(accIds);
  const st = settings || D().settings;
  const day = today || to || lastTxnDate();
  const key = ['incomeStats', ids ? ids.join(',') : 'all', from, to, day, st.taxRate, st.govTaxRate].join('|');
  return cached(key, () => computeIncome(ids, from, to, day, st));
}

function computeIncome(accIds, from, to, today, settings) {
  const series = getSeries(seriesKey(accIds));
  const events = incomeEvents(accIds);
  let pFrom = from || (series ? series.start : today);
  let pTo = to || today;
  if (pFrom > pTo) [pFrom, pTo] = [pTo, pFrom];

  /* ---------- Period totals ---------- */
  let total = 0;
  let gross = 0;
  let dividends = 0;
  let coupons = 0;
  let interest = 0;
  let taxes = 0;
  let count = 0;
  const ccyMap = new Map();
  for (const e of events) {
    if (e.date < pFrom || e.date > pTo) continue;
    total += e.net;
    gross += e.gross;
    taxes += e.tax;
    count++;
    if (e.kind === 'coupon') coupons += e.net;
    else if (e.kind === 'interest') interest += e.net;
    else dividends += e.net;
    const ccy = e.aid ? asset(e.aid).currency || 'EUR' : 'EUR';
    ccyMap.set(ccy, (ccyMap.get(ccy) || 0) + e.net);
  }

  /* ---------- Current holdings ---------- */
  const pos = positions({ accIds, date: today });
  const open = pos.filter((p) => p.qty > EPS);
  const value = open.reduce((s, p) => s + fin(p.value), 0);
  const bondMap = new Map();
  for (const p of open) {
    if (p.asset.type !== 'bond') continue;
    const ccy = p.currency || 'EUR';
    bondMap.set(ccy, (bondMap.get(ccy) || 0) + fin(p.value));
  }

  /* ---------- Yields and return decomposition ---------- */
  // Trailing yield: dividends and coupons of the last 12 months over the current value of the
  // securities. Interest is left out on both sides: the cash that earns it is not in the value,
  // so counting it would inflate the yield of a portfolio with idle cash.
  const lo12 = addDays(today, -YEAR_DAYS);
  let income12m = 0;
  for (const e of events) if (e.date > lo12 && e.date <= today && e.kind !== 'interest') income12m += e.net;
  const securitiesValue = open.reduce((s, p) => s + (p.asset.type === 'cash' ? 0 : fin(p.value)), 0);
  const yield12m = securitiesValue > EPS ? income12m / securitiesValue : 0;

  let twr = 0;
  let avgValue = 0;
  let days = 0;
  let i0 = 0;
  let i1 = -1;
  if (series) {
    ({ i0, i1 } = periodRange(series, pFrom, pTo));
    let g = 1;
    let sv = 0;
    for (let k = i0; k <= i1; k++) {
      g *= 1 + fin(series.ret[k]);
      sv += fin(series.value[k]);
    }
    twr = g - 1;
    days = i1 - i0 + 1;
    avgValue = days > 0 ? sv / days : 0;
  }
  const incomeReturn = avgValue > EPS ? total / avgValue : 0;
  const yieldPeriod = avgValue > EPS && days > 0 ? ((total / avgValue) * YEAR_DAYS) / days : 0;
  const priceReturn = twr - incomeReturn;

  /* ---------- Forecast (next 12 months) ---------- */
  const eventsByAid = new Map();
  for (const e of events) {
    if (!e.aid) continue;
    if (!eventsByAid.has(e.aid)) eventsByAid.set(e.aid, []);
    eventsByAid.get(e.aid).push(e);
  }
  const forecastByAsset = open
    .map((p) => forecastPosition(p, { accIds, today, settings, eventsByAid }))
    .filter(Boolean)
    .sort((a, b) => b.amount - a.amount);
  const forecast12m = forecastByAsset.reduce((s, f) => s + f.amount, 0);

  /* ---------- Frequency ---------- */
  const byLabel = new Map();
  for (const f of forecastByAsset) byLabel.set(f.frequency, (byLabel.get(f.frequency) || 0) + f.amount);
  let freqLabel = 'Nessuna';
  let best = -Infinity;
  for (const [label, amount] of byLabel) {
    if (amount > best) {
      best = amount;
      freqLabel = label;
    }
  }
  const frequency = { label: freqLabel, byAsset: forecastByAsset.map((f) => ({ aid: f.aid, label: f.frequency, count: f.count })) };

  /* ---------- Calendar ---------- */
  const thisYear = yearOf(today);
  const calendar = (year) => {
    const y = String(year);
    const months = emptyCalendar();
    for (const e of events) {
      if (yearOf(e.date) !== y) continue;
      months[+e.date.slice(5, 7) - 1].items.push({ date: e.date, aid: e.aid, acc: e.acc, amount: e.net, kind: e.kind, forecast: false });
    }
    if (y === thisYear) {
      for (const f of forecastByAsset) {
        for (const p of f.payments) {
          if (p.next <= today || yearOf(p.next) !== y) continue;
          months[+p.next.slice(5, 7) - 1].items.push({ date: p.next, aid: f.aid, amount: p.amount, kind: f.kind, forecast: true });
        }
      }
    }
    for (const m of months) {
      m.items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      m.total = m.items.reduce((s, it) => s + it.amount, 0);
    }
    return months;
  };
  const years = [...new Set([...events.map((e) => +yearOf(e.date)), +thisYear])].sort((a, b) => a - b);

  /* ---------- Cumulative income over the period ---------- */
  const cumulative = { dates: [], dividends: [], coupons: [] };
  if (series && i1 >= i0) {
    const perDay = new Map();
    for (const e of events) {
      if (e.date < series.dates[i0] || e.date > series.dates[i1]) continue;
      const x = perDay.get(e.date) || [0, 0];
      if (e.kind === 'coupon') x[1] += e.net;
      else x[0] += e.net;
      perDay.set(e.date, x);
    }
    let cd = 0;
    let cc = 0;
    for (let k = i0; k <= i1; k++) {
      const d = series.dates[k];
      const x = perDay.get(d);
      if (x) {
        cd += x[0];
        cc += x[1];
      }
      cumulative.dates.push(d);
      cumulative.dividends.push(cd);
      cumulative.coupons.push(cc);
    }
  }

  /* ---------- Market dividends not yet recorded ---------- */
  const missing = [];
  const lookFrom = addDays(today, -MISSING_LOOKBACK);
  for (const p of pos) {
    const a = p.asset;
    const h = assetHistory(a);
    if (!h || !Array.isArray(h.divs) || !h.divs.length) continue;
    // Match on a slightly longer window, so a payment of an older ex-date is not taken for a newer one
    const divs = heldDivs(h, accIds, p.aid, addDays(lookFrom, -MATCH_AFTER - MATCH_BEFORE), today);
    if (!divs.length) continue;
    const paidDates = [...new Set((eventsByAid.get(p.aid) || []).map((e) => e.date))].sort();
    const matched = matchPayments(divs.map((x) => x.date), paidDates);
    const ccy = a.currency || 'EUR';
    const keep = 1 - rateFor(a, settings);
    divs.forEach((x, i) => {
      if (matched[i] || x.date <= lookFrom) return;
      const g = (x.perShare * x.qty) / (fxOn(ccy, x.date) || 1);
      missing.push({ aid: p.aid, date: x.date, perShare: x.perShare, currency: ccy, qty: x.qty, gross: g, net: g * keep, kind: kindOf(a) });
    });
  }
  missing.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    from: pFrom, to: pTo, days,
    total, gross, dividends, coupons, interest, taxes, count,
    value, securitiesValue, income12m,
    yield12m, yieldPeriod,
    twr, priceReturn, incomeReturn,
    forecast12m, forecastByAsset,
    byCurrency: groupItems(ccyMap),
    bondByCurrency: groupItems(bondMap),
    calendar, years,
    cumulative,
    frequency,
    missing,
  };
}
