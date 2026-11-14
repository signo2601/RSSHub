// Savings plans (PAC, "piano di accumulo"): the same amount invested in one security every 1, 2, 3, 6
// or 12 months on a chosen day, like the savings plans of Scalable Capital.
//
// A plan is part of the data (data.plans):
//   { id, acc, aid, amount, every, day, start, end?, step?, fee?, sepa, paused?, done?, skipped?, createdAt }
// amount: euros of the first purchase, fees included; step: yearly increase (0.02 = +2% at every
//   anniversary of the first purchase, the "adeguamento all'inflazione"); day: 1-28;
// start: the first purchase is on `day` of that month, or of the next month when `day` has passed;
// done: the last scheduled day already handled (purchases after it are still to come).
//
// Its purchases become ordinary buy transactions ({ plan: id, gen: true }): fractional shares at the
// closing price of the execution day, the scheduled day or, when the market is closed then, the next
// day with a price. A purchase is recorded once that day is over and its close is known; a security
// without market data buys at its last price, on the day. With sepa (the default) the money comes by
// SEPA direct debit from a bank account outside the app: the purchase never touches the cash of the
// broker account and the engine counts it as money coming in, like Scalable does.
// Editing a plan changes the purchases still to come; past ones change only when recomputed on purpose.
import { D, asset, account } from './state.js';
import { assetHistory, fxOn, fxSeries, priceOn } from './engine.js';
import { addDays, addMonths, dayDiff, isWeekend, iso, todayISO, newId, money } from './util.js';

export const EVERY = [1, 2, 3, 6, 12];
export const EVERY_LABEL = { 1: 'Ogni mese', 2: 'Ogni 2 mesi', 3: 'Ogni 3 mesi', 6: 'Ogni 6 mesi', 12: 'Ogni anno' };
export const EVERY_SHORT = { 1: 'al mese', 2: 'ogni 2 mesi', 3: 'ogni 3 mesi', 6: 'ogni 6 mesi', 12: 'all\'anno' };
export const STEPS = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1];
export const MAX_DAY = 28;
const LATE_DAYS = 10; // a close more than this many days after the scheduled day is not that day's price
const MAX_RUNS = 400; // purchases handled per plan in one pass (33 years of monthly purchases)

const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const everyOf = (p) => (EVERY.includes(+p.every) ? +p.every : 1);
export const dayOf = (p) => Math.min(MAX_DAY, Math.max(1, Math.round(+p.day) || 1));
const stepOf = (p) => (Number.isFinite(+p.step) && +p.step > -1 ? +p.step : 0);
const feeOf = (p) => (Number.isFinite(+p.fee) && +p.fee > 0 ? +p.fee : 0);
const monthsBetween = (a, b) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

export const plans = () => (Array.isArray(D().plans) ? D().plans : []);
export const planById = (id) => plans().find((p) => p.id === id) || null;
export const plansOf = (aid) => plans().filter((p) => p.aid === aid);
export const planTxns = (id, data = D()) => data.txns.filter((t) => t.plan === id);

/* ---------- Schedule ---------- */
// First purchase: `day` of the start month, or of the next month when that day is already past
export function firstDate(p) {
  const d = `${p.start.slice(0, 7)}-${String(dayOf(p)).padStart(2, '0')}`;
  return d >= p.start ? d : addMonths(d, 1);
}
// Scheduled day of the k-th purchase (0 = first)
export const nthDate = (p, k) => addMonths(firstDate(p), k * everyOf(p));

// Index of the first purchase scheduled after `date` (exclusive)
export function indexAfter(p, date) {
  const f = firstDate(p);
  if (!date || date < f) return 0;
  let k = Math.max(0, Math.floor(monthsBetween(f, date) / everyOf(p)));
  while (nthDate(p, k) <= date) k++;
  return k;
}

// Euros of the k-th purchase: the amount grows by `step` at every anniversary of the first purchase
export const amountAt = (p, k) => round(+p.amount * (1 + stepOf(p)) ** Math.floor((k * everyOf(p)) / 12), 2);

// Scheduled purchases in [from, to] (dates included): [{ k, date, amount }]
export function scheduleBetween(p, from, to, max = 600) {
  const out = [];
  for (let k = indexAfter(p, addDays(from, -1)); out.length < max; k++) {
    const date = nthDate(p, k);
    if (date > to || (p.end && date > p.end)) break;
    out.push({ k, date, amount: amountAt(p, k) });
  }
  return out;
}

// Next purchase still to come (today included), or null when the plan is over or paused
export function nextRun(p, today = todayISO()) {
  if (p.paused) return null;
  const after = p.done && p.done >= addDays(today, -1) ? p.done : addDays(today, -1);
  const k = indexAfter(p, after);
  const date = nthDate(p, k);
  return p.end && date > p.end ? null : { k, date, amount: amountAt(p, k) };
}

