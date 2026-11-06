// Shared pieces of the Mercati pages: preferences, periods, number formats, flags, status lines.
import { S } from '../state.js';
import { eco } from '../eco.js';
import { esc, icon, fmtTime, fmtDate, iso } from '../util.js';

/* ---------- Preferences of the Mercati tab (saved with the other UI choices) ---------- */
export const DEFAULTS = {
  page: 'overview',
  period: '1D',
  hmIndex: 'SPX',
  hmPeriod: '1D',
  hmSize: 'cap',
  hmGroup: true,
  hmSector: null,
  ycCountries: ['IT', 'DE', 'US'],
  ycCompare: 'none',
  mcInd: 'IRYY',
  mcRegion: 'g20',
  mcSel: null,
};

export function prefs() {
  let p = S.ui.eco;
  if (!p || typeof p !== 'object' || Array.isArray(p)) p = S.ui.eco = {};
  for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in p)) p[k] = Array.isArray(v) ? [...v] : v;
  return p;
}

/* ---------- Periods ---------- */
// key → [short label, long label, field of the answers]
export const PERIODS = {
  '1D': ['1G', 'oggi', 'chg'],
  '1W': ['1S', 'in una settimana', 'w'],
  '1M': ['1M', 'in un mese', 'm1'],
  '3M': ['3M', 'in tre mesi', 'm3'],
  '6M': ['6M', 'in sei mesi', 'm6'],
  YTD: ['YTD', 'da inizio anno', 'ytd'],
  '1Y': ['1A', 'in un anno', 'y'],
};
export const periodLabel = (p) => (PERIODS[p] || PERIODS['1D'])[0];
export const periodLong = (p) => (PERIODS[p] || PERIODS['1D'])[1];
export const periodField = (p) => (PERIODS[p] || PERIODS['1D'])[2];

// Segmented control of periods; act receives data-period
export function periodSeg(list, current, act, label = 'Periodo') {
  return `<div class="seg eco-periods" role="group" aria-label="${esc(label)}">${list.map((p) => `<button type="button" data-act="${esc(act)}" data-period="${p}" aria-pressed="${p === current}" title="Variazione ${esc(periodLong(p))}">${esc(periodLabel(p))}</button>`).join('')}</div>`;
}

