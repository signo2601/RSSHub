// Application state, data model (v2), migration and the commit cycle.
import { app } from './app.js';
import { market } from './market.js';

export const TYPE_KEYS = ['stock', 'etf', 'fund', 'bond', 'crypto', 'cash', 'commodity', 'realestate', 'other'];
export const TYPE_LABEL = { stock: 'Azione', etf: 'ETF', fund: 'Fondo', bond: 'Obbligazione', crypto: 'Crypto', cash: 'Liquidità', commodity: 'Materia prima', realestate: 'Immobile', other: 'Altro' };
export const TYPE_PLURAL = { stock: 'Azioni', etf: 'ETF', fund: 'Fondi', bond: 'Obbligazioni', crypto: 'Crypto', cash: 'Liquidità', commodity: 'Materie prime', realestate: 'Immobili', other: 'Altro' };
export const SECTORS = ['Tecnologia', 'Finanza', 'Sanità', 'Beni di consumo', 'Beni voluttuari', 'Industria', 'Energia', 'Utility', 'Materiali', 'Immobiliare', 'Telecomunicazioni', 'Governativo', 'Diversificato', 'Altro'];
export const REGIONS = ['Italia', 'Europa', 'USA', 'Globale', 'Mercati emergenti', 'Asia', 'Altro'];
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD', 'SEK', 'NOK', 'DKK', 'HKD', 'CNY'];
export const BROKERS = ['DEGIRO', 'Scalable Capital', 'Fineco', 'Directa', 'Trade Republic', 'Interactive Brokers', 'Banca Sella', 'Intesa Sanpaolo', 'Moneyfarm', 'Revolut', 'Altro'];
export const TX_TYPES = ['buy', 'sell', 'div', 'deposit', 'withdraw', 'interest', 'fee', 'tax'];
export const TX_LABEL = { buy: 'Acquisto', sell: 'Vendita', div: 'Dividendo', deposit: 'Deposito', withdraw: 'Prelievo', interest: 'Interessi', fee: 'Commissione', tax: 'Imposta' };
export const FEE_KINDS = { transaction: 'Commissione di negoziazione', autofx: 'Costo cambio valuta (AutoFX)', connectivity: 'Connectivity fee', other: 'Altro costo' };
export const TAX_KINDS = { capital: 'Imposta su plusvalenze', income: 'Ritenuta su dividendi e cedole', stamp: 'Imposta di bollo', other: 'Altra imposta' };

