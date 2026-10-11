// Tab "Altro": accounts, broker CSV import, report and tax settings, appearance, where the data is
// (privacy and storage), backup and data, price server, guide. Every group is a list of rows (iOS
// settings feel on phones, two columns of cards on desktop); rows that need input open a sheet.
// The user's data never leaves the device: the only network traffic started here is public market
// data from the app's own /api (prices, search, FX).
// Also owns the 'demo-remove' and 'demo-load' actions used by the other views.
import { S, D, migrate, blankData, bump, commit, account, hasDemo, assetCode, BROKERS, TYPE_KEYS, TYPE_LABEL, TX_LABEL, FEE_KINDS, TAX_KINDS } from '../state.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, FORM_SHEETS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { getSeries, fxOn, sortTxns } from '../engine.js';
import { demoData, installDemoMarket, removeDemo } from '../demo.js';
import { PRESETS, parseCsv, detectPreset, guessMapping, buildTxns } from '../importer.js';
import { CATALOG, findInCatalog } from '../catalog.js';
import { fiscalBackpack } from '../costs.js';
import { infoBtn } from '../info.js';
import { avatar, demoBanner, txAmount, txFx } from './home.js';
import { tickerOf } from './sheets.js';
import { benchShort } from './report.js';
import {
  esc, icon, ICONS, money, moneyLocal, pct, num, numInput, parseNum, fmtDate, fmtTime, todayISO, iso, dayDiff, newId, hashHue, saveFile, clone,
} from '../util.js';
// Namespace import: optional helpers (storageStatus) are feature-detected
import * as util from '../util.js';

/* ======================================================================
   Constants
   ====================================================================== */
export const VERSION = 'Gruzzolo 2.0';
export const CASH_MODES = {
  track: {
    label: 'Traccio la liquidità',
    short: 'Con liquidità',
    text: 'Registri depositi e prelievi e l\'app calcola il saldo di cassa. La liquidità fa parte del valore del conto.',
  },
  auto: {
    label: 'Solo investimenti',
    short: 'Solo investimenti',
    text: 'Ogni acquisto conta come nuovo versamento: non serve registrare depositi e prelievi, e la liquidità non viene mostrata.',
  },
};
const cashModeOf = (a) => (a && a.cashMode === 'track' ? 'track' : 'auto');

const NEW_ACC = '__new';
const PRESET_ORDER = ['degiro-transactions', 'degiro-account', 'scalable', 'generic'];
const PRESET_LABEL = {
  'degiro-transactions': 'DEGIRO · Transazioni',
  'degiro-account': 'DEGIRO · Estratto conto',
  scalable: 'Scalable Capital',
  generic: 'Generico (altro broker)',
};
const PRESET_NOTE = {
  'degiro-transactions': 'Contiene acquisti e vendite con commissioni e cambio. Dividendi, depositi e costi di connessione sono nell\'Estratto conto: importa anche quello.',
  'degiro-account': 'Contiene dividendi, cedole, depositi, prelievi, interessi e costi (connessione, AutoFX). Acquisti e vendite si leggono dal file Transazioni.',
  scalable: 'Contiene acquisti, vendite, piani di accumulo, dividendi, depositi, prelievi, interessi e imposte.',
  generic: 'Per un altro broker: al passo successivo indichi quale colonna contiene la data, il tipo di operazione, la quantità…',
};
const GUIDES = [
  { broker: 'DEGIRO', title: 'DEGIRO · Transazioni', path: ['Attività', 'Transazioni', 'scegli le date', 'Esporta', 'CSV'], what: 'Acquisti e vendite, con commissioni e cambio.' },
  { broker: 'DEGIRO', title: 'DEGIRO · Estratto conto', path: ['Attività', 'Estratto conto', 'scegli le date', 'Esporta', 'CSV'], what: 'Dividendi, cedole, depositi, prelievi, interessi e costi.' },
  { broker: 'Scalable Capital', title: 'Scalable Capital', path: ['Transazioni', 'Esporta CSV'], what: 'Tutto: compravendite, piani di accumulo, dividendi, depositi e imposte.' },
];
// Target fields of the generic preset, in the order shown in the mapping table
const MAP_FIELDS = [
  ['date', 'Data', 'obbligatoria'], ['type', 'Tipo di operazione', 'acquisto, vendita, dividendo…'], ['isin', 'ISIN', ''], ['symbol', 'Ticker', ''],
  ['name', 'Nome del titolo', ''], ['qty', 'Quantità', ''], ['price', 'Prezzo unitario', ''], ['currency', 'Valuta', ''],
  ['fx', 'Tasso di cambio', ''], ['fee', 'Commissioni', ''], ['tax', 'Tasse', ''], ['amount', 'Importo', ''],
  ['total', 'Totale', ''], ['ref', 'Riferimento ordine', ''], ['description', 'Descrizione', ''], ['time', 'Ora', ''],
];
const TYPE_COUNT = {
  buy: ['acquisto', 'acquisti'], sell: ['vendita', 'vendite'], div: ['dividendo o cedola', 'dividendi e cedole'],
  deposit: ['deposito', 'depositi'], withdraw: ['prelievo', 'prelievi'], interest: ['accredito di interessi', 'accrediti di interessi'],
  fee: ['costo', 'costi'], tax: ['imposta', 'imposte'],
};
const FEE_SHORT = { transaction: 'Commissione', autofx: 'Costo cambio', connectivity: 'Connectivity fee', other: 'Costo' };
const TAX_SHORT = { capital: 'Imposta plusvalenze', income: 'Ritenuta', stamp: 'Bollo', other: 'Imposta' };
const DEFAULT_RATES = { riskFree: 0.02, taxRate: 0.26, govTaxRate: 0.125, stampDuty: 0.002 };
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const LOOKUP_TRIES = 3;
const SEARCH_CONCURRENCY = 3;

// Yahoo symbol suffixes: by broker venue code (DEGIRO "Borsa"), and preferred ones by currency
const VENUE_SUFFIX = {
  MIL: 'MI', MOT: 'MI', ETLX: 'MI', XET: 'DE', TDG: 'DE', FRA: 'F', EAM: 'AS', EPA: 'PA', EBR: 'BR', ELI: 'LS', MAD: 'MC',
  LSE: 'L', SWX: 'SW', VIE: 'VI', HSE: 'HE', OMX: 'ST', OSL: 'OL', CSE: 'CO', TOR: 'TO', HKS: 'HK', ASX: 'AX', TSE: 'T',
  NDQ: '', NSY: '', NYSE: '', NASDAQ: '', ARCA: '', BATS: '',
};
const CCY_SUFFIXES = {
  EUR: ['MI', 'DE', 'AS', 'PA', 'F', 'MC', 'BR', 'LS', 'VI', 'HE', 'IR', 'MU', 'SG', 'DU', 'BE', 'HM'],
  USD: [''], GBP: ['L', 'IL'], CHF: ['SW'], CAD: ['TO', 'V'], JPY: ['T'], HKD: ['HK'], SEK: ['ST'], NOK: ['OL'], DKK: ['CO'], AUD: ['AX'],
};

/* ======================================================================
   Small helpers
   ====================================================================== */
const CHEV = `<svg class="ico chev" viewBox="0 0 24 24" aria-hidden="true">${ICONS.chevRight}</svg>`;
const topSheet = () => S.sheets[S.sheets.length - 1] || null;
const isTop = (name) => {
  const t = topSheet();
  return Boolean(t && t.name === name);
};
const doc = () => (typeof document !== 'undefined' ? document : null);
const byId = (id) => {
  const d = doc();
  return d ? d.getElementById(id) : null;
};
const plural = (n, one, many) => `${num(n, 0)} ${n === 1 ? one : many}`;
const pctInput = (v) => (Number.isFinite(v) ? numInput(+(v * 100).toFixed(4)) : '');
const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
export const normCcy = (c) => {
  const s = String(c || '').trim();
  if (s === 'GBp' || s.toUpperCase() === 'GBX') return 'GBP';
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : '';
};
const isPence = (c) => {
  const s = String(c || '').trim();
  return s === 'GBp' || s.toUpperCase() === 'GBX';
};
const suffixOf = (symbol) => {
  const m = /\.([A-Z]{1,3})$/.exec(String(symbol || '').toUpperCase());
  return m ? m[1] : '';
};

// 'iPhone' or 'iPad' when the app runs on one, '' elsewhere (e.g. the preview inside Claude on a computer):
// the copy names the phone only when it is true
export function deviceName(ua = null) {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const s = ua ?? String((nav && nav.userAgent) || '');
  if (/iPhone|iPod/.test(s)) return 'iPhone';
  if (/iPad/.test(s) || (/Macintosh/.test(s) && nav && nav.maxTouchPoints > 1)) return 'iPad';
  return '';
}
const onIos = () => Boolean(deviceName());
const hereText = () => (deviceName() ? `questo ${deviceName()}` : 'questo dispositivo');
// Opened from the Home Screen icon (standalone web app) rather than in a Safari tab
function isStandalone() {
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) return true;
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

// Anything the user entered (example data excluded): transactions, securities, watchlist items
export function hasUserContent(d) {
  if (!d || typeof d !== 'object') return false;
  const txns = Array.isArray(d.txns) ? d.txns : [];
  const assets = d.assets && typeof d.assets === 'object' ? Object.values(d.assets) : [];
  const watch = Array.isArray(d.watch) ? d.watch : [];
  return txns.some((t) => t && !t.demo) || assets.some((a) => a && !a.demo) || watch.some((w) => w && !w.demo);
}

// Italian file size, decimal units like the iPhone settings: 850 kB, 2,4 MB
export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1e3) return `${num(n, 0)} byte`;
  if (n < 1e6) return `${num(n / 1e3, 0)} kB`;
  if (n < 1e9) return `${num(n / 1e6, 1)} MB`;
  return `${num(n / 1e9, 1)} GB`;
}

function lead(name, tone = '') {
  return `<span class="more-ico${tone ? ' ' + tone : ''}">${icon(name)}</span>`;
}

// One tappable row of a settings list. title/sub/end are HTML: callers escape their strings.
function navRow({ act, attrs = '', ico = '', tone = '', avatarHtml = '', title, sub = '', end = '', chev = true, cls = '', disabled = false }) {
  return `<button class="row more-row${cls ? ' ' + cls : ''}" type="button" data-act="${act}"${attrs}${disabled ? ' disabled' : ''}>
    ${avatarHtml || (ico ? lead(ico, tone) : '')}<span class="row-main"><span class="row-title">${title}</span>${sub ? `<span class="row-sub">${sub}</span>` : ''}</span>
    ${end ? `<span class="row-end">${end}</span>` : ''}${chev ? CHEV : ''}
  </button>`;
}

// A settings group: title, a list of rows, an optional note under it (foot is HTML)
function group(id, ico, title, body, foot = '') {
  return `<section class="more-group" aria-labelledby="mg-${id}">
    <h2 class="more-group-title" id="mg-${id}"><span class="more-gico">${icon(ico)}</span>${esc(title)}</h2>
    ${body}
    ${foot ? `<p class="more-foot">${foot}</p>` : ''}
  </section>`;
}

// Numbered steps (guide sheets); items are HTML: callers escape their strings
const stepsHtml = (steps) => `<ol class="more-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>`;

function accAvatar(a) {
  const src = String((a.broker && a.broker !== 'Altro' ? a.broker : a.name) || '?');
  const words = src.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const txt = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  return `<span class="avatar sm more-acc-av" style="background:hsl(${hashHue(src)} 42% 44%)" aria-hidden="true">${esc(txt)}</span>`;
}

function txCounts(data = D()) {
  const counts = {};
  for (const t of data.txns) counts[t.acc] = (counts[t.acc] || 0) + 1;
  return counts;
}

function lastValue(key) {
  try {
    const s = getSeries(key);
    return s && s.value.length ? s.value[s.value.length - 1] : null;
  } catch (e) {
    console.warn('[gruzzolo] valore conto', e);
    return null;
  }
}

// Time of a refresh or a backup: "alle 14:32" today, "3 ott alle 14:32" otherwise
function whenText(ms, today = todayISO()) {
  if (!ms) return '';
  const day = iso(new Date(ms));
  return day === today ? `alle ${fmtTime(ms)}` : `${fmtDate(day, false)} alle ${fmtTime(ms)}`;
}

function formError(form) {
  return (msg, field = null) => {
    const e = form.querySelector('[data-error]');
    if (e) {
      e.textContent = msg;
      e.hidden = false;
    }
    if (field && field.setAttribute) {
      field.setAttribute('aria-invalid', 'true');
      try {
        field.focus({ preventScroll: false });
      } catch { /* ignore */ }
    } else if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest' });
    return false;
  };
}
function clearErrors(form) {
  const e = form.querySelector('[data-error]');
  if (e) {
    e.hidden = true;
    e.textContent = '';
  }
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
}

function blurActive() {
  const d = doc();
  if (d && d.activeElement && typeof d.activeElement.blur === 'function') d.activeElement.blur();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Read a text file: UTF-8, or Windows-1252 when UTF-8 does not fit (old Excel exports)
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('�')) {
    try {
      text = new TextDecoder('windows-1252').decode(buf);
    } catch { /* keep UTF-8 */ }
  }
  return text;
}

