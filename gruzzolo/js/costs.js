// Costs and taxes: broker fees by kind, monthly summary, withheld taxes, Italian stamp duty
// (imposta di bollo / IVAFE 0,20%), value-weighted TER of the portfolio and the Italian
// capital-loss carry-forward ("zaino fiscale").
// Pure analytics: no DOM, no clock. "today" is always a parameter (results memoized via cached()).
import { D, FEE_KINDS, accName, asset, cached } from './state.js';
import { costEvents, fxOn, getSeries, positions, priceOn, realizedEvents, taxEvents, txnsFor } from './engine.js';
import { addDays, dayDiff } from './util.js';

const EPS = 1e-9;
const CENT = 0.005; // amounts below half a cent count as zero
const FEE_KEYS = ['transaction', 'autofx', 'connectivity', 'other'];
const TAX_KEYS = ['capital', 'income', 'stamp', 'other'];
const FUND_TYPES = new Set(['etf', 'fund']);
const TER_STEP_DAYS = 7;
const TER_MAX_SNAPSHOTS = 600; // longer periods widen the step instead
const CARRY_YEARS = 4; // a loss can offset gains of its own year and of the next 4
const SHOWN_PAST_YEARS = 5;

// Italian tax treatment of realized P&L by asset type:
// 'diversi' = redditi diversi (gains and losses both count), 'capitale' = redditi di capitale
// (gains cannot offset losses; losses still enter the backpack), 'escluso' = not considered.
export const FISCAL_CLASS = {
  stock: 'diversi', bond: 'diversi', crypto: 'diversi', commodity: 'diversi', other: 'diversi',
  etf: 'capitale', fund: 'capitale',
  cash: 'escluso', realestate: 'escluso',
};

const normIds = (accIds) => (Array.isArray(accIds) && accIds.length ? accIds : null);
const seriesKey = (accIds) => (accIds ? accIds[0] : 'all');
const yearOf = (d) => d.slice(0, 4);
const fin = (x) => (Number.isFinite(x) ? x : 0);
const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);

// Latest transaction date: fallback "today" when a caller passes none (never the clock)
function lastTxnDate() {
  let d = '1970-01-01';
  for (const t of D().txns) if (t.date > d) d = t.date;
  return d;
}

