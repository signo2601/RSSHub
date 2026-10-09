// Gruzzolo entry point: boot sequence, router, app chrome (phone header and tab bar,
// desktop sidebar and top bar), event delegation, sheet stack, toasts and price refresh.
// Views register their handlers in registry.js at import time; this file only dispatches.
import { S, D, migrate, blankData, restoreUi, saveUi, bump, commit, persistence, account, accName, hasDemo } from './state.js';
import { app } from './app.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, FORM_SHEETS, MOUNTS } from './registry.js';
import { market } from './market.js';
import { getSeries, trackedSymbols } from './engine.js';
import { esc, fmt, icon, money, todayISO, debounce, isDesktop, fmtTime, newId } from './util.js';
import { initCharts } from './charts.js';
import * as storeMod from './store.js';
import * as syncMod from './sync.js';
import * as demoMod from './demo.js';
// Views, in the agreed order (namespace imports: a missing export shows a placeholder, not a crash)
import * as homeView from './views/home.js';
import * as marketView from './views/market.js';
import './views/sheets.js';
import * as reportView from './views/report.js';
import './views/sheet-summary.js';
import './views/sheet-visual.js';
import './views/sheet-composition.js';
import './views/sheet-income.js';
import './views/sheet-costs.js';
import './views/sheet-risk.js';
import * as moreView from './views/more.js';

// Tell the start-up guard in index.html that the code loaded
if (typeof window !== 'undefined') window.__gruzzoloStarted = true;

/* ---------- Constants ---------- */
const TABS = ['home', 'tx', 'report', 'market', 'more'];
const TAB_LABEL = { home: 'Portafoglio', tx: 'Transazioni', report: 'Report', market: 'Mercati', more: 'Altro' };
const TABBAR = [['home', 'chart', 'Portafoglio'], ['report', 'report', 'Report'], null, ['market', 'globe', 'Mercati'], ['more', 'more', 'Altro']];
const SIDENAV = [['home', 'chart', 'Portafoglio'], ['tx', 'receipt', 'Transazioni'], ['report', 'report', 'Report'], ['market', 'globe', 'Mercati'], ['more', 'sliders', 'Altro']];
const NO_SCOPE_TABS = new Set(['market', 'more']);
const THEMES = ['auto', 'light', 'dark'];
const THEME_COLOR = { light: '#eef1f5', dark: '#0c0e12' };
const THEME_KEY = 'gruzzolo:theme';
const STALE_MS = 10 * 60e3; // refresh on return to the app after this
const EVERY_MS = 15 * 60e3; // refresh while the app stays open
const SYNC_RESUME_MS = 30e3;
const BOOT_MARKET_WAIT_MS = 1500;
const BOOT_SYNC_WAIT_MS = 2500;
const HISTORY_CONCURRENCY = 3;

const VIEWS = {
  home: () => homeView.renderHome,
  tx: () => homeView.renderTransactions,
  market: () => marketView.renderMarket,
  report: () => reportView.renderReport,
  more: () => moreView.renderMore,
};

const sync = syncMod.sync || null;
const $ = (sel) => document.querySelector(sel);
// Claude artifact: the host provides window.claude; the artifact build also sets a flag
const isArtifact = () => typeof window !== 'undefined' && Boolean(window.claude || window.__GRUZZOLO_ARTIFACT__);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

/* ---------- Runtime state of the shell ---------- */
let store = null;
let canSave = true;
let warnedNotSaved = false;
let marketReady = Promise.resolve();
const shell = {
  refreshing: false,
  refreshPromise: null,
  manualPending: false,
  lastAttempt: 0,
  everOnline: false,
  lastSyncCheck: 0,
  syncBusy: false,
  deferred: false, // a background render waits until the user stops typing
};

/* ---------- Small helpers ---------- */
function hasRealHistory(symbol) {
  const h = market.getHistory(symbol);
  return Boolean(h && !h.synthetic && Array.isArray(h.dates) && h.dates.length);
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function reportError(where, err) {
  console.error(`[gruzzolo] ${where}`, err);
  const msg = err && err.message ? err.message : String(err || '');
  toast(`Qualcosa non ha funzionato${msg ? ': ' + msg : ''}`);
}

// Run a view handler; sync errors and rejected promises end in the console and a toast
function runHandler(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') r.catch((e) => reportError(name, e));
  } catch (e) {
    reportError(name, e);
  }
}

// A text field has the focus: re-rendering now would close the iPhone keyboard
function isEditing() {
  const a = document.activeElement;
  if (!a || a === document.body) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') return true;
  if (a.tagName !== 'INPUT') return false;
  return !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image'].includes(a.type);
}

