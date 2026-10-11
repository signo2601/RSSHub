// Example portfolio ("demo") with a synthetic market. Prices, dividends and exchange rates are
// invented by a deterministic generator, but every number is internally consistent: trades happen
// at the synthetic close of their day, dividends follow the shares held, the DEGIRO cash balance
// never goes negative, sells never exceed holdings.
//
//   demoData({ today })          → v2 data; every account/asset/txn/watch item has demo: true; settings.started false
//   installDemoMarket({ today }) → injects the synthetic histories under 'demo:' + symbol (memory only)
//   removeDemo(data)             → copy of data without the example items (settings.started true)
//
// Market model: business-day closes for 8 years back from today. Daily log return =
// drift + monthly volatility regime × (beta × common market factor + idiosyncratic noise).
// The random numbers are tied to the calendar date (hash of symbol + date), and each price path is
// pinned to a fixed anchor date, so a given day shows the same synthetic price whatever "today" is.
import { blankData } from './state.js';
import { market } from './market.js';
import { addDays, addMonths, iso, parseISO, todayISO } from './util.js';

export const DEMO_ACCOUNTS = { degiro: 'demo-degiro', scalable: 'demo-scalable' };
const ANCHOR_DATE = '2026-01-02';
const HISTORY_YEARS = 8;
const MARKET_VOL = 0.14;
const TRADING_DAYS = 252;
const DEMO_EXTERNAL_LOSS = -120;
// Chosen so the example looks like an ordinary market (ups, a correction, no wild boom)
let SALT = 's132|';

