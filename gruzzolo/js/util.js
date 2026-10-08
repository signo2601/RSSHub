// Shared helpers: dates, number formatting, parsing, HTML escaping, icons.

/* ---------- Dates ('YYYY-MM-DD' strings, local calendar) ---------- */
export function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}
export const todayISO = () => iso(new Date());
export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
export function addMonths(s, n) {
  const d = parseISO(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return iso(d);
}
export const dayDiff = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 864e5);
export function isWeekend(s) {
  const wd = parseISO(s).getDay();
  return wd === 0 || wd === 6;
}
export const monthKey = (s) => s.slice(0, 7);
// Epoch seconds (exchange time) to local date string
export const epochToISO = (sec) => iso(new Date(sec * 1000));

export const MONTHS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export const MONTHS_LONG = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
export function fmtDate(s, withYear = true) {
  if (!s) return '—';
  const d = parseISO(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ' ' + d.getFullYear() : ''}`;
}
export function fmtMonth(ym, long = false) {
  const [y, m] = ym.split('-').map(Number);
  return long ? `${MONTHS_LONG[m - 1]} ${y}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- Numbers ---------- */
// Privacy mode: main.js sets fmt.hide from S.ui.hide before each render
export const fmt = { hide: false };
const MASK = '•••••';
const nfCache = new Map();
function nf(opts) {
  const k = JSON.stringify(opts);
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('it-IT', opts));
  return nfCache.get(k);
}
const EUR = nf({ style: 'currency', currency: 'EUR' });
export const money = (v) => (fmt.hide ? MASK + ' €' : EUR.format(Number.isFinite(v) ? v : 0));
export function moneySigned(v) {
  if (fmt.hide) return MASK + ' €';
  const sign = v > 0.004 ? '+' : v < -0.004 ? '−' : '';
  return sign + EUR.format(Math.abs(v || 0));
}
// Amount in any ISO currency (falls back to a plain number + code)
export function moneyLocal(v, ccy = 'EUR', { mask = true } = {}) {
  if (mask && fmt.hide) return MASK;
  try {
    const digits = Math.abs(v) !== 0 && Math.abs(v) < 1 ? 4 : 2;
    return nf({ style: 'currency', currency: ccy || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(v);
  } catch {
    return `${num(v, 2)} ${ccy}`;
  }
}
// Prices are public information: never masked
export const priceFmt = (v, ccy = 'EUR') => (Number.isFinite(v) ? moneyLocal(v, ccy, { mask: false }) : '—');
export function pct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return (v * 100).toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%';
}
export function pctSigned(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0.00005 ? '+' : v < -0.00005 ? '−' : '';
  return sign + Math.abs(v * 100).toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%';
}
export const pctPlain = (v) => pct(v, 1);
export function num(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}
export function compact(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const f = (x, d) => x.toLocaleString('it-IT', { maximumFractionDigits: d });
  if (a >= 1e6) return f(v / 1e6, 1) + ' Mln';
  if (a >= 1e4) return f(v / 1e3, 0) + 'k';
  if (a >= 1e3) return f(v / 1e3, 1) + 'k';
  return f(v, a < 10 ? 2 : 0);
}
export const qtyFmt = (v) => (fmt.hide ? '•••' : num(v, 6));
export const tone = (v, eps = 0.004) => (v > eps ? 'up' : v < -eps ? 'down' : 'flat');

// Accepts "1.234,56", "1234,56", "1234.56", "-3,5%"
export function parseNum(s) {
  let t = String(s ?? '').trim().replace(/[\s€%]/g, '').replace('−', '-');
  if (!t) return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}
export const numInput = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(+v) ? '' : String(+(+v).toFixed(8)).replace('.', ','));

/* ---------- Statistics helpers ---------- */
export const sum = (arr, fn = (x) => x) => { let s = 0; for (const x of arr) s += fn(x); return s; };
export const mean = (arr) => (arr.length ? sum(arr) / arr.length : NaN);
export function stdev(arr) {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  let s = 0;
  for (const x of arr) s += (x - m) * (x - m);
  return Math.sqrt(s / (arr.length - 1));
}
// Linear-interpolated quantile, q in [0, 1]
export function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/* ---------- Misc ---------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const clone = (o) => JSON.parse(JSON.stringify(o));
export function hashHue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------- Layout ---------- */
export const DESKTOP_MIN = 900;
export const isDesktop = () => (typeof window !== 'undefined' ? window.innerWidth >= DESKTOP_MIN : false);
// Width available to page content (inside page padding), matching css/app.css
export function contentWidth() {
  if (typeof document === 'undefined') return 360;
  const vw = document.documentElement.clientWidth || window.innerWidth || 390;
  if (vw >= DESKTOP_MIN) return Math.min(1240, vw - 248 - 64);
  return Math.max(280, vw - 32);
}

/* ---------- Icons (24×24 stroke icons, currentColor) ---------- */
export const ICONS = {
  chart: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/>',
  report: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  pie: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  coins: '<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.6-2.4-2.9-5.5-3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  star: '<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.3 7.4A16.4 16.4 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  chevDown: '<path d="M6 9l6 6 6-6"/>',
  chevLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevRight: '<path d="M9 5l7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 14.7 4.3l1.3-1.8"/><path d="M20 20v-4.5h-4.5"/>',
  down: '<path d="M12 4v14M6 12l6 6 6-6"/>',
  upArrow: '<path d="M12 20V6M6 12l6-6 6 6"/>',
  euro: '<path d="M17 6.5A7 7 0 1 0 17 17.5"/><path d="M4 10h9M4 14h9"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v4h16v-4"/>',
  wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a1 1 0 0 1-1-1z"/><path d="M4 7l11-3v3"/><circle cx="16" cy="13.5" r="1.3"/>',
  bank: '<path d="M3 10l9-6 9 6M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18z"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
};
export function icon(name, attrs = '') {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" ${attrs}>${ICONS[name] || ''}</svg>`;
}

/* ---------- Files ---------- */
// Offer a generated file to the user: Claude artifact downloads capability when present,
// otherwise a normal browser download. Resolves true when handed over.
export async function saveFile(filename, text, mime = 'text/plain') {
  if (typeof window !== 'undefined' && window.claude && typeof window.claude.use === 'function') {
    try {
      const dl = await window.claude.use('downloads');
      if (dl) {
        await dl.save({ filename, data: text });
        return true;
      }
    } catch (e) {
      if (e && e.code === 'declined') return false;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}