// Purchases due but not recorded yet: their day is not over, or its price has not arrived
export function pendingRuns(p, today = todayISO()) {
  if (p.paused) return [];
  const out = [];
  for (let k = indexAfter(p, p.done || ''); out.length < 24; k++) {
    const date = nthDate(p, k);
    if (date > today || (p.end && date > p.end)) break;
    out.push({ k, date, amount: amountAt(p, k) });
  }
  return out;
}

// Money the plan will invest in the next 12 months (from today), for the summary of the plan
export function yearAhead(p, today = todayISO()) {
  if (p.paused) return 0;
  return round(scheduleBetween(p, today, addDays(addMonths(today, 12), -1)).reduce((s, r) => s + r.amount, 0), 2);
}

/* ---------- Execution ---------- */
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
const nextWeekday = (d) => (isWeekend(d) ? nextWeekday(addDays(d, 1)) : d);

// Day and price of the purchase scheduled on `s`: { date, price }, 'wait' while that day is not over
// or its price has not arrived, 'skip' when no price exists near that day (before the market data starts)
export function execution(a, s, today = todayISO()) {
  const h = assetHistory(a);
  if (h && Array.isArray(h.dates) && h.dates.length) {
    let i = lowerBound(h.dates, s);
    while (i < h.dates.length && !(h.close[i] > 0)) i++;
    if (i >= h.dates.length) return 'wait';
    const date = h.dates[i];
    if (date >= today) return 'wait';
    // the close is final once a later day exists, or the data was downloaded after that day
    if (i === h.dates.length - 1 && h.updatedAt && iso(new Date(h.updatedAt)) <= date) return 'wait';
    if (dayDiff(s, date) <= LATE_DAYS) return { date, price: h.close[i] };
    // A hole in the market data: the last close before the day, on the day itself
    let j = i - 1;
    while (j >= 0 && !(h.close[j] > 0)) j--;
    if (j < 0 || dayDiff(h.dates[j], s) > LATE_DAYS) return 'skip';
    return { date: nextWeekday(s), price: h.close[j] };
  }
  if (a.priceSource === 'auto' && a.symbol) return 'wait'; // its market data has not arrived yet
  const date = nextWeekday(s);
  if (date > today) return 'wait';
  const price = priceOn(a.id, date);
  return price > 0 ? { date, price } : 'wait';
}

// Euros paid for a purchase, fees included
export const paidOf = (t) => {
  const fx = +t.fx > 0 ? +t.fx : fxOn(asset(t.aid).currency, t.date);
  return (+t.qty * +t.price) / fx + (+t.fee || 0) + (+t.fxFee || 0);
};
// A purchase of the plan's account and security made around the scheduled day `s`
const around = (t, p, s) => t.type === 'buy' && t.acc === p.acc && t.aid === p.aid && t.date >= addDays(s, -3) && t.date <= addDays(s, LATE_DAYS);
// The purchase of day `s` already exists: recorded by the plan, adopted by it earlier (imported from the
// broker, typed by hand), or an ordinary purchase around that day for the same money
const sameRun = (t, p, s, id, amount) => t.id === id
  || (t.plan === p.id && !t.gen && around(t, p, s))
  || (!t.plan && around(t, p, s) && Math.abs(paidOf(t) - amount) <= Math.max(1, amount * 0.03));

// Records the purchases due up to `today` (all plans, or `only` one id). Mutates data.
// Returns { added: [txns], changed } (changed: some plan moved on, even with no new purchase).
export function runPlans({ data = D(), today = todayISO(), only = null } = {}) {
  const added = [];
  let changed = false;
  for (const p of Array.isArray(data.plans) ? data.plans : []) {
    if (only && p.id !== only) continue;
    if (!isDate(p.start) || !(+p.amount > 0) || !data.assets[p.aid] || !data.accounts.some((x) => x.id === p.acc)) continue;
    const a = data.assets[p.aid];
    const ccy = a.currency || 'EUR';
    let k = p.done ? indexAfter(p, p.done) : 0;
    for (let n = 0; n < MAX_RUNS; n++, k++) {
      const s = nthDate(p, k);
      if (s > today || (p.end && s > p.end)) break;
      if (p.paused) {
        p.done = s;
        changed = true;
        continue;
      }
      const amount = amountAt(p, k);
      const ex = execution(a, s, today);
      if (ex === 'wait') break;
      if (ex === 'skip') p.skipped = (+p.skipped || 0) + 1;
      else {
        const fx = ccy === 'EUR' ? 1 : fxSeries(ccy).length ? fxOn(ccy, ex.date) : 0;
        if (!(fx > 0)) break; // wait for the exchange rates
        const fee = feeOf(p);
        const qty = round(((amount - fee) * fx) / ex.price, 6);
        const id = `p-${p.id}-${s}`;
        const twin = data.txns.find((t) => sameRun(t, p, s, id, amount));
        if (twin) {
          // already recorded (imported from the broker, or typed by hand): it becomes part of the plan
          if (!twin.plan) twin.plan = p.id;
        } else if (qty > 0) {
          const t = { id, acc: p.acc, aid: p.aid, date: ex.date, type: 'buy', qty, price: round(ex.price, 6), plan: p.id, gen: true };
          if (ccy !== 'EUR') t.fx = round(fx, 6);
          if (fee) t.fee = round(fee, 2);
          if (p.sepa !== false) t.sepa = true;
          if (a.demo) t.demo = true;
          data.txns.push(t);
          added.push(t);
        }
      }
      p.done = s;
      changed = true;
    }
  }
  return { added, changed };
}