/* ---------- Focus preservation across re-renders ---------- */
function focusKey(root) {
  const el = document.activeElement;
  if (!el || el === document.body || !root || !root.contains(el)) return null;
  let sel = '';
  if (el.id) sel = '#' + CSS.escape(el.id);
  else {
    const attrs = [...el.attributes].filter((a) => a.name === 'name' || (a.name.startsWith('data-') && a.value.length < 200));
    if (!attrs.length) return null;
    sel = el.tagName.toLowerCase() + attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('');
  }
  let index = 0;
  try {
    index = Math.max(0, [...root.querySelectorAll(sel)].indexOf(el));
  } catch {
    return null;
  }
  let start = null;
  let end = null;
  try {
    start = el.selectionStart;
    end = el.selectionEnd;
  } catch { /* inputs without a caret */ }
  return { el, sel, index, start, end };
}

function restoreFocus(root, key) {
  if (!key || key.el.isConnected) return;
  let target = null;
  try {
    const all = root.querySelectorAll(key.sel);
    target = all[key.index] || all[0] || null;
  } catch {
    target = null;
  }
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
    if (typeof key.start === 'number' && typeof target.setSelectionRange === 'function') target.setSelectionRange(key.start, key.end);
  } catch { /* some input types refuse a selection range */ }
}

/* ---------- Theme ---------- */
let lastTheme = null;
function applyTheme() {
  const t = THEMES.includes(D().settings.theme) ? D().settings.theme : 'auto';
  if (t === lastTheme) return;
  lastTheme = t;
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    const own = (m.getAttribute('media') || '').includes('dark') ? 'dark' : 'light';
    m.setAttribute('content', THEME_COLOR[t === 'auto' ? own : t]);
  }
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch { /* storage unavailable */ }
}

