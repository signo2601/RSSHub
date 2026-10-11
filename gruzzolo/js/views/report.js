// Tab "Report": header, controls (period, benchmark, risk-free rate, base 100, log scale, theme),
// sheet navigator and the registry of the six report sheets. Each sheet module registers itself with
// registerSheet() and receives the shared report context (ARCHITECTURE.md "Report ctx").
// Also the shared building blocks of every sheet: KPI, chart and table cards, badges, account colors.
import { S, D, scopeIds, scopeKey, account, commit, cached, hasDemo } from '../state.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { getSeries, historyFor, txnsFor, positions } from '../engine.js';
import { resolvePeriod, benchReturns } from '../metrics.js';
import { BENCHMARKS, searchCatalog, findInCatalog } from '../catalog.js';
import { INFO, infoBtn } from '../info.js';
import {
  esc, icon, pct, parseNum, fmtDate, fmtTime, todayISO, contentWidth, isDesktop, debounce,
} from '../util.js';
import { avatar, demoBanner } from './home.js';

/* ======================================================================
   Sheet registry
   ====================================================================== */
const SHEET_DEFS = [];

// Register a report sheet: { id, order, title, subtitle, render(ctx) → html }. Re-registering an id replaces it.
export function registerSheet(def) {
  if (!def || !def.id || typeof def.render !== 'function') return;
  const i = SHEET_DEFS.findIndex((d) => d.id === def.id);
  if (i >= 0) SHEET_DEFS.splice(i, 1);
  SHEET_DEFS.push(def);
  SHEET_DEFS.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}
export const sheetDefs = () => SHEET_DEFS.slice();

/* ======================================================================
   Shared building blocks for the sheets
   ====================================================================== */
// 'up' | 'down' | 'flat' by sign (null when the value is unknown: no badge)
export function badgeFor(value, eps = 0.00005) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value > eps ? 'up' : value < -eps ? 'down' : 'flat';
}

// Color of account i (index in D().accounts)
export const accColor = (i) => `var(--c${(((i % 8) + 8) % 8) + 1})`;