// Imported purchases replace the plan's simulated ones they match (the broker knows the real price
// and quantity). Mutates data; returns how many were replaced.
export function replaceWithReal(data, imported) {
  let n = 0;
  for (const r of imported) {
    if (r.type !== 'buy' || r.plan) continue;
    const i = data.txns.findIndex((t) => t.gen && t.plan && t.acc === r.acc && t.aid === r.aid
      && r.date >= addDays(t.date, -4) && r.date <= addDays(t.date, 6)
      && Math.abs(paidOf(r) - paidOf(t)) <= Math.max(1, paidOf(t) * 0.03));
    if (i < 0) continue;
    r.plan = data.txns[i].plan;
    data.txns.splice(i, 1);
    n++;
  }
  return n;
}

/* ---------- Totals of a plan ---------- */
// Purchases, money invested, units bought (current value is computed by the view with the last price)
export function planTotals(id, data = D()) {
  const list = planTxns(id, data).filter((t) => t.type === 'buy');
  let paid = 0;
  let qty = 0;
  for (const t of list) {
    paid += paidOf(t);
    qty += +t.qty || 0;
  }
  return { count: list.length, paid: round(paid, 2), qty, first: list.length ? list.reduce((m, t) => (t.date < m ? t.date : m), list[0].date) : null };
}

/* ---------- Editing ---------- */
// A new plan with defaults (first purchase on `day` from today)
export function blankPlan({ acc = '', aid = '' } = {}) {
  return { id: newId('pac'), acc, aid, amount: 100, every: 1, day: 1, start: todayISO(), step: 0, fee: 0, sepa: true, createdAt: Date.now() };
}

// The purchases of a plan become ordinary ones (they stay in the portfolio, paid as they were)
export function detachPurchases(data, id) {
  for (const t of data.txns) {
    if (t.plan === id) {
      delete t.plan;
      delete t.gen;
    }
  }
}

// Removes a plan; with `purchases` also the purchases it recorded by itself (imported ones stay,
// they just stop belonging to it). Returns how many purchases were removed.
export function deletePlan(data, id, { purchases = false } = {}) {
  data.plans = (Array.isArray(data.plans) ? data.plans : []).filter((p) => p.id !== id);
  const before = data.txns.length;
  if (purchases) data.txns = data.txns.filter((t) => !(t.plan === id && t.gen));
  detachPurchases(data, id);
  return before - data.txns.length;
}

// Forget the purchases recorded by the plan itself, so the next run records them again with the
// plan as it is now (after an edit that should apply to the past too). Returns how many went.
export function resetPlan(data, p) {
  const before = data.txns.length;
  data.txns = data.txns.filter((t) => !(t.plan === p.id && t.gen));
  delete p.done;
  delete p.skipped;
  return before - data.txns.length;
}

// Euros of the next purchase (of the last one, for a plan that is over)
export function currentAmount(p, today = todayISO()) {
  const next = nextRun({ ...p, paused: false }, today);
  return amountAt(p, next ? next.k : Math.max(0, indexAfter(p, today) - 1));
}
// "200,00 € al mese"
export const planSummary = (p, today = todayISO()) => `${money(currentAmount(p, today))} ${EVERY_SHORT[everyOf(p)]}`;

// Name of the plan for lists and toasts: the security, and the account when several have one
export function planName(p) {
  const a = asset(p.aid);
  const acc = account(p.acc);
  const same = plans().filter((x) => x.aid === p.aid).length > 1;
  return same && acc ? `${a.name} · ${acc.name}` : a.name;
}