function validTer(t) {
  if (t === null || t === undefined || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ---------- Stamp duty ---------- */
// Estimated stamp duty for `year`: rate × value of the open securities (cash excluded) at 31/12 of year − 1
export function stampEstimate(accIds, year, rate) {
  const refDate = `${year - 1}-12-31`;
  let base = 0;
  for (const p of positions({ accIds: normIds(accIds), date: refDate })) {
    if (p.qty > EPS && p.asset.type !== 'cash') base += fin(p.value);
  }
  return { year, refDate, base, rate, amount: base * (Number.isFinite(rate) ? rate : 0) };
}

/* ---------- TER ---------- */
// Value-weighted TER of one positions snapshot. Assets without a TER count as 0; for ETFs and
// funds a missing TER also lowers the coverage (share of fund value whose TER is known).
export function terSnapshot(list) {
  let value = 0;
  let cost = 0;
  let fundValue = 0;
  let fundCovered = 0;
  const rows = [];
  for (const p of list) {
    if (!(p.qty > EPS) || p.asset.type === 'cash') continue;
    const v = fin(p.value);
    if (v <= 0) continue;
    const ter = validTer(p.asset.ter);
    value += v;
    if (ter !== null) cost += v * ter;
    if (FUND_TYPES.has(p.asset.type)) {
      fundValue += v;
      if (ter !== null) fundCovered += v;
    }
    rows.push({ aid: p.aid, type: p.asset.type, value: v, ter, cost: ter !== null ? v * ter : 0 });
  }
  for (const r of rows) r.weight = value > EPS ? r.value / value : 0;
  rows.sort((a, b) => b.value - a.value);
  return {
    value,
    cost, // EUR per year at these values
    ter: value > EPS ? cost / value : 0,
    coverage: fundValue > EPS ? fundCovered / fundValue : 1,
    rows,
  };
}

// Walks the ledger once and values the holdings at increasing dates. Same rules as
// engine.positions() (average cost per account, carry-forward prices, FX of the day, average
// cost when no price exists), without replaying every transaction for each snapshot.
function holdingsWalker(accIds) {
  const txns = txnsFor(accIds);
  const per = new Map(); // `${acc}|${aid}` → { aid, qty, costLocal }
  let ti = 0;
  return (date) => {
    while (ti < txns.length && txns[ti].date <= date) {
      const t = txns[ti++];
      if ((t.type !== 'buy' && t.type !== 'sell') || !t.aid) continue;
      const k = t.acc + '|' + t.aid;
      const h = per.get(k) || { aid: t.aid, qty: 0, costLocal: 0 };
      if (t.type === 'buy') {
        h.qty += t.qty;
        h.costLocal += t.qty * t.price;
      } else if (h.qty > 0) {
        const q = Math.min(t.qty, h.qty);
        h.costLocal -= h.costLocal * (q / h.qty);
        h.qty -= q;
        if (h.qty < 1e-9) {
          h.qty = 0;
          h.costLocal = 0;
        }
      }
      per.set(k, h);
    }
    const byAid = new Map();
    for (const h of per.values()) {
      const x = byAid.get(h.aid) || { qty: 0, costLocal: 0 };
      x.qty += h.qty;
      x.costLocal += h.costLocal;
      byAid.set(h.aid, x);
    }
    const out = [];
    for (const [aid, x] of byAid) {
      if (!(x.qty > EPS)) continue;
      const a = asset(aid);
      let price = priceOn(aid, date);
      if (!(price > 0)) price = x.costLocal / x.qty;
      out.push({ aid, asset: a, qty: x.qty, value: (x.qty * price) / fxOn(a.currency || 'EUR', date) });
    }
    return out;
  };
}

function terStats(accIds, series, from, to) {
  const empty = { end: 0, average: 0, coverage: 1, annualCost: 0, value: 0, date: null, byAsset: [], series: { dates: [], ter: [] } };
  if (!series) return empty;
  const start = from > series.start ? from : series.start;
  const end = to < series.end ? to : series.end;
  if (start > end) return empty;
  const step = Math.max(TER_STEP_DAYS, Math.ceil(dayDiff(start, end) / TER_MAX_SNAPSHOTS));
  const snapDates = [];
  for (let d = start; d <= end; d = addDays(d, step)) snapDates.push(d);
  if (snapDates[snapDates.length - 1] !== end) snapDates.push(end);
  const dates = [];
  const ter = [];
  let last = null;
  let lastDate = null;
  const walk = holdingsWalker(accIds);
  snapDates.forEach((d, i) => {
    // The last snapshot comes from engine.positions(), so it matches the rest of the report exactly
    const snap = terSnapshot(i === snapDates.length - 1 ? positions({ accIds, date: d }) : walk(d));
    if (snap.value <= EPS) return; // nothing held on that day
    dates.push(d);
    ter.push(snap.ter);
    last = snap;
    lastDate = d;
  });
  if (!last) return empty;
  return {
    end: last.ter,
    average: ter.reduce((s, x) => s + x, 0) / ter.length,
    coverage: last.coverage,
    annualCost: last.cost,
    value: last.value,
    date: lastDate,
    byAsset: last.rows,
    series: { dates, ter },
  };
}

/* ---------- Costs and taxes of a period ---------- */
/**
 * Broker costs and taxes of a scope (accIds: null = all accounts, else [accountId]) over [from, to].
 * settings defaults to the stored ones (stampDuty rate).
 */
export function costStats({ accIds = null, from = null, to = null, today = null, settings = null } = {}) {
  const ids = normIds(accIds);
  const st = settings || D().settings;
  const day = today || to || lastTxnDate();
  const key = ['costStats', ids ? ids.join(',') : 'all', from, to, day, st.stampDuty].join('|');
  return cached(key, () => computeCosts(ids, from, to, day, st));
}

function computeCosts(accIds, from, to, today, settings) {
  const series = getSeries(seriesKey(accIds));
  let pFrom = from || (series ? series.start : '0000-01-01');
  let pTo = to || today;
  if (pFrom > pTo) [pFrom, pTo] = [pTo, pFrom];
  const inPeriod = (d) => d >= pFrom && d <= pTo;
  const months = new Map();
  const monthRow = (d) => {
    const m = d.slice(0, 7);
    if (!months.has(m)) months.set(m, { month: m, broker: 0, incomeTaxes: 0, total: 0 });
    return months.get(m);
  };

  /* Broker costs */
  const sums = { transaction: 0, autofx: 0, connectivity: 0, other: 0 };
  const events = [];
  for (const e of costEvents(accIds)) {
    if (!inPeriod(e.date)) continue;
    const kind = FEE_KEYS.includes(e.kind) ? e.kind : 'other';
    const amount = fin(e.amount);
    sums[kind] += amount;
    monthRow(e.date).broker += amount;
    events.push({
      date: e.date, acc: e.acc, accName: accName(e.acc), aid: e.aid || null, kind, label: FEE_KINDS[kind],
      desc: e.desc || '', ref: e.ref || '', amount, txId: e.txId,
    });
  }
  events.sort(byDateDesc);
  const totalBroker = FEE_KEYS.reduce((s, k) => s + sums[k], 0);
  const breakdown = FEE_KEYS.map((k) => ({ key: k, label: FEE_KINDS[k], amount: sums[k], share: totalBroker > EPS ? sums[k] / totalBroker : 0 }));

  /* Taxes */
  const taxSums = { capital: 0, income: 0, stamp: 0, other: 0 };
  const taxes = taxEvents(accIds);
  for (const e of taxes) {
    if (!inPeriod(e.date)) continue;
    const kind = TAX_KEYS.includes(e.kind) ? e.kind : 'other';
    taxSums[kind] += fin(e.amount);
    if (kind === 'income') monthRow(e.date).incomeTaxes += fin(e.amount);
  }
  const monthly = [...months.values()]
    .map((r) => ({ ...r, total: r.broker + r.incomeTaxes }))
    .filter((r) => Math.abs(r.broker) > EPS || Math.abs(r.incomeTaxes) > EPS)
    .sort((a, b) => (a.month < b.month ? 1 : -1)); // most recent first

  /* Stamp duty of the year of `to` (base: securities value at 31/12 of the year before) */
  const rate = Number.isFinite(settings.stampDuty) ? settings.stampDuty : 0.002;
  const stampYear = +yearOf(pTo);
  const est = stampEstimate(accIds, stampYear, rate);
  let recorded = 0;
  for (const e of taxes) if (e.kind === 'stamp' && +yearOf(e.date) === stampYear) recorded += fin(e.amount);
  const stampDuty = {
    year: stampYear, rate, refDate: est.refDate, base: est.base, amount: est.amount, recorded,
    note: 'Con le banche e i broker italiani è l\'imposta di bollo e la trattiene il broker; con i broker esteri in regime dichiarativo (es. DEGIRO) si chiama IVAFE e la versi tu con la dichiarazione dei redditi.',
  };

  /* All taxes of the previous calendar year (estimated stamp duty added when none was recorded) */
  const prevYear = +yearOf(today) - 1;
  const prev = { capital: 0, income: 0, stamp: 0, other: 0 };
  for (const e of taxes) {
    if (+yearOf(e.date) !== prevYear) continue;
    prev[TAX_KEYS.includes(e.kind) ? e.kind : 'other'] += fin(e.amount);
  }
  const estimatedStamp = prev.stamp > CENT ? 0 : stampEstimate(accIds, prevYear, rate).amount;
  const totalTaxesPrevYear = TAX_KEYS.reduce((s, k) => s + prev[k], 0) + estimatedStamp;

  return {
    from: pFrom, to: pTo,
    ...sums,
    totalBroker,
    breakdown,
    monthly,
    events,
    capitalTaxes: taxSums.capital,
    incomeTaxes: taxSums.income,
    stampTaxes: taxSums.stamp, // stamp duty recorded inside the period
    otherTaxes: taxSums.other,
    totalTaxes: TAX_KEYS.reduce((s, k) => s + taxSums[k], 0),
    stampDuty,
    totalTaxesPrevYear,
    prevYear,
    prevYearTaxes: { ...prev, estimatedStamp },
    estimatedStamp, // > 0 when the previous year had no recorded stamp duty and it was estimated
    ter: terStats(accIds, series, pFrom, pTo),
  };
}

/* ---------- Zaino fiscale (capital-loss carry-forward) ---------- */
export const BACKPACK_NOTES = [
  'È una stima basata sulle vendite registrate nell\'app, non una consulenza fiscale: controlla sempre con il commercialista o con i documenti del broker.',
  'Una minusvalenza (perdita realizzata vendendo un titolo) può compensare le plusvalenze dell\'anno in cui nasce e dei 4 anni successivi. Si usano prima le più vecchie; dopo il 31 dicembre del quarto anno successivo scade.',
  'ETF e fondi (armonizzati UCITS): i guadagni sono «redditi di capitale» e non possono compensare le minusvalenze, quindi qui non sono contati. Le perdite su ETF e fondi invece entrano nello zaino.',
  'Azioni, obbligazioni, ETC/materie prime e crypto: guadagni e perdite sono «redditi diversi» e contano entrambi. Liquidità e immobili sono esclusi.',
  'Titoli di Stato ed equiparati (es. BTP): per legge guadagni e perdite andrebbero contati solo al 48,08%, perché tassati al 12,5%. Qui questa riduzione non è applicata: sono contati per intero.',
  'Regime amministrato (banche e broker italiani che fanno da sostituto d\'imposta): lo zaino lo gestisce il broker, separato per ogni intermediario. Regime dichiarativo (es. DEGIRO): lo gestisci tu nella dichiarazione dei redditi (quadro RT).',
  '«P&L esterno» sono guadagni (+) o perdite (−) realizzati fuori dall\'app, per esempio su un altro conto: li inserisci tu anno per anno.',
  'L\'anno in corso è provvisorio: il risultato cambia fino al 31 dicembre.',
];
const savingNote = (rate) => `Il risparmio d'imposta potenziale è il ${String(Math.round(rate * 1000) / 10).replace('.', ',')}% dello zaino disponibile: sono le tasse che non pagheresti su future plusvalenze di pari importo.`;

/**
 * Loss carry-forward by calendar year for a scope. Rows: the 5 previous years and the current one.
 * settings: taxRate (saving estimate) and externalPL ({ '2023': -75 }).
 */
export function fiscalBackpack({ accIds = null, today = null, settings = null } = {}) {
  const ids = normIds(accIds);
  const st = settings || D().settings;
  const day = today || lastTxnDate();
  const key = ['fiscalBackpack', ids ? ids.join(',') : 'all', day, st.taxRate, JSON.stringify(st.externalPL || {})].join('|');
  return cached(key, () => computeBackpack(ids, day, st));
}

function computeBackpack(accIds, today, settings) {
  const current = +yearOf(today);
  const external = settings.externalPL && typeof settings.externalPL === 'object' ? settings.externalPL : {};
  const realized = new Map(); // year → { portfolio, gains, losses, ignored }
  const yearRow = (y) => {
    if (!realized.has(y)) realized.set(y, { portfolio: 0, gains: 0, losses: 0, ignored: 0 });
    return realized.get(y);
  };
  let first = current - 9;
  for (const e of realizedEvents(accIds)) {
    const y = +yearOf(e.date);
    if (!(y <= current)) continue;
    const cls = FISCAL_CLASS[asset(e.aid).type] || 'diversi';
    if (cls === 'escluso') continue;
    const pl = fin(e.pl);
    const r = yearRow(y);
    first = Math.min(first, y);
    if (cls === 'capitale' && pl > 0) {
      r.ignored += pl; // ETF / fund gain: redditi di capitale, cannot offset losses
      continue;
    }
    r.portfolio += pl;
    if (pl >= 0) r.gains += pl;
    else r.losses += pl;
  }
  for (const k of Object.keys(external)) {
    const y = Number(k);
    if (Number.isInteger(y) && y <= current && Math.abs(fin(+external[k])) > CENT) first = Math.min(first, y);
  }

  // Walk the years: losses create lots, gains consume the oldest valid lots first (FIFO)
  const lots = [];
  const lotOf = new Map();
  const info = new Map();
  for (let y = first; y <= current; y++) {
    const r = realized.get(y) || { portfolio: 0, gains: 0, losses: 0, ignored: 0 };
    const ext = fin(+external[String(y)]);
    const net = r.portfolio + ext;
    const used = [];
    if (net < -CENT) {
      const lot = { year: y, amount: -net, remaining: -net, expires: y + CARRY_YEARS, usedBy: [] };
      lots.push(lot);
      lotOf.set(y, lot);
    } else if (net > CENT) {
      let gain = net;
      for (const lot of lots) {
        if (gain <= CENT) break;
        if (lot.year >= y || lot.expires < y || lot.remaining <= CENT) continue;
        const take = Math.min(gain, lot.remaining);
        lot.remaining -= take;
        gain -= take;
        lot.usedBy.push({ year: y, amount: take });
        used.push({ year: lot.year, amount: take });
      }
    }
    info.set(y, { ...r, external: ext, net, offset: used.reduce((s, u) => s + u.amount, 0), used });
  }
  for (const lot of lots) if (lot.remaining < CENT) lot.remaining = 0;

  const rows = [];
  let expired = 0;
  for (let y = current - SHOWN_PAST_YEARS; y <= current; y++) {
    const r = info.get(y) || { portfolio: 0, gains: 0, losses: 0, ignored: 0, external: 0, net: 0, offset: 0, used: [] };
    const lot = lotOf.get(y) || null;
    let status;
    if (y === current) status = 'in corso';
    else if (r.net > CENT) status = 'anno positivo';
    else if (!lot) status = 'nessun movimento';
    else if (lot.remaining <= 0) status = 'compensata';
    else if (lot.expires < current) status = 'scaduta';
    else status = 'usabile entro ' + lot.expires;
    if (lot && lot.expires < current) expired += lot.remaining;
    rows.push({
      year: y,
      portfolio: r.portfolio,
      external: r.external,
      net: r.net,
      status,
      expires: lot ? lot.expires : null,
      remaining: lot ? lot.remaining : 0,
      // details for the table / explanations
      gains: r.gains,
      losses: r.losses,
      ignored: r.ignored, // ETF/fund gains left out
      offset: r.offset, // older losses used against this year's gains
      used: r.used, // [{ year (of the loss), amount }]
      usedBy: lot ? lot.usedBy : [], // [{ year (of the gain), amount }]
    });
  }
  const available = lots.filter((l) => l.expires >= current).reduce((s, l) => s + l.remaining, 0);
  const taxRate = Number.isFinite(settings.taxRate) ? settings.taxRate : 0.26;
  return {
    year: current,
    rows,
    available,
    potentialSaving: available * taxRate,
    expired,
    lots: lots.map((l) => ({ year: l.year, amount: l.amount, remaining: l.remaining, expires: l.expires, valid: l.expires >= current })),
    notes: [...BACKPACK_NOTES, savingNote(taxRate)],
  };
}

export const _test = { holdingsWalker };