export function blankData() {
  return {
    v: 2,
    updatedAt: 0,
    settings: {
      started: false,
      riskFree: 0.02,
      benchmark: { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF' },
      taxRate: 0.26,
      govTaxRate: 0.125,
      stampDuty: 0.002,
      externalPL: {},
      apiBase: '',
      theme: 'auto',
    },
    accounts: [{ id: 'acc1', name: 'Principale', broker: 'Altro', cashMode: 'auto' }],
    assets: {},
    txns: [],
    prices: {},
    watch: [],
  };
}

export const S = {
  data: blankData(),
  ver: 0,
  loaded: false,
  sheets: [],
  ui: {
    tab: 'home',
    scope: 'all',
    range: '1A',
    chartMode: 'value',
    sort: 'value',
    showClosed: false,
    hide: false,
    sheet: 0,
    period: 'ALL',
    from: null,
    to: null,
    base100: false,
    logScale: false,
    allocBy: 'class',
    allocSel: null,
    incomeYear: null,
    txFilter: 'all',
    marketQuery: '',
  },
};
export const D = () => S.data;

/* ---------- Migration ---------- */
// Accepts v1 (first Gruzzolo) or v2 data and returns valid v2 data
export function migrate(raw) {
  const base = blankData();
  if (!raw || typeof raw !== 'object') return base;
  if (raw.v === 2) {
    const d = { ...base, ...raw };
    d.settings = { ...base.settings, ...(raw.settings || {}), benchmark: { ...base.settings.benchmark, ...((raw.settings || {}).benchmark || {}) } };
    d.accounts = Array.isArray(raw.accounts) && raw.accounts.length ? raw.accounts : base.accounts;
    d.assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
    d.txns = Array.isArray(raw.txns) ? raw.txns : [];
    d.prices = raw.prices && typeof raw.prices === 'object' ? raw.prices : {};
    d.watch = Array.isArray(raw.watch) ? raw.watch : [];
    return d;
  }
  // v1 → v2: portfolios become accounts, prices were entered in EUR
  const d = base;
  d.settings.started = Boolean(raw.settings && raw.settings.started);
  if (Array.isArray(raw.portfolios) && raw.portfolios.length) {
    d.accounts = raw.portfolios.map((p) => ({ id: p.id, name: p.name, broker: 'Altro', cashMode: 'auto', ...(p.demo ? { demo: true } : {}) }));
  }
  for (const a of Object.values(raw.assets || {})) {
    d.assets[a.id] = {
      id: a.id, name: a.name, ticker: a.ticker || '', symbol: '', isin: '', type: a.type || 'other', currency: 'EUR',
      exchange: '', sector: a.sector || '', region: a.region || '', ter: null, priceSource: 'manual', ...(a.demo ? { demo: true } : {}),
    };
  }
  d.txns = (raw.txns || []).map((t) => {
    const { pid, ...rest } = t;
    return { ...rest, acc: pid || d.accounts[0].id, ...(t.type === 'buy' || t.type === 'sell' ? { fx: 1 } : {}) };
  });
  d.prices = raw.prices || {};
  d.watch = (raw.watch || []).map((w) => ({ id: w.id, symbol: '', ticker: w.ticker || '', name: w.name, currency: 'EUR', price: w.price || 0, target: w.target || 0, note: w.note || '', ...(w.demo ? { demo: true } : {}) }));
  return d;
}

/* ---------- Lookups ---------- */
export function asset(aid) {
  return S.data.assets[aid] || { id: aid, name: 'Titolo rimosso', ticker: '', symbol: '', type: 'other', currency: 'EUR', priceSource: 'manual' };
}
export const account = (id) => S.data.accounts.find((a) => a.id === id) || null;
export const accName = (id) => (account(id) || {}).name || 'Conto';
export const accountIds = () => S.data.accounts.map((a) => a.id);
export function scopeIds() {
  return S.ui.scope !== 'all' && account(S.ui.scope) ? [S.ui.scope] : null;
}
export const scopeKey = () => (scopeIds() ? S.ui.scope : 'all');
export function incomeLabel(aid) {
  const t = aid ? asset(aid).type : 'cash';
  return t === 'bond' ? 'Cedola' : t === 'cash' ? 'Interessi' : 'Dividendo';
}
export const assetCode = (a) => a.ticker || (a.symbol ? a.symbol.replace(/\..*$/, '').replace(/-USD$|=X$/, '') : '') || '';
export const hasDemo = () => S.data.txns.some((t) => t.demo) || Object.values(S.data.assets).some((a) => a.demo) || S.data.watch.some((w) => w.demo);

// Manual price point in the asset currency
export function setPrice(aid, date, price) {
  const arr = (S.data.prices[aid] ||= []);
  const i = arr.findIndex((p) => p[0] === date);
  if (i >= 0) arr[i] = [date, price];
  else {
    arr.push([date, price]);
    arr.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
}

/* ---------- Memo and commit ---------- */
const memo = new Map();
let memoStamp = '';
// Memoize a computation until the data or market data changes
export function cached(key, fn) {
  const stamp = S.ver + ':' + market.version;
  if (stamp !== memoStamp) {
    memo.clear();
    memoStamp = stamp;
  }
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}
export function bump() {
  S.ver++;
  memo.clear();
}

// Set by main.js (store + sync)
export const persistence = {
  save(_data) {},
  afterCommit: [],
};

export function commit(message) {
  S.data.updatedAt = Date.now();
  if (S.data.txns.length || Object.keys(S.data.assets).length) S.data.settings.started = true;
  bump();
  persistence.save(S.data);
  for (const fn of persistence.afterCommit) {
    try {
      fn(S.data);
    } catch { /* a failing hook must not block the UI */ }
  }
  app.render();
  if (message) app.toast(message);
}

/* ---------- UI preferences (per device) ---------- */
const UI_KEY = 'gruzzolo:ui:v2';
const UI_SAVED = ['tab', 'scope', 'range', 'chartMode', 'sort', 'hide', 'sheet', 'period', 'from', 'to', 'base100', 'logScale', 'allocBy'];
export function restoreUi() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || '{}');
    for (const k of UI_SAVED) if (k in saved) S.ui[k] = saved[k];
  } catch { /* storage unavailable: keep defaults */ }
}
export function saveUi() {
  try {
    const out = {};
    for (const k of UI_SAVED) out[k] = S.ui[k];
    localStorage.setItem(UI_KEY, JSON.stringify(out));
  } catch { /* ignore */ }
}