/* ---------- Chrome: header, sidebar, tab bar ---------- */
function setHtml(el, html) {
  if (el && el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}

function scopeLabel() {
  const accs = D().accounts;
  if (S.ui.scope !== 'all' && account(S.ui.scope)) return accName(S.ui.scope);
  return accs.length > 1 ? 'Tutti i conti' : (accs[0] && accs[0].name) || 'Conto';
}

function marketStatus() {
  if (shell.refreshing) return { cls: 'busy', short: 'Aggiorno…', long: 'Aggiorno i prezzi…' };
  if (market.status === 'offline') {
    return {
      cls: 'offline',
      short: 'Offline',
      long: market.lastRefresh ? `Offline · prezzi delle ${fmtTime(market.lastRefresh)}` : 'Server prezzi non raggiungibile: uso i prezzi salvati',
    };
  }
  if (market.lastRefresh) return { cls: 'online', short: `Aggiornato <span class="st-alle">alle </span>${fmtTime(market.lastRefresh)}`, long: `Prezzi aggiornati alle ${fmtTime(market.lastRefresh)}` };
  if (market.status === 'online') return { cls: 'online', short: 'Online', long: 'Server prezzi collegato' };
  return { cls: '', short: '', long: 'Mi collego al server prezzi…' };
}

function renderChrome() {
  const tab = S.ui.tab;
  const cur = tab === 'tx' ? 'home' : tab;
  const st = marketStatus();

  setHtml($('#tabbar'), `<div class="tabbar-inner">${TABBAR.map((t) => (t
    ? `<button class="tab" type="button" data-act="tab" data-tab="${t[0]}"${cur === t[0] ? ' aria-current="page"' : ''}>${icon(t[1])}<span>${t[2]}</span></button>`
    : `<button class="fab" type="button" data-act="add-tx" aria-label="Nuova transazione" title="Nuova transazione">${icon('plus')}</button>`)).join('')}</div>`);

  setHtml($('#side-nav'), SIDENAV.map(([id, ico, label]) => `<button class="side-item" type="button" data-act="tab" data-tab="${id}"${tab === id ? ' aria-current="page"' : ''}>${icon(ico)}<span>${label}</span></button>`).join(''));
  setHtml($('#side-add'), `<button class="btn primary block" type="button" data-act="add-tx">${icon('plus')}Nuova transazione</button>`);
  setHtml($('#side-status'), `<div class="side-status"><span class="dot ${st.cls}"></span><span>${esc(st.long)}</span></div>`
    + (S.loaded && hasDemo() ? '<div class="side-status"><span class="dot demo"></span><span>Stai guardando dati di esempio</span></div>' : '')
    + '<div>Gruzzolo 2.0 · prezzi da Yahoo Finance</div>');

  // st.short is built here from fixed text and a time: it may hold markup
  setHtml($('#top-status'), st.short ? `<span class="dot ${st.cls}"></span><span>${st.short}</span>` : '');
  setHtml($('#top-crumb'), `<span>Gruzzolo</span><span aria-hidden="true">/</span><b>${esc(TAB_LABEL[tab] || '')}</b>`);

  if (!S.loaded) {
    setHtml($('#top-actions'), '');
    return;
  }
  const hide = Boolean(S.ui.hide);
  const scope = NO_SCOPE_TABS.has(tab) ? ''
    : `<button class="pill-btn" type="button" data-act="scope-picker" aria-haspopup="dialog" title="Scegli il conto da mostrare"><span>${esc(scopeLabel())}</span>${icon('chevDown')}</button>`;
  setHtml($('#top-actions'), scope
    + `<button class="icon-btn" type="button" data-act="toggle-hide" aria-pressed="${hide}" aria-label="${hide ? 'Mostra gli importi' : 'Nascondi gli importi'}" title="${hide ? 'Mostra gli importi' : 'Nascondi gli importi'}">${icon(hide ? 'eyeOff' : 'eye')}</button>`
    + `<button class="icon-btn${shell.refreshing ? ' spinning' : ''}" type="button" data-act="refresh" aria-label="Aggiorna i prezzi" title="Aggiorna i prezzi"${shell.refreshing ? ' aria-busy="true"' : ''}>${icon('refresh')}</button>`);
}

/* ---------- Views ---------- */
function errorCard(where, err) {
  const msg = (err && (err.message || String(err))) || 'errore sconosciuto';
  return `<div class="error-card" role="alert">
    <strong>Non riesco a mostrare ${esc(where)}</strong>
    <p>Si è verificato un errore. Il resto dell'app funziona: prova a ricaricare o a cambiare sezione.</p>
    <code>${esc(msg)}</code>
    <button class="btn sm" type="button" data-act="shell-reload">${icon('refresh')}Ricarica</button>
  </div>`;
}

function placeholderView(tab) {
  return `<div class="page"><div class="empty">
    <div class="empty-ill">${icon('layers')}</div>
    <h2>${esc(TAB_LABEL[tab] || 'Sezione')} non disponibile</h2>
    <p>Questa sezione non è inclusa in questa versione dell'app.</p>
    <div class="btns"><button class="btn" type="button" data-act="tab" data-tab="home">Vai al portafoglio</button></div>
  </div></div>`;
}

function renderView() {
  const tab = S.ui.tab;
  const fn = VIEWS[tab] ? VIEWS[tab]() : null;
  if (typeof fn !== 'function') return placeholderView(tab);
  try {
    const html = fn();
    return typeof html === 'string' ? html : '';
  } catch (e) {
    console.error(`[gruzzolo] vista ${tab}`, e);
    return errorCard(`la sezione ${TAB_LABEL[tab] || tab}`, e);
  }
}

function normalizeUi() {
  if (!TABS.includes(S.ui.tab)) S.ui.tab = 'home';
  if (S.ui.scope !== 'all' && !account(S.ui.scope)) S.ui.scope = 'all';
}

function renderPage() {
  fmt.hide = Boolean(S.ui.hide);
  if (S.loaded) {
    normalizeUi();
    applyTheme();
  }
  renderChrome();
  if (!S.loaded) return;
  shell.deferred = false;
  const tab = S.ui.tab;
  try {
    document.title = tab === 'home' ? 'Gruzzolo' : `${TAB_LABEL[tab]} · Gruzzolo`;
  } catch { /* ignore */ }
  const view = $('#view');
  const focus = focusKey(view);
  view.innerHTML = renderView();
  restoreFocus(view, focus);
  for (const fn of MOUNTS) {
    try {
      fn();
    } catch (e) {
      console.error('[gruzzolo] mount', e);
    }
  }
  const top = topSheet();
  if (top && !FORM_SHEETS.has(top.name)) renderSheet();
  saveUi();
}

// Re-entrant calls (a commit inside a mount, an after() hook…) run once more right after
let rendering = false;
let renderAgain = false;
let renderChain = 0;
function render() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  rendering = true;
  try {
    renderPage();
  } catch (e) {
    console.error('[gruzzolo] render', e);
  } finally {
    rendering = false;
  }
  if (renderAgain) {
    renderAgain = false;
    if (++renderChain > 5) {
      console.warn('[gruzzolo] too many nested renders: stopped');
      renderChain = 0;
      return;
    }
    setTimeout(render, 0);
  } else renderChain = 0;
}

// Renders not started by the user (market data, resize): wait while a text field is focused
function backgroundRender() {
  if (!S.loaded) return;
  if (isEditing()) {
    shell.deferred = true;
    renderChrome();
    return;
  }
  render();
}
// Coalesce bursts of market updates: 150 ms after the first one, at most every 800 ms while
// prices are downloading (each symbol notifies, and report pages are heavy on an iPhone)
let renderTimer = null;
let lastBackground = 0;
function scheduleRender() {
  if (renderTimer) return;
  const gap = shell.refreshing ? 800 : 150;
  const wait = Math.max(150, gap - (Date.now() - lastBackground));
  renderTimer = setTimeout(() => {
    renderTimer = null;
    lastBackground = Date.now();
    backgroundRender();
  }, wait);
}