/* ======================================================================
   Pure helpers (exported for tests)
   ====================================================================== */
// All-caps broker names become readable: 'APPLE INC. - COMMON STOCK' → 'Apple Inc. - Common Stock'
const KEEP_UPPER = new Set(['ETF', 'ETC', 'ETN', 'UCITS', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'MSCI', 'FTSE', 'ACC', 'DIST', 'EM', 'IMI', 'ESG', 'SRI',
  'S&P', 'BTP', 'BOT', 'CCT', 'CTZ', 'SE', 'SA', 'AG', 'NV', 'PLC', 'SPA', 'II', 'III', 'US', 'UK', 'EU', 'ADR', 'REIT', 'AI', 'NYSE', 'DAX']);
export function prettyName(name) {
  const s = String(name || '').trim().replace(/\s+/g, ' ');
  if (!s || /[a-zà-ÿ]/.test(s)) return s;
  const word = (w) => {
    const bare = w.replace(/[.,;:()]+$/g, '').replace(/^[(]+/, '');
    if (KEEP_UPPER.has(bare) || /\d/.test(w)) return w;
    return w.split('-').map((p) => (p ? p.charAt(0) + p.slice(1).toLowerCase() : p)).join('-');
  };
  return s.split(' ').map(word).join(' ');
}

const CSV_HEAD = ['Data', 'Conto', 'Tipo', 'Titolo', 'Ticker', 'ISIN', 'Quantità', 'Prezzo', 'Valuta', 'Cambio', 'Commissioni', 'AutoFX', 'Tasse', 'Importo EUR', 'Riferimento', 'Nota'];
function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// Italian decimal comma, no thousands separator, no exponent (Excel-friendly)
export function csvNum(v, digits = 8) {
  if (v === undefined || v === null || v === '' || !Number.isFinite(+v)) return '';
  let s = (+v).toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (/^-0$/.test(s)) s = '0';
  return s.replace('.', ',');
}
function txTypeText(t, a) {
  if (t.type === 'div') return a && a.type === 'bond' ? 'Cedola' : 'Dividendo';
  if (t.type === 'fee') return FEE_KINDS[t.kind] || FEE_KINDS.other;
  if (t.type === 'tax') return TAX_KINDS[t.kind] || TAX_KINDS.other;
  return TX_LABEL[t.type] || t.type || '';
}

// All transactions as a ';' separated CSV (BOM, Italian decimals). Amounts use the app data (S.data).
export function transactionsCsv(data = D()) {
  const accName = (id) => ((data.accounts || []).find((a) => a.id === id) || {}).name || '';
  const lines = sortTxns(data.txns || []).map((t) => {
    const a = t.aid ? (data.assets || {})[t.aid] || null : null;
    const trade = t.type === 'buy' || t.type === 'sell';
    const ccy = a ? a.currency || 'EUR' : 'EUR';
    let fx = '';
    if (trade && ccy !== 'EUR') {
      try {
        fx = csvNum(txFx(t), 6);
      } catch {
        fx = csvNum(t.fx, 6);
      }
    }
    let amount = '';
    try {
      amount = csvNum(txAmount(t), 2);
    } catch { /* leave empty */ }
    return [
      t.date, accName(t.acc), txTypeText(t, a), a ? a.name : '', a ? assetCode(a) : '', a ? a.isin || '' : '',
      trade ? csvNum(t.qty, 8) : '', trade ? csvNum(t.price, 8) : '', trade ? ccy : '', fx,
      csvNum(t.fee, 2), csvNum(t.fxFee, 2), csvNum(t.tax, 2), amount, t.ref || '', t.note || '',
    ].map(csvCell).join(';');
  });
  return '﻿' + [CSV_HEAD.join(';'), ...lines].join('\r\n') + '\r\n';
}

// A backup file → { ok, data (migrated v2), version, txns, accounts, updatedAt } or { ok: false, error }
export function checkBackup(raw) {
  const bad = { ok: false, error: 'Il file non è un backup di Gruzzolo: mancano conti, titoli o operazioni.' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad;
  const hasTx = Array.isArray(raw.txns);
  const hasAssets = raw.assets && typeof raw.assets === 'object' && !Array.isArray(raw.assets);
  let version = 0;
  if (raw.v === 2 && hasTx && hasAssets && (raw.accounts === undefined || Array.isArray(raw.accounts))) version = 2;
  else if ((raw.v === 1 || raw.v === undefined) && hasTx && hasAssets && (Array.isArray(raw.portfolios) || raw.v === 1)) version = 1;
  if (!version) {
    if (typeof raw.v === 'number' && raw.v > 2) return { ok: false, error: 'Questo backup viene da una versione più recente di Gruzzolo: aggiorna l\'app e riprova.' };
    return bad;
  }
  let data;
  try {
    data = migrate(raw);
  } catch {
    return { ok: false, error: 'Il backup è danneggiato e non si può leggere.' };
  }
  const badTx = data.txns.some((t) => !t || typeof t !== 'object' || typeof t.date !== 'string' || typeof t.type !== 'string');
  if (badTx) return { ok: false, error: 'Il backup contiene operazioni non valide e non si può importare.' };
  return { ok: true, data, version, txns: data.txns.length, accounts: data.accounts.length, updatedAt: Number(raw.updatedAt) || 0 };
}

// Remove an account and its transactions (mutates data) → number of transactions removed
export function dropAccount(data, id) {
  if (!data || !Array.isArray(data.accounts) || data.accounts.length < 2) return -1;
  if (!data.accounts.some((a) => a.id === id)) return -1;
  const before = data.txns.length;
  data.txns = data.txns.filter((t) => t.acc !== id);
  data.accounts = data.accounts.filter((a) => a.id !== id);
  return before - data.txns.length;
}

// Search results ordered by fit with the CSV: same venue first, then a listing in the same currency
export function rankListings(results, { currency = '', exchange = '' } = {}) {
  const want = normCcy(currency);
  const venue = String(exchange || '').toUpperCase();
  const venueSfx = Object.prototype.hasOwnProperty.call(VENUE_SUFFIX, venue) ? VENUE_SUFFIX[venue] : null;
  const prefs = CCY_SUFFIXES[want] || null;
  return (Array.isArray(results) ? results : [])
    .filter((r) => r && r.symbol)
    .map((r, i) => {
      const sfx = suffixOf(r.symbol);
      let score = 0;
      if (venueSfx !== null && sfx === venueSfx) score += 100;
      if (prefs) {
        const k = prefs.indexOf(sfx);
        if (k >= 0) score += 50 - k;
      }
      return [score, i, r];
    })
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .map((x) => x[2]);
}

// Same security already in the data: ISIN first, then Yahoo symbol, then the exact name
export function findExistingAsset(assets, item) {
  const list = Object.values(assets || {}).filter(Boolean);
  const up = (s) => String(s || '').trim().toUpperCase();
  if (item.isin) {
    const hit = list.find((a) => up(a.isin) === up(item.isin));
    if (hit) return hit.id;
  }
  if (item.symbol) {
    const hit = list.find((a) => up(a.symbol) === up(item.symbol) || (!a.symbol && up(a.ticker) === up(item.symbol)));
    if (hit) return hit.id;
  }
  if (!item.isin && item.name) {
    const hit = list.find((a) => up(a.name) === up(item.name));
    if (hit) return hit.id;
  }
  return null;
}

// Best curated listing of an ISIN for the CSV currency/venue
function catalogListing(item) {
  const want = normCcy(item.currency);
  const byIsin = item.isin ? CATALOG.filter((c) => c.isin && c.isin.toUpperCase() === item.isin.toUpperCase()) : [];
  const bySymbol = item.symbol ? [findInCatalog(item.symbol)].filter(Boolean) : [];
  const ranked = rankListings([...byIsin, ...bySymbol], item);
  return ranked.find((c) => !want || normCcy(c.currency) === want) || null;
}

// Yahoo listing for an imported security: search by ISIN (or ticker), confirm the currency with a
// quote lookup; the curated catalog when offline. null → manual prices.
async function findListing(item, { online, search, lookup }) {
  const want = normCcy(item.currency);
  const query = item.isin || item.symbol;
  if (online && query && typeof search === 'function') {
    let results = [];
    try {
      results = await search(query);
    } catch {
      results = [];
    }
    for (const c of rankListings(results, item).slice(0, LOOKUP_TRIES)) {
      let info = null;
      try {
        info = typeof lookup === 'function' ? await lookup(c.symbol) : null;
      } catch {
        info = null;
      }
      const ccy = normCcy(info && info.currency);
      const sfxOk = want && (CCY_SUFFIXES[want] || []).includes(suffixOf(c.symbol));
      if ((ccy && (!want || ccy === want)) || (!ccy && (!want || sfxOk))) {
        return {
          symbol: (info && info.symbol) || c.symbol,
          name: (info && info.name) || c.name || '',
          type: (info && info.type) || c.type || '',
          currency: ccy || want || 'EUR',
          exchange: (info && info.exchange) || c.exchange || '',
          source: 'yahoo',
        };
      }
    }
  }
  const cat = catalogListing(item);
  if (cat) return { symbol: cat.symbol, name: cat.name, type: cat.type, currency: cat.currency, exchange: cat.exchange || '', source: 'catalog' };
  return null;
}

function buildAsset(item, info, id) {
  const meta = (info && findInCatalog(info.symbol)) || (item.isin && findInCatalog(item.isin)) || null;
  const sameListing = Boolean(info && meta && meta.symbol === info.symbol);
  const type = [info && info.type, item.type, meta && meta.type].find((t) => TYPE_KEYS.includes(t) && t !== 'other') || 'other';
  return {
    id,
    name: (sameListing && meta.name) || (info && info.name) || prettyName(item.name) || item.isin || item.symbol || 'Titolo',
    ticker: info ? tickerOf(info.symbol) : '',
    symbol: info ? info.symbol : '',
    isin: item.isin || (meta && meta.isin) || '',
    type,
    currency: info ? normCcy(info.currency) || 'EUR' : normCcy(item.currency) || 'EUR',
    exchange: (info && info.exchange) || item.exchange || '',
    sector: (meta && meta.sector) || '',
    region: (meta && meta.region) || '',
    ter: meta && meta.ter > 0 ? meta.ter : null,
    priceSource: info ? 'auto' : 'manual',
  };
}

/**
 * Resolve the securities of an import to asset ids.
 * items: importer assets [{ key, isin, name, currency, type, symbol?, exchange? }]
 * → { map: { key → aid }, created: Asset[], pence: Set<key> }
 */
export async function resolveImportAssets(items, { assets = {}, online = false, search = null, lookup = null, onProgress = null, idFor = () => newId('a') } = {}) {
  const list = Array.isArray(items) ? items : [];
  let done = 0;
  const found = await mapLimit(list, SEARCH_CONCURRENCY, async (item) => {
    const aid = findExistingAsset(assets, item);
    const info = aid ? null : await findListing(item, { online, search, lookup });
    done++;
    if (typeof onProgress === 'function') onProgress(done, list.length);
    return { item, aid, info };
  });
  const map = {};
  const created = [];
  const pence = new Set();
  for (const { item, aid, info } of found) {
    if (isPence(item.currency)) pence.add(item.key);
    if (aid) {
      map[item.key] = aid;
      continue;
    }
    // Two rows of the file can point to the same listing (e.g. different product names)
    const same = info && info.symbol ? [...Object.values(assets || {}), ...created].find((a) => a && a.symbol === info.symbol) : null;
    if (same) {
      map[item.key] = same.id;
      continue;
    }
    const a = buildAsset(item, info, idFor());
    created.push(a);
    map[item.key] = a.id;
  }
  return { map, created, pence };
}

// Importer transactions → app transactions (asset ids, account, batch id; pence prices to pounds)
export function finalizeTxns(list, { map = {}, pence = new Set(), acc, src }) {
  const out = [];
  let dropped = 0;
  for (const t of list || []) {
    const { assetKey, ...rest } = t;
    const aid = assetKey ? map[assetKey] : undefined;
    if (!aid && (t.type === 'buy' || t.type === 'sell' || t.type === 'div')) {
      dropped++;
      continue;
    }
    const n = { ...rest, acc, src };
    if (aid) n.aid = aid;
    if (assetKey && pence.has(assetKey) && (t.type === 'buy' || t.type === 'sell')) {
      if (n.price > 0) n.price = +(n.price / 100).toFixed(8);
      if (n.fx > 0) n.fx = +(n.fx / 100).toFixed(8);
    }
    out.push(n);
  }
  return { txns: out, dropped };
}

// External fiscal P&L rows of the form → settings.externalPL ({ '2023': -75 })
export function externalFromRows(rows) {
  const out = {};
  for (const { year, sign, amount } of rows) {
    const y = String(year);
    if (!/^\d{4}$/.test(y)) continue;
    const n = typeof amount === 'number' ? amount : parseNum(amount);
    if (!Number.isFinite(n) || n === 0) continue;
    const signed = n < 0 ? n : sign < 0 ? -n : n;
    out[y] = Math.round(signed * 100) / 100;
  }
  return out;
}

// Import batches in the data (newest first): [{ src, count, acc, time }]
export function importBatches(data = D()) {
  const by = new Map();
  for (const t of data.txns || []) {
    if (!t.src || !String(t.src).startsWith('imp')) continue;
    const b = by.get(t.src) || { src: t.src, count: 0, acc: t.acc, time: 0, first: t.date, last: t.date };
    b.count++;
    if (t.date < b.first) b.first = t.date;
    if (t.date > b.last) b.last = t.date;
    by.set(t.src, b);
  }
  for (const b of by.values()) {
    const m = /^imp-([0-9a-z]+)-/.exec(b.src);
    const ms = m ? parseInt(m[1], 36) : 0;
    b.time = ms > 1.5e12 && ms < 4e12 ? ms : 0;
  }
  return [...by.values()].sort((a, b) => b.time - a.time || (a.last < b.last ? 1 : -1));
}

// Empty data for «Cancella tutti i dati»: preferences survive (rates, benchmark, server, theme),
// everything the user entered (accounts, transactions, assets, prices, watchlist, external P&L) goes
export const KEEP_ON_WIPE = ['riskFree', 'benchmark', 'taxRate', 'govTaxRate', 'stampDuty', 'apiBase', 'theme'];
export function wipedData(prev = {}) {
  const d = blankData();
  const st = (prev && prev.settings) || {};
  for (const k of KEEP_ON_WIPE) if (st[k] !== undefined && st[k] !== null) d.settings[k] = clone(st[k]);
  d.settings.started = true;
  return d;
}

const newBatchId = () => `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/* ======================================================================
   Tab page
   ====================================================================== */
export function renderMore() {
  const today = todayISO();
  return `<div class="page more-page">
    <div class="page-head"><div><p class="eyebrow">Impostazioni e strumenti</p><h1 class="page-title">Altro</h1></div></div>
    ${demoBanner()}
    <div class="more-cols">
      <div class="more-col">${accountsGroup()}${importGroup(today)}${fiscalGroup()}${appearanceGroup()}</div>
      <div class="more-col">${privacyGroup(today)}${dataGroup()}${serverGroup(today)}${guideGroup()}</div>
    </div>
  </div>`;
}

/* ---------- 1. Accounts ---------- */
function accountsGroup() {
  const counts = txCounts();
  const rows = D().accounts.map((a) => {
    const n = counts[a.id] || 0;
    const v = n ? lastValue(a.id) : null;
    // the broker is left out when it is already the account's name ("DEGIRO · DEGIRO")
    const broker = a.broker && a.broker !== 'Altro' ? a.broker : 'Altro intermediario';
    const sub = [broker.toLowerCase() === String(a.name).toLowerCase() ? '' : broker, CASH_MODES[cashModeOf(a)].short, plural(n, 'operazione', 'operazioni')].filter(Boolean);
    return navRow({
      act: 'more-account',
      attrs: ` data-id="${esc(a.id)}"`,
      avatarHtml: accAvatar(a),
      title: esc(a.name),
      sub: `${a.demo ? '<span class="tag">esempio</span> ' : ''}${esc(sub.join(' · '))}`,
      end: `<span class="row-value">${v === null ? '—' : money(v)}</span>`,
    });
  });
  rows.push(navRow({ act: 'more-account', attrs: ' data-id=""', ico: 'plus', tone: 'accent', title: 'Aggiungi un conto', sub: 'Uno per ogni broker o deposito titoli', cls: 'more-add' }));
  return group('accounts', 'wallet', 'Conti', `<div class="list">${rows.join('')}</div>`,
    'Un conto è il deposito titoli presso un broker (DEGIRO, Scalable Capital…). Portafoglio e report li mostrano insieme o uno alla volta.');
}

/* ---------- 2. Import ---------- */
function importGroup(today) {
  const rows = [navRow({ act: 'more-import', ico: 'upload', tone: 'accent', title: 'Importa un file CSV', sub: 'Da DEGIRO, Scalable Capital o un altro broker' })];
  for (const b of importBatches().slice(0, 3)) {
    const when = b.time ? whenText(b.time, today) : '';
    const sub = [plural(b.count, 'operazione', 'operazioni'), (account(b.acc) || {}).name || '', when ? `importate ${when}` : `${fmtDate(b.first)} → ${fmtDate(b.last)}`].filter(Boolean);
    rows.push(navRow({ act: 'more-import-undo', attrs: ` data-src="${esc(b.src)}"`, ico: 'trash', title: 'Annulla un\'importazione', sub: esc(sub.join(' · ')), chev: false }));
  }
  return group('import', 'file', 'Importa da broker', `<div class="list">${rows.join('')}</div>`,
    esc(`Il file viene letto su ${hereText()}: al server dei prezzi arrivano solo gli ISIN dei titoli, per trovarne le quotazioni. Le operazioni già presenti vengono riconosciute e saltate: puoi reimportare un file aggiornato senza doppioni.`));
}

/* ---------- 3. Report and taxes ---------- */
function etfFundAssets() {
  const used = new Set(D().txns.map((t) => t.aid).filter(Boolean));
  return Object.values(D().assets).filter((a) => a && (a.type === 'etf' || a.type === 'fund') && used.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));
}

function fiscalGroup() {
  const st = D().settings;
  const b = st.benchmark || {};
  const ext = Object.entries(st.externalPL || {}).filter(([, v]) => Number.isFinite(v) && v !== 0).sort((x, y) => (x[0] < y[0] ? 1 : -1));
  const extSub = ext.length ? ext.slice(0, 3).map(([y, v]) => `${y}: ${v < 0 ? '−' : '+'}${money(Math.abs(v))}`).join(' · ') + (ext.length > 3 ? ' …' : '') : 'Nessun anno inserito';
  const funds = etfFundAssets();
  const withTer = funds.filter((a) => Number.isFinite(a.ter) && a.ter >= 0).length;
  const rows = [
    navRow({ act: 'bench-pick', attrs: ' aria-haspopup="dialog"', ico: 'chart', title: 'Benchmark', sub: esc(b.name || 'Nessuno'), end: `<span class="row-value">${esc(benchShort(b))}</span>` }),
    navRow({
      act: 'more-rates', ico: 'sliders', title: 'Tassi e aliquote',
      sub: esc(`Privo di rischio ${pct(st.riskFree ?? 0.02)} · Plusvalenze ${pct(st.taxRate ?? 0.26, 0)} · Titoli di Stato ${pct(st.govTaxRate ?? 0.125, 1)} · Bollo ${pct(st.stampDuty ?? 0.002)}`),
    }),
    navRow({ act: 'more-extpl', ico: 'receipt', title: 'Plus/minusvalenze esterne', sub: `Per lo zaino fiscale · ${esc(extSub)}` }),
    navRow({ act: 'more-ter', ico: 'coins', title: 'TER di ETF e fondi', sub: esc(funds.length ? `${withTer} di ${funds.length} con il costo annuo indicato` : 'Nessun ETF o fondo nel portafoglio') }),
  ];
  return group('fiscal', 'report', 'Report e fiscalità', `<div class="list">${rows.join('')}</div>`,
    'Valori usati dal Report: confronto con il benchmark, Sharpe, imposte, bollo, zaino fiscale e costo dei fondi.');
}

/* ---------- 4. Appearance ---------- */
function appearanceGroup() {
  const theme = ['auto', 'light', 'dark'].includes(D().settings.theme) ? D().settings.theme : 'auto';
  const tb = (k, label, ico) => `<button type="button" data-act="set-theme" data-theme="${k}" aria-pressed="${theme === k}">${icon(ico)}<span>${label}</span></button>`;
  const hide = Boolean(S.ui.hide);
  return group('look', 'sun', 'Aspetto', `<div class="list">
    <div class="row more-static more-theme"><span class="row-main"><span class="row-title">Tema</span><span class="row-sub">«Automatico» segue l'aspetto chiaro o scuro scelto nelle impostazioni del telefono</span></span></div>
    <div class="more-seg-wrap"><div class="seg full more-seg" role="group" aria-label="Tema">${tb('auto', 'Automatico', 'refresh')}${tb('light', 'Chiaro', 'sun')}${tb('dark', 'Scuro', 'moon')}</div></div>
    <button class="row more-row more-switch" type="button" role="switch" aria-checked="${hide}" data-act="toggle-hide">
      ${lead(hide ? 'eyeOff' : 'eye')}<span class="row-main"><span class="row-title">Nascondi gli importi</span><span class="row-sub">Utile in pubblico: gli euro diventano •••••, le percentuali restano visibili</span></span>
      <span class="more-toggle" aria-hidden="true"></span>
    </button>
  </div>`);
}

/* ---------- 5. Where your data is ---------- */
// Storage state from util.storageStatus(), read after the page renders (MOUNTS) and patched in place.
// persisted/usage/quota stay null when unknown (helper missing, unsupported, error).
const storage = { known: false, persisted: null, usage: null, quota: null, at: 0, pending: null };
const STORAGE_TTL = 30 * 1000;
const STORAGE_TIMEOUT = 4000;
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const canAskPersist = () => typeof navigator !== 'undefined' && Boolean(navigator.storage) && typeof navigator.storage.persist === 'function';

// util.storageStatus() made safe: a missing helper, a throw, a hang or odd values all become nulls
export async function readStorageStatus(fn = util.storageStatus) {
  const none = { persisted: null, usage: null, quota: null };
  if (typeof fn !== 'function') return none;
  let timer = null;
  try {
    const r = await Promise.race([
      Promise.resolve().then(() => fn()),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), STORAGE_TIMEOUT);
      }),
    ]);
    if (!r || typeof r !== 'object') return none;
    return { persisted: typeof r.persisted === 'boolean' ? r.persisted : null, usage: finiteOrNull(r.usage), quota: finiteOrNull(r.quota) };
  } catch (e) {
    console.warn('[gruzzolo] stato della memoria', e);
    return none;
  } finally {
    clearTimeout(timer);
  }
}

// Read the storage state again (at most every 30 s unless forced) and update its row if it is on screen
export function refreshStorage({ force = false, read = util.storageStatus } = {}) {
  if (storage.pending) return storage.pending;
  if (!force && storage.known && Date.now() - storage.at < STORAGE_TTL) return Promise.resolve(storage);
  storage.pending = readStorageStatus(read).then((r) => {
    Object.assign(storage, r, { known: true, at: Date.now(), pending: null });
    patchStorageRow();
    return storage;
  });
  return storage.pending;
}

const storageKey = () => (storage.known ? `${storage.persisted}|${storage.usage === null ? '' : Math.round(storage.usage / 1e4)}|${canAskPersist()}` : 'loading');

function storageLine() {
  const ios = onIos();
  const who = ios ? 'iOS' : 'il browser';
  const whoCap = ios ? 'iOS' : 'Il browser';
  if (!storage.known) return { cls: 'busy', title: 'Controllo la memoria…', sub: '' };
  if (storage.persisted === true) {
    return { cls: 'online', title: 'Memoria permanente attiva', sub: `${whoCap} conserva i dati di Gruzzolo e non li cancella per liberare spazio.` };
  }
  if (storage.persisted === false) {
    const base = `I dati sono salvati, ma ${ios ? 'se il telefono resta senza spazio' : 'se manca spazio'} ${who} potrebbe cancellarli.`;
    const line = { cls: 'warn', title: 'Memoria permanente non ancora concessa', sub: base };
    // In Safari iOS grants it to the Home Screen app only: asking again from the tab does not help
    if (ios && !isStandalone()) line.sub += ' Si attiva aprendo Gruzzolo dall\'icona sulla schermata Home.';
    else if (canAskPersist()) Object.assign(line, { sub: `${base} Tocca per chiederla di nuovo.`, ask: true });
    return line;
  }
  return { cls: 'offline', title: 'Stato della memoria non disponibile', sub: `${whoCap} non lo comunica: i dati restano comunque salvati qui.` };
}

function storageRow() {
  const line = storageLine();
  const end = storage.known && storage.usage !== null
    ? `<span class="row-end"><span class="row-value">${esc(fmtBytes(storage.usage))}</span><span class="row-sub">usati</span></span>`
    : '';
  const inner = `<span class="dot ${line.cls}"></span><span class="row-main"><span class="row-title">${esc(line.title)}</span>${line.sub ? `<span class="row-sub">${esc(line.sub)}</span>` : ''}</span>${end}`;
  const state = esc(storageKey());
  if (line.ask) {
    return `<button class="row more-row more-status more-note" type="button" id="more-storage" data-state="${state}" data-act="more-storage-persist">${inner}</button>`;
  }
  return `<div class="row more-static more-status more-note" id="more-storage" data-state="${state}">${inner}</div>`;
}

function patchStorageRow() {
  const el = byId('more-storage');
  if (el && el.dataset.state !== storageKey()) el.outerHTML = storageRow();
}

MOUNTS.push(() => {
  if (byId('more-storage')) refreshStorage();
});

// When the last backup was exported (this device only; it is not part of the data)
const BACKUP_AT_KEY = 'gruzzolo:lastBackup';
export const BACKUP_EVERY_DAYS = 30;
function lastBackupAt() {
  try {
    const ls = globalThis.localStorage;
    return ls ? Number(ls.getItem(BACKUP_AT_KEY)) || 0 : 0;
  } catch {
    return 0;
  }
}
function markBackup(ms = Date.now()) {
  try {
    const ls = globalThis.localStorage;
    if (ls) ls.setItem(BACKUP_AT_KEY, String(ms));
  } catch { /* the reminder is only a convenience */ }
}

// Reminder under «Esporta backup»: due (stronger color) when there is real data and no backup in 30 days
export function backupReminder(last, { today = todayISO(), content = true } = {}) {
  if (!last) return { due: Boolean(content), text: 'Non hai ancora fatto un backup: fanne uno ogni mese' };
  const day = iso(new Date(last));
  if (dayDiff(day, today) > BACKUP_EVERY_DAYS) return { due: Boolean(content), text: `Ultimo il ${fmtDate(day)}: è ora di farne uno nuovo` };
  return { due: false, text: `Ultimo backup ${day === today ? `oggi ${whenText(last, today)}` : `il ${fmtDate(day)}`}` };
}

function installRow() {
  if (!onIos() || isStandalone()) return '';
  return navRow({
    act: 'more-guide', attrs: ' data-topic="iphone"', ico: 'alert', tone: 'warn', cls: 'more-note',
    title: 'Installa Gruzzolo sulla schermata Home',
    sub: esc('In Safari, iOS può cancellare i dati dei siti che non apri da 7 giorni. Dall\'icona sulla schermata Home no.'),
  });
}

function privacyGroup(today) {
  const ios = onIos();
  const rem = backupReminder(lastBackupAt(), { today, content: hasUserContent(D()) });
  const static2 = (ico, tone, title, sub, cls = '') => `<div class="row more-static more-note${cls}">${lead(ico, tone)}<span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${esc(sub)}</span></span></div>`;
  const rows = [
    static2('lock', 'accent', `I tuoi dati restano solo su ${hereText()}`,
      `Conti, operazioni, titoli e impostazioni sono salvati nella memoria di Gruzzolo, qui sul ${ios ? 'telefono' : 'dispositivo'}. Niente account e niente cloud: nessuno oltre a te può vederli.`, ' more-hero'),
    static2('globe', '', 'Cosa passa da internet',
      'Solo il nome, il ticker o l\'ISIN dei titoli, per cercarli e chiederne i prezzi pubblici al server dell\'app. Mai importi, quantità, conti o operazioni.'),
    storageRow(),
    installRow(),
    navRow({ act: 'more-backup-export', ico: 'download', tone: rem.due ? 'warn' : 'accent', title: 'Esporta backup', sub: esc(rem.text), chev: false, cls: 'more-backup-now' }),
  ];
  const foot = ios
    ? 'Attenzione: se elimini l\'icona di Gruzzolo, iOS cancella anche i suoi dati. Prima esporta un backup.'
    : 'Attenzione: se cancelli i dati di navigazione del browser, si cancellano anche quelli di Gruzzolo. Prima esporta un backup.';
  return group('privacy', 'lock', 'Dove sono i tuoi dati', `<div class="list">${rows.join('')}</div>`, esc(foot));
}

/* ---------- 6. Backup and data ---------- */
function dataGroup() {
  const realTx = D().txns.some((t) => !t.demo);
  const demo = hasDemo();
  const dev = deviceName();
  const rows = [
    navRow({
      act: 'more-backup-export', ico: 'download', title: 'Esporta backup', chev: false,
      sub: esc(dev ? `Si apre Condividi: scegli «Salva su File» → «Sul mio ${dev}»` : 'Tutti i tuoi dati in un file .json da conservare'),
    }),
    navRow({
      act: 'more-backup-import', ico: 'upload', title: 'Importa backup', chev: false,
      sub: esc(dev ? 'Scegli il file .json nell\'app File: sostituisce i dati attuali' : 'Da un file .json di Gruzzolo: sostituisce i dati attuali'),
    }),
    navRow({ act: 'more-csv-export', ico: 'file', title: 'Esporta transazioni', sub: 'File .csv per Numbers, Excel o Fogli Google', chev: false }),
    navRow({ act: 'prices', ico: 'edit', title: 'Prezzi manuali', sub: 'Per i titoli senza quotazione automatica' }),
  ];
  if (demo) rows.push(navRow({ act: 'demo-remove', ico: 'close', title: 'Rimuovi i dati di esempio', sub: 'Tiene solo quello che hai inserito tu', chev: false }));
  else if (!realTx) rows.push(navRow({ act: 'demo-load', ico: 'chart', title: 'Carica un esempio', sub: 'Un portafoglio dimostrativo con prezzi simulati', chev: false }));
  rows.push(navRow({ act: 'more-wipe', ico: 'trash', tone: 'danger', title: '<span class="down">Cancella tutti i dati</span>', sub: 'Conti, operazioni, titoli, prezzi e watchlist', chev: false }));
  const foot = `Il backup è un file con tutti i tuoi dati: conservane sempre una copia recente. Con «Importa backup» li ripristini, anche su un nuovo ${dev || 'dispositivo'}.`;
  return group('data', 'shield', 'Backup e dati', `<div class="list">${rows.join('')}</div>`, esc(foot));
}

/* ---------- 7. Price server ---------- */
function serverLine(today) {
  if (market.status === 'online') {
    return { cls: 'online', text: market.lastRefresh ? `Collegato · prezzi aggiornati ${whenText(market.lastRefresh, today)}` : 'Collegato' };
  }
  if (market.status === 'offline') {
    return { cls: 'offline', text: market.lastRefresh ? `Non raggiungibile · uso i prezzi ${whenText(market.lastRefresh, today)}` : 'Non raggiungibile · uso i prezzi salvati' };
  }
  return { cls: 'busy', text: 'Verifico la connessione…' };
}

function serverGroup(today) {
  const base = String(D().settings.apiBase || '').trim();
  const line = serverLine(today);
  const rows = [
    `<div class="row more-static more-status"><span class="dot ${line.cls}"></span><span class="row-main"><span class="row-title">${esc(line.text)}</span><span class="row-sub">${esc(base ? `Server: ${base}` : 'Server: lo stesso sito dell\'app')}</span></span></div>`,
    navRow({ act: 'more-refresh', ico: 'refresh', title: 'Aggiorna prezzi ora', sub: 'Scarica le ultime quotazioni di titoli, benchmark e cambi', chev: false }),
    navRow({ act: 'more-server', ico: 'globe', title: 'Indirizzo del server', sub: esc(base || 'Lo stesso sito dell\'app (consigliato)') }),
    navRow({ act: 'more-clear-cache', ico: 'trash', title: 'Svuota cache prezzi', sub: 'Cancella i prezzi scaricati e li riscarica', chev: false }),
  ];
  return group('server', 'globe', 'Server prezzi', `<div class="list">${rows.join('')}</div>`,
    esc('Dal server dell\'app passano solo dati pubblici di mercato da Yahoo Finance: prezzi, cambi, dividendi e ricerca dei titoli. Riceve solo nomi e ticker dei titoli, mai i tuoi dati.'));
}

/* ---------- 8. Guide ---------- */
function guideGroup() {
  const installed = isStandalone();
  const rows = [
    navRow({
      act: 'more-guide', attrs: ' data-topic="iphone"', ico: installed ? 'check' : 'download', title: 'Installa su iPhone',
      sub: esc(installed ? 'Fatto: stai usando l\'app installata' : 'Safari → Condividi → Aggiungi alla schermata Home'),
    }),
    navRow({ act: 'more-guide', attrs: ' data-topic="offline"', ico: 'cloud', title: 'Senza internet', sub: 'Cosa funziona offline e quando si aggiornano i prezzi' }),
    navRow({ act: 'more-guide', attrs: ' data-topic="prices"', ico: 'info', title: 'Da dove arrivano i prezzi', sub: 'Fonte, ritardo e prezzi manuali' }),
  ];
  return group('guide', 'info', 'Guida', `<div class="list">${rows.join('')}</div>`,
    `<b>${esc(VERSION)}</b> · prezzi da Yahoo Finance tramite il server dell'app, solo a scopo informativo.`);
}

/* ======================================================================
   Sheet: account (add / edit)
   ====================================================================== */
function suggestedBroker() {
  const used = new Set(D().accounts.filter((a) => !a.demo).map((a) => a.broker));
  return ['DEGIRO', 'Scalable Capital'].find((b) => !used.has(b)) || 'Altro';
}

SHEETS['more-account'] = (args = {}) => {
  const a = args.id ? account(args.id) : null;
  if (args.id && !a) return { title: 'Conto', body: '<div class="empty"><p>Questo conto non esiste più.</p></div>' };
  const dr = args.draft || {};
  const name = dr.name ?? (a ? a.name : '');
  const broker = dr.broker ?? (a ? a.broker || 'Altro' : suggestedBroker());
  const mode = dr.cashMode === 'track' || dr.cashMode === 'auto' ? dr.cashMode : a ? cashModeOf(a) : 'auto';
  const brokers = BROKERS.includes(broker) ? BROKERS : [...BROKERS, broker];
  const n = a ? txCounts()[a.id] || 0 : 0;
  const v = a && n ? lastValue(a.id) : null;
  const radio = (k) => `<label><input type="radio" name="cashMode" value="${k}" data-input="more-cash-mode"${mode === k ? ' checked' : ''}><span class="seg-lbl">${esc(CASH_MODES[k].label)}</span></label>`;
  const canDelete = a && D().accounts.length > 1;
  return {
    title: a ? 'Modifica conto' : 'Nuovo conto',
    body: `<form class="form more-form" data-form="more-account" data-id="${esc(a ? a.id : '')}" novalidate>
      ${a ? `<div class="more-acc-head">${accAvatar(a)}<div><b>${esc(a.name)}</b><span class="hint">${esc(plural(n, 'operazione', 'operazioni'))}${v !== null ? ` · valore ${money(v)}` : ''}</span></div></div>` : ''}
      <div class="field"><label for="ma-name">Nome del conto</label>
        <input id="ma-name" name="name" value="${esc(name)}" maxlength="40" placeholder="${esc(broker !== 'Altro' ? broker : 'es. Conto titoli banca')}" autocomplete="off" autocapitalize="words" enterkeyhint="done">
        <p class="hint">Se lo lasci vuoto uso il nome del broker.</p></div>
      <div class="field"><label for="ma-broker">Broker</label>
        <select id="ma-broker" name="broker">${brokers.map((b) => opt(b, b === 'Altro' ? 'Altro intermediario' : b, b === broker)).join('')}</select></div>
      <div class="field"><span class="label" id="ma-cash-l">Liquidità del conto</span>
        <div class="seg full more-cash-seg" role="radiogroup" aria-labelledby="ma-cash-l">${radio('track')}${radio('auto')}</div>
        <p class="hint more-cash-hint" id="ma-cash-hint" aria-live="polite">${esc(CASH_MODES[mode].text)}</p>
        <p class="hint">Puoi cambiarla quando vuoi: i rendimenti si ricalcolano da soli.</p></div>
      <p class="form-error" data-error role="alert" hidden></p>
      <button class="btn primary block" type="submit">${a ? 'Salva' : 'Crea il conto'}</button>
      ${canDelete ? `<button class="btn danger block" type="button" data-act="more-account-delete" data-id="${esc(a.id)}">${icon('trash')}Elimina il conto</button>` : ''}
      ${a && !canDelete ? '<p class="hint">È l\'unico conto: per eliminarlo crea prima un altro conto.</p>' : ''}
    </form>`,
  };
};
FORM_SHEETS.add('more-account');

INPUTS['more-cash-mode'] = (el) => {
  const hint = byId('ma-cash-hint');
  if (hint && CASH_MODES[el.value]) hint.textContent = CASH_MODES[el.value].text;
};

FORMS['more-account'] = (form) => {
  clearErrors(form);
  const showErr = formError(form);
  const id = form.dataset.id || '';
  const a = id ? account(id) : null;
  if (id && !a) {
    app.popSheet();
    return;
  }
  const broker = BROKERS.includes(form.elements.broker.value) ? form.elements.broker.value : 'Altro';
  let name = form.elements.name.value.trim().replace(/\s+/g, ' ');
  if (!name) {
    if (broker === 'Altro') return showErr('Scrivi un nome per il conto, per esempio «Conto titoli banca».', form.elements.name);
    name = broker;
  }
  const clash = D().accounts.find((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase());
  if (clash) return showErr(`Esiste già un conto chiamato «${clash.name}»: scegli un altro nome.`, form.elements.name);
  const checked = form.querySelector('input[name="cashMode"]:checked');
  const cashMode = checked && checked.value === 'track' ? 'track' : 'auto';
  blurActive();
  if (a) Object.assign(a, { name, broker, cashMode });
  else D().accounts.push({ id: newId('acc'), name, broker, cashMode });
  app.popSheet();
  commit(a ? 'Conto aggiornato' : `Conto «${name}» creato`);
};

/* ======================================================================
   Sheet: CSV import
   ====================================================================== */
const imp = {
  step: 1,
  fileName: '',
  size: 0,
  headers: [],
  rows: [],
  delimiter: ',',
  detected: 'generic',
  preset: 'generic',
  acc: '',
  accTouched: false,
  mapping: null,
  result: null,
  src: '',
  busy: false,
  error: '',
};

function resetImport() {
  Object.assign(imp, {
    step: 1, fileName: '', size: 0, headers: [], rows: [], delimiter: ',', detected: 'generic', preset: 'generic',
    acc: '', accTouched: false, mapping: null, result: null, src: '', busy: false, error: '',
  });
}

const realAccounts = () => D().accounts.filter((a) => !a.demo);
const presetBroker = (preset) => (PRESETS[preset] ? PRESETS[preset].broker : 'Altro');

function defaultAccFor(preset) {
  const accs = realAccounts();
  const broker = presetBroker(preset);
  if (broker !== 'Altro') {
    const same = accs.find((a) => a.broker === broker);
    return same ? same.id : NEW_ACC;
  }
  const scoped = S.ui.scope !== 'all' ? accs.find((a) => a.id === S.ui.scope) : null;
  if (scoped) return scoped.id;
  return accs.length === 1 ? accs[0].id : NEW_ACC;
}

// Name of the account an import would create. Example accounts do not count: the import removes them.
function newAccName(preset, accounts = realAccounts()) {
  const broker = presetBroker(preset);
  const base = broker !== 'Altro' ? broker : 'Conto importato';
  let name = base;
  for (let k = 2; accounts.some((a) => a.name.toLowerCase() === name.toLowerCase()); k++) name = `${base} ${k}`;
  return name;
}

function loadImportText(fileName, text, size = 0) {
  resetImport();
  imp.fileName = fileName || 'file.csv';
  imp.size = size;
  const parsed = parseCsv(text);
  imp.headers = parsed.headers;
  imp.rows = parsed.rows;
  imp.delimiter = parsed.delimiter;
  if (!imp.headers.length || !imp.rows.length) {
    imp.error = 'Il file è vuoto o non sembra un CSV: controlla di aver scelto il file esportato dal broker.';
    return;
  }
  imp.detected = detectPreset(imp.headers);
  imp.preset = imp.detected;
  imp.mapping = guessMapping(imp.headers, imp.preset);
  imp.acc = defaultAccFor(imp.preset);
  imp.src = newBatchId();
  computeImport();
}

function computeImport() {
  if (!imp.rows.length || !imp.mapping) {
    imp.result = null;
    return null;
  }
  const real = imp.acc && imp.acc !== NEW_ACC && account(imp.acc) ? imp.acc : null;
  try {
    imp.result = buildTxns(imp.rows, imp.mapping, {
      preset: imp.preset,
      acc: real || NEW_ACC,
      existing: real ? D().txns : [],
      assets: D().assets,
      src: imp.src,
      fxOn: (ccy, date) => fxOn(normCcy(ccy) || ccy, date),
    });
  } catch (e) {
    console.warn('[gruzzolo] import', e);
    imp.result = { txns: [], assets: [], warnings: [`Non riesco a leggere le righe: ${e && e.message ? e.message : 'errore'}`], skipped: imp.rows.length, skippedReasons: {}, duplicates: 0, rows: imp.rows.length };
  }
  return imp.result;
}

function rerenderImport() {
  if (isTop('more-import')) app.renderSheet();
}

function stepper(step) {
  const names = ['File', 'Controllo', 'Importa'];
  return `<ol class="imp-steps" aria-label="Passaggi">${names.map((n, i) => {
    const k = i + 1;
    const cls = k < step ? ' class="done"' : '';
    return `<li${cls}${k === step ? ' aria-current="step"' : ''}><span class="imp-step-n">${k < step ? icon('check') : k}</span><span>${n}</span></li>`;
  }).join('')}</ol>`;
}

const pathHtml = (parts) => parts.map((p) => `<b>${esc(p)}</b>`).join('<span class="imp-arrow" aria-hidden="true">→</span>');

function filePicker(label, cls = 'btn primary block imp-pick') {
  return `<label class="${cls}"><input type="file" class="sr-only" accept=".csv,.txt,text/csv,text/plain" data-input="more-import-csv">${icon('upload')}<span>${esc(label)}</span></label>`;
}

function importStep1() {
  if (!imp.fileName || !imp.rows.length) {
    return `<p class="imp-intro">Scarica dal sito del broker il file CSV delle operazioni, poi sceglilo qui. Consiglio: come data di inizio metti quella della tua prima operazione.</p>
      ${filePicker('Scegli il file CSV')}
      ${imp.error ? `<p class="form-error" role="alert">${esc(imp.error)}</p>` : ''}
      <h3 class="imp-h">Dove trovo il file?</h3>
      <div class="imp-guides">${GUIDES.map((g) => `<div class="imp-guide">
        <div class="imp-guide-head">${accAvatar({ broker: g.broker, name: g.broker })}<b>${esc(g.title)}</b></div>
        <p class="imp-path">${pathHtml(g.path)}</p>
        <p class="hint">${esc(g.what)}</p>
      </div>`).join('')}</div>
      <p class="hint">Con DEGIRO importa entrambi i file, uno dopo l'altro, nello stesso conto. Altro broker? Va bene qualsiasi CSV con data, tipo di operazione, titolo, quantità e prezzo: al passo 2 indichi le colonne.</p>`;
  }
  const accs = realAccounts();
  const accOpts = accs.map((a) => opt(a.id, a.broker && a.broker !== 'Altro' && a.broker !== a.name ? `${a.name} (${a.broker})` : a.name, imp.acc === a.id)).join('')
    + opt(NEW_ACC, `Nuovo conto «${newAccName(imp.preset)}»`, imp.acc === NEW_ACC);
  const target = imp.acc !== NEW_ACC ? account(imp.acc) : null;
  const accHint = target
    ? `Le operazioni già presenti in «${target.name}» vengono saltate.`
    : `Creo il conto «${newAccName(imp.preset)}» al momento dell'importazione.${hasDemo() ? ' I dati di esempio verranno rimossi.' : ''}`;
  return `<div class="imp-file">${icon('file')}<div class="imp-file-main"><b>${esc(imp.fileName)}</b><span class="hint">${esc(plural(imp.rows.length, 'riga', 'righe'))} · ${esc(plural(imp.headers.length, 'colonna', 'colonne'))}</span></div>
      ${filePicker('Cambia', 'link-btn imp-change')}</div>
    <div class="imp-opts">
      <div class="field"><label for="imp-preset">Tipo di file</label>
        <select id="imp-preset" data-input="more-import-preset">${PRESET_ORDER.map((k) => opt(k, PRESET_LABEL[k], imp.preset === k)).join('')}</select>
        <p class="hint">${imp.preset === imp.detected ? 'Riconosciuto automaticamente. ' : `Avevo riconosciuto «${esc(PRESET_LABEL[imp.detected])}». `}${esc(PRESET_NOTE[imp.preset])}</p></div>
      <div class="field"><label for="imp-acc">Importa nel conto</label>
        <select id="imp-acc" data-input="more-import-acc">${accOpts}</select>
        <p class="hint">${esc(accHint)}</p></div>
    </div>
    <div class="sheet-actions"><button class="btn primary" type="button" data-act="more-import-next">Avanti${icon('chevRight')}</button></div>`;
}

function mappingTable() {
  const first = imp.rows[0] || [];
  const colLabel = (h, i) => {
    const sample = String(first[i] ?? '').trim();
    const head = h || `Colonna ${i + 1}`;
    return sample ? `${head} · es. ${sample.length > 18 ? sample.slice(0, 17) + '…' : sample}` : head;
  };
  const rows = MAP_FIELDS.map(([key, label, note]) => {
    const cur = Number.isInteger(imp.mapping[key]) ? imp.mapping[key] : -1;
    return `<tr><th scope="row"><label for="imp-map-${key}">${esc(label)}</label>${note ? `<small>${esc(note)}</small>` : ''}</th>
      <td><select id="imp-map-${key}" data-input="more-import-map" data-key="${key}">${opt(-1, '— non presente —', cur < 0)}${imp.headers.map((h, i) => opt(i, colLabel(h, i), cur === i)).join('')}</select></td></tr>`;
  }).join('');
  return `<h3 class="imp-h">Colonne del file</h3>
    <p class="hint">Per ogni dato scegli la colonna del tuo file che lo contiene. Servono almeno la data e il tipo di operazione (oppure la quantità: positiva per gli acquisti, negativa per le vendite).</p>
    <div class="table-wrap"><table class="table imp-map"><thead><tr><th>Dato</th><th>Colonna del tuo file</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function opLabel(t) {
  if (t.type === 'fee') return FEE_SHORT[t.kind] || 'Costo';
  if (t.type === 'tax') return TAX_SHORT[t.kind] || 'Imposta';
  if (t.type === 'div') {
    const item = t.assetKey ? (imp.result.assets || []).find((x) => x.key === t.assetKey) : null;
    return item && item.type === 'bond' ? 'Cedola' : 'Dividendo';
  }
  return TX_LABEL[t.type] || t.type;
}

function rawPreview() {
  const head = imp.headers.slice(0, 8);
  const rows = imp.rows.slice(0, 5).map((r) => `<tr>${head.map((_, i) => `<td>${esc(String(r[i] ?? ''))}</td>`).join('')}</tr>`).join('');
  return `<p class="hint">Le prime righe del file, per aiutarti a scegliere le colonne:</p>
    <div class="table-wrap"><table class="table imp-table"><thead><tr>${head.map((h, i) => `<th>${esc(h || `Colonna ${i + 1}`)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function previewHtml() {
  const res = imp.result;
  const list = res ? res.txns : [];
  if (!list.length) {
    if (res && res.duplicates) {
      const target = account(imp.acc);
      return `<div class="empty compact imp-none"><p><b>${esc(`${res.duplicates === 1 ? 'L\'operazione del file è già presente' : `Le ${num(res.duplicates, 0)} operazioni del file sono già presenti`}${target ? ` nel conto «${target.name}»` : ''}.`)}</b> Non c'è niente di nuovo da importare: per aggiungere le operazioni più recenti esporta dal broker un file aggiornato.</p></div>`;
    }
    const warn = res && res.warnings && res.warnings.length ? `<ul class="imp-list warn">${res.warnings.slice(0, 4).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    return `<div class="empty compact imp-none"><p><b>Nessuna operazione riconosciuta con queste impostazioni.</b>${imp.preset === 'generic' ? ' Controlla le colonne qui sopra.' : ' Controlla il tipo di file al passo 1.'}</p></div>${warn}${imp.preset === 'generic' ? rawPreview() : ''}`;
  }
  const items = new Map((res.assets || []).map((a) => [a.key, a]));
  const rows = list.slice(0, 10).map((t) => {
    const a = t.assetKey ? items.get(t.assetKey) : null;
    const ccy = a ? (isPence(a.currency) ? 'GBP' : normCcy(a.currency) || 'EUR') : 'EUR';
    const trade = t.type === 'buy' || t.type === 'sell';
    const price = trade ? (isPence(a && a.currency) ? t.price / 100 : t.price) : null;
    const amount = trade ? moneyLocal(t.qty * price, ccy) : money(t.amount || 0);
    const name = a ? prettyName(a.name) || a.isin : t.note || '';
    return `<tr><td>${esc(fmtDate(t.date))}</td><td>${esc(opLabel(t))}</td><td class="imp-name">${esc(name)}</td>
      <td class="num">${trade ? esc(num(t.qty, 6)) : ''}</td><td class="num">${trade ? esc(moneyLocal(price, ccy, { mask: false })) : ''}</td><td class="num">${amount}</td></tr>`;
  }).join('');
  return `<p class="hint">${list.length > 10 ? `Le prime 10 di ${esc(plural(list.length, 'operazione', 'operazioni'))} lette dal file.` : `${esc(plural(list.length, 'operazione letta', 'operazioni lette'))} dal file.`}</p>
    <div class="table-wrap"><table class="table imp-table"><thead><tr><th>Data</th><th>Operazione</th><th>Titolo</th><th class="num">Quantità</th><th class="num">Prezzo</th><th class="num">Importo</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function importStep2() {
  const n = imp.result ? imp.result.txns.length : 0;
  return `${imp.preset === 'generic' ? mappingTable() : ''}
    <h3 class="imp-h">Anteprima</h3>
    <div id="imp-preview" aria-live="polite">${previewHtml()}</div>
    <div class="sheet-actions more-sticky">
      <button class="btn" type="button" data-act="more-import-back">${icon('chevLeft')}Indietro</button>
      <button class="btn primary" id="imp-next" type="button" data-act="more-import-next"${n ? '' : ' disabled'}>Avanti${icon('chevRight')}</button>
    </div>`;
}

// Existing vs new securities of the current import (against the data that will remain)
function assetPlan() {
  const res = imp.result;
  if (!res) return [];
  const base = hasDemo() ? removeDemo(D()).assets : D().assets;
  const used = new Set(res.txns.map((t) => t.assetKey).filter(Boolean));
  return (res.assets || []).filter((a) => used.has(a.key)).map((item) => ({ item, existing: findExistingAsset(base, item) }));
}

function typeSummary(list) {
  const counts = {};
  for (const t of list) counts[t.type] = (counts[t.type] || 0) + 1;
  return Object.keys(TYPE_COUNT).filter((k) => counts[k]).map((k) => plural(counts[k], TYPE_COUNT[k][0], TYPE_COUNT[k][1])).join(', ');
}

function importStep3() {
  const res = imp.result || { txns: [], warnings: [], skipped: 0, skippedReasons: {}, duplicates: 0 };
  const n = res.txns.length;
  const plan = assetPlan();
  const fresh = plan.filter((p) => !p.existing);
  const target = imp.acc !== NEW_ACC ? account(imp.acc) : null;
  const stat = (v, label, tone = '') => `<div class="imp-stat${tone ? ' ' + tone : ''}"><b>${esc(num(v, 0))}</b><span>${esc(label)}</span></div>`;
  const reasons = Object.entries(res.skippedReasons || {}).map(([k, v]) => `<li>${esc(plural(v, 'riga', 'righe'))}: ${esc(k)}</li>`).join('');
  const deposits = res.txns.some((t) => t.type === 'deposit' || t.type === 'withdraw');
  const notes = [];
  notes.push(target ? `Importo nel conto «${esc(target.name)}».` : `Creo il conto «${esc(newAccName(imp.preset))}».`);
  if (hasDemo()) notes.push('I dati di esempio verranno rimossi: da qui in poi lavori con i tuoi dati.');
  if (fresh.length) {
    notes.push(market.status === 'online'
      ? 'Cerco i nuovi titoli su Yahoo Finance per collegare i prezzi automatici; quelli non trovati useranno i prezzi manuali.'
      : 'Server prezzi non raggiungibile: collego i titoli che conosco, gli altri useranno i prezzi delle operazioni (li colleghi più tardi dalla scheda del titolo).');
  }
  if (deposits && (!target || cashModeOf(target) === 'auto')) {
    notes.push('Il file contiene depositi e prelievi: per vedere la liquidità imposta il conto su «Traccio la liquidità» in Altro → Conti.');
  }
  const assetRows = plan.slice(0, 40).map(({ item, existing }) => `<div class="row imp-asset">
      ${accAvatar({ name: prettyName(item.name) || item.isin })}
      <span class="row-main"><span class="row-title">${esc(prettyName(item.name) || item.isin)}</span><span class="row-sub">${esc([item.isin, isPence(item.currency) ? 'GBP' : item.currency, TYPE_LABEL[item.type] || ''].filter(Boolean).join(' · '))}</span></span>
      <span class="row-end"><span class="tag${existing ? '' : ' imp-new'}">${existing ? 'già presente' : 'nuovo'}</span></span>
    </div>`).join('');
  return `<div class="imp-sum">
      ${stat(n, n === 1 ? 'operazione da importare' : 'operazioni da importare', 'accent')}
      ${stat(fresh.length, fresh.length === 1 ? 'nuovo titolo' : 'nuovi titoli')}
      ${stat(res.duplicates || 0, 'già presenti, saltate')}
      ${stat(res.skipped || 0, 'righe non importate')}
    </div>
    ${n ? `<p class="imp-types">${esc(typeSummary(res.txns))}.</p>` : ''}
    ${plan.length ? `<h3 class="imp-h">Titoli</h3><div class="list imp-assets">${assetRows}</div>` : ''}
    ${res.warnings && res.warnings.length ? `<h3 class="imp-h">Avvisi</h3><ul class="imp-list warn">${res.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${reasons ? `<details class="imp-details"><summary>Righe non importate</summary><ul class="imp-list">${reasons}</ul></details>` : ''}
    <ul class="imp-list notes">${notes.map((t) => `<li>${t}</li>`).join('')}</ul>
    <p class="imp-progress" id="imp-progress" aria-live="polite"${imp.busy ? '' : ' hidden'}>${imp.busy ? 'Importo…' : ''}</p>
    <div class="sheet-actions more-sticky">
      <button class="btn" type="button" data-act="more-import-back"${imp.busy ? ' disabled' : ''}>${icon('chevLeft')}Indietro</button>
      <button class="btn primary" id="imp-run" type="button" data-act="more-import-run"${n && !imp.busy ? '' : ' disabled'}>${icon('check')}${n ? `Importa ${esc(plural(n, 'operazione', 'operazioni'))}` : 'Niente da importare'}</button>
    </div>`;
}

SHEETS['more-import'] = () => {
  const step = imp.fileName && imp.rows.length ? imp.step : 1;
  const body = step === 3 ? importStep3() : step === 2 ? importStep2() : importStep1();
  return {
    title: 'Importa da broker',
    size: 'wide',
    body: `<div class="imp">${stepper(step)}${body}</div>`,
  };
};
FORM_SHEETS.add('more-import');

async function handleCsvFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    resetImport();
    imp.error = 'Il file è troppo grande (più di 15 MB): esporta un periodo più breve.';
  } else {
    let text = '';
    try {
      text = await readFileText(file);
    } catch {
      resetImport();
      imp.error = 'Non riesco a leggere il file: riprova o scegline un altro.';
    }
    if (text) loadImportText(file.name, text, file.size);
  }
  if (isTop('more-import')) app.renderSheet();
  else app.pushSheet('more-import');
}

INPUTS['more-import-csv'] = async (el, ev) => {
  if (ev && ev.type !== 'change') return;
  const file = el.files && el.files[0];
  try {
    await handleCsvFile(file);
  } finally {
    try {
      el.value = '';
    } catch { /* ignore */ }
  }
};

INPUTS['more-import-preset'] = (el, ev) => {
  if (ev && ev.type !== 'change') return;
  if (!PRESETS[el.value]) return;
  imp.preset = el.value;
  imp.mapping = guessMapping(imp.headers, imp.preset);
  if (!imp.accTouched) imp.acc = defaultAccFor(imp.preset);
  computeImport();
  rerenderImport();
};

INPUTS['more-import-acc'] = (el, ev) => {
  if (ev && ev.type !== 'change') return;
  imp.acc = el.value === NEW_ACC || account(el.value) ? el.value : NEW_ACC;
  imp.accTouched = true;
  computeImport();
  rerenderImport();
};

INPUTS['more-import-map'] = (el, ev) => {
  if (ev && ev.type !== 'change') return;
  const key = el.dataset.key;
  if (!imp.mapping || !MAP_FIELDS.some((f) => f[0] === key)) return;
  const v = Number(el.value);
  // A column feeds one field only: free it from the field that had it
  if (v >= 0) {
    for (const k of Object.keys(imp.mapping)) {
      if (k !== key && imp.mapping[k] === v && MAP_FIELDS.some((f) => f[0] === k)) {
        imp.mapping[k] = -1;
        const other = byId(`imp-map-${k}`);
        if (other) other.value = '-1';
      }
    }
  }
  imp.mapping[key] = Number.isInteger(v) ? v : -1;
  computeImport();
  const box = byId('imp-preview');
  if (box) box.innerHTML = previewHtml();
  const next = byId('imp-next');
  if (next) next.disabled = !(imp.result && imp.result.txns.length);
};

async function runImport() {
  if (imp.busy) return;
  computeImport();
  const res = imp.result;
  if (!res || !res.txns.length) return;
  imp.busy = true;
  rerenderImport();
  const progress = (text) => {
    const el = byId('imp-progress');
    if (el) {
      el.hidden = false;
      el.textContent = text;
    }
  };
  try {
    const used = new Set(res.txns.map((t) => t.assetKey).filter(Boolean));
    const items = (res.assets || []).filter((a) => used.has(a.key));
    const baseAssets = hasDemo() ? removeDemo(D()).assets : D().assets;
    const online = market.status === 'online';
    progress(items.length ? 'Cerco i titoli…' : 'Importo…');
    const resolved = await resolveImportAssets(items, {
      assets: baseAssets,
      online,
      search: (q) => market.search(q),
      lookup: (s) => market.lookup(s),
      onProgress: (done, total) => progress(`Cerco i titoli${online ? ' su Yahoo Finance' : ''}… ${done} di ${total}`),
    });
    // The data may have changed while searching: apply everything to the current data now
    if (hasDemo()) {
      S.data = migrate(removeDemo(D()));
      if (S.ui.scope !== 'all' && !account(S.ui.scope)) S.ui.scope = 'all';
    }
    const d = D();
    for (const [key, aid] of Object.entries(resolved.map)) {
      if (d.assets[aid] || resolved.created.some((a) => a.id === aid)) continue;
      const item = items.find((x) => x.key === key);
      const a = buildAsset(item || { key, name: key, currency: 'EUR', type: 'other' }, null, newId('a'));
      resolved.created.push(a);
      resolved.map[key] = a.id;
    }
    for (const a of resolved.created) d.assets[a.id] = a;
    let acc = imp.acc !== NEW_ACC ? account(imp.acc) : null;
    if (!acc) {
      const broker = presetBroker(imp.preset);
      const counts = txCounts(d);
      const pristine = d.accounts.length === 1 && !counts[d.accounts[0].id] && d.accounts[0].name === 'Principale' && d.accounts[0].broker === 'Altro';
      if (pristine && broker !== 'Altro') {
        acc = d.accounts[0];
        Object.assign(acc, { name: newAccName(imp.preset, []), broker });
      } else {
        acc = { id: newId('acc'), name: newAccName(imp.preset, d.accounts), broker, cashMode: 'auto' };
        d.accounts.push(acc);
      }
    }
    const { txns } = finalizeTxns(res.txns, { map: resolved.map, pence: resolved.pence, acc: acc.id, src: imp.src || newBatchId() });
    d.txns.push(...txns);
    const created = resolved.created.length;
    resetImport();
    app.closeSheets();
    S.ui.tab = 'home';
    commit(`Importate ${plural(txns.length, 'operazione', 'operazioni').replace(/^1 operazione$/, '1 operazione')}${created ? ` · ${plural(created, 'nuovo titolo', 'nuovi titoli')}` : ''}`);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
    app.refreshPrices();
  } catch (e) {
    imp.busy = false;
    console.error('[gruzzolo] import', e);
    rerenderImport();
    app.toast(`Importazione non riuscita: ${e && e.message ? e.message : 'errore'}`);
  }
}

/* ======================================================================
   Sheet: rates and tax settings
   ====================================================================== */
const RATE_FIELDS = [
  { key: 'riskFree', label: 'Tasso privo di rischio', info: 'riskFree', min: -2, max: 15, hint: 'Il rendimento di un investimento senza rischio (conto deposito, BOT). Serve per Sharpe e Sortino.' },
  { key: 'taxRate', label: 'Aliquota su plusvalenze e dividendi', info: 'tassePlusvalenze', min: 0, max: 60, hint: 'In Italia 26% su azioni, ETF e fondi. Serve per stimare il risparmio dello zaino fiscale.' },
  { key: 'govTaxRate', label: 'Aliquota sui titoli di Stato', info: '', min: 0, max: 60, hint: 'In Italia 12,5% su BTP, BOT e titoli di Stato dei paesi della «white list».' },
  { key: 'stampDuty', label: 'Imposta di bollo annua', info: 'bollo', min: 0, max: 2, hint: '0,20% all\'anno sul valore dei titoli al 31 dicembre dell\'anno precedente.' },
];

SHEETS['more-rates'] = (args = {}) => {
  const st = D().settings;
  const dr = args.draft || {};
  const fields = RATE_FIELDS.map((f) => {
    const val = dr[f.key] ?? pctInput(st[f.key] ?? DEFAULT_RATES[f.key]);
    return `<div class="field"><div class="more-label-row"><label for="mr-${f.key}">${esc(f.label)}</label>${f.info ? infoBtn(f.info) : ''}</div>
      <div class="unit-input"><input id="mr-${f.key}" name="${f.key}" inputmode="decimal" autocomplete="off" value="${esc(val)}" placeholder="${esc(pctInput(DEFAULT_RATES[f.key]))}"><span aria-hidden="true">%</span></div>
      <p class="hint">${esc(f.hint)}</p></div>`;
  }).join('');
  return {
    title: 'Tassi e aliquote',
    body: `<form class="form more-form" data-form="more-rates" novalidate>
      ${fields}
      <button class="btn ghost block" type="button" data-act="more-rates-reset">Ripristina i valori italiani standard</button>
      <p class="form-error" data-error role="alert" hidden></p>
      <div class="sheet-actions more-sticky"><button class="btn primary" type="submit">Salva</button></div>
    </form>`,
  };
};
FORM_SHEETS.add('more-rates');

FORMS['more-rates'] = (form) => {
  clearErrors(form);
  const showErr = formError(form);
  const next = {};
  for (const f of RATE_FIELDS) {
    const el = form.elements[f.key];
    const raw = el.value.trim();
    const n = raw === '' ? DEFAULT_RATES[f.key] * 100 : parseNum(raw);
    if (!Number.isFinite(n) || n < f.min || n > f.max) return showErr(`${f.label}: scrivi un valore tra ${num(f.min)} e ${num(f.max)} (in percentuale, es. ${pctInput(DEFAULT_RATES[f.key])}).`, el);
    next[f.key] = +(n / 100).toFixed(6);
  }
  blurActive();
  Object.assign(D().settings, next);
  app.popSheet();
  commit('Tassi e aliquote salvati');
};

ACTIONS['more-rates-reset'] = (el) => {
  const form = el.closest('form');
  if (!form) return;
  for (const f of RATE_FIELDS) if (form.elements[f.key]) form.elements[f.key].value = pctInput(DEFAULT_RATES[f.key]);
  app.toast('Valori standard inseriti: tocca «Salva» per confermare');
};

/* ======================================================================
   Sheet: external fiscal P&L (zaino fiscale)
   ====================================================================== */
function extYears(today) {
  const y = Number(today.slice(0, 4));
  const years = new Set(Array.from({ length: 6 }, (_, k) => String(y - k)));
  for (const k of Object.keys(D().settings.externalPL || {})) if (/^\d{4}$/.test(k)) years.add(k);
  return [...years].sort((a, b) => (a < b ? 1 : -1));
}

SHEETS['more-extpl'] = (args = {}) => {
  const today = todayISO();
  const ext = D().settings.externalPL || {};
  const dr = args.draft || {};
  let portfolio = {};
  try {
    const fb = fiscalBackpack({ accIds: null, today, settings: D().settings });
    for (const r of fb.rows || []) portfolio[String(r.year)] = r.portfolio;
  } catch (e) {
    console.warn('[gruzzolo] zaino fiscale', e);
    portfolio = {};
  }
  const rows = extYears(today).map((y) => {
    const v = Number(ext[y]);
    const has = Number.isFinite(v) && v !== 0;
    const sign = dr['s' + y] ?? (has && v > 0 ? '1' : '-1');
    const amount = dr['a' + y] ?? (has ? numInput(Math.abs(v)) : '');
    const p = portfolio[y];
    const current = y === today.slice(0, 4);
    return `<div class="ext-row">
      <div class="ext-year"><b>${esc(y)}</b><span class="hint">${current ? 'anno in corso' : Number.isFinite(p) && p !== 0 ? `in Gruzzolo: ${p < 0 ? '−' : '+'}${money(Math.abs(p))}` : 'in Gruzzolo: nessuna vendita'}</span></div>
      <select name="s${esc(y)}" aria-label="Perdita o guadagno nel ${esc(y)}">${opt('-1', 'Perdita', sign !== '1')}${opt('1', 'Guadagno', sign === '1')}</select>
      <div class="unit-input"><input name="a${esc(y)}" inputmode="decimal" autocomplete="off" value="${esc(amount)}" placeholder="0,00" aria-label="Importo ${esc(y)} in euro"><span aria-hidden="true">€</span></div>
    </div>`;
  }).join('');
  return {
    title: 'Plus/minusvalenze esterne',
    body: `<form class="form more-form" data-form="more-extpl" novalidate>
      <p class="hint more-lead">Plusvalenze (guadagni) o minusvalenze (perdite) da vendite fatte <b>fuori da Gruzzolo</b>: presso un altro broker o in anni che non hai registrato qui. Si sommano a quelle del portafoglio nello «zaino fiscale» del Report. ${infoBtn('zainoFiscale')}</p>
      <div class="ext-list">${rows}</div>
      <p class="hint">Le perdite si possono usare fino al quarto anno successivo, poi scadono. Lascia vuoto un anno senza movimenti.</p>
      <p class="form-error" data-error role="alert" hidden></p>
      <div class="sheet-actions more-sticky"><button class="btn primary" type="submit">Salva</button></div>
    </form>`,
  };
};
FORM_SHEETS.add('more-extpl');

FORMS['more-extpl'] = (form) => {
  clearErrors(form);
  const showErr = formError(form);
  const rows = [];
  for (const el of form.querySelectorAll('input[name^="a"]')) {
    const year = el.name.slice(1);
    const raw = el.value.trim();
    if (!raw) continue;
    const n = parseNum(raw);
    if (!Number.isFinite(n) || Math.abs(n) > 1e9) return showErr(`Importo del ${year} non valido: scrivi un numero, per esempio 150,00.`, el);
    const sel = form.elements['s' + year];
    rows.push({ year, sign: sel && sel.value === '1' ? 1 : -1, amount: n });
  }
  blurActive();
  D().settings.externalPL = externalFromRows(rows);
  app.popSheet();
  commit('Plus/minusvalenze esterne salvate');
};

/* ======================================================================
   Sheet: TER of ETFs and funds
   ====================================================================== */
SHEETS['more-ter'] = (args = {}) => {
  const dr = args.draft || {};
  const funds = etfFundAssets();
  if (!funds.length) {
    return { title: 'TER di ETF e fondi', body: '<div class="empty"><p>Nel portafoglio non ci sono ETF o fondi. Quando ne registri uno, qui puoi indicarne il costo annuo (TER).</p></div>' };
  }
  let fromCatalog = 0;
  const rows = funds.map((a) => {
    const cat = findInCatalog(a.symbol) || (a.isin ? findInCatalog(a.isin) : null);
    const catTer = cat && cat.ter > 0 ? cat.ter : null;
    if (catTer !== null && !(a.ter >= 0)) fromCatalog++;
    const name = `t:${a.id}`;
    const val = dr[name] ?? (Number.isFinite(a.ter) ? pctInput(a.ter) : '');
    return `<div class="row ter-row">
      ${avatar(a, 'sm')}
      <span class="row-main"><label class="row-title" for="ter-${esc(a.id)}">${esc(a.name)}</label><span class="row-sub">${esc([assetCode(a), TYPE_LABEL[a.type], catTer !== null ? `catalogo: ${pct(catTer)}` : ''].filter(Boolean).join(' · '))}</span></span>
      <span class="unit-input ter-input"><input id="ter-${esc(a.id)}" name="${esc(name)}" data-aid="${esc(a.id)}"${catTer !== null ? ` data-cat="${esc(pctInput(catTer))}"` : ''} inputmode="decimal" autocomplete="off" value="${esc(val)}" placeholder="${catTer !== null ? esc(pctInput(catTer)) : '0,20'}" aria-label="TER di ${esc(a.name)} in percentuale"><span aria-hidden="true">%</span></span>
    </div>`;
  }).join('');
  return {
    title: 'TER di ETF e fondi',
    body: `<form class="form more-form" data-form="more-ter" novalidate>
      <p class="hint more-lead">Il TER è il costo annuo di gestione di un ETF o di un fondo, già incluso nel prezzo. Lo trovi nella scheda del fondo (KID) o su justETF. ${infoBtn('ter')}</p>
      ${fromCatalog ? `<button class="btn sm" type="button" data-act="more-ter-fill">${icon('check')}Compila dal catalogo (${num(fromCatalog, 0)})</button>` : ''}
      <div class="list">${rows}</div>
      <p class="hint">Scrivi la percentuale, per esempio 0,22. Lascia vuoto se non lo conosci.</p>
      <p class="form-error" data-error role="alert" hidden></p>
      <div class="sheet-actions more-sticky"><button class="btn primary" type="submit">Salva</button></div>
    </form>`,
  };
};
FORM_SHEETS.add('more-ter');

ACTIONS['more-ter-fill'] = (el) => {
  const form = el.closest('form');
  if (!form) return;
  let n = 0;
  for (const input of form.querySelectorAll('input[data-cat]')) {
    if (input.value.trim()) continue;
    input.value = input.dataset.cat;
    n++;
  }
  app.toast(n ? `${plural(n, 'TER inserito', 'TER inseriti')} dal catalogo: tocca «Salva»` : 'I TER del catalogo sono già inseriti');
};

FORMS['more-ter'] = (form) => {
  clearErrors(form);
  const showErr = formError(form);
  const updates = [];
  for (const input of form.querySelectorAll('input[data-aid]')) {
    const a = D().assets[input.dataset.aid];
    if (!a) continue;
    const raw = input.value.trim();
    if (!raw) {
      updates.push([a, null]);
      continue;
    }
    const n = parseNum(raw);
    if (!Number.isFinite(n) || n < 0 || n > 5) return showErr(`TER di ${a.name}: scrivi una percentuale tra 0 e 5, per esempio 0,22.`, input);
    updates.push([a, +(n / 100).toFixed(6)]);
  }
  blurActive();
  for (const [a, ter] of updates) a.ter = ter;
  app.popSheet();
  commit('TER salvati');
};

/* ======================================================================
   Sheet: price server address
   ====================================================================== */
function serverStatusHtml(text = null) {
  const today = todayISO();
  const line = text ? { cls: 'busy', text } : serverLine(today);
  return `<span class="dot ${line.cls}"></span><span><b>${esc(line.text)}</b><small>Riceve solo nomi e ticker dei titoli, mai i tuoi dati</small></span>`;
}

SHEETS['more-server'] = (args = {}) => {
  const dr = args.draft || {};
  const base = dr.apiBase ?? String(D().settings.apiBase || '');
  return {
    title: 'Server prezzi',
    body: `<form class="form more-form" data-form="more-server" novalidate>
      <p class="hint more-lead">Gruzzolo scarica prezzi, cambi e dividendi da Yahoo Finance attraverso il suo piccolo server. Sono dati pubblici: al server arrivano solo i nomi e i ticker dei titoli, mai i tuoi conti o le tue operazioni, che restano sul telefono.</p>
      <p class="hint more-lead">Di solito il server è sullo stesso sito dell'app: lascia vuoto il campo. Scrivi un indirizzo solo se l'hai pubblicato altrove.</p>
      <div class="field"><label for="msv-base">Indirizzo del server</label>
        <input id="msv-base" name="apiBase" type="url" inputmode="url" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(base)}" placeholder="Vuoto = lo stesso sito dell'app">
        <p class="hint">Per esempio https://gruzzolo.tuonome.workers.dev</p></div>
      <div class="more-server-status" id="msv-status" aria-live="polite">${serverStatusHtml()}</div>
      <p class="form-error" data-error role="alert" hidden></p>
      <button class="btn primary block" type="submit" id="msv-submit">${icon('refresh')}Verifica connessione</button>
    </form>`,
  };
};
FORM_SHEETS.add('more-server');

export function normalizeApiBase(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return { ok: true, value: '' };
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(s)) return { ok: false, error: 'Scrivi un indirizzo completo che inizia con https://' };
  return { ok: true, value: s.replace(/\/api$/i, '') };
}

let serverBusy = false;
FORMS['more-server'] = async (form) => {
  if (serverBusy) return;
  clearErrors(form);
  const showErr = formError(form);
  const norm = normalizeApiBase(form.elements.apiBase.value);
  if (!norm.ok) return showErr(norm.error, form.elements.apiBase);
  const value = norm.value;
  if (value.startsWith('http://') && typeof location !== 'undefined' && location.protocol === 'https:') {
    return showErr('Questa app usa https: anche il server deve iniziare con https://', form.elements.apiBase);
  }
  const old = String(D().settings.apiBase || '');
  const box = byId('msv-status');
  const btn = byId('msv-submit');
  serverBusy = true;
  if (btn) btn.disabled = true;
  if (box) box.innerHTML = serverStatusHtml('Verifico la connessione…');
  blurActive();
  try {
    const status = await market.init({ apiBase: value });
    if (status !== 'online' && value) {
      await market.init({ apiBase: old });
      if (box) box.innerHTML = serverStatusHtml();
      showErr('Server non raggiungibile a questo indirizzo: ho tenuto quello precedente. Controlla l\'indirizzo e la connessione.', form.elements.apiBase);
      return;
    }
    if (box) box.innerHTML = serverStatusHtml();
    form.elements.apiBase.value = value;
    if (value !== old) {
      D().settings.apiBase = value;
      commit(status === 'online' ? 'Server prezzi collegato' : 'Indirizzo salvato: server non raggiungibile ora');
    } else {
      app.render();
      app.toast(status === 'online' ? 'Server prezzi collegato' : 'Server non raggiungibile: uso i prezzi salvati');
    }
    if (status === 'online') app.refreshPrices();
  } finally {
    serverBusy = false;
    if (btn) btn.disabled = false;
  }
};

/* ======================================================================
   Sheet: guide
   ====================================================================== */
const GUIDE = {
  iphone: {
    title: 'Installa su iPhone',
    body: () => `${isStandalone() ? `<div class="banner info more-banner">${icon('check')}<p><b>Fatto!</b> Stai già usando Gruzzolo dall'icona sulla schermata Home.</p></div>` : ''}
    ${stepsHtml([
      'Apri l\'indirizzo di Gruzzolo in <b>Safari</b>, con internet attivo.',
      'Tocca <b>Condividi</b>: il quadrato con la freccia verso l\'alto (se non lo vedi, tocca prima <b>…</b> in basso).',
      'Scorri e scegli <b>Aggiungi alla schermata Home</b>. Se compare «Apri come app web», lascialo attivo. Tocca <b>Aggiungi</b>.',
      'Apri Gruzzolo <b>sempre dall\'icona</b>: si apre a tutto schermo, come un\'app, e i dati restano lì.',
      'Alla prima apertura resta online qualche secondo: Gruzzolo si salva sul telefono e poi funziona anche senza internet. Scegli «Inizia da zero» per partire con i tuoi dati.',
    ])}
    <div class="banner info more-banner">${icon('info')}<p>L'app sulla schermata Home e Safari hanno memorie separate: quello che inserisci in Safari non compare nell'app. Se avevi già dei dati in Safari, esporta un backup da lì e importalo nell'app.</p></div>
    <div class="banner warn more-banner">${icon('alert')}<p><b>Prima di eliminare l'icona</b> esporta un backup: eliminando l'app iOS cancella anche i suoi dati.</p></div>`,
  },
  offline: {
    title: 'Senza internet',
    body: () => `<p>Gruzzolo è salvato sul telefono: si apre e funziona anche in aereo o senza campo.</p>
      <ul class="more-bullets">
        <li>Portafoglio, report e operazioni sono sempre disponibili. Puoi aggiungere, modificare ed eliminare operazioni: tutto resta salvato sul telefono.</li>
        <li>I prezzi sono gli ultimi scaricati. Quando torni online si aggiornano da soli, oppure tocca <b>Aggiorna prezzi ora</b> in Altro.</li>
        <li>Senza internet non puoi cercare titoli nuovi su Yahoo Finance; il catalogo dei titoli più diffusi funziona comunque.</li>
        <li>Quando esce una nuova versione di Gruzzolo, aprila con internet attivo: si aggiorna da sola (a volte serve chiuderla e riaprirla una seconda volta).</li>
      </ul>`,
  },
  prices: {
    title: 'Da dove arrivano i prezzi',
    body: () => `<p>I prezzi di azioni, ETF, crypto e cambi valuta arrivano da <b>Yahoo Finance</b>, attraverso il piccolo server di Gruzzolo che sta sullo stesso sito dell'app.</p>
      <ul class="more-bullets">
        <li>Al server arrivano solo il nome, il ticker o l'ISIN del titolo (es. VWCE.DE): mai importi, quantità, conti o operazioni.</li>
        <li>Sono in ritardo di circa <b>15 minuti</b> e servono solo a scopo informativo: per i tuoi ordini fa fede il broker.</li>
        <li>I prezzi scaricati restano salvati sul telefono: senza connessione l'app funziona con gli ultimi disponibili.</li>
        <li>I titoli senza quotazione su Yahoo (alcune obbligazioni, fondi non quotati, polizze) usano i <b>prezzi manuali</b> che inserisci tu, oppure il prezzo dell'ultima operazione.</li>
        <li>I valori in valuta estera sono convertiti in euro con il cambio del giorno.</li>
      </ul>
      <button class="btn block" type="button" data-act="prices">${icon('edit')}Inserisci prezzi manuali</button>`,
  },
};

SHEETS['more-guide'] = (args = {}) => {
  const g = GUIDE[args.topic] || GUIDE.prices;
  return { title: g.title, body: `<div class="more-sheet">${g.body()}</div>` };
};

/* ======================================================================
   Backup, CSV export, wipe
   ====================================================================== */
let fileMode = 'auto';

function openBackupPicker() {
  const input = byId('import-file');
  if (!input) {
    app.toast('Selezione file non disponibile in questa pagina');
    return;
  }
  fileMode = 'backup';
  input.value = '';
  input.click();
}

function askImportBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    app.toast('Il file non è un backup valido di Gruzzolo (non si riesce a leggere).');
    return;
  }
  const chk = checkBackup(raw);
  if (!chk.ok) {
    app.toast(chk.error);
    return;
  }
  const when = chk.updatedAt ? ` (salvato il ${fmtDate(iso(new Date(chk.updatedAt)))})` : '';
  const lines = [
    `Il backup${when} contiene ${plural(chk.txns, 'operazione', 'operazioni')} in ${plural(chk.accounts, 'conto', 'conti')}${chk.version === 1 ? ' ed è della prima versione di Gruzzolo: lo converto' : ''}.`,
    `Sostituirà tutti i dati su ${hereText()}: se vuoi tenere quelli attuali, esporta prima un backup.`,
  ];
  app.askConfirm({
    title: 'Importare il backup?',
    text: lines.join('\n'),
    ok: 'Sostituisci i dati',
    onOk: () => {
      const d = chk.data;
      d.settings.started = true;
      S.data = d;
      if (hasDemo()) installDemoMarket({ today: todayISO() });
      S.ui.scope = 'all';
      storage.at = 0;
      app.closeSheets();
      commit('Backup importato');
      app.refreshPrices();
    },
  });
}

INPUTS['more-import-file'] = async (el, ev) => {
  if (ev && ev.type !== 'change') return;
  const file = el.files && el.files[0];
  const mode = fileMode;
  fileMode = 'auto';
  if (!file) return;
  try {
    if (file.size > MAX_FILE_BYTES) {
      app.toast('Il file è troppo grande (più di 15 MB).');
      return;
    }
    const text = await readFileText(file);
    const looksJson = /\.json$/i.test(file.name) || /^\s*[{[]/.test(text);
    if (looksJson) askImportBackup(text);
    else if (mode === 'backup') app.toast('Per il backup scegli un file .json esportato da Gruzzolo. I file CSV dei broker si importano da «Importa un file CSV».');
    else {
      loadImportText(file.name, text, file.size);
      if (isTop('more-import')) app.renderSheet();
      else app.pushSheet('more-import');
    }
  } catch (e) {
    console.error('[gruzzolo] file', e);
    app.toast('Non riesco a leggere il file: riprova o scegline un altro.');
  } finally {
    try {
      el.value = '';
    } catch { /* ignore */ }
  }
};

/* ======================================================================
   Demo data
   ====================================================================== */
function loadDemo() {
  const today = todayISO();
  const prev = D().settings || {};
  const d = migrate(demoData({ today }));
  d.settings.apiBase = prev.apiBase || '';
  d.settings.theme = prev.theme || 'auto';
  S.data = d;
  installDemoMarket({ today });
  S.ui.scope = 'all';
  app.closeSheets();
  bump();
  app.render();
  app.toast('Esempio caricato: non viene salvato finché non lo modifichi');
}

/* ======================================================================
   Actions
   ====================================================================== */
Object.assign(ACTIONS, {
  'demo-remove': () => {
    if (!hasDemo()) return;
    S.data = migrate(removeDemo(D()));
    S.ui.scope = 'all';
    if (S.sheets.length) app.closeSheets();
    commit('Dati di esempio rimossi');
  },
  'demo-load': () => {
    if (D().txns.some((t) => !t.demo)) {
      app.toast('Hai già delle operazioni: l\'esempio si carica solo con un portafoglio vuoto.');
      return;
    }
    if (hasUserContent(D())) {
      app.askConfirm({
        title: 'Caricare l\'esempio?',
        text: 'I titoli e la watchlist che hai inserito verranno sostituiti dall\'esempio finché non ricarichi la pagina. Se modifichi l\'esempio, verrà salvato al loro posto.',
        ok: 'Carica l\'esempio',
        danger: false,
        onOk: loadDemo,
      });
      return;
    }
    loadDemo();
  },
  'more-account': (el) => app.pushSheet('more-account', { id: el.dataset.id || '' }),
  'more-account-delete': (el) => {
    const a = account(el.dataset.id);
    if (!a) return;
    if (D().accounts.length < 2) {
      app.toast('Serve almeno un conto: crea prima un altro conto.');
      return;
    }
    const n = txCounts()[a.id] || 0;
    app.askConfirm({
      title: `Eliminare «${a.name}»?`,
      text: n
        ? `Verranno eliminate anche ${n === 1 ? 'la sua operazione' : `le sue ${num(n, 0)} operazioni`}. Non si può annullare: se vuoi, esporta prima un backup (Altro → Backup e dati).`
        : 'Il conto non ha operazioni.',
      ok: 'Elimina il conto',
      onOk: () => {
        const removed = dropAccount(D(), a.id);
        if (removed < 0) return;
        if (S.ui.scope === a.id) S.ui.scope = 'all';
        app.closeSheets();
        commit(`Conto «${a.name}» eliminato`);
      },
    });
  },
  'more-import': () => {
    if (!imp.busy) resetImport();
    app.pushSheet('more-import');
  },
  'more-import-next': () => {
    if (imp.busy) return;
    if (imp.step === 1) {
      computeImport();
      imp.step = 2;
    } else if (imp.step === 2) {
      computeImport();
      if (!imp.result || !imp.result.txns.length) return;
      imp.step = 3;
    }
    rerenderImport();
    const body = byId('sheet-body');
    if (body) body.scrollTop = 0;
  },
  'more-import-back': () => {
    if (imp.busy) return;
    imp.step = Math.max(1, imp.step - 1);
    rerenderImport();
  },
  'more-import-run': () => runImport(),
  'more-import-undo': (el) => {
    const src = el.dataset.src;
    const b = importBatches().find((x) => x.src === src);
    if (!b) return;
    const accName = (account(b.acc) || {}).name || 'conto';
    app.askConfirm({
      title: 'Annullare l\'importazione?',
      text: `Elimino le ${plural(b.count, 'operazione', 'operazioni')} importate nel conto «${accName}» con questo file. Le operazioni inserite a mano restano.`,
      ok: 'Elimina le operazioni',
      onOk: () => {
        D().txns = D().txns.filter((t) => t.src !== src);
        commit(`Importazione annullata: ${plural(b.count, 'operazione eliminata', 'operazioni eliminate')}`);
      },
    });
  },
  'more-rates': () => app.pushSheet('more-rates'),
  'more-extpl': () => app.pushSheet('more-extpl'),
  'more-ter': () => app.pushSheet('more-ter'),
  'more-server': () => app.pushSheet('more-server'),
  'more-refresh': () => app.refreshPrices({ force: true, manual: true }),
  'more-clear-cache': () => app.askConfirm({
    title: 'Svuotare la cache dei prezzi?',
    text: `Cancello i prezzi scaricati da Yahoo Finance su ${hereText()} e li riscarico. Operazioni e prezzi manuali non vengono toccati.`,
    ok: 'Svuota la cache',
    danger: false,
    onOk: async () => {
      await market.clearCache();
      storage.at = 0;
      app.render();
      app.toast(market.status === 'offline' ? 'Cache svuotata: riscarico i prezzi quando torni online' : 'Cache svuotata: riscarico i prezzi');
      app.refreshPrices({ force: true });
    },
  }),
  'more-guide': (el) => app.pushSheet('more-guide', { topic: el.dataset.topic || 'prices' }),
  // On iPhone saveFile opens the share sheet: «Salva su File» → «Sul mio iPhone»
  'more-backup-export': async () => {
    const ok = await saveFile(`gruzzolo-backup-${todayISO()}.json`, JSON.stringify(D(), null, 1), 'application/json');
    if (!ok) return;
    markBackup();
    app.render();
    const dev = deviceName();
    app.toast(dev ? `Backup esportato: tienilo in File → Sul mio ${dev}` : 'Backup esportato: conservalo in un posto sicuro');
  },
  'more-storage-persist': async () => {
    let granted = false;
    try {
      if (typeof util.requestPersistentStorage === 'function') granted = (await util.requestPersistentStorage()) === true;
      else if (canAskPersist()) granted = Boolean(await navigator.storage.persist());
    } catch {
      granted = false;
    }
    await refreshStorage({ force: true });
    if (granted || storage.persisted === true) app.toast('Fatto: la memoria di Gruzzolo ora è permanente');
    else if (onIos() && !isStandalone()) app.toast('Non concessa: apri Gruzzolo dall\'icona sulla schermata Home e riprova');
    else app.toast('Non concessa per ora: i dati restano salvati, esporta un backup ogni tanto');
  },
  'more-backup-import': () => openBackupPicker(),
  'more-csv-export': async () => {
    if (!D().txns.length) {
      app.toast('Non ci sono operazioni da esportare');
      return;
    }
    const ok = await saveFile(`gruzzolo-transazioni-${todayISO()}.csv`, transactionsCsv(D()), 'text/csv;charset=utf-8');
    if (ok) app.toast(`Esportate ${plural(D().txns.length, 'operazione', 'operazioni')}`);
  },
  'more-wipe': () => app.askConfirm({
    title: 'Cancellare tutti i dati?',
    text: `Conti, operazioni, titoli, prezzi manuali, watchlist e plus/minusvalenze esterne verranno eliminati da ${hereText()}; aliquote, benchmark e tema restano. Non si può annullare: se vuoi conservarli, esporta prima un backup.`,
    ok: 'Cancella tutto',
    onOk: () => {
      S.data = wipedData(D());
      S.ui.scope = 'all';
      storage.at = 0;
      resetImport();
      app.closeSheets();
      commit('Dati cancellati');
    },
  }),
});

export const _test = {
  imp, loadImportText, computeImport, resetImport, defaultAccFor, newAccName, importStep3, previewHtml, catalogListing, buildAsset, NEW_ACC,
  storage, storageRow, markBackup, lastBackupAt, GUIDE,
  resetStorage: () => Object.assign(storage, { known: false, persisted: null, usage: null, quota: null, at: 0, pending: null }),
};