/* ---------- Numbers (it-IT) ---------- */
const nfCache = new Map();
function nf(min, max) {
  const k = `${min}:${max}`;
  // 'always': 7.413,18 like 50.052,95 (Italian rules group only from 5 digits); old engines read it as true
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('it-IT', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' }));
  return nfCache.get(k);
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Fixed decimals; when dp is not given: 2 decimals, more for small values
export function fmtNum(v, dp) {
  if (!finite(v)) return '—';
  const a = Math.abs(v);
  const d = dp ?? (a >= 1 || a === 0 ? 2 : a >= 0.01 ? 4 : 6);
  return nf(d, d).format(v);
}
// Percent value already in percent units: 4.3564 → '4,36%'
export const fmtPct = (v, dp = 2) => (finite(v) ? `${nf(dp, dp).format(v)}%` : '—');
export const fmtPctSigned = (v, dp = 2) => {
  if (!finite(v)) return '—';
  const r = Math.round(v * 10 ** dp) / 10 ** dp;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${nf(dp, dp).format(Math.abs(r))}%`;
};
// Basis points from a change in percentage points: 0.0876 → '+8,8 pb'
export function fmtBp(pp, dp = 1) {
  if (!finite(pp)) return '—';
  const bp = Math.round(pp * 100 * 10 ** dp) / 10 ** dp;
  return `${bp > 0 ? '+' : bp < 0 ? '−' : ''}${nf(0, dp).format(Math.abs(bp))} pb`;
}
// Large amounts in short Italian words: 2,55 bilioni → '2.552 mld'
export function fmtBig(v, unit = '') {
  if (!finite(v)) return '—';
  const a = Math.abs(v);
  const tail = unit ? ` ${unit}` : '';
  if (a >= 1e12) return `${nf(0, a >= 1e13 ? 1 : 2).format(v / 1e12)} mila mld${tail}`;
  if (a >= 1e9) return `${nf(0, a >= 1e11 ? 0 : 1).format(v / 1e9)} mld${tail}`;
  if (a >= 1e6) return `${nf(0, a >= 1e8 ? 0 : 1).format(v / 1e6)} mln${tail}`;
  return `${nf(0, 0).format(v)}${tail}`;
}

// Tone of a percent value (percent units)
export const toneOf = (v, eps = 0.005) => (!finite(v) ? 'flat' : v > eps ? 'up' : v < -eps ? 'down' : 'flat');

// Pill with the change in percent units: ▲ 0,53%
export function chgPill(v, dp = 2) {
  if (!finite(v)) return '<span class="pill flat">—</span>';
  const t = toneOf(v, 0.5 * 10 ** -dp);
  const tri = t === 'up' ? '▲' : t === 'down' ? '▼' : '';
  return `<span class="pill ${t}">${tri ? `<span class="tri" aria-hidden="true">${tri}</span>` : ''}${fmtPct(Math.abs(v), dp)}</span>`;
}
// Pill with a change in basis points (bond yields)
export function bpPill(pp) {
  if (!finite(pp)) return '<span class="pill flat">—</span>';
  const bp = pp * 100;
  const t = bp > 0.05 ? 'up' : bp < -0.05 ? 'down' : 'flat';
  return `<span class="pill ${t} bp">${fmtBp(pp)}</span>`;
}

/* ---------- Flags ---------- */
// ISO 3166 alpha-2 → emoji flag (iPhone draws them in color); 'EU' gives the European flag
export function flag(cc) {
  const c = String(cc || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}
export const flagSpan = (cc, cls = '') => `<span class="flag${cls ? ' ' + cls : ''}" aria-hidden="true">${flag(cc)}</span>`;

/* ---------- Data status ---------- */
// Seconds (TradingView 'time') → local date
export const dateOfSec = (sec) => (finite(sec) && sec > 0 ? iso(new Date(sec * 1000)) : null);

// "Dati TradingView · 14:32" line under a page, with the state of the download
export function stampLine(key, { note = '' } = {}) {
  const e = eco.entry(key);
  const fail = eco.failure(key);
  const loading = eco.isLoading(key);
  const parts = [];
  let cls = '';
  if (loading) parts.push('<span class="dot busy"></span><span>Aggiorno…</span>');
  else if (fail && e) {
    cls = ' warn';
    parts.push(`${icon('cloud')}<span>${fail.offline ? 'Offline' : 'Aggiornamento non riuscito'}: dati del ${esc(fmtDate(iso(new Date(e.fetchedAt)), false))} alle ${esc(fmtTime(e.fetchedAt))}</span>`);
  } else if (e) {
    const at = (e.data && e.data.at) || e.fetchedAt;
    const today = iso(new Date()) === iso(new Date(at));
    parts.push(`<span>Dati TradingView · ${today ? '' : esc(fmtDate(iso(new Date(at)), false)) + ' '}${esc(fmtTime(at))}</span>`);
  }
  if (note) parts.push(`<span class="eco-stamp-note">${note}</span>`);
  return parts.length ? `<p class="eco-stamp${cls}" aria-live="polite">${parts.join('')}</p>` : '';
}

// Placeholder while the first download runs, or the reason it failed
export function emptyState(key, { what = 'i dati', retry = 'eco-retry' } = {}) {
  const fail = eco.failure(key);
  if (eco.isLoading(key) || !fail) {
    return `<div class="eco-loading" aria-busy="true"><p class="boot-text">Carico ${esc(what)}…</p>
      <div class="skeleton skel-block"></div><div class="skeleton skel-line"></div><div class="skeleton skel-line" style="width: 70%"></div></div>`;
  }
  return `<div class="empty compact eco-empty" role="alert">
    <div class="empty-ill">${icon('cloud')}</div>
    <h3>${fail.offline ? 'Sei offline' : 'Dati non disponibili'}</h3>
    <p>${fail.offline ? `Collegati a internet per scaricare ${esc(what)}: poi li trovi anche senza connessione.` : esc(fail.message)}</p>
    <div class="btns"><button class="btn sm" type="button" data-act="${esc(retry)}">${icon('refresh')}Riprova</button></div>
  </div>`;
}

export const finiteNum = finite;