/* ---------- Sheets ---------- */
const topSheet = () => S.sheets[S.sheets.length - 1] || null;
let shownSheet = null;
let sheetOpener = null;
let inAfter = false;
let afterAsked = false; // the running after() hook asked for a re-render
let afterChain = 0; // consecutive re-renders asked by after() hooks

// Current values of a form sheet, so it can be rebuilt after another sheet on top closes
function readDraft(root) {
  const draft = {};
  if (!root) return draft;
  const fields = [...root.querySelectorAll('input[name], select[name], textarea[name]')];
  const count = {};
  for (const el of fields) count[el.name] = (count[el.name] || 0) + 1;
  for (const el of fields) {
    const { name, type } = el;
    if (['file', 'submit', 'button', 'reset', 'password', 'image'].includes(type)) continue;
    if (type === 'checkbox') {
      if (count[name] > 1) {
        if (!Array.isArray(draft[name])) draft[name] = [];
        if (el.checked) draft[name].push(el.value);
      } else draft[name] = el.checked;
    } else if (type === 'radio') {
      if (el.checked) draft[name] = el.value;
    } else if (el.tagName === 'SELECT' && el.multiple) {
      draft[name] = [...el.selectedOptions].map((o) => o.value);
    } else draft[name] = el.value;
  }
  return draft;
}

function setLocked(on) {
  document.documentElement.classList.toggle('locked', on);
  const appEl = $('#app');
  if (appEl) appEl.inert = on;
  if (!on) fitSheetToViewport();
}

function focusSheet() {
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  // On iPhone focusing a field opens the keyboard: only desktop gets the first field
  if (isDesktop() && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches) {
    const field = body.querySelector('input:not([type="hidden"]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])');
    if (field) {
      field.focus({ preventScroll: true });
      return;
    }
  }
  sheet.focus({ preventScroll: true });
}

function renderSheet() {
  const layer = $('#sheet-layer');
  const sheet = $('#sheet');
  const body = $('#sheet-body');
  const top = topSheet();
  if (!top) {
    if (!layer.hidden) {
      layer.hidden = true;
      body.innerHTML = '';
      shownSheet = null;
      setLocked(false);
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && opener.isConnected && isDesktop()) {
        try {
          opener.focus({ preventScroll: true });
        } catch { /* ignore */ }
      }
      if (shell.deferred) scheduleRender();
    }
    return;
  }
  if (inAfter) {
    // an after() hook asked for a re-render: do it right after the hook (never in a loop)
    afterAsked = true;
    if (afterChain < 3) {
      afterChain++;
      setTimeout(renderSheet, 0);
    } else console.warn(`[gruzzolo] la finestra ${top.name} si ridisegna di continuo: fermata`);
    return;
  }
  const fresh = shownSheet !== top;
  let out;
  try {
    const fn = SHEETS[top.name];
    if (typeof fn !== 'function') throw new Error(`la finestra "${top.name}" non esiste`);
    out = fn(top.args) || {};
  } catch (e) {
    console.error(`[gruzzolo] finestra ${top.name}`, e);
    out = { title: 'Si è verificato un problema', body: errorCard('questa finestra', e) };
  }
  const scroll = fresh ? 0 : body.scrollTop;
  const focus = fresh ? null : focusKey(body);
  const wasHidden = layer.hidden;
  $('#sheet-title').textContent = out.title || '';
  $('#sheet-back').hidden = S.sheets.length < 2;
  sheet.classList.toggle('wide', out.size === 'wide');
  body.innerHTML = typeof out.body === 'string' ? out.body : '';
  layer.hidden = false;
  if (wasHidden) setLocked(true);
  body.scrollTop = scroll;
  shownSheet = top;
  if (fresh) {
    if (!wasHidden) {
      sheet.classList.remove('enter');
      void sheet.offsetWidth; // restart the content fade
      sheet.classList.add('enter');
    }
    focusSheet();
  } else restoreFocus(body, focus);
  if (typeof out.after === 'function') {
    inAfter = true;
    afterAsked = false;
    try {
      const r = out.after(body);
      if (r && typeof r.then === 'function') r.catch((e) => console.error(`[gruzzolo] after ${top.name}`, e));
    } catch (e) {
      console.error(`[gruzzolo] after ${top.name}`, e);
    } finally {
      inAfter = false;
      if (!afterAsked) afterChain = 0;
    }
  } else afterChain = 0;
  fitSheetToViewport();
}