const BADGE = {
  up: { text: 'Up', aria: 'in crescita', path: '<path d="M12 19V5M6 11l6-6 6 6"/>' },
  down: { text: 'Down', aria: 'in calo', path: '<path d="M12 5v14M6 13l6 6 6-6"/>' },
  flat: { text: 'Flat', aria: 'stabile', path: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
};
export function badgeHtml(kind) {
  const b = BADGE[kind];
  if (!b) return '';
  return `<span class="badge ${kind}" title="${b.aria}"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${b.path}</svg>${b.text}<span class="sr-only"> (${b.aria})</span></span>`;
}

// KPI card. value and sub are HTML (escape user strings before passing them); label is plain text.
// Extra (optional): bar = 0..1 → thin progress bar (the drawdown depth on the danger card).
export function kpiCard({ label, value, valueClass = '', badge = null, sub = '', info = '', cls = '', bar = null } = {}) {
  const barHtml = Number.isFinite(bar)
    ? `<div class="kpi-bar" aria-hidden="true"><i style="width:${(Math.max(0, Math.min(1, bar)) * 100).toFixed(1)}%"></i></div>`
    : '';
  return `<div class="kpi rkpi ${esc(cls)}">
    <div class="kpi-top"><span class="kpi-label">${esc(label)}</span>${badge ? badgeHtml(badge) : ''}</div>
    <div class="kpi-value ${esc(valueClass)}">${value ?? '—'}</div>
    ${barHtml}
    <div class="kpi-foot"><div class="kpi-sub">${sub || ''}</div>${info ? infoBtn(info) : ''}</div>
  </div>`;
}

// "Curva equity (portafoglio, conti e benchmark)" → uppercase title + muted parenthetical
function titleHtml(title) {
  const t = String(title ?? '');
  const m = t.match(/^(.*?)\s*(\(.*\))\s*$/);
  if (!m || !m[1]) return esc(t);
  return `${esc(m[1])} <span class="ct-paren">${esc(m[2])}</span>`;
}

// Chart card: title, one-line subtitle, (i) button, chart body (HTML). cls 'full' spans the grid.
export function chartCard({ title, subtitle = '', info = '', body = '', cls = '' } = {}) {
  return `<section class="chart-card rcard ${esc(cls)}">
    <header class="rcard-head">
      <div class="rcard-titles"><h3 class="rcard-title">${titleHtml(title)}</h3>${subtitle ? `<p class="rcard-sub">${subtitle}</p>` : ''}</div>
      ${info ? infoBtn(info) : ''}
    </header>
    <div class="rcard-body">${body}</div>
  </section>`;
}

// Table card. Cells are HTML. Extra (optional): foot = [cellHtml, ...] → bold total row; note = HTML under the table.
export function tableCard({ title, info = '', columns = [], rows = [], empty = 'Nessun dato nel periodo', cls = '', foot = null, note = '' } = {}) {
  const alignCls = (c) => (c && c.align === 'right' ? ' class="num"' : '');
  const head = columns.map((c) => `<th scope="col"${alignCls(c)}>${esc(c.label)}</th>`).join('');
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((cell, i) => `<td${alignCls(columns[i])}>${cell ?? ''}</td>`).join('')}</tr>`).join('')
    : `<tr><td class="table-empty" colspan="${Math.max(1, columns.length)}">${esc(empty)}</td></tr>`;
  const footer = foot && rows.length ? `<tfoot><tr>${foot.map((cell, i) => `<td${alignCls(columns[i])}>${cell ?? ''}</td>`).join('')}</tr></tfoot>` : '';
  return `<section class="card rcard table-card ${esc(cls)}">
    <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">${titleHtml(title)}</h3></div>${info ? infoBtn(info) : ''}</header>
    <div class="table-wrap"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${footer}</table></div>
    ${note ? `<p class="rcard-note">${note}</p>` : ''}
  </section>`;
}

// Placeholder card for "nothing to show here" (plain text)
export const emptyCard = (text) => `<div class="card rcard empty-card"><p>${esc(text)}</p></div>`;

/* ======================================================================
   Period
   ====================================================================== */
export const PERIODS = [['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1A'], ['YTD', 'YTD'], ['ALL', 'Dall\'inizio']];
const PERIOD_NAME = {
  '1M': 'Ultimo mese', '3M': 'Ultimi 3 mesi', '6M': 'Ultimi 6 mesi', '1Y': 'Ultimo anno',
  YTD: 'Da inizio anno', ALL: 'Dall\'inizio', CUSTOM: 'Personalizzato',
};
const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const validPeriod = (p) => (PERIOD_NAME[p] ? p : 'ALL');

// Effective [from, to] of the report: presets end today; from is clamped to the series start
export function reportPeriod(series, today, ui = S.ui) {
  const period = validPeriod(ui.period);
  const start = series ? series.start : today;
  let { from, to } = resolvePeriod(period, {
    today, start,
    from: isIsoDate(ui.from) ? ui.from : null,
    to: isIsoDate(ui.to) ? ui.to : null,
  });
  if (to < start) to = start;
  if (from > to) from = to;
  return { period, from, to };
}
export const periodLabel = (period, from, to) => `${PERIOD_NAME[validPeriod(period)]} · ${fmtDate(from)} → ${fmtDate(to)}`;

/* ======================================================================
   Benchmark
   ====================================================================== */
const benchState = new Map(); // symbol → 'loading' | 'failed'

function benchInfo(series, scope) {
  const b = (D().settings && D().settings.benchmark) || {};
  const symbol = String(b.symbol || '').trim();
  const name = String(b.name || symbol || 'Benchmark');
  const out = { symbol, name, history: null, ret: null, status: 'none' };
  if (!symbol) return out;
  // The example portfolio is compared with the synthetic benchmark (same invented market)
  const demo = hasDemo();
  const history = (demo && market.getHistory('demo:' + symbol)) || historyFor(symbol);
  if (!history || !Array.isArray(history.dates) || !history.dates.length) {
    if (market.status === 'online' && !benchState.has(symbol)) {
      benchState.set(symbol, 'loading');
      market.ensureHistory(symbol)
        .then((h) => {
          if (h) benchState.delete(symbol);
          else benchState.set(symbol, 'failed');
        })
        .catch(() => benchState.set(symbol, 'failed'))
        .finally(() => app.render());
    }
    const st = benchState.get(symbol);
    out.status = st === 'failed' ? 'failed' : market.status === 'offline' ? 'offline' : 'loading';
    return out;
  }
  out.history = history;
  out.status = 'ok';
  if (series) {
    const ccy = history.currency || 'EUR';
    const fxSym = market.fxSymbol(ccy);
    const fx = ccy !== 'EUR' ? (demo && market.getHistory('demo:' + fxSym)) || historyFor(fxSym) : null;
    out.ret = cached(`rep-bench:${symbol}:${demo ? 'demo' : 'real'}:${scope}:${series.start}:${series.end}`, () => benchReturns(history, fx, series.dates));
  }
  return out;
}

// Short label of the benchmark for legends ("VWCE")
export function benchShort(bench) {
  if (!bench || !bench.symbol) return 'Benchmark';
  return bench.symbol.replace(/\.[A-Z]{1,4}$/, '').replace(/^\^/, '');
}

/* ======================================================================
   Report context
   ====================================================================== */
let lastCtx = null; // for the action handlers (period bounds, dates of the custom form)

export function buildCtx(today = todayISO()) {
  const accIds = scopeIds();
  const key = scopeKey();
  const series = getSeries(key);
  if (!series) return null;
  const { period, from, to } = reportPeriod(series, today);
  const accSeries = {};
  if (key === 'all') {
    for (const a of D().accounts) {
      const s = getSeries(a.id);
      if (s) accSeries[a.id] = s;
    }
  }
  const cw = contentWidth();
  const desktop = isDesktop();
  const w = Math.max(200, Math.floor(cw - 32));
  const wHalf = desktop ? Math.max(200, Math.floor((cw - 16) / 2 - 32)) : w;
  const settings = D().settings;
  const rf = Number.isFinite(settings.riskFree) ? settings.riskFree : 0.02;
  return {
    accIds, scopeKey: key, from, to, today, rf, settings, period,
    bench: benchInfo(series, key),
    base100: Boolean(S.ui.base100), logScale: Boolean(S.ui.logScale),
    series, accSeries, w, wHalf, desktop,
  };
}

/* ======================================================================
   Rendering
   ====================================================================== */
function effectiveTheme() {
  const t = D().settings.theme;
  if (t === 'light' || t === 'dark') return t;
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function statusChip() {
  if (hasDemo()) return '<span class="r-chip muted"><span class="dot demo"></span>Dati di esempio</span>';
  if (market.status === 'offline') {
    return `<span class="r-chip muted"><span class="dot offline"></span>Dati offline${market.lastRefresh ? ` · prezzi delle ${fmtTime(market.lastRefresh)}` : ''}</span>`;
  }
  if (market.lastRefresh) return `<span class="r-chip ok"><span class="dot online"></span>Prezzi aggiornati alle ${fmtTime(market.lastRefresh)}</span>`;
  return '<span class="r-chip muted"><span class="dot busy"></span>Carico i prezzi…</span>';
}

// One line when market data is missing for held securities
function priceStatusLine(ctx) {
  if (market.status === 'offline') {
    return `<p class="report-status">${icon('cloud')}<span>Server prezzi non raggiungibile: uso gli ultimi prezzi salvati.</span></p>`;
  }
  const open = positions({ accIds: ctx.accIds, date: ctx.to }).filter((p) => p.qty > 0 && p.asset.priceSource === 'auto' && p.asset.symbol);
  const missing = open.filter((p) => !market.getHistory(p.asset.symbol)).length;
  if (!missing) return '';
  return `<p class="report-status" aria-live="polite"><span class="dot busy"></span><span>Carico i prezzi di ${missing} ${missing === 1 ? 'titolo' : 'titoli'}…</span></p>`;
}

function headHtml(ctx) {
  const scope = ctx && ctx.accIds ? (account(ctx.accIds[0]) || {}).name : (D().accounts.length > 1 ? 'Tutti i conti' : '');
  return `<header class="report-head">
    <div class="report-titles">
      <p class="eyebrow">Analisi del patrimonio${scope ? ` · ${esc(scope)}` : ''}</p>
      <h1 class="page-title">Analisi della performance</h1>
    </div>
    <div class="report-chips">
      ${ctx ? `<span class="r-chip">${icon('calendar')}<span>${esc(periodLabel(ctx.period, ctx.from, ctx.to))}</span></span>` : ''}
      ${statusChip()}
    </div>
  </header>`;
}

const periodChip = (key, label, cur, extra = '') => `<button class="chip" type="button" data-act="period" data-period="${key}" aria-pressed="${cur === key}"${extra}>${esc(label)}</button>`;

function periodChips(ctx) {
  return PERIODS.map(([k, l]) => periodChip(k, l, ctx.period)).join('')
    + periodChip('CUSTOM', 'Personalizzato', ctx.period, ' title="Scegli le date"');
}

function datesForm(ctx, { compact = false } = {}) {
  const min = ctx.series.start;
  const max = ctx.series.end;
  // The fields always show the period on screen: a good starting point for a custom one
  const { from, to } = ctx;
  if (compact) {
    return `<form class="rc-dates" data-form="report-dates" aria-label="Periodo personalizzato">
      <label class="rc-field"><span>Da</span><input type="date" name="from" value="${esc(from)}" min="${esc(min)}" max="${esc(max)}" required></label>
      <label class="rc-field"><span>A</span><input type="date" name="to" value="${esc(to)}" min="${esc(min)}" max="${esc(max)}" required></label>
      <button class="btn sm" type="submit">Applica</button>
    </form>`;
  }
  return `<form class="form f-dates" data-form="report-dates" aria-label="Periodo personalizzato">
    <div class="grid2">
      <div class="field"><label for="rf-from">Da</label><input id="rf-from" type="date" name="from" value="${esc(from)}" min="${esc(min)}" max="${esc(max)}" required></div>
      <div class="field"><label for="rf-to">A</label><input id="rf-to" type="date" name="to" value="${esc(to)}" min="${esc(min)}" max="${esc(max)}" required></div>
    </div>
    <button class="btn block" type="submit">Applica le date</button>
  </form>`;
}

// Risk-free select (0%–5% step 0,25%) plus a custom value form
const RF_STEPS = Array.from({ length: 21 }, (_, k) => +(k * 0.0025).toFixed(4));
function rfControl(rf, { id = 'rc-rf', compact = false } = {}) {
  const onGrid = RF_STEPS.some((v) => Math.abs(v - rf) < 1e-9);
  const opts = RF_STEPS.map((v) => `<option value="${v}"${onGrid && Math.abs(v - rf) < 1e-9 ? ' selected' : ''}>${pct(v)}</option>`).join('')
    + `<option value="custom"${onGrid ? '' : ' selected'}>${onGrid ? 'Altro valore…' : `Altro: ${pct(rf)}`}</option>`;
  const custom = `<form class="rc-rf-custom" data-form="report-rf"${onGrid ? ' hidden' : ''} aria-label="Tasso privo di rischio personalizzato">
      <input type="text" name="rf" inputmode="decimal" autocomplete="off" value="${onGrid ? '' : esc((rf * 100).toLocaleString('it-IT', { maximumFractionDigits: 3 }))}" placeholder="es. 2,5" aria-label="Tasso in percentuale">
      <span class="rc-unit">%</span><button class="btn sm" type="submit">OK</button>
    </form>`;
  if (compact) {
    return `<div class="rc-rf"><label class="rc-label" for="${id}">Tasso privo di rischio</label>${infoBtn('riskFree')}
      <select id="${id}" class="rc-select" data-input="report-rf">${opts}</select>${custom}</div>`;
  }
  return `<div class="field"><div class="label-row"><label for="${id}">Tasso privo di rischio</label>${infoBtn('riskFree')}</div>
    <select id="${id}" data-input="report-rf">${opts}</select>${custom}
    <p class="hint">Il rendimento di un investimento senza rischio (conto deposito, BOT): serve per Sharpe e Sortino.</p></div>`;
}

function benchButton(ctx, { compact = false } = {}) {
  const b = ctx.bench;
  const busy = b.status === 'loading' ? '<span class="dot busy" title="Carico il benchmark…"></span>' : '';
  if (compact) {
    return `<div class="rc-bench-wrap"><button class="rc-bench" type="button" data-act="bench-pick" aria-haspopup="dialog" title="${esc(b.name)}">
      <span class="rc-label">Benchmark</span><b>${esc(benchShort(b))}</b>${busy}${icon('chevDown')}</button>${infoBtn('benchmark')}</div>`;
  }
  const sub = b.status === 'loading' ? 'Carico il benchmark…'
    : b.status === 'offline' ? 'Dati non disponibili offline'
      : b.status === 'failed' ? 'Dati non disponibili: riprova più tardi'
        : (b.symbol || 'Nessuno');
  return `<div class="list f-bench"><button class="row" type="button" data-act="bench-pick" aria-haspopup="dialog">
    ${avatar({ name: b.name, ticker: benchShort(b), symbol: b.symbol, type: 'etf' }, 'sm')}
    <span class="row-main"><span class="row-title">${esc(b.name)}</span><span class="row-sub">${esc(sub)}</span></span>
    <span class="row-end"><span class="link-btn">Cambia${icon('chevRight')}</span></span>
  </button></div>`;
}

const switchBtn = (act, on, label) => `<button class="switch" type="button" role="switch" aria-checked="${on}" data-act="${act}">${esc(label)}</button>`;

function controlsDesktop(ctx) {
  const dark = effectiveTheme() === 'dark';
  return `<section class="report-controls" aria-label="Impostazioni del report">
    <div class="rc-row">
      <div class="rc-group"><span class="rc-label">Periodo</span>
        <div class="chips period-chips" role="group" aria-label="Periodo">${periodChips(ctx)}</div></div>
      ${datesForm(ctx, { compact: true })}
    </div>
    <div class="rc-row rc-row2">
      ${benchButton(ctx, { compact: true })}
      ${rfControl(ctx.rf, { compact: true })}
      <div class="rc-switches">
        <span class="rc-switch">${switchBtn('toggle-base100', ctx.base100, 'Base 100')}${infoBtn('base100')}</span>
        <span class="rc-switch">${switchBtn('toggle-log', ctx.logScale, 'Scala log')}${infoBtn('scalaLog')}</span>
        <button class="icon-btn rc-theme" type="button" data-act="set-theme" data-theme="${dark ? 'light' : 'dark'}" aria-label="${dark ? 'Passa al tema chiaro' : 'Passa al tema scuro'}" title="${dark ? 'Tema chiaro' : 'Tema scuro'}">${icon(dark ? 'sun' : 'moon')}</button>
      </div>
    </div>
  </section>`;
}

function controlsPhone(ctx) {
  const n = (ctx.base100 ? 1 : 0) + (ctx.logScale ? 1 : 0);
  return `<div class="report-controls-phone">
    <div class="report-bar">
      <div class="chips period-chips" role="group" aria-label="Periodo">${periodChips(ctx)}</div>
      <button class="btn sm rb-filters" type="button" data-act="report-filters" aria-haspopup="dialog">${icon('sliders')}<span>Filtri</span>${n ? `<span class="rb-count" aria-label="${n} attivi">${n}</span>` : ''}</button>
    </div>
    <p class="rb-summary">Confronto con <b>${esc(benchShort(ctx.bench))}</b>${ctx.bench.status === 'loading' ? ' <span class="muted">(carico…)</span>' : ''} · tasso senza rischio ${pct(ctx.rf)}${ctx.base100 ? ' · base 100' : ''}${ctx.logScale ? ' · scala log' : ''}</p>
  </div>`;
}

function navHtml(defs, cur, desktop) {
  const def = defs[cur];
  const prev = `<button class="btn sm rn-prev" type="button" data-act="report-prev"${cur <= 0 ? ' disabled' : ''}>${icon('chevLeft')}<span>Foglio precedente</span></button>`;
  const next = `<button class="btn sm rn-next" type="button" data-act="report-next"${cur >= defs.length - 1 ? ' disabled' : ''}><span>Foglio successivo</span>${icon('chevRight')}</button>`;
  if (desktop) {
    const dots = defs.map((d, i) => `<button class="rn-dot" type="button" data-act="report-sheet" data-i="${i}" aria-label="${esc(d.title)}" title="${esc(d.title)}"${i === cur ? ' aria-current="true"' : ''}><i></i></button>`).join('');
    return `<nav class="report-nav" aria-label="Fogli del report">
      <div class="rn-label"><span class="rn-kicker">Report</span><span aria-hidden="true">·</span><b>${esc(def.title)}</b><span class="rn-count">${cur + 1} di ${defs.length}</span></div>
      <div class="rn-ctrl">${prev}<div class="rn-dots">${dots}</div>${next}</div>
    </nav>`;
  }
  const tabs = defs.map((d, i) => `<button class="chip" type="button" data-act="report-sheet" data-i="${i}" aria-pressed="${i === cur}"${i === cur ? ' aria-current="true"' : ''}>${esc(d.title)}</button>`).join('');
  return `<nav class="report-nav phone" aria-label="Fogli del report">
    <div class="rn-tabs chips">${tabs}</div>
    <div class="rn-arrows">
      <button class="icon-btn" type="button" data-act="report-prev" aria-label="Foglio precedente"${cur <= 0 ? ' disabled' : ''}>${icon('chevLeft')}</button>
      <button class="icon-btn" type="button" data-act="report-next" aria-label="Foglio successivo"${cur >= defs.length - 1 ? ' disabled' : ''}>${icon('chevRight')}</button>
    </div>
  </nav>`;
}

// Big "next sheet" link at the end of a sheet
function footNav(defs, cur) {
  const prev = defs[cur - 1];
  const next = defs[cur + 1];
  if (!prev && !next) return '';
  return `<div class="report-foot">
    ${prev ? `<button class="rf-link prev${next ? '' : ' solo'}" type="button" data-act="report-prev"><span class="rf-dir">${icon('chevLeft')}Foglio precedente</span><b>${esc(prev.title)}</b></button>` : ''}
    ${next ? `<button class="rf-link next${prev ? '' : ' solo'}" type="button" data-act="report-next"><span class="rf-dir">Foglio successivo${icon('chevRight')}</span><b>${esc(next.title)}</b></button>` : ''}
  </div>`;
}

function sheetError(err) {
  const msg = (err && (err.message || String(err))) || 'errore sconosciuto';
  return `<div class="error-card" role="alert">
    <strong>Non riesco a mostrare questo foglio</strong>
    <p>Si è verificato un errore nei calcoli. Gli altri fogli funzionano: prova a cambiare periodo o foglio.</p>
    <code>${esc(msg)}</code>
  </div>`;
}

function emptyReport() {
  const scoped = Boolean(scopeIds());
  return `<div class="page report-page">${demoBanner()}${headHtml(null)}
    <div class="empty">
      <div class="empty-ill">${icon('report')}</div>
      <h2>${scoped ? 'Nessuna operazione in questo conto' : 'Il report si riempie da solo'}</h2>
      <p>Registra o importa le tue operazioni: rendimenti, rischio, dividendi, costi e tasse vengono calcolati automaticamente.</p>
      <div class="btns">
        <button class="btn primary" type="button" data-act="add-tx">${icon('plus')}Registra un'operazione</button>
        <button class="btn" type="button" data-act="tab" data-tab="more">${icon('upload')}Importa da DEGIRO o Scalable</button>
        ${D().txns.length ? '' : '<button class="btn ghost" type="button" data-act="demo-load">Guarda un esempio</button>'}
      </div>
    </div>
  </div>`;
}

export function renderReport() {
  const today = todayISO();
  if (!txnsFor(scopeIds()).length) {
    lastCtx = null;
    return emptyReport();
  }
  const ctx = buildCtx(today);
  if (!ctx) {
    lastCtx = null;
    return emptyReport();
  }
  lastCtx = ctx;
  const defs = SHEET_DEFS;
  if (!defs.length) {
    return `<div class="page report-page">${demoBanner()}${headHtml(ctx)}<div class="empty"><p>I fogli del report non sono disponibili in questa versione.</p></div></div>`;
  }
  const cur = Math.max(0, Math.min(Number(S.ui.sheet) || 0, defs.length - 1));
  if (S.ui.sheet !== cur) S.ui.sheet = cur;
  const def = defs[cur];
  let body;
  try {
    body = def.render(ctx);
    if (typeof body !== 'string') body = '';
  } catch (e) {
    console.error(`[gruzzolo] foglio ${def.id}`, e);
    body = sheetError(e);
  }
  return `<div class="page report-page${ctx.desktop ? ' is-desktop' : ''}">
    ${demoBanner()}
    ${headHtml(ctx)}
    ${priceStatusLine(ctx)}
    ${ctx.desktop ? controlsDesktop(ctx) : controlsPhone(ctx)}
    ${navHtml(defs, cur, ctx.desktop)}
    <section class="report-sheet" aria-labelledby="rs-title" data-sheet="${esc(def.id)}">
      <div class="rs-head">
        <p class="eyebrow">Foglio ${cur + 1} di ${defs.length}</p>
        <h2 class="rs-title" id="rs-title">${esc(def.title)}</h2>
        ${def.subtitle ? `<p class="rs-sub">${esc(def.subtitle)}</p>` : ''}
      </div>
      ${body}
    </section>
    ${footNav(defs, cur)}
  </div>`;
}

/* ======================================================================
   Sheets: info, filters, benchmark
   ====================================================================== */
const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('');

SHEETS.info = (args = {}) => {
  const it = INFO[args.key] || { title: 'Informazioni', text: 'Spiegazione non disponibile per questa voce.' };
  return {
    title: it.title,
    body: `<div class="info-body">${paragraphs(it.text)}
      ${it.formula ? `<div class="info-formula"><span>Come si calcola</span><p>${esc(it.formula)}</p></div>` : ''}
      <div class="sheet-actions"><button class="btn" type="button" data-act="back-sheet">Ho capito</button></div>
    </div>`,
  };
};

SHEETS['report-filters'] = () => {
  const ctx = lastCtx || buildCtx();
  if (!ctx) return { title: 'Filtri del report', body: '<p class="hint">Registra prima qualche operazione.</p>' };
  const theme = ['auto', 'light', 'dark'].includes(D().settings.theme) ? D().settings.theme : 'auto';
  const themeBtn = (k, label) => `<button type="button" data-act="set-theme" data-theme="${k}" aria-pressed="${theme === k}">${label}</button>`;
  return {
    title: 'Filtri del report',
    body: `<div class="filters">
      <section class="f-sec">
        <h3 class="f-title">Periodo</h3>
        <p class="hint">${esc(periodLabel(ctx.period, ctx.from, ctx.to))}</p>
        <div class="chips f-chips" role="group" aria-label="Periodo">${periodChips(ctx)}</div>
        ${datesForm(ctx)}
      </section>
      <section class="f-sec">
        <div class="f-title-row"><h3 class="f-title">Confronto</h3>${infoBtn('benchmark')}</div>
        ${benchButton(ctx)}
        ${rfControl(ctx.rf, { id: 'f-rf' })}
      </section>
      <section class="f-sec">
        <h3 class="f-title">Grafici</h3>
        <div class="f-switch">${switchBtn('toggle-base100', ctx.base100, 'Base 100')}${infoBtn('base100')}</div>
        <p class="hint">Le curve partono tutte da 100 invece che da 0%.</p>
        <div class="f-switch">${switchBtn('toggle-log', ctx.logScale, 'Scala logaritmica')}${infoBtn('scalaLog')}</div>
        <p class="hint">Variazioni percentuali uguali occupano lo stesso spazio: utile su periodi lunghi.</p>
      </section>
      <section class="f-sec">
        <h3 class="f-title">Aspetto</h3>
        <div class="seg full" role="group" aria-label="Tema">${themeBtn('auto', 'Automatico')}${themeBtn('light', 'Chiaro')}${themeBtn('dark', 'Scuro')}</div>
      </section>
      <button class="btn primary block" type="button" data-act="close-sheet">Mostra il report</button>
    </div>`,
  };
};

// Benchmark picker: suggested list, offline catalog search, then Yahoo results
const benchSearch = { q: '', gen: 0, live: [], pending: false };

function benchCandidates(q) {
  const items = [];
  const seen = new Set();
  const add = (it) => {
    if (!it || !it.symbol || seen.has(it.symbol)) return;
    seen.add(it.symbol);
    items.push(it);
  };
  const query = q.trim();
  if (!query) {
    for (const b of BENCHMARKS) add({ symbol: b.symbol, name: b.name, sub: b.desc, type: 'etf' });
    const cur = D().settings.benchmark;
    if (cur && cur.symbol && !seen.has(cur.symbol)) items.unshift({ symbol: cur.symbol, name: cur.name || cur.symbol, sub: 'Scelto da te', type: 'etf' });
    return items;
  }
  const lq = query.toLowerCase();
  for (const b of BENCHMARKS) {
    if ([b.symbol, b.name, b.desc].some((s) => String(s).toLowerCase().includes(lq))) add({ symbol: b.symbol, name: b.name, sub: b.desc, type: 'etf' });
  }
  for (const c of searchCatalog(query, 10)) add({ symbol: c.symbol, name: c.name, sub: [c.symbol, c.exchange, c.currency].filter(Boolean).join(' · '), type: c.type });
  for (const r of benchSearch.live.slice(0, 12)) {
    const cat = findInCatalog(r.symbol);
    add({ symbol: r.symbol, name: r.name || (cat && cat.name) || r.symbol, sub: [r.symbol, r.exchange, r.typeDisp].filter(Boolean).join(' · '), type: r.type || 'etf' });
  }
  return items;
}

function benchResultsHtml(q) {
  const cur = (D().settings.benchmark || {}).symbol || '';
  const items = benchCandidates(q);
  const query = q.trim();
  let note = '';
  if (!query) note = '<p class="combo-note">Scelte consigliate. Scrivi per cercare altri ETF o indici.</p>';
  else if (benchSearch.pending) note = '<p class="combo-note"><span class="dot busy"></span>Cerco su Yahoo Finance…</p>';
  else if (market.status === 'offline') note = '<p class="combo-note">Ricerca online non disponibile: mostro il catalogo.</p>';
  else if (!items.length) note = '<p class="combo-note">Nessun risultato. Prova con il ticker (es. VWCE) o l\'ISIN.</p>';
  const rows = items.map((it) => `<button class="row" type="button" data-act="report-bench-set" data-symbol="${esc(it.symbol)}" data-name="${esc(it.name)}" aria-pressed="${it.symbol === cur}">
      ${avatar({ name: it.name, ticker: it.symbol.replace(/\.[A-Z]{1,4}$/, '').replace(/^\^/, ''), symbol: it.symbol, type: it.type }, 'sm')}
      <span class="row-main"><span class="row-title">${esc(it.name)}</span><span class="row-sub">${esc(it.sub || it.symbol)}</span></span>
      ${it.symbol === cur ? `<span class="check-ico">${icon('check')}</span>` : ''}
    </button>`).join('');
  return `${note}${rows ? `<div class="list bench-list">${rows}</div>` : ''}`;
}

const benchLive = debounce((q, gen) => {
  market.search(q).then((res) => {
    if (benchSearch.gen !== gen) return;
    benchSearch.live = Array.isArray(res) ? res : [];
    benchSearch.pending = false;
    updateBenchResults();
  }).catch(() => {
    if (benchSearch.gen !== gen) return;
    benchSearch.pending = false;
    updateBenchResults();
  });
}, 300);

function updateBenchResults() {
  const box = typeof document !== 'undefined' ? document.getElementById('bench-results') : null;
  if (box) box.innerHTML = benchResultsHtml(benchSearch.q);
}

SHEETS.bench = (args = {}) => {
  const q = typeof args.q === 'string' ? args.q : '';
  if (q !== benchSearch.q) {
    benchSearch.q = q;
    benchSearch.live = [];
    benchSearch.pending = false;
  }
  return {
    title: 'Benchmark di confronto',
    body: `<p class="hint bench-intro">Il benchmark è l'ETF o l'indice con cui confronti il portafoglio. Un ETF azionario mondiale è la scelta più comune.</p>
      <div class="field bench-field">
        <label for="bench-q">Cerca un ETF o un indice</label>
        <input id="bench-q" type="search" data-input="report-bench-q" value="${esc(q)}" placeholder="Es. VWCE, S&amp;P 500, MSCI World" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      </div>
      <div id="bench-results" aria-live="polite">${benchResultsHtml(q)}</div>`,
  };
};

/* ======================================================================
   Actions, forms, inputs
   ====================================================================== */
const scrollReportTop = () => {
  if (typeof window !== 'undefined') window.scrollTo(0, 0);
};
const topSheet = () => S.sheets[S.sheets.length - 1] || null;

function goSheet(i) {
  const n = SHEET_DEFS.length;
  if (!n) return;
  const next = Math.max(0, Math.min(i, n - 1));
  if (next === S.ui.sheet) return;
  S.ui.sheet = next;
  app.render();
  scrollReportTop();
}

Object.assign(ACTIONS, {
  info: (el) => {
    const key = el.dataset.key;
    if (key) app.pushSheet('info', { key });
  },
  'report-sheet': (el) => goSheet(Number(el.dataset.i) || 0),
  'report-prev': () => goSheet((Number(S.ui.sheet) || 0) - 1),
  'report-next': () => goSheet((Number(S.ui.sheet) || 0) + 1),
  period: (el) => {
    const p = el.dataset.period;
    if (!PERIOD_NAME[p]) return;
    if (p === 'CUSTOM') {
      // Start from the dates on screen, so the date fields are never empty
      if (!isIsoDate(S.ui.from) || !isIsoDate(S.ui.to)) {
        if (lastCtx) {
          S.ui.from = lastCtx.from;
          S.ui.to = lastCtx.to;
        }
      }
      S.ui.period = 'CUSTOM';
      const top = topSheet();
      if (!isDesktop() && !(top && top.name === 'report-filters')) app.pushSheet('report-filters');
      app.render();
      return;
    }
    S.ui.period = p;
    app.render();
  },
  'toggle-base100': () => {
    S.ui.base100 = !S.ui.base100;
    app.render();
  },
  'toggle-log': () => {
    S.ui.logScale = !S.ui.logScale;
    app.render();
  },
  'bench-pick': () => {
    benchSearch.q = '';
    benchSearch.live = [];
    benchSearch.pending = false;
    app.pushSheet('bench', { q: '' });
  },
  'report-filters': () => app.pushSheet('report-filters'),
  'report-bench-set': (el) => {
    const symbol = el.dataset.symbol;
    if (!symbol) return;
    const name = el.dataset.name || symbol;
    const top = topSheet();
    if (top && top.name === 'bench') app.popSheet();
    const cur = D().settings.benchmark || {};
    if (cur.symbol === symbol) return;
    D().settings.benchmark = { symbol, name };
    benchState.delete(symbol);
    commit(`Benchmark: ${name}`);
  },
});

FORMS['report-dates'] = (form) => {
  const from = form.elements.from ? form.elements.from.value : '';
  const to = form.elements.to ? form.elements.to.value : '';
  if (!isIsoDate(from) || !isIsoDate(to)) {
    app.toast('Scegli entrambe le date: «Da» e «A»');
    return;
  }
  let f = from;
  let t = to;
  if (f > t) [f, t] = [t, f];
  S.ui.period = 'CUSTOM';
  S.ui.from = f;
  S.ui.to = t;
  if (S.sheets.length) app.closeSheets();
  app.render();
  app.toast(`Periodo: ${fmtDate(f)} → ${fmtDate(t)}`);
};

function setRiskFree(v) {
  if (!Number.isFinite(v)) return;
  if (Math.abs((D().settings.riskFree ?? 0.02) - v) < 1e-9) return;
  D().settings.riskFree = v;
  commit(`Tasso privo di rischio: ${pct(v)}`);
}

FORMS['report-rf'] = (form) => {
  const raw = form.elements.rf ? form.elements.rf.value : '';
  const n = parseNum(raw);
  if (!Number.isFinite(n) || n < -2 || n > 15) {
    app.toast('Scrivi un tasso tra −2 e 15, per esempio 2,5');
    return;
  }
  setRiskFree(+(n / 100).toFixed(6));
};

INPUTS['report-rf'] = (el, ev) => {
  if (ev && ev.type !== 'change') return;
  if (el.value === 'custom') {
    const form = el.parentElement && el.parentElement.querySelector('form[data-form="report-rf"]');
    if (form) {
      form.hidden = false;
      const input = form.querySelector('input');
      if (input) input.focus();
    }
    return;
  }
  setRiskFree(Number(el.value));
};

INPUTS['report-bench-q'] = (el, ev) => {
  if (ev && ev.type === 'change') return;
  const q = el.value || '';
  const top = topSheet();
  if (top && top.name === 'bench') top.args.q = q;
  benchSearch.q = q;
  benchSearch.gen++;
  benchSearch.live = [];
  const query = q.trim();
  benchSearch.pending = query.length >= 2 && market.status !== 'offline';
  updateBenchResults();
  if (benchSearch.pending) benchLive(query, benchSearch.gen);
};

/* ======================================================================
   Mount: keep the current sheet chip and period chip in view on phones
   ====================================================================== */
// Scroll a chip row just enough to show the pressed chip (with a peek of the next one)
function revealPressed(row) {
  if (!row) return;
  const cur = row.querySelector('[aria-pressed="true"]');
  if (!cur || row.scrollWidth <= row.clientWidth) return;
  const peek = 28;
  const left = cur.offsetLeft;
  const right = left + cur.offsetWidth;
  if (right + peek > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.min(left - peek, right + peek - row.clientWidth);
  else if (left - peek < row.scrollLeft) row.scrollLeft = Math.max(0, left - peek);
}

MOUNTS.push(() => {
  if (typeof document === 'undefined' || S.ui.tab !== 'report') return;
  revealPressed(document.querySelector('.report-nav .rn-tabs'));
  revealPressed(document.querySelector('.report-bar .period-chips'));
});

export const _test = { reportPeriod, periodLabel, benchCandidates, titleHtml, RF_STEPS };
