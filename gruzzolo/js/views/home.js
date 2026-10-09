// Tab "Portafoglio": hero with total value and period gain, value/performance chart with scrubbing,
// KPI row, accounts strip, positions list, recent activity. Also the "Transazioni" list (tab 'tx')
// and small UI fragments shared by the other portfolio views (avatar, change pills, transaction rows).
import { S, D, asset, account, accName, scopeIds, scopeKey, hasDemo, cached, incomeLabel, assetCode, TYPE_LABEL, FEE_KINDS, TAX_KINDS } from '../state.js';
import { ACTIONS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { getSeries, positions, txnsFor, lastQuote, incomeEvents, cashAt, fxOn, qtyAt } from '../engine.js';
import { lineChart, chartScrubHandlers } from '../charts.js';
import {
  esc, icon, money, moneySigned, pct, pctSigned, pctPlain, qtyFmt, priceFmt, fmtDate, fmtTime, tone, todayISO,
  addDays, addMonths, dayDiff, contentWidth, isDesktop, hashHue, sum, compact, MONTHS_LONG,
} from '../util.js';

/* ======================================================================
   Shared fragments (also used by sheets.js and market.js)
   ====================================================================== */

// Round avatar with the ticker initials; hue derived from the ticker so it stays stable
export function avatar(a, size = '') {
  const item = a || {};
  const code = String(item.ticker || assetCode(item) || item.name || '?');
  const txt = code.replace(/[^A-Za-z0-9]/g, '').slice(0, code.length <= 4 ? 4 : 3).toUpperCase() || '?';
  const cash = item.type === 'cash';
  const bg = cash ? 'var(--c-other)' : `hsl(${hashHue(item.ticker || item.symbol || item.name || '?')} 42% 44%)`;
  const cls = ['avatar', size, txt.length > 3 && size !== 'lg' ? 'l4' : ''].filter(Boolean).join(' ');
  return `<span class="${cls}" style="background:${bg}" aria-hidden="true">${cash ? icon('wallet') : esc(txt)}</span>`;
}

// Percentage pill without sign, with a triangle (▲ up, ▼ down)
export function pctPill(r, digits = 2) {
  if (!Number.isFinite(r)) return '<span class="pill flat">—</span>';
  const t = r > 0.00005 ? 'up' : r < -0.00005 ? 'down' : 'flat';
  const tri = t === 'up' ? '▲' : t === 'down' ? '▼' : '';
  return `<span class="pill ${t}">${tri ? `<span class="tri" aria-hidden="true">${tri}</span>` : ''}${pct(Math.abs(r), digits)}</span>`;
}

// Gain chip: "▲ +1.234,00 € (+5,20%)"
export function deltaChip(gain, r, extra = '') {
  const t = Number.isFinite(r) ? tone(r, 0.00005) : tone(gain);
  const tri = t === 'up' ? '▲' : t === 'down' ? '▼' : '•';
  return `<span class="delta ${t}"><span class="tri" aria-hidden="true">${tri}</span>${moneySigned(gain)}${Number.isFinite(r) ? ` (${pctSigned(r)})` : ''}</span>${extra}`;
}

// Unit shown after a quantity ("12 quote", "5 az.")
export function unitFor(a) {
  if (!a) return '';
  if (a.type === 'crypto') return assetCode(a) || '';
  return { stock: 'az.', etf: 'quote', fund: 'quote', bond: 'titoli', commodity: 'quote', other: 'pz.' }[a.type] || '';
}

const FEE_SHORT = { transaction: 'Commissione', autofx: 'Costo cambio valuta', connectivity: 'Connectivity fee', other: 'Altro costo' };
const TAX_SHORT = { capital: 'Imposta su plusvalenze', income: 'Ritenuta su dividendi', stamp: 'Imposta di bollo', other: 'Imposta' };
const TX_ICON = { buy: 'down', sell: 'upArrow', div: 'euro', interest: 'euro', deposit: 'download', withdraw: 'upload', fee: 'receipt', tax: 'bank' };

// Short Italian label of a transaction ("Acquisto", "Cedola", "Imposta di bollo"…)
export function txLabel(t) {
  switch (t.type) {
    case 'buy': return 'Acquisto';
    case 'sell': return 'Vendita';
    case 'div': return t.aid ? incomeLabel(t.aid) : 'Dividendo';
    case 'interest': return 'Interessi';
    case 'deposit': return 'Deposito';
    case 'withdraw': return 'Prelievo';
    case 'fee': return FEE_SHORT[t.kind] || 'Commissione';
    case 'tax': return TAX_SHORT[t.kind] || 'Imposta';
    default: return 'Operazione';
  }
}
export const feeKindLabel = (k) => FEE_KINDS[k] || FEE_KINDS.other;
export const taxKindLabel = (k) => TAX_KINDS[k] || TAX_KINDS.other;

// Exchange rate used by a trade (units of currency per EUR)
export function txFx(t) {
  if (t.fx > 0) return t.fx;
  const a = t.aid ? asset(t.aid) : null;
  return a && a.currency && a.currency !== 'EUR' ? fxOn(a.currency, t.date) : 1;
}

// Signed EUR effect of a transaction on the account (buy negative, sell positive…)
export function txAmount(t) {
  const fee = +t.fee || 0;
  const fxFee = +t.fxFee || 0;
  const tax = +t.tax || 0;
  const amount = +t.amount || 0;
  switch (t.type) {
    case 'buy': return -((t.qty * t.price) / txFx(t) + fee + fxFee);
    case 'sell': return (t.qty * t.price) / txFx(t) - fee - fxFee - tax;
    case 'div':
    case 'interest':
    case 'deposit': return amount;
    case 'withdraw':
    case 'fee':
    case 'tax': return -amount;
    default: return 0;
  }
}

const multiAccount = () => D().accounts.length > 1 && !scopeIds();

// One transaction as a list row (opens the transaction detail)
export function txRow(t, { showAsset = true, showYear = true, showAcc = multiAccount() } = {}) {
  const a = t.aid ? asset(t.aid) : null;
  const label = txLabel(t);
  const date = fmtDate(t.date, showYear);
  let detail = '';
  if ((t.type === 'buy' || t.type === 'sell') && a) detail = `${qtyFmt(t.qty)} × ${priceFmt(t.price, a.currency || 'EUR')}`;
  const title = showAsset && a ? a.name : label;
  // The date comes before quantity × price: on a phone the end of the line gets cut
  const subParts = showAsset && a ? [label, date, detail] : [date, detail];
  if (!a && t.note) subParts.unshift(t.note);
  const amt = txAmount(t);
  let cls = '';
  let text = money(Math.abs(amt));
  if (t.type === 'div' || t.type === 'interest') {
    cls = 'up';
    text = moneySigned(amt);
  } else if (t.type === 'fee' || t.type === 'tax') {
    cls = 'down';
    text = moneySigned(amt);
  } else if (t.type === 'sell' || t.type === 'deposit') text = moneySigned(amt);
  else if (t.type === 'withdraw') text = moneySigned(amt);
  return `<button class="row tx-row" type="button" data-act="open-tx" data-id="${esc(t.id)}">
    <span class="tx-ico ${esc(t.type)}">${icon(TX_ICON[t.type] || 'receipt')}</span>
    <span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${subParts.filter(Boolean).map(esc).join(' · ')}</span></span>
    <span class="row-end"><span class="row-value ${cls}">${text}</span>${showAcc ? `<span class="row-sub">${esc(accName(t.acc))}</span>` : ''}</span>
  </button>`;
}

// Banner shown while the example portfolio is loaded
export function demoBanner() {
  if (!hasDemo()) return '';
  return `<div class="banner demo-banner" role="note">${icon('info')}
    <p><strong>Dati di esempio.</strong> Operazioni e prezzi sono simulati per mostrarti l'app. Quando vuoi, parti dal tuo portafoglio.</p>
    <button class="btn sm primary" type="button" data-act="demo-remove">Inizia da zero</button>
  </div>`;
}

// The (i) button of the report explanations (action 'info' is owned by report.js)
const infoBtn = (key) => `<button class="info-btn" type="button" data-act="info" data-key="${esc(key)}" aria-label="Che cos'è?">i</button>`;

/* ======================================================================
   Range logic of the home chart
   ====================================================================== */
export const RANGES = [['1S', '1S'], ['1M', '1M'], ['3M', '3M'], ['YTD', 'YTD'], ['1A', '1A'], ['3A', '3A'], ['MAX', 'Max']];
const RANGE_TEXT = {
  '1S': "nell'ultima settimana",
  '1M': "nell'ultimo mese",
  '3M': 'negli ultimi 3 mesi',
  YTD: "da inizio anno",
  '1A': "nell'ultimo anno",
  '3A': 'negli ultimi 3 anni',
  MAX: "dall'inizio",
};
const rangeKey = (r) => (RANGE_TEXT[r] ? r : '1A');

// Close the range starts from (the base); null = since the first transaction
export function rangeStart(range, today) {
  switch (range) {
    case '1S': return addDays(today, -7);
    case '1M': return addMonths(today, -1);
    case '3M': return addMonths(today, -3);
    case 'YTD': return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case '1A': return addMonths(today, -12);
    case '3A': return addMonths(today, -36);
    default: return null;
  }
}

// Points of a range. gain = value change − net external flows; perf = time-weighted return.
// Pure: works on any Series-like object ({ start, dates, value, invested, cash, flowIn, flowOut, ret }).
export function rangePoints(series, range, today) {
  const n = series && series.dates ? series.dates.length : 0;
  if (!n) return null;
  const idx = (d) => {
    if (typeof series.index === 'function') return series.index(d);
    if (d < series.dates[0]) return -1;
    return Math.min(dayDiff(series.dates[0], d), n - 1);
  };
  const s = rangeStart(range, today);
  let end = n - 1;
  if (today >= series.dates[0]) end = Math.max(0, Math.min(idx(today), n - 1));
  let base = -1;
  if (s && s > series.dates[0]) base = Math.min(idx(s), end);
  const out = { dates: [], value: [], invested: [], gain: [], perf: [], base, end };
  const push = (k, g, p) => {
    out.dates.push(series.dates[k]);
    out.value.push(series.value[k]);
    out.invested.push((series.invested ? series.invested[k] : 0) + (series.cash ? series.cash[k] : 0));
    out.gain.push(g);
    out.perf.push(p);
  };
  let gain = 0;
  let growth = 1;
  let prev = base >= 0 ? series.value[base] : 0;
  if (base >= 0) push(base, 0, 0);
  for (let k = base + 1; k <= end; k++) {
    gain += series.value[k] - prev - (series.flowIn[k] || 0) + (series.flowOut[k] || 0);
    growth *= 1 + (series.ret[k] || 0);
    prev = series.value[k];
    push(k, gain, growth - 1);
  }
  const last = out.dates.length - 1;
  out.gainTotal = last >= 0 ? out.gain[last] : 0;
  out.perfTotal = last >= 0 ? out.perf[last] : 0;
  out.valueEnd = last >= 0 ? out.value[last] : 0;
  return out;
}

function rangeFor(key, range) {
  const today = todayISO();
  return cached(`home-range:${key}:${range}:${today}`, () => {
    const s = getSeries(key);
    return s ? rangePoints(s, range, today) : null;
  });
}

/* ======================================================================
   Market status helpers
   ====================================================================== */
const isLinked = (a) => Boolean(a && a.symbol && (a.priceSource === 'auto' || a.priceSource === 'demo'));
const isManual = (a) => Boolean(a && a.type !== 'cash' && (a.priceSource === 'manual' || !a.symbol));

// Today's change of the open positions, only from fresh market quotes and only on the
// quantity already held at the previous close (shares bought today did not "move" for the user)
function todayChange(open, today, ids = null) {
  let change = 0;
  let base = 0;
  let count = 0;
  let latest = '';
  for (const p of open) {
    const a = p.asset;
    if (!isLinked(a)) continue;
    if (a.priceSource === 'auto' && market.status === 'offline') continue;
    const q = lastQuote(p.aid);
    if (!q || q.source !== 'market' || !q.date || dayDiff(q.date, today) > 4) continue;
    const before = p.qty > 0 ? Math.min(1, Math.max(0, qtyAt(ids, p.aid, addDays(q.date, -1))) / p.qty) : 0;
    if (!(before > 0)) continue;
    change += p.dayChange * before;
    base += (p.value - p.dayChange) * before;
    count++;
    if (q.date > latest) latest = q.date;
  }
  if (!count) return null;
  return { change, pct: base > 0 ? change / base : 0, latest, isToday: latest === today };
}

// One line about prices still loading or the server being unreachable
function priceStatusLine(open) {
  const real = open.filter((p) => p.asset.priceSource === 'auto' && p.asset.symbol);
  if (!real.length) return '';
  const missing = real.filter((p) => !market.getHistory(p.asset.symbol));
  if (market.status === 'offline') {
    return `<p class="price-status">${icon('cloud')}<span>Server prezzi non raggiungibile: uso gli ultimi prezzi salvati${missing.length ? ` (${missing.length} ${missing.length === 1 ? 'titolo senza prezzo di mercato' : 'titoli senza prezzo di mercato'})` : ''}.</span></p>`;
  }
  if (missing.length) {
    return `<p class="price-status busy" aria-live="polite"><span class="dot busy"></span><span>Carico i prezzi di ${missing.length} ${missing.length === 1 ? 'titolo' : 'titoli'}…</span></p>`;
  }
  return '';
}

/* ======================================================================
   Home view
   ====================================================================== */
let hero = null; // data for the scrub handlers of the hero chart

const SORTERS = {
  value: (a, b) => b.value - a.value,
  day: (a, b) => b.dayChangePct - a.dayChangePct || b.value - a.value,
  perf: (a, b) => b.unrealPct - a.unrealPct,
  name: (a, b) => a.asset.name.localeCompare(b.asset.name, 'it'),
};

function scopeTitle() {
  const ids = scopeIds();
  if (ids) return accName(ids[0]);
  return D().accounts.length > 1 ? 'Tutti i conti' : 'Il tuo portafoglio';
}

function emptyHome() {
  const scoped = Boolean(scopeIds());
  const none = !D().txns.length;
  return `<div class="page home">${demoBanner()}
    <div class="empty home-empty">
      <div class="empty-ill">${icon('chart')}</div>
      <h2>${scoped && !none ? 'Questo conto è vuoto' : 'Il tuo portafoglio è vuoto'}</h2>
      <p>Registra il primo acquisto di azioni, ETF, obbligazioni o crypto. Valore, grafici, dividendi e costi si calcolano da soli, con i prezzi aggiornati da Yahoo Finance.</p>
      <div class="btns">
        <button class="btn primary" type="button" data-act="add-tx">${icon('plus')}Registra un'operazione</button>
        <button class="btn" type="button" data-act="tab" data-tab="more">${icon('upload')}Importa da DEGIRO o Scalable</button>
        ${none ? '<button class="btn ghost" type="button" data-act="demo-load">Guarda un esempio</button>' : ''}
      </div>
    </div>
  </div>`;
}

function heroDefaultHtml(R, range, today, todayInfo) {
  // A range longer than the portfolio's life is simply "since the start"
  const when = R && R.base < 0 ? RANGE_TEXT.MAX : RANGE_TEXT[range];
  const delta = R ? deltaChip(R.gainTotal, R.perfTotal, `<span class="muted">${when}</span>`) : '';
  const day = todayInfo
    ? `<span class="hero-today ${tone(todayInfo.change)}">${todayInfo.isToday ? 'Oggi' : 'Ultima seduta'} ${moneySigned(todayInfo.change)} (${pctSigned(todayInfo.pct)})</span>`
    : '';
  return { label: 'Valore totale', value: money(R ? R.valueEnd : 0), delta, day };
}

function accountCards(range) {
  const accs = D().accounts;
  if (scopeIds() || accs.length < 2) return '';
  const cards = accs.map((a, i) => {
    const R = rangeFor(a.id, range);
    const value = R ? R.valueEnd : 0;
    const broker = a.broker && a.broker !== 'Altro' && a.broker !== a.name ? a.broker : (a.cashMode === 'track' ? 'Liquidità tracciata' : 'Conto');
    return `<button class="acc-card" type="button" data-act="pick-scope" data-scope="${esc(a.id)}" style="--acc:var(--c${(i % 8) + 1})" aria-label="Mostra solo ${esc(a.name)}">
      <span class="acc-name"><i aria-hidden="true"></i>${esc(a.name)}</span>
      <span class="acc-broker">${esc(broker)}</span>
      <span class="acc-value">${money(value)}</span>
      ${R ? pctPill(R.perfTotal) : '<span class="pill flat">nessuna operazione</span>'}
    </button>`;
  }).join('');
  return `<section class="section" aria-label="Conti">
    <div class="sec-head"><h2>Conti</h2><span class="hint">Rendimento ${RANGE_TEXT[range]}</span></div>
    <div class="acc-strip">${cards}</div>
  </section>`;
}

function positionRow(p, today) {
  const a = p.asset;
  const unit = unitFor(a);
  const closed = p.qty <= 0;
  let sub;
  if (closed) sub = 'Posizione chiusa';
  else if (a.type === 'cash' || a.type === 'realestate') sub = `${TYPE_LABEL[a.type]} · ${pctPlain(p.weight)}`;
  else sub = `${qtyFmt(p.qty)}${unit ? ' ' + esc(unit) : ''} · ${pctPlain(p.weight)}`;
  let end;
  if (closed) {
    const result = p.realized + p.income;
    end = `<span class="row-value ${tone(result)}">${moneySigned(result)}</span><span class="row-sub">risultato</span>`;
  } else {
    const q = isLinked(a) ? lastQuote(p.aid) : null;
    const fresh = q && q.source === 'market' && q.date && dayDiff(q.date, today) <= 4 && !(a.priceSource === 'auto' && market.status === 'offline');
    const day = fresh && Math.abs(p.dayChangePct) > 0.000005
      ? `<span class="row-today ${tone(p.dayChangePct, 0.00005)}">${q.date === today ? 'oggi' : 'ultima seduta'} ${pctSigned(p.dayChangePct)}</span>`
      : '';
    end = `<span class="row-value">${money(p.value)}</span>${a.type === 'cash' ? '' : pctPill(p.unrealPct)}${day}`;
  }
  return `<button class="row pos-row${closed ? ' closed' : ''}" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">
    ${avatar(a)}
    <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${sub}</span></span>
    <span class="row-end">${end}</span>
  </button>`;
}

function staleManual(open, today) {
  return open.filter((p) => {
    if (!isManual(p.asset)) return false;
    const q = lastQuote(p.aid);
    return !q || !q.date || dayDiff(q.date, today) > 7;
  });
}

export function renderHome() {
  const today = todayISO();
  const ids = scopeIds();
  const key = scopeKey();
  const txns = txnsFor(ids);
  if (!txns.length) {
    hero = null;
    return emptyHome();
  }
  const range = rangeKey(S.ui.range);
  const valueMode = S.ui.chartMode !== 'perf';
  const R = rangeFor(key, range);
  const all = positions({ accIds: ids });
  const open = all.filter((p) => p.qty > 0);
  const closed = all.filter((p) => p.qty <= 0);
  const todayInfo = todayChange(open, today, ids);
  const def = heroDefaultHtml(R, range, today, todayInfo);

  // Chart
  const w = contentWidth();
  const h = isDesktop() ? 260 : 196;
  let chart = '';
  const tracksCash = D().accounts.some((a) => a.cashMode === 'track' && (!ids || ids.includes(a.id)));
  if (R && R.dates.length === 1) {
    chart = `<div class="chart-empty-note">Il grafico si disegna dal secondo giorno: oggi è il primo giorno del ${ids ? 'conto' : 'portafoglio'}.</div>`;
  } else if (R && R.dates.length) {
    const yFmt = S.ui.hide ? () => '' : compact;
    chart = valueMode
      ? lineChart('home-chart', {
        dates: R.dates,
        series: [
          { name: 'Valore', color: 'var(--accent-line)', values: R.value, area: true, width: 2.25 },
          { name: tracksCash ? 'Investito + liquidità' : 'Capitale investito', color: 'var(--muted)', values: R.invested, dash: true, width: 1.5 },
        ],
        w, h, yFormat: yFmt, legend: true,
        tooltipValue: (v) => money(v),
        ariaLabel: 'Valore del portafoglio nel tempo',
      })
      : lineChart('home-chart', {
        dates: R.dates,
        series: [{ name: 'Rendimento', color: 'var(--accent-line)', values: R.perf, area: true, width: 2.25 }],
        w, h, zero: true, legend: false,
        yFormat: (v) => `${(v * 100).toLocaleString('it-IT', { maximumFractionDigits: Math.abs(v) < 0.1 ? 1 : 0 })}%`,
        tooltipValue: (v) => pctSigned(v),
        ariaLabel: 'Rendimento ponderato nel tempo',
      });
  }
  hero = R ? { R, def, valueMode } : null;

  // KPI row
  const cost = sum(open, (p) => p.cost);
  const unreal = sum(open, (p) => p.unreal);
  const realized = sum(all, (p) => p.realized);
  const income = sum(incomeEvents(ids), (e) => e.net);
  const kpi = (label, value, { cls = '', sub = '', info = '', wide = false } = {}) => `<div class="kpi${wide ? ' wide' : ''}">
    <div class="kpi-head"><span class="kpi-label">${label}</span>${info ? infoBtn(info) : ''}</div>
    <div class="kpi-value ${cls}">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div>`;
  let kpis = kpi('Capitale investito', money(cost), { sub: `${open.length} ${open.length === 1 ? 'posizione aperta' : 'posizioni aperte'}` })
    + kpi('Plus/minus latente', moneySigned(unreal), { cls: tone(unreal), sub: cost > 0 ? `${pctSigned(unreal / cost)} sul capitale` : 'se vendessi oggi', info: 'plNonRealizzato' })
    + kpi('Plus/minus realizzata', moneySigned(realized), { cls: tone(realized), sub: 'dalle vendite, prima delle tasse', info: 'plRealizzato' })
    + kpi('Dividendi e cedole', money(income), { sub: 'netti dall\'inizio, interessi inclusi' });
  if (tracksCash) kpis += kpi('Liquidità', money(cashAt(ids, today)), { sub: 'contanti sul conto del broker', info: 'liquidita', wide: true });

  // Positions
  const sort = SORTERS[S.ui.sort] ? S.ui.sort : 'value';
  const rows = [...open].sort(SORTERS[sort]).map((p) => positionRow(p, today)).join('');
  const closedRows = S.ui.showClosed ? [...closed].sort(SORTERS.name).map((p) => positionRow(p, today)).join('') : '';
  const stale = staleManual(open, today);
  const sortChip = (k, l) => `<button class="chip" type="button" data-act="sort" data-sort="${k}" aria-pressed="${sort === k}">${l}</button>`;
  const recent = [...txns].reverse().slice(0, 4).map((t) => txRow(t)).join('');

  return `<div class="page home">
    ${demoBanner()}
    <section class="home-top" aria-label="Valore del portafoglio">
      <div class="hero">
        <p class="eyebrow hero-scope">${esc(scopeTitle())}</p>
        <div class="hero-label" id="hero-label">${def.label}</div>
        <div class="hero-value num" id="hero-value">${def.value}</div>
        <div class="hero-delta" id="hero-delta" aria-live="polite">${def.delta}</div>
        <div class="hero-day" id="hero-day">${def.day}</div>
      </div>
      ${priceStatusLine(open)}
      <div class="home-chart">${chart || '<div class="chart-empty-note">Il grafico appare dopo la prima operazione.</div>'}</div>
      <div class="home-controls">
        <div class="chips range-chips" role="group" aria-label="Periodo del grafico">${RANGES.map(([k, l]) => `<button class="chip" type="button" data-act="range" data-range="${k}" aria-pressed="${range === k}">${l}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Tipo di grafico">
          <button type="button" data-act="chart-mode" data-mode="value" aria-pressed="${valueMode}">Valore</button>
          <button type="button" data-act="chart-mode" data-mode="perf" aria-pressed="${!valueMode}">Rendimento</button>
        </div>
      </div>
      <p class="hint home-chart-note">${valueMode
    ? 'La linea tratteggiata è quanto hai investito: la distanza tra le due linee è il tuo guadagno non ancora incassato.'
    : 'Rendimento ponderato nel tempo: misura come sono andati i tuoi titoli, senza contare quando hai aggiunto o tolto soldi.'}</p>
    </section>

    <div class="kpi-grid home-kpis">${kpis}</div>

    ${accountCards(range)}

    <div class="home-grid">
      <section class="section" aria-label="Posizioni">
        <div class="sec-head"><h2>Posizioni <span class="muted">${open.length}</span></h2>
          <button class="link-btn" type="button" data-act="prices">${icon('edit')}Prezzi manuali</button></div>
        ${stale.length ? `<div class="banner warn stale-hint">${icon('alert')}<p>${stale.length === 1 ? '1 titolo ha' : `${stale.length} titoli hanno`} il prezzo manuale fermo da più di 7 giorni.</p><button class="btn sm" type="button" data-act="prices">Aggiorna</button></div>` : ''}
        <div class="chips sort-chips" role="group" aria-label="Ordina le posizioni">
          ${sortChip('value', 'Valore')}${sortChip('day', 'Oggi')}${sortChip('perf', 'Rendimento')}${sortChip('name', 'A–Z')}
        </div>
        <div class="list pos-list">${rows || '<div class="row muted">Nessuna posizione aperta in questo momento.</div>'}${closedRows}</div>
        ${closed.length ? `<button class="link-btn" type="button" data-act="toggle-closed" aria-expanded="${Boolean(S.ui.showClosed)}">${S.ui.showClosed ? 'Nascondi' : 'Mostra'} le posizioni chiuse (${closed.length})</button>` : ''}
      </section>
      <section class="section" aria-label="Attività recenti">
        <div class="sec-head"><h2>Attività recenti</h2><button class="link-btn" type="button" data-act="go-tx">Vedi tutte${icon('chevRight')}</button></div>
        <div class="list">${recent}</div>
        <button class="btn block" type="button" data-act="add-tx">${icon('plus')}Registra un'operazione</button>
      </section>
    </div>
  </div>`;
}

/* ======================================================================
   Transactions list (tab 'tx')
   ====================================================================== */
const TX_FILTERS = [
  ['all', 'Tutte', null],
  ['buy', 'Acquisti', ['buy']],
  ['sell', 'Vendite', ['sell']],
  ['div', 'Dividendi', ['div']],
  ['cash', 'Liquidità', ['deposit', 'withdraw', 'interest']],
  ['costs', 'Costi e imposte', ['fee', 'tax']],
];
const TX_PAGE = 200;
let txLimit = TX_PAGE;
let txLimitKey = '';

export function renderTransactions() {
  const ids = scopeIds();
  const all = txnsFor(ids);
  const f = TX_FILTERS.find((x) => x[0] === S.ui.txFilter) || TX_FILTERS[0];
  const list = [...all].reverse().filter((t) => !f[2] || f[2].includes(t.type));
  const k = `${scopeKey()}|${f[0]}`;
  if (k !== txLimitKey) {
    txLimitKey = k;
    txLimit = TX_PAGE;
  }
  const shown = list.slice(0, txLimit);
  const groups = new Map();
  for (const t of shown) {
    const m = t.date.slice(0, 7);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(t);
  }
  const body = [...groups.entries()].map(([ym, items]) => {
    const [y, m] = ym.split('-');
    return `<div class="tx-group"><div class="group-label">${MONTHS_LONG[Number(m) - 1]} ${y} <span>${items.length}</span></div>
      <div class="list">${items.map((t) => txRow(t, { showYear: false })).join('')}</div></div>`;
  }).join('');
  const chip = ([key, label]) => `<button class="chip" type="button" data-act="tx-filter" data-f="${key}" aria-pressed="${f[0] === key}">${label}</button>`;
  const empty = !all.length
    ? `<div class="empty"><div class="empty-ill">${icon('receipt')}</div><h2>Nessuna operazione</h2><p>Registra un acquisto o importa il file delle transazioni del tuo broker.</p>
        <div class="btns"><button class="btn primary" type="button" data-act="add-tx">${icon('plus')}Registra un'operazione</button>
        <button class="btn" type="button" data-act="tab" data-tab="more">${icon('upload')}Importa</button>
        ${D().txns.length ? '' : '<button class="btn ghost" type="button" data-act="demo-load">Guarda un esempio</button>'}</div></div>`
    : `<div class="empty"><p>Nessuna operazione in questo filtro.</p><button class="btn" type="button" data-act="tx-filter" data-f="all">Mostra tutte</button></div>`;
  return `<div class="page tx-page">
    <button class="link-btn back-link" type="button" data-act="tab" data-tab="home">${icon('chevLeft')}Portafoglio</button>
    <div class="page-head">
      <div><p class="eyebrow">${esc(scopeTitle())}</p><h1 class="page-title">Transazioni</h1></div>
      <button class="btn sm primary" type="button" data-act="add-tx">${icon('plus')}Nuova</button>
    </div>
    ${demoBanner()}
    <div class="chips tx-filters" role="group" aria-label="Filtra le operazioni">${TX_FILTERS.map(chip).join('')}</div>
    <p class="hint tx-count">${list.length} ${list.length === 1 ? 'operazione' : 'operazioni'}${f[0] === 'all' ? '' : ` su ${all.length}`}</p>
    ${body || empty}
    ${list.length > shown.length ? `<button class="btn block" type="button" data-act="pf-tx-more">Mostra altre ${Math.min(TX_PAGE, list.length - shown.length)} operazioni</button>` : ''}
  </div>`;
}

/* ======================================================================
   Actions and mounts
   ====================================================================== */
const scrollTop = () => {
  if (typeof window !== 'undefined') window.scrollTo(0, 0);
};

Object.assign(ACTIONS, {
  range: (el) => {
    const r = el.dataset.range;
    if (!RANGE_TEXT[r]) return;
    S.ui.range = r;
    app.render();
  },
  'chart-mode': (el) => {
    S.ui.chartMode = el.dataset.mode === 'perf' ? 'perf' : 'value';
    app.render();
  },
  sort: (el) => {
    S.ui.sort = SORTERS[el.dataset.sort] ? el.dataset.sort : 'value';
    app.render();
  },
  'toggle-closed': () => {
    S.ui.showClosed = !S.ui.showClosed;
    app.render();
  },
  'go-tx': () => {
    S.ui.tab = 'tx';
    app.render();
    scrollTop();
  },
  'tx-filter': (el) => {
    const f = el.dataset.f;
    S.ui.txFilter = TX_FILTERS.some((x) => x[0] === f) ? f : 'all';
    app.render();
  },
  'pf-tx-more': () => {
    txLimit += TX_PAGE;
    app.render();
  },
});

// Scrubbing the hero chart shows the value, gain and return of the touched day
MOUNTS.push(() => {
  if (typeof document === 'undefined' || S.ui.tab !== 'home' || !hero) return;
  if (!document.querySelector('[data-chart-id="home-chart"]')) return;
  const { R, def, valueMode } = hero;
  const $ = (id) => document.getElementById(id);
  chartScrubHandlers('home-chart', {
    onScrub(i) {
      if (!R.dates[i]) return;
      const label = $('hero-label');
      const value = $('hero-value');
      const delta = $('hero-delta');
      const day = $('hero-day');
      if (label) label.textContent = fmtDate(R.dates[i]);
      if (value) value.textContent = money(R.value[i]);
      if (delta) delta.innerHTML = deltaChip(R.gain[i], R.perf[i], valueMode ? `<span class="muted">investito ${money(R.invested[i])}</span>` : '');
      if (day) day.innerHTML = '';
    },
    onEnd() {
      const label = $('hero-label');
      const value = $('hero-value');
      const delta = $('hero-delta');
      const day = $('hero-day');
      if (label) label.textContent = def.label;
      if (value) value.textContent = def.value;
      if (delta) delta.innerHTML = def.delta;
      if (day) day.innerHTML = def.day;
    },
  });
});

export const _test = { rangePoints, rangeStart, txAmount, txLabel, todayChange, fmtTime };