function pushSheet(name, args = {}) {
  const top = topSheet();
  if (top && FORM_SHEETS.has(top.name) && shownSheet === top) {
    try {
      top.args.draft = readDraft($('#sheet-body'));
    } catch (e) {
      console.warn('[gruzzolo] draft', e);
    }
  }
  if (!S.sheets.length) sheetOpener = document.activeElement;
  S.sheets.push({ name, type: name, args: args && typeof args === 'object' ? args : {} });
  renderSheet();
}

function popSheet() {
  S.sheets.pop();
  renderSheet();
}

function closeSheets() {
  S.sheets = [];
  renderSheet();
}

// iPhone keyboard: keep the open sheet inside the visible area above the keyboard
function fitSheetToViewport() {
  const layer = $('#sheet-layer');
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!layer) return;
  const clear = () => {
    layer.style.top = '';
    layer.style.height = '';
    layer.style.bottom = '';
  };
  if (!vv || layer.hidden || isDesktop()) {
    clear();
    return;
  }
  const keyboard = window.innerHeight - vv.height;
  if (keyboard > 120 && vv.scale <= 1.01) {
    layer.style.top = `${Math.max(0, vv.offsetTop)}px`;
    layer.style.height = `${vv.height}px`;
    layer.style.bottom = 'auto';
  } else clear();
}

/* ---------- Confirm dialog ---------- */
const confirmFns = new Map();
SHEETS.confirm = ({ title = 'Confermi?', text = '', ok = 'Conferma', danger = true, key = '' } = {}) => ({
  title,
  body: `<p class="confirm-text">${esc(text).replace(/\n/g, '<br>')}</p>
    <div class="sheet-actions">
      <button class="btn" type="button" data-act="back-sheet">Annulla</button>
      <button class="btn ${danger ? 'danger solid' : 'primary'}" type="button" data-act="confirm-ok" data-key="${esc(key)}">${esc(ok)}</button>
    </div>`,
});

function askConfirm({ title = 'Confermi?', text = '', ok = 'Conferma', danger = true, onOk } = {}) {
  const key = newId('c');
  confirmFns.set(key, onOk);
  pushSheet('confirm', { title, text, ok, danger, key });
}

/* ---------- Scope picker ---------- */
function lastValue(key) {
  try {
    const s = getSeries(key);
    return s && s.value.length ? money(s.value[s.value.length - 1]) : null;
  } catch (e) {
    console.warn('[gruzzolo] valore conto', e);
    return null;
  }
}

SHEETS.scope = () => {
  const accs = D().accounts;
  const selected = S.ui.scope !== 'all' && account(S.ui.scope) ? S.ui.scope : 'all';
  const counts = {};
  for (const t of D().txns) counts[t.acc] = (counts[t.acc] || 0) + 1;
  const rows = [
    { id: 'all', ico: 'layers', name: 'Tutti i conti', sub: accs.length === 1 ? '1 conto' : `${accs.length} conti insieme` },
    ...accs.map((a) => ({
      id: a.id,
      ico: 'wallet',
      name: a.name,
      sub: [a.broker && a.broker !== 'Altro' && a.broker !== a.name ? a.broker : '', counts[a.id] ? `${counts[a.id]} operazioni` : 'nessuna operazione'].filter(Boolean).join(' · '),
    })),
  ];
  return {
    title: 'Quale conto vuoi vedere?',
    body: `<div class="list scope-list">${rows.map((r) => {
      const on = r.id === selected;
      const v = lastValue(r.id);
      return `<button class="row" type="button" data-act="pick-scope" data-scope="${esc(r.id)}" aria-pressed="${on}">
        <span class="scope-ico">${icon(r.ico)}</span>
        <span class="row-main"><span class="row-title">${esc(r.name)}</span><span class="row-sub">${esc(r.sub)}</span></span>
        <span class="row-end">${v ? `<span class="row-value">${v}</span>` : '<span class="row-sub">—</span>'}</span>
        ${on ? `<span class="check-ico">${icon('check')}</span>` : ''}
      </button>`;
    }).join('')}</div>
    <p class="hint" style="margin-top: 12px">Report e portafoglio mostrano solo il conto scelto. Aggiungi o rinomina i conti in Altro → Conti.</p>`,
  };
};

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  if (!msg) return;
  const el = $('#toast');
  if (!el) return;
  const text = String(msg);
  el.textContent = text;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth; // restart the entrance animation
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, Math.min(6500, 2600 + text.length * 30));
}