// Synthetic instruments. vol: annual volatility; beta: loading on the common market factor;
// drift: annual price drift; anchor: close on ANCHOR_DATE; div: ex-dividend schedule [month, day, share of the year]
const SPECS = [
  { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World (Acc)', type: 'etf', currency: 'EUR', exchange: 'XETRA', vol: 0.15, beta: 1, drift: 0.08, anchor: 138.2 },
  { symbol: 'EIMI.MI', name: 'iShares Core MSCI EM IMI (Acc)', type: 'etf', currency: 'EUR', exchange: 'Milano', vol: 0.17, beta: 0.8, drift: 0.05, anchor: 36.4 },
  {
    symbol: 'VHYL.MI', name: 'Vanguard FTSE All-World High Dividend Yield (Dist)', type: 'etf', currency: 'EUR', exchange: 'Milano', vol: 0.13, beta: 0.8, drift: 0.035, anchor: 71.3,
    div: { dates: [[3, 14], [6, 13], [9, 12], [12, 12]], yield: 0.032 },
  },
  {
    symbol: 'ENEL.MI', name: 'Enel', type: 'stock', currency: 'EUR', exchange: 'Milano', vol: 0.24, beta: 0.75, drift: 0.03, anchor: 8.62,
    div: { dates: [[1, 20, 0.45], [7, 21, 0.55]], yield: 0.062 },
  },
  {
    symbol: 'ALV.DE', name: 'Allianz', type: 'stock', currency: 'EUR', exchange: 'XETRA', vol: 0.25, beta: 0.9, drift: 0.06, anchor: 356,
    div: { dates: [[5, 8, 1]], yield: 0.047 },
  },
  {
    symbol: 'AAPL', name: 'Apple', type: 'stock', currency: 'USD', exchange: 'NASDAQ', vol: 0.3, beta: 1.1, drift: 0.11, anchor: 255,
    div: { dates: [[2, 9], [5, 10], [8, 11], [11, 8]], perShare: (y) => Math.max(0.1, 0.2 + 0.01 * (y - 2019)) },
  },
  { symbol: 'BTC-EUR', name: 'Bitcoin', type: 'crypto', currency: 'EUR', exchange: 'Crypto', vol: 0.6, beta: 0.5, drift: 0.2, anchor: 82000 },
  { symbol: 'ASML.AS', name: 'ASML', type: 'stock', currency: 'EUR', exchange: 'Amsterdam', vol: 0.35, beta: 1.2, drift: 0.1, anchor: 880 },
  { symbol: 'RACE.MI', name: 'Ferrari', type: 'stock', currency: 'EUR', exchange: 'Milano', vol: 0.27, beta: 0.85, drift: 0.12, anchor: 415 },
  { symbol: 'SGLD.MI', name: 'Invesco Physical Gold ETC', type: 'commodity', currency: 'EUR', exchange: 'Milano', vol: 0.14, beta: 0.05, drift: 0.08, anchor: 335 },
  { symbol: 'EURUSD=X', name: 'EUR/USD', type: 'other', currency: 'USD', exchange: 'CCY', vol: 0.07, beta: 0.1, drift: 0, anchor: 1.17, decimals: 4 },
];
export const DEMO_SYMBOLS = SPECS.map((s) => s.symbol);

// Demo assets of the example portfolio
const ASSETS = {
  enel: { symbol: 'ENEL.MI', ticker: 'ENEL', isin: 'IT0003128367', sector: 'Utility', region: 'Italia', ter: null, venue: 'Borsa Italiana (MIL)', fee: 4.9, wht: 0.26, lag: 2 },
  alv: { symbol: 'ALV.DE', ticker: 'ALV', isin: 'DE0008404005', sector: 'Finanza', region: 'Europa', ter: null, venue: 'Xetra (XET)', fee: 4.9, wht: 0.26375, lag: 3 },
  aapl: { symbol: 'AAPL', ticker: 'AAPL', isin: 'US0378331005', sector: 'Tecnologia', region: 'USA', ter: null, venue: 'Nasdaq (NDQ)', fee: 2, wht: 0.15, lag: 4 },
  vhyl: { symbol: 'VHYL.MI', ticker: 'VHYL', isin: 'IE00B8GKDB10', sector: 'Diversificato', region: 'Globale', ter: 0.0029, venue: 'Borsa Italiana (MIL)', fee: 1, wht: 0, lag: 14 },
  btp: { symbol: '', ticker: 'BTP30', isin: 'IT0005024234', name: 'BTP 3,5% mar 2030', type: 'bond', currency: 'EUR', exchange: 'MOT', sector: 'Governativo', region: 'Italia', ter: null, venue: 'Borsa Italiana (MIL)' },
  vwce: { symbol: 'VWCE.DE', ticker: 'VWCE', isin: 'IE00BK5BQT80', sector: 'Diversificato', region: 'Globale', ter: 0.0022 },
  eimi: { symbol: 'EIMI.MI', ticker: 'EIMI', isin: 'IE00BKM4GZ66', sector: 'Diversificato', region: 'Mercati emergenti', ter: 0.0018 },
  btc: { symbol: 'BTC-EUR', ticker: 'BTC', isin: '', sector: 'Altro', region: 'Globale', ter: null },
};
const aidOf = (key) => 'demo-' + key;
const BTP = { coupon: 3.5, maturity: '2030-03-01', taxRate: 0.125 };

/* ---------- Deterministic random numbers ---------- */
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Standard normal number tied to a key (Box–Muller)
function normalAt(key) {
  const r = mulberry32(hash32(key));
  r();
  const u1 = Math.max(r(), 1e-12);
  const u2 = r();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const round = (v, d = 2) => {
  const f = 10 ** d;
  const r = Math.round((v + Math.sign(v) * Number.EPSILON) * f) / f;
  return r === 0 ? 0 : r;
};

function businessDays(from, to) {
  const out = [];
  const d = parseISO(from);
  const end = parseISO(to);
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) out.push(iso(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// Index of the last element <= value (-1 if none)
function floorIndex(arr, value) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/* ---------- Synthetic market ---------- */
let marketCache = null;

function buildMarket(today) {
  const start = addMonths(today, -12 * HISTORY_YEARS);
  const all = businessDays(start < ANCHOR_DATE ? start : ANCHOR_DATE, today > ANCHOR_DATE ? today : ANCHOR_DATE);
  const i0 = all.findIndex((d) => d >= start);
  const i1 = floorIndex(all, today);
  const anchorIdx = Math.max(0, floorIndex(all, ANCHOR_DATE));
  const dates = all.slice(i0, i1 + 1);
  const sd = Math.sqrt(1 / TRADING_DAYS);
  // Monthly volatility regime shared by all instruments (calm and nervous months)
  const regime = new Map();
  const volMult = (d) => {
    const k = d.slice(0, 7);
    if (!regime.has(k)) regime.set(k, Math.min(2.2, Math.max(0.6, Math.exp(0.35 * normalAt(SALT + 'regime|' + k) - 0.06))));
    return regime.get(k);
  };
  const mkt = all.map((d) => normalAt(SALT + 'mkt|' + d));
  const histories = {};
  const index = new Map(dates.map((d, i) => [d, i]));
  const lastDate = dates[dates.length - 1];
  const [ly, lm, ld] = lastDate.split('-').map(Number);
  const time = new Date(ly, lm - 1, ld, 17, 35).getTime();

  for (const s of SPECS) {
    const idio = Math.sqrt(Math.max(s.vol * s.vol - s.beta * s.beta * MARKET_VOL * MARKET_VOL, 0.0004));
    const mu = (s.drift - 0.5 * s.vol * s.vol) / TRADING_DAYS;
    const logs = new Float64Array(all.length);
    for (let i = 1; i < all.length; i++) {
      const shock = s.beta * MARKET_VOL * mkt[i] + idio * normalAt(SALT + s.symbol + '|' + all[i]);
      logs[i] = logs[i - 1] + mu + volMult(all[i]) * sd * shock;
    }
    const decimals = s.decimals ?? null;
    const close = dates.map((_, k) => {
      const p = s.anchor * Math.exp(logs[i0 + k] - logs[anchorIdx]);
      return round(p, decimals ?? (p < 10 ? 3 : 2));
    });
    // Dividends on the ex-dates of the schedule (business day on or after the nominal date)
    const divs = [];
    if (s.div) {
      const y0 = Number(dates[0].slice(0, 4));
      const y1 = Number(lastDate.slice(0, 4));
      for (let y = y0; y <= y1; y++) {
        for (const [mo, day, share] of s.div.dates) {
          const nominal = `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const k = dates.findIndex((d) => d >= nominal);
          if (k <= 0) continue;
          const amount = s.div.perShare ? s.div.perShare(y) : close[k - 1] * s.div.yield * (share ?? 1 / s.div.dates.length);
          divs.push([dates[k], round(amount, 4)]);
        }
      }
    }
    // Dividend-adjusted closes: every dividend scales the closes before its ex-date
    const adj = new Array(close.length);
    const exAt = new Map(divs.map(([d, a]) => [d, a]));
    let f = 1;
    for (let k = close.length - 1; k >= 0; k--) {
      adj[k] = round(close[k] * f, 6);
      const a = exAt.get(dates[k]);
      if (a && k > 0) f *= 1 - a / close[k - 1];
    }
    const n = close.length;
    histories[s.symbol] = {
      symbol: 'demo:' + s.symbol,
      currency: s.currency,
      name: s.name,
      type: s.type,
      exchange: s.exchange,
      dates,
      close,
      adj,
      divs,
      splits: [],
      price: close[n - 1],
      prev: n > 1 ? close[n - 2] : close[n - 1],
      time,
      updatedAt: 0,
      fullAt: 0,
      synthetic: true,
    };
  }

  // BTP (manual prices): mean-reverting deviation around a pull-to-par path
  const btpPrice = new Map();
  let x = 0;
  const kappa = 1.5 / TRADING_DAYS;
  for (let i = 0; i < all.length; i++) {
    if (i > 0) x = x * (1 - kappa) + 0.04 * sd * (0.3 * mkt[i] + 0.95 * normalAt(SALT + 'btp|' + all[i]));
    if (i < i0 || i > i1) continue;
    const years = Math.max(0, (parseISO(BTP.maturity) - parseISO(all[i])) / (365.25 * 864e5));
    const base = 100 - 1.6 * Math.min(years, 4) / 4;
    btpPrice.set(all[i], round(base * (1 + x), 2));
  }

  return {
    today,
    dates,
    lastDate,
    histories,
    btpPrice,
    // Close of a symbol on a business day of the synthetic calendar (carry back otherwise)
    close(symbol, date) {
      const h = histories[symbol];
      const k = index.has(date) ? index.get(date) : floorIndex(dates, date);
      return k >= 0 ? h.close[k] : h.close[0];
    },
    // First synthetic business day on or after date (null after the last one)
    bizOnOrAfter(date) {
      const k = floorIndex(dates, date);
      if (k >= 0 && dates[k] === date) return date;
      return k + 1 < dates.length ? dates[k + 1] : null;
    },
    bizOnOrBefore(date) {
      const k = floorIndex(dates, date);
      return k >= 0 ? dates[k] : null;
    },
  };
}

function demoMarket(today) {
  if (!marketCache || marketCache.today !== today) marketCache = buildMarket(today);
  return marketCache;
}

// Inject the synthetic histories ('demo:' + symbol) into the market cache, memory only
export function installDemoMarket({ today } = {}) {
  const mk = demoMarket(today || todayISO());
  const out = [];
  for (const s of SPECS) {
    market.inject('demo:' + s.symbol, mk.histories[s.symbol], { persist: false });
    out.push('demo:' + s.symbol);
  }
  return out;
}

/* ---------- Example portfolio ---------- */
const TYPE_ORDER = { deposit: 0, buy: 1, div: 2, interest: 3, fee: 4, tax: 5, sell: 6, withdraw: 7 };
const sortEvents = (list) => list
  .map((e, i) => [e, i])
  .sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : TYPE_ORDER[a[0].type] - TYPE_ORDER[b[0].type] || a[1] - b[1]))
  .map((x) => x[0]);

// EUR cash effect, same formula as the engine
function cashDelta(t) {
  const fx = t.fx > 0 ? t.fx : 1;
  const fee = t.fee || 0;
  const fxFee = t.fxFee || 0;
  switch (t.type) {
    case 'buy': return -((t.qty * t.price) / fx + fee + fxFee);
    case 'sell': return (t.qty * t.price) / fx - fee - fxFee - (t.tax || 0);
    case 'div':
    case 'interest':
    case 'deposit': return t.amount;
    default: return -t.amount;
  }
}

const monthStart = (d) => d.slice(0, 8) + '01';

export function demoData({ today } = {}) {
  const T = today || todayISO();
  const mk = demoMarket(T);
  const last = mk.lastDate;
  const data = blankData();
  const year = Number(T.slice(0, 4));
  data.settings.started = false;
  data.settings.externalPL = { [String(year - 3)]: DEMO_EXTERNAL_LOSS };
  data.settings.demoMarks = { externalPL: { [String(year - 3)]: DEMO_EXTERNAL_LOSS } };
  data.accounts = [
    { id: DEMO_ACCOUNTS.degiro, name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track', demo: true },
    { id: DEMO_ACCOUNTS.scalable, name: 'Scalable Capital', broker: 'Scalable Capital', cashMode: 'auto', demo: true },
  ];
  const specOf = (sym) => SPECS.find((s) => s.symbol === sym);
  for (const [key, a] of Object.entries(ASSETS)) {
    const s = a.symbol ? specOf(a.symbol) : null;
    data.assets[aidOf(key)] = {
      id: aidOf(key),
      name: a.name || s.name,
      ticker: a.ticker,
      symbol: a.symbol,
      isin: a.isin,
      type: a.type || s.type,
      currency: a.currency || s.currency,
      exchange: a.exchange || s.exchange,
      sector: a.sector,
      region: a.region,
      ter: a.ter,
      priceSource: a.symbol ? 'demo' : 'manual',
      demo: true,
    };
  }
  const ccyOf = (key) => data.assets[aidOf(key)].currency;
  const fxOn = (key, date) => (ccyOf(key) === 'USD' ? mk.close('EURUSD=X', date) : 1);
  const priceOf = (key, date) => (key === 'btp' ? mk.btpPrice.get(date) : mk.close(ASSETS[key].symbol, date));

  /* --- DEGIRO (cash tracked) --- */
  const ACC = DEMO_ACCOUNTS.degiro;
  const s0 = addMonths(T, -30);
  const at = (months, days = 0) => mk.bizOnOrAfter(addDays(addMonths(s0, months), days));
  const trades = [];
  const addTrade = (type, key, date, qty) => {
    const price = priceOf(key, date);
    const fx = fxOn(key, date);
    const value = (qty * price) / fx;
    const t = { acc: ACC, type, date, aid: aidOf(key), qty, price, fee: key === 'btp' ? round(2 + 0.0005 * value, 2) : ASSETS[key].fee };
    if (fx !== 1) {
      t.fx = fx;
      t.fxFee = round(0.0025 * value, 2);
    }
    trades.push(t);
    return t;
  };
  const buyPlan = [
    ['enel', 0, 2400], ['vhyl', 1, 2000], ['alv', 2, 1500], ['aapl', 3, 1800], ['btp', 5, 0],
    ['enel', 9, 1000], ['aapl', 12, 1000], ['vhyl', 14, 1500], ['alv', 18, 1100],
  ];
  for (const [key, m, budget] of buyPlan) {
    const date = at(m, 3);
    if (!date || date > last) continue;
    const qty = key === 'btp' ? 50 : Math.floor(budget / (priceOf(key, date) / fxOn(key, date)));
    if (qty > 0) addTrade('buy', key, date, qty);
  }
  // Average cost (EUR, fees included) and shares held before a date, from the trades so far
  const book = (key, date) => {
    let qty = 0;
    let cost = 0;
    for (const t of sortEvents(trades)) {
      if (t.aid !== aidOf(key) || t.date >= date) continue;
      if (t.type === 'buy') {
        qty += t.qty;
        cost += -cashDelta(t);
      } else {
        const out = cost * (t.qty / qty);
        qty -= t.qty;
        cost -= out;
      }
    }
    return { qty, cost };
  };
  // A sell between two months with the wanted outcome: the first date with a clear gain / loss,
  // otherwise the best (or worst) date of the window
  const findSell = (key, fromM, toM, part, wantGain) => {
    const from = at(fromM);
    const to = mk.bizOnOrBefore(addDays(addMonths(s0, toM), 0));
    if (!from || !to || from > to) return null;
    let best = null;
    for (const d of mk.dates) {
      if (d < from) continue;
      if (d > to || d > addDays(last, -10)) break;
      const { qty, cost } = book(key, d);
      const q = Math.floor(qty * part);
      if (q < 1) continue;
      const price = priceOf(key, d);
      const fx = fxOn(key, d);
      const gross = (q * price) / fx;
      const proceeds = gross - ASSETS[key].fee - (fx !== 1 ? round(0.0025 * gross, 2) : 0);
      const ratio = proceeds / ((cost * q) / qty);
      const cand = { key, date: d, qty: q, ratio };
      if (wantGain ? ratio > 1.06 : ratio < 0.97) return cand;
      if (!best || (wantGain ? ratio > best.ratio : ratio < best.ratio)) best = cand;
    }
    return best;
  };
  // Try a few securities: the first with a clear result wins, else the best one found
  const pickSell = (keys, fromM, toM, part, wantGain) => {
    let fallback = null;
    for (const key of keys) {
      const c = findSell(key, fromM, toM, part, wantGain);
      if (!c) continue;
      if (wantGain ? c.ratio > 1.06 : c.ratio < 0.97) return c;
      if (!fallback || (wantGain ? c.ratio > fallback.ratio : c.ratio < fallback.ratio)) fallback = c;
    }
    return fallback;
  };
  const gainSell = pickSell(['alv', 'enel', 'vhyl', 'aapl'], 18, 28, 0.5, true);
  if (gainSell) addTrade('sell', gainSell.key, gainSell.date, gainSell.qty);
  const lossSell = pickSell(['aapl', 'enel', 'vhyl', 'alv'].filter((k) => !gainSell || k !== gainSell.key), 12, 28, 1 / 3, false);
  if (lossSell) addTrade('sell', lossSell.key, lossSell.date, lossSell.qty);

  const events = [...trades];
  const firstTrade = sortEvents(trades)[0];
  const heldBefore = (key, date) => book(key, date).qty;

  // Dividends with withholding (USD ones converted with AutoFX). A dividend already ex but not
  // yet due is booked on the last market day, so the example never shows "unrecorded" dividends.
  for (const key of ['enel', 'alv', 'aapl', 'vhyl']) {
    const h = mk.histories[ASSETS[key].symbol];
    for (const [ex, perShare] of h.divs) {
      if (!firstTrade || ex <= firstTrade.date || ex > last) continue;
      const held = heldBefore(key, ex);
      if (held <= 0) continue;
      const due = mk.bizOnOrAfter(addDays(ex, ASSETS[key].lag));
      const pay = !due || due > last ? last : due;
      const fx = fxOn(key, pay);
      const grossEur = (held * perShare) / fx;
      const gross = round(grossEur, 2);
      const tax = round(grossEur * ASSETS[key].wht, 2);
      const fxFee = fx !== 1 ? round((gross - tax) * 0.0025, 2) : 0;
      const t = { acc: ACC, type: 'div', date: pay, aid: aidOf(key), amount: round(gross - tax - fxFee, 2), gross };
      if (tax) t.tax = tax;
      if (fxFee) t.fxFee = fxFee;
      events.push(t);
    }
  }
  // BTP coupons on 1 March and 1 September, 12,5% tax on government bonds
  const btpBuy = trades.find((t) => t.aid === aidOf('btp'));
  if (btpBuy) {
    for (let y = Number(btpBuy.date.slice(0, 4)); y <= year; y++) {
      for (const md of ['-03-01', '-09-01']) {
        const pay = mk.bizOnOrAfter(y + md);
        if (!pay || pay <= btpBuy.date || pay > last) continue;
        const units = heldBefore('btp', pay);
        if (units <= 0) continue;
        const gross = round((units * BTP.coupon) / 2, 2);
        const tax = round(gross * BTP.taxRate, 2);
        events.push({ acc: ACC, type: 'div', date: pay, aid: aidOf('btp'), amount: round(gross - tax, 2), gross, tax });
      }
    }
  }
  // Connectivity fee: 2,50 € per exchange and calendar year (first trade of the year, or early January when holding)
  const venues = [...new Set(Object.values(ASSETS).map((a) => a.venue).filter(Boolean))];
  for (const venue of venues) {
    const keys = Object.keys(ASSETS).filter((k) => ASSETS[k].venue === venue);
    const venueTrades = sortEvents(trades).filter((t) => keys.some((k) => aidOf(k) === t.aid));
    if (!venueTrades.length) continue;
    for (let y = Number(venueTrades[0].date.slice(0, 4)); y <= year; y++) {
      const jan = mk.bizOnOrAfter(`${y}-01-03`);
      const holding = jan && keys.some((k) => heldBefore(k, jan) > 0);
      const firstOfYear = venueTrades.find((t) => t.date.startsWith(String(y)));
      const date = holding && jan > venueTrades[0].date ? jan : firstOfYear ? firstOfYear.date : null;
      if (!date || date > last) continue;
      events.push({ acc: ACC, type: 'fee', kind: 'connectivity', date, amount: 2.5, note: `Commissione di connessione ${y} · ${venue}` });
    }
  }
  // Monthly deposits, a withdrawal after the profitable sell, interest on cash at quarter ends
  if (firstTrade) {
    events.push({ acc: ACC, type: 'deposit', date: firstTrade.date, amount: 3000, note: 'Bonifico iniziale' });
    for (let m = 1; m <= 20; m++) {
      const d = mk.bizOnOrAfter(monthStart(addMonths(firstTrade.date, m)));
      if (!d || d > last) break;
      events.push({ acc: ACC, type: 'deposit', date: d, amount: 250, note: 'Bonifico mensile' });
    }
    for (let m = 0; ; m += 3) {
      const qEnd = addDays(monthStart(addMonths(firstTrade.date.slice(0, 5) + '01-01', m + 3)), -1);
      if (qEnd > last) break;
      const d = mk.bizOnOrBefore(qEnd);
      if (d && d > firstTrade.date) events.push({ acc: ACC, type: 'interest', date: d, amount: 0, note: 'Interessi sulla liquidità', _interest: true });
    }
  }
  if (gainSell) {
    const d = mk.bizOnOrAfter(addDays(gainSell.date, 12));
    if (d && d <= last) events.push({ acc: ACC, type: 'withdraw', date: d, amount: 0, note: 'Prelievo verso il conto corrente', _withdraw: true });
  }
  // Walk the cash balance: interest and the withdrawal are sized on it, top-ups keep it >= 0
  const degiro = [];
  let cash = 0;
  for (const e of sortEvents(events)) {
    if (e._interest) {
      const amount = round(Math.max(cash, 0) * 0.005, 2);
      if (amount < 0.01) continue;
      delete e._interest;
      e.amount = amount;
    } else if (e._withdraw) {
      const amount = Math.min(1000, Math.floor((cash - 300) / 100) * 100);
      if (amount < 300) continue;
      delete e._withdraw;
      e.amount = amount;
    }
    const delta = cashDelta(e);
    if (cash + delta < 0) {
      const topUp = Math.ceil((-(cash + delta) + 100) / 500) * 500;
      degiro.push({ acc: ACC, type: 'deposit', date: e.date, amount: topUp, note: 'Bonifico' });
      cash += topUp;
    }
    cash += delta;
    degiro.push(e);
  }

  /* --- Scalable Capital (cash not tracked): monthly savings plans and Bitcoin --- */
  const ACC2 = DEMO_ACCOUNTS.scalable;
  const scalable = [];
  const s1 = addMonths(T, -28);
  const planBuy = (key, date, euros, fee = 0, note = '') => {
    const price = priceOf(key, date);
    const t = { acc: ACC2, type: 'buy', date, aid: aidOf(key), qty: round(euros / price, 6), price, fee };
    if (note) t.note = note;
    scalable.push(t);
  };
  for (let m = 0; ; m++) {
    const first = monthStart(addMonths(s1, m));
    const d = mk.bizOnOrAfter(addDays(first, 1));
    if (!d || d > last) break;
    planBuy('vwce', d, 200, 0, 'Piano di accumulo');
    if (m >= 3) planBuy('eimi', d, 50, 0, 'Piano di accumulo');
    if (m === 4 || m === 15) {
      const db = mk.bizOnOrAfter(addDays(first, 9));
      if (db && db <= last) planBuy('btc', db, m === 4 ? 500 : 300, 0.99);
    }
  }

  data.txns = sortEvents([...degiro, ...scalable]).map((t, i) => ({ id: 'demo-t' + String(i + 1).padStart(3, '0'), ...t, demo: true }));

  // Manual prices of the BTP: month ends, trade days and the last close
  const btpPoints = new Map();
  if (btpBuy) {
    for (let m = 0; ; m++) {
      const end = mk.bizOnOrBefore(addDays(monthStart(addMonths(btpBuy.date, m + 1)), -1));
      if (!end || end > last || m > 240) break;
      if (end >= btpBuy.date) btpPoints.set(end, mk.btpPrice.get(end));
    }
    for (const t of data.txns) if (t.aid === aidOf('btp') && (t.type === 'buy' || t.type === 'sell')) btpPoints.set(t.date, t.price);
    btpPoints.set(last, mk.btpPrice.get(last));
    data.prices[aidOf('btp')] = [...btpPoints.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  // Watchlist with price targets (prices are the synthetic last closes)
  const watchItem = (id, symbol, ticker, target, note) => {
    const s = specOf(symbol);
    const price = mk.close(symbol, last);
    return { id, symbol, ticker, name: s.name, currency: s.currency, price, target: round(price * target, price < 50 ? 2 : 0), note, demo: true };
  };
  data.watch = [
    watchItem('demo-w1', 'ASML.AS', 'ASML', 0.88, 'Da comprare se scende sotto l\'obiettivo'),
    watchItem('demo-w2', 'RACE.MI', 'RACE', 0.92, 'Aspetto un ritracciamento'),
    watchItem('demo-w3', 'SGLD.MI', 'SGLD', 1.08, 'Oro come protezione: obiettivo di vendita'),
  ];
  data.updatedAt = 0;
  return data;
}

/* ---------- Leaving the example ---------- */
// Copy of data without the example: demo transactions and watch items go away; demo assets and
// accounts stay only if the user's own transactions use them (then they become ordinary items).
export function removeDemo(data) {
  const d = JSON.parse(JSON.stringify(data || blankData()));
  d.txns = (Array.isArray(d.txns) ? d.txns : []).filter((t) => t && !t.demo);
  d.watch = (Array.isArray(d.watch) ? d.watch : []).filter((w) => w && !w.demo);
  d.assets = d.assets && typeof d.assets === 'object' ? d.assets : {};
  d.prices = d.prices && typeof d.prices === 'object' ? d.prices : {};
  const used = new Set();
  for (const t of d.txns) if (t.aid) used.add(t.aid);
  for (const w of d.watch) if (w.aid) used.add(w.aid);
  for (const [id, a] of Object.entries(d.assets)) {
    if (!a || !a.demo) continue;
    if (!used.has(id)) {
      delete d.assets[id];
      delete d.prices[id];
      continue;
    }
    delete a.demo;
    // Synthetic prices must not survive: live prices for listed assets, the user's own for the others
    if (a.priceSource === 'demo') a.priceSource = a.symbol ? 'auto' : 'manual';
    else delete d.prices[id];
  }
  const accUsed = new Set(d.txns.map((t) => t.acc));
  d.accounts = (Array.isArray(d.accounts) ? d.accounts : []).filter((a) => a && (!a.demo || accUsed.has(a.id))).map((a) => {
    const { demo, ...rest } = a;
    return rest;
  });
  if (!d.accounts.length) d.accounts = blankData().accounts;
  d.settings = { ...blankData().settings, ...(d.settings || {}) };
  const marks = (d.settings.demoMarks && d.settings.demoMarks.externalPL) || {};
  const ext = { ...(d.settings.externalPL || {}) };
  for (const [y, v] of Object.entries(marks)) if (ext[y] === v) delete ext[y];
  d.settings.externalPL = ext;
  delete d.settings.demoMarks;
  d.settings.started = true;
  return d;
}

export const _test = {
  buildMarket, hash32, normalAt, SPECS, ASSETS,
  setSalt(s) {
    SALT = s;
    marketCache = null;
  },
};