/* ---------- Prices ---------- */
// Download missing histories (3 at a time), then the latest quotes for everything tracked.
// Toasts only when the user pressed the button, or when the server stopped answering.
function refreshPrices(opts = {}) {
  const { force = false, manual = false } = opts || {};
  if (shell.refreshPromise) {
    if (manual) shell.manualPending = true;
    return shell.refreshPromise;
  }
  shell.lastAttempt = Date.now();
  shell.refreshing = true;
  shell.manualPending = manual;
  renderChrome();
  const run = (async () => {
    await marketReady;
    if (manual && market.status !== 'online') await market.ping();
    if (market.status === 'online') {
      const missing = trackedSymbols().filter((s) => !hasRealHistory(s));
      await mapLimit(missing, HISTORY_CONCURRENCY, (s) => market.ensureHistory(s).catch(() => null));
    }
    return market.refresh(trackedSymbols(), { force: force || manual });
  })();
  shell.refreshPromise = run.then(
    (res) => ({ res, error: null }),
    (error) => ({ res: null, error }),
  ).then(({ res, error }) => {
    const wasManual = shell.manualPending;
    shell.refreshing = false;
    shell.refreshPromise = null;
    shell.manualPending = false;
    if (market.status === 'online') shell.everOnline = true;
    if (error) console.warn('[gruzzolo] aggiornamento prezzi', error);
    const offline = Boolean(error || !res || res.offline || market.status === 'offline');
    if (offline) {
      if (wasManual || shell.everOnline) toast('Prezzi non aggiornati: server non raggiungibile');
    } else if (wasManual) {
      const failed = (res.failed || []).length;
      toast(failed ? `Prezzi aggiornati (${failed} non disponibili: riprova tra poco)` : 'Prezzi aggiornati');
    }
    renderChrome();
    scheduleRender();
    return res;
  });
  return shell.refreshPromise;
}

/* ---------- Storage and sync ---------- */
function fallbackStore() {
  const KEY = 'gruzzolo:data:v2';
  return {
    kind: 'local',
    async load() {
      try {
        const t = localStorage.getItem(KEY);
        return t ? JSON.parse(t) : null;
      } catch {
        return null;
      }
    },
    save(d) {
      try {
        localStorage.setItem(KEY, JSON.stringify(d));
      } catch {
        toast('Non riesco a salvare: memoria del browser piena. Esporta un backup da Altro.');
      }
    },
    flush() {},
  };
}

function flushStore() {
  try {
    if (store && typeof store.flush === 'function') store.flush();
  } catch (e) {
    console.warn('[gruzzolo] salvataggio', e);
  }
  try {
    if (sync && typeof sync.flush === 'function' && sync.enabled()) sync.flush();
  } catch { /* never block hiding the page */ }
}

function saveData(d) {
  if (!canSave) {
    if (!warnedNotSaved) {
      warnedNotSaved = true;
      toast('Modifica non salvata: i dati salvati non si sono caricati. Ricarica la pagina.');
    }
    return;
  }
  try {
    store.save(d);
  } catch (e) {
    console.error('[gruzzolo] salvataggio', e);
  }
  try {
    if (sync && typeof sync.schedulePush === 'function' && sync.enabled()) sync.schedulePush(d);
  } catch (e) {
    console.warn('[gruzzolo] sync', e);
  }
}

function installDemo(today) {
  if (typeof demoMod.installDemoMarket !== 'function') return;
  try {
    demoMod.installDemoMarket({ today });
  } catch (e) {
    console.error('[gruzzolo] dati di esempio', e);
  }
}

function demoOrBlank(today) {
  if (typeof demoMod.demoData === 'function') {
    try {
      const d = demoMod.demoData({ today });
      if (d) return migrate(d);
    } catch (e) {
      console.error('[gruzzolo] dati di esempio', e);
    }
  }
  return blankData();
}

// Replace the data with a copy pulled from the other device
function adoptData(raw) {
  S.data = migrate(raw);
  if (hasDemo()) installDemo(todayISO());
  bump();
  if (canSave && store) {
    try {
      store.save(S.data);
    } catch (e) {
      console.error('[gruzzolo] salvataggio', e);
    }
  }
  if (S.loaded) {
    render();
    toast('Dati aggiornati dall\'altro dispositivo');
  }
}

async function reconcileSync() {
  if (!sync || typeof sync.enabled !== 'function' || typeof sync.reconcile !== 'function') return;
  if (shell.syncBusy || !sync.enabled()) return;
  shell.syncBusy = true;
  shell.lastSyncCheck = Date.now();
  const before = S.data;
  const stamp = S.data.updatedAt;
  try {
    const r = await sync.reconcile(S.data);
    // adopt only if nothing changed locally in the meantime (a newer local edit is pushed instead)
    if (r && r.action === 'pulled' && r.data && S.data === before && S.data.updatedAt === stamp) adoptData(r.data);
  } catch (e) {
    console.warn('[gruzzolo] sincronizzazione', e);
  } finally {
    shell.syncBusy = false;
  }
}

/* ---------- Service worker ---------- */
function registerServiceWorker() {
  if (isArtifact() || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[gruzzolo] service worker', e));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('Gruzzolo è stata aggiornata: chiudila e riaprila per la nuova versione');
  });
}

/* ---------- Launch parameters (manifest shortcuts) ---------- */
function readLaunch() {
  try {
    const q = new URLSearchParams(location.search);
    const tab = q.get('tab');
    return { tab: TABS.includes(tab) ? tab : null, action: q.get('action'), had: q.has('tab') || q.has('action') };
  } catch {
    return { tab: null, action: null, had: false };
  }
}

function clearLaunch(launch) {
  if (!launch.had) return;
  try {
    const q = new URLSearchParams(location.search);
    q.delete('tab');
    q.delete('action');
    const rest = q.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
  } catch { /* sandboxed frames */ }
}

function runLaunchAction(launch) {
  if (launch.action !== 'add') return;
  const fn = ACTIONS['add-tx'];
  if (typeof fn === 'function') runHandler('add-tx', () => fn(document.createElement('button'), new Event('click')));
}

/* ---------- Actions owned by the shell ---------- */
Object.assign(ACTIONS, {
  tab: (el) => {
    const tab = el.dataset.tab;
    if (!TABS.includes(tab)) return;
    const same = S.ui.tab === tab;
    if (S.sheets.length) closeSheets();
    S.ui.tab = tab;
    render();
    if (same) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    else {
      window.scrollTo(0, 0);
      const view = $('#view');
      if (view && isDesktop()) view.focus({ preventScroll: true });
    }
  },
  'scope-picker': () => pushSheet('scope'),
  'pick-scope': (el) => {
    const id = el.dataset.scope;
    S.ui.scope = id && id !== 'all' && account(id) ? id : 'all';
    closeSheets();
    render();
  },
  'toggle-hide': () => {
    S.ui.hide = !S.ui.hide;
    render();
    toast(S.ui.hide ? 'Importi nascosti: tocca l\'occhio per mostrarli' : 'Importi visibili');
  },
  refresh: () => refreshPrices({ force: true, manual: true }),
  'close-sheet': () => closeSheets(),
  'back-sheet': () => popSheet(),
  'confirm-ok': (el) => {
    const key = el.dataset.key;
    const fn = confirmFns.get(key);
    confirmFns.delete(key);
    const entry = S.sheets.find((s) => s.name === 'confirm' && s.args && s.args.key === key);
    try {
      if (typeof fn === 'function') runHandler('conferma', fn);
    } finally {
      // close the confirm unless the callback already rearranged the sheets
      const i = S.sheets.indexOf(entry);
      if (entry && i >= 0) {
        S.sheets.splice(i, 1);
        renderSheet();
      }
    }
  },
  'set-theme': (el) => {
    const t = el.dataset.theme;
    if (!THEMES.includes(t) || D().settings.theme === t) return;
    D().settings.theme = t;
    commit(t === 'auto' ? 'Tema automatico: segue il telefono' : t === 'dark' ? 'Tema scuro' : 'Tema chiaro');
  },
  'shell-reload': () => location.reload(),
});

Object.assign(app, { render, toast, pushSheet, popSheet, closeSheets, renderSheet, askConfirm, refreshPrices });

/* ---------- Event delegation ---------- */
function onClick(e) {
  const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const name = el.dataset.act;
  const fn = ACTIONS[name];
  if (typeof fn !== 'function') {
    console.warn(`[gruzzolo] azione sconosciuta: ${name}`);
    return;
  }
  if (!el.matches('input, select, textarea, label')) e.preventDefault();
  runHandler(name, () => fn(el, e));
}

function onSubmit(e) {
  const form = e.target;
  e.preventDefault(); // never navigate away
  const name = form && form.dataset ? form.dataset.form : null;
  if (!name) return;
  const fn = FORMS[name];
  if (typeof fn !== 'function') {
    console.warn(`[gruzzolo] modulo sconosciuto: ${name}`);
    return;
  }
  runHandler(name, () => fn(form, e));
}

function onInput(e) {
  const el = e.target && e.target.closest ? e.target.closest('[data-input]') : null;
  if (!el) return;
  if (e.type === 'input' && el.type === 'file') return; // a chosen file fires both events: handle it once, on change
  const fn = INPUTS[el.dataset.input];
  if (typeof fn === 'function') runHandler(el.dataset.input, () => fn(el, e));
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function trapFocus(e) {
  const sheet = $('#sheet');
  const items = [...sheet.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.getClientRects().length);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (!sheet.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && (active === first || active === sheet)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape' && S.sheets.length) {
    e.preventDefault();
    popSheet();
    return;
  }
  if (e.key === 'Tab' && S.sheets.length) {
    trapFocus(e);
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && !e.defaultPrevented) {
    const el = e.target;
    if (el && el.matches && el.matches('[data-act][role="button"]:not(button):not(a):not(input):not(select):not(textarea)')) {
      e.preventDefault();
      el.click();
    }
  }
}

let scrollTicking = false;
function onScroll() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    scrollTicking = false;
    const top = $('#top');
    if (top) top.classList.toggle('scrolled', window.scrollY > 4);
  });
}

let lastWidth = 0;
const onResize = debounce(() => {
  const w = document.documentElement.clientWidth;
  if (w === lastWidth) return; // iPhone toolbars change only the height
  lastWidth = w;
  backgroundRender();
}, 180);

function onVisibility() {
  if (document.visibilityState === 'hidden') {
    flushStore();
    return;
  }
  if (!S.loaded) return;
  if (Date.now() - shell.lastAttempt > STALE_MS) refreshPrices();
  if (Date.now() - shell.lastSyncCheck > SYNC_RESUME_MS) reconcileSync();
}

function listen() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onInput);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('focusout', () => {
    if (!shell.deferred) return;
    setTimeout(() => {
      if (shell.deferred && !isEditing()) render();
    }, 150);
  });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flushStore);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('online', () => {
    if (!S.loaded) return;
    market.ping().then(() => {
      if (market.status === 'online' && Date.now() - shell.lastAttempt > 60e3) refreshPrices();
    }).catch(() => {});
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', fitSheetToViewport);
    window.visualViewport.addEventListener('scroll', fitSheetToViewport);
  }
  const toastEl = $('#toast');
  if (toastEl) toastEl.addEventListener('click', () => { toastEl.hidden = true; });
  window.addEventListener('unhandledrejection', (e) => console.warn('[gruzzolo] promessa non gestita', e.reason));
  market.subscribe(() => {
    if (market.status === 'online') shell.everOnline = true;
    scheduleRender();
  });
  if (sync && typeof sync.onChange === 'function') sync.onChange(() => scheduleRender());
  setInterval(() => {
    if (!S.loaded || document.visibilityState !== 'visible') return;
    if (Date.now() - shell.lastAttempt >= EVERY_MS) refreshPrices();
  }, 60e3);
}

/* ---------- Boot ---------- */
async function boot() {
  restoreUi();
  const launch = readLaunch();
  if (launch.tab) S.ui.tab = launch.tab;
  lastWidth = document.documentElement.clientWidth;
  $('#sheet-back').innerHTML = icon('chevLeft');
  $('#sheet-close').innerHTML = icon('close');
  initCharts();
  listen();
  renderChrome();

  // 1. Saved data (device storage or Claude artifact database)
  try {
    store = typeof storeMod.pickStore === 'function' ? await storeMod.pickStore() : null;
  } catch (e) {
    console.error('[gruzzolo] archivio', e);
  }
  if (!store || typeof store.load !== 'function') store = fallbackStore();
  let raw = null;
  let loadFailed = false;
  try {
    raw = await store.load();
  } catch (e) {
    loadFailed = true;
    console.error('[gruzzolo] lettura dati', e);
  }
  const today = todayISO();
  let data = null;
  if (raw) {
    try {
      data = migrate(raw);
    } catch (e) {
      loadFailed = true;
      console.error('[gruzzolo] dati salvati non validi', e);
    }
  }
  if (!data || (!data.settings.started && !data.txns.length)) data = demoOrBlank(today);
  S.data = data;
  if (hasDemo()) installDemo(today);
  bump();
  if (loadFailed) {
    // never overwrite data we could not read
    canSave = false;
    toast('Non riesco a leggere i dati salvati: per sicurezza le modifiche non verranno salvate. Ricarica la pagina.');
  }
  persistence.save = saveData;

  // 2. Market cache (IndexedDB) and server check: do not keep the user waiting for it
  marketReady = market.init({ apiBase: S.data.settings.apiBase || '' }).catch((e) => console.warn('[gruzzolo] mercato', e));
  await withTimeout(marketReady, BOOT_MARKET_WAIT_MS);

  // 3. Sync with the other device (the newer copy wins)
  if (canSave) await withTimeout(reconcileSync(), BOOT_SYNC_WAIT_MS);

  // 4. First real render
  S.loaded = true;
  render();
  if (typeof window !== 'undefined') window.__gruzzoloReady = true;
  runLaunchAction(launch);
  clearLaunch(launch);
  registerServiceWorker();

  // 5. Fresh prices in the background
  marketReady.then(() => refreshPrices());
}

boot().catch((e) => {
  console.error('[gruzzolo] avvio', e);
  const view = $('#view');
  if (view) view.innerHTML = errorCard('l\'app', e);
});
