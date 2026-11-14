// Gruzzolo API: a small read-only proxy for public market data. Yahoo Finance for the portfolio
// (search, price history, quotes, dividends, FX); the TradingView screener for the Mercati tab
// (heatmaps, yield curves, macro indicators, indices, commodities, currencies, crypto).
// It only answers questions about public market data: it never receives, stores or forwards the
// user's portfolio (that stays on the phone). No storage bindings or secrets are needed.
//
// Cloudflare Pages Function: this file lives at functions/api/[[path]].js and answers every
// /api/... request of the site. It is self-contained (no imports), so it can also be pasted
// as a standalone Cloudflare Worker: the default export at the bottom is the Worker entry.
//
// Routes (all GET, JSON unless noted, CORS enabled; anything else → 404 or 405):
//   GET  /api/health                              → { ok: true }
//   GET  /api/search?q=enel                       → { results: [...] }
//   GET  /api/chart?symbol=VWCE.DE&range=10y&interval=1d
//   GET  /api/quotes?symbols=AAPL,ENEL.MI         → { quotes: { [symbol]: {...} }, errors? }
//   GET  /api/eco/quotes?t=TVC:FTMIB,FX_IDC:EURUSD → { at, cols, rows: { [ticker]: [...] } }
//   GET  /api/eco/heatmap?index=SPX               → { at, index, cols, rows: [[...], ...] }
//   GET  /api/eco/yields                          → { at, cols, curves: { [country]: [[months, ...], ...] } }
//   GET  /api/eco/macro                           → { at, cols, data: { [indicator]: { [country]: [...] } } }
//   GET  /api/eco/crypto                          → { at, cols, rows: [[...], ...] }
//   GET  /api/eco/logo?id=apple                   → SVG logo, flag (country/IT) or commodity icon (metal/gold)
//   GET  /api/eco/calendar                        → { at, from, to, cols, rows: [[id, date, country, title, ...]] }
//   GET  /api/eco/inflation                       → { at, base, start, series: { IT: [...], EA: [...] } } (monthly HICP)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const YAHOO_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
};
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
const UPSTREAM_TIMEOUT_MS = 10000;

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']);
const LONG_RANGES = new Set(['1y', '2y', '5y', '10y', 'max']);
const INTERVALS = new Set(['1d', '1wk', '1mo']);
const SYMBOL_RE = /^[A-Za-z0-9.\-=^_]{1,32}$/;
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const MAX_QUOTES = 50;
const QUOTE_CONCURRENCY = 8;
const MAX_SUBREQUESTS = 48; // Cloudflare free plan allows 50 outbound requests per invocation

// Edge cache lifetimes (seconds)
const TTL_SEARCH = 3600;
const TTL_CHART_LONG = 12 * 3600;
const TTL_CHART_SHORT = 300;
const TTL_QUOTES = 60;

const TYPE_MAP = { EQUITY: 'stock', ETF: 'etf', MUTUALFUND: 'fund', CRYPTOCURRENCY: 'crypto', INDEX: 'other', CURRENCY: 'other', FUTURE: 'commodity' };
// Prices quoted in minor units (pence, cents, agorot) are converted to the major currency
const MINOR_UNITS = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };
// Exchange preference for an Italian investor (Yahoo exchange codes), used to sort ISIN results
const EXCHANGE_RANK = { MIL: 0, GER: 1, PAR: 2, AMS: 2, BRU: 2, MCE: 2, EBS: 3, LSE: 3, VIE: 3, STU: 4, MUN: 4, DUS: 4, FRA: 4, BER: 4, HAM: 4, HAN: 4 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ---------- Responses ---------- */
function json(data, status = 200, cacheControl = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// Serve from the Cloudflare edge cache when available; store successful answers for ttl seconds
async function withEdgeCache(context, cacheUrl, ttl, produce) {
  const cache = typeof caches !== 'undefined' && caches && caches.default ? caches.default : null;
  const key = cache ? new Request(cacheUrl, { method: 'GET' }) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch {
      /* cache unavailable: answer from upstream */
    }
  }
  const { data, cacheable = true } = await produce();
  const res = json(data, 200, cacheable ? `public, max-age=${ttl}` : 'no-store');
  if (cache && cacheable) {
    const put = cache.put(key, res.clone()).catch(() => {});
    if (typeof context.waitUntil === 'function') context.waitUntil(put);
    else await put;
  }
  return res;
}

/* ---------- Yahoo Finance ---------- */
function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// GET a Yahoo JSON endpoint, trying the second host when the first fails.
// Returns { status, body } for 2xx and 4xx answers; throws HttpError 502/503 when Yahoo is unreachable.
async function yahooJson(path, budget) {
  let rateLimited = false;
  for (const host of YAHOO_HOSTS) {
    if (budget) {
      if (budget.left <= 0) break;
      budget.left--;
    }
    let res;
    try {
      res = await fetch(host + path, { headers: YAHOO_HEADERS, signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
    } catch {
      continue; // network error or timeout: try the other host
    }
    if (res.status === 429) {
      rateLimited = true;
      continue;
    }
    if (res.status >= 500) continue;
    let body = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok) continue; // HTML or truncated answer: try the other host
    }
    return { status: res.status, body };
  }
  if (rateLimited) throw new HttpError(503, 'Yahoo Finance sta limitando le richieste: riprova tra qualche minuto.');
  throw new HttpError(502, 'Yahoo Finance non risponde in questo momento: riprova più tardi.');
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// Compact numbers: Yahoo sends float32 noise (105.69999694824219 → 105.7)
function round(v) {
  if (!finite(v)) return null;
  return Math.abs(v) >= 1e5 ? Math.round(v * 100) / 100 : Number(v.toPrecision(7));
}

// Epoch seconds → exchange-local 'YYYY-MM-DD'. The IANA time zone handles daylight saving
// correctly for old bars; meta.gmtoffset (current offset) is the fallback.
function dateFormatter(timeZone, gmtoffset) {
  if (timeZone) {
    try {
      const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      f.format(0);
      return (sec) => f.format(sec * 1000);
    } catch {
      /* unknown time zone: use the offset */
    }
  }
  const off = finite(gmtoffset) ? gmtoffset : 0;
  return (sec) => new Date((sec + off) * 1000).toISOString().slice(0, 10);
}

function mapType(quoteType) {
  return TYPE_MAP[String(quoteType || '').toUpperCase()] || 'other';
}

// Convert one Yahoo chart result into the compact History shape used by the app
function compactChart(result) {
  const meta = result.meta || {};
  const [currency, unit] = MINOR_UNITS[meta.currency] || [meta.currency || null, 1];
  const toDate = dateFormatter(meta.exchangeTimezoneName, meta.gmtoffset);
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const closes = quote.close || [];
  const adjs = (result.indicators && result.indicators.adjclose && result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose) || [];

  // Same date twice (live bar after the daily bar): the later row wins
  const rows = new Map();
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (!finite(c) || !finite(ts[i])) continue;
    const a = finite(adjs[i]) ? adjs[i] : c;
    rows.set(toDate(ts[i]), [round(c / unit), round(a / unit)]);
  }
  const dates = [...rows.keys()].sort();
  const close = dates.map((d) => rows.get(d)[0]);
  const adj = dates.map((d) => rows.get(d)[1]);

  const divMap = new Map();
  const dividends = (result.events && result.events.dividends) || {};
  for (const ev of Object.values(dividends)) {
    if (!ev || !finite(ev.amount) || !(ev.amount > 0) || !finite(ev.date)) continue;
    const d = toDate(ev.date);
    divMap.set(d, (divMap.get(d) || 0) + ev.amount / unit);
  }
  const divs = [...divMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, v]) => [d, round(v)]);

  const splits = [];
  const splitEvents = (result.events && result.events.splits) || {};
  for (const ev of Object.values(splitEvents)) {
    if (!ev || !finite(ev.date) || !finite(ev.numerator) || !finite(ev.denominator) || !(ev.denominator > 0)) continue;
    splits.push([toDate(ev.date), round(ev.numerator / ev.denominator)]);
  }
  splits.sort((x, y) => (x[0] < y[0] ? -1 : 1));

  const n = dates.length;
  const price = finite(meta.regularMarketPrice) ? round(meta.regularMarketPrice / unit) : n ? close[n - 1] : null;
  const time = finite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : null;
  let prev = finite(meta.previousClose) ? round(meta.previousClose / unit) : null;
  if (prev === null && n >= 2) {
    // When the live quote is newer than the last daily bar, that bar is the previous close
    const quoteDate = finite(meta.regularMarketTime) ? toDate(meta.regularMarketTime) : null;
    prev = quoteDate && dates[n - 1] < quoteDate ? close[n - 1] : close[n - 2];
  }
  if (prev === null && finite(meta.chartPreviousClose)) prev = round(meta.chartPreviousClose / unit);

  return {
    currency,
    name: meta.longName || meta.shortName || meta.symbol || '',
    type: mapType(meta.instrumentType),
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    price,
    prev,
    time,
    dates,
    close,
    adj,
    divs,
    splits,
  };
}

async function fetchChart(symbol, range, interval, budget) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div,split&includeAdjustedClose=true`;
  const { status, body } = await yahooJson(path, budget);
  const chart = body && body.chart;
  const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  if (status === 404 || (chart && chart.error && /not found|delisted/i.test(String(chart.error.code) + ' ' + String(chart.error.description)))) {
    throw new HttpError(404, `Titolo non trovato su Yahoo Finance: ${symbol}`);
  }
  if (status === 400 || status === 422) throw new HttpError(400, `Richiesta non valida per ${symbol}: controlla periodo e intervallo.`);
  if (!result) {
    if (status >= 400) throw new HttpError(502, 'Yahoo Finance ha risposto con un errore: riprova più tardi.');
    throw new HttpError(404, `Nessun dato disponibile per ${symbol}`);
  }
  return compactChart(result);
}

function mapSearchQuote(q) {
  return {
    symbol: q.symbol,
    name: q.longname || q.shortname || q.symbol,
    exchange: q.exchDisp || q.exchange || '',
    type: mapType(q.quoteType),
    typeDisp: q.typeDisp || '',
    sector: q.sectorDisp || q.sector || '',
    industry: q.industryDisp || q.industry || '',
  };
}

async function yahooSearch(q) {
  const path = `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0&lang=it-IT&region=IT`;
  const { status, body } = await yahooJson(path);
  if (status >= 400 || !body) throw new HttpError(502, 'La ricerca su Yahoo Finance non è disponibile: riprova più tardi.');
  return (Array.isArray(body.quotes) ? body.quotes : []).filter((x) => x && x.symbol && x.isYahooFinance !== false);
}

const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Yahoo maps an ETF ISIN to one primary listing only (often London in USD). Find the other
// listings of the same share class (Milan, Xetra...) by searching the fund name.
async function expandIsin(quotes) {
  const lead = quotes.find((x) => (x.quoteType === 'ETF' || x.quoteType === 'MUTUALFUND') && x.longname);
  if (!lead) return quotes;
  const full = normName(lead.longname);
  const stem = lead.longname.split(/\s+UCITS\b/i)[0].trim();
  const query = stem.length >= 6 && stem.length < lead.longname.length ? stem : lead.longname.split(/\s+/).slice(0, 4).join(' ');
  let more = [];
  try {
    more = await yahooSearch(query.slice(0, 64));
  } catch {
    return quotes;
  }
  const seen = new Set(quotes.map((x) => x.symbol));
  const out = [...quotes];
  for (const x of more) {
    if (!seen.has(x.symbol) && normName(x.longname) === full) {
      seen.add(x.symbol);
      out.push(x);
    }
  }
  // Preferred exchanges first; pseudo-symbols made of the ISIN itself last
  const rank = (x) => (/^[A-Z]{2}[A-Z0-9]{9}\d(\.|$)/.test(x.symbol) ? 9 : EXCHANGE_RANK[x.exchange] ?? 6);
  return out.map((x, i) => [x, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((p) => p[0]);
}

/* ---------- Route handlers ---------- */
async function handleSearch(context, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 64) throw new HttpError(400, 'Scrivi da 1 a 64 caratteri per cercare un titolo.');
  const cacheUrl = `${url.origin}/api/search?q=${encodeURIComponent(q.toLowerCase())}`;
  return withEdgeCache(context, cacheUrl, TTL_SEARCH, async () => {
    let quotes = await yahooSearch(q);
    if (ISIN_RE.test(q.toUpperCase())) quotes = await expandIsin(quotes);
    return { data: { results: quotes.map(mapSearchQuote) } };
  });
}

function readSymbol(value) {
  const s = (value || '').trim();
  if (!SYMBOL_RE.test(s)) throw new HttpError(400, `Simbolo non valido: "${s.slice(0, 40)}". Usa il codice Yahoo, per esempio VWCE.DE o AAPL.`);
  return s;
}

async function handleChart(context, url) {
  const symbol = readSymbol(url.searchParams.get('symbol'));
  const range = url.searchParams.get('range') || '10y';
  const interval = url.searchParams.get('interval') || '1d';
  if (!RANGES.has(range)) throw new HttpError(400, `Periodo non valido: usa uno tra ${[...RANGES].join(', ')}.`);
  if (!INTERVALS.has(interval)) throw new HttpError(400, 'Intervallo non valido: usa 1d, 1wk o 1mo.');
  const ttl = LONG_RANGES.has(range) ? TTL_CHART_LONG : TTL_CHART_SHORT;
  const cacheUrl = `${url.origin}/api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`;
  return withEdgeCache(context, cacheUrl, ttl, async () => {
    const chart = await fetchChart(symbol, range, interval);
    return { data: { symbol, ...chart } };
  });
}

// Run fn over items with at most `limit` calls in flight
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

async function handleQuotes(context, url) {
  const raw = url.searchParams.get('symbols') || '';
  const symbols = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!symbols.length) throw new HttpError(400, 'Indica almeno un simbolo, per esempio ?symbols=AAPL,ENEL.MI');
  if (symbols.length > MAX_QUOTES) throw new HttpError(400, `Troppi simboli: massimo ${MAX_QUOTES} per richiesta.`);
  for (const s of symbols) readSymbol(s);
  const cacheUrl = `${url.origin}/api/quotes?symbols=${symbols.map(encodeURIComponent).join(',')}`;
  return withEdgeCache(context, cacheUrl, TTL_QUOTES, async () => {
    const quotes = {};
    const errors = {};
    let upstreamFailures = 0;
    let lastUpstream = null;
    const budget = { left: MAX_SUBREQUESTS };
    await mapLimit(symbols, QUOTE_CONCURRENCY, async (s) => {
      try {
        const { divs, splits, ...rest } = await fetchChart(s, '5d', '1d', budget);
        quotes[s] = { ...rest, divs, splits };
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 502;
        errors[s] = e instanceof HttpError ? e.message : 'Errore imprevisto';
        if (status >= 500) {
          upstreamFailures++;
          lastUpstream = e;
        }
      }
    });
    if (!Object.keys(quotes).length && upstreamFailures) throw lastUpstream instanceof HttpError ? lastUpstream : new HttpError(502, 'Yahoo Finance non risponde: riprova più tardi.');
    const data = { quotes };
    if (Object.keys(errors).length) data.errors = errors;
    return { data, cacheable: upstreamFailures === 0 };
  });
}

/* ---------- Mercati tab: economy data from the TradingView screener ---------- */
// Public market data (delayed up to 15 minutes, as on TradingView's own pages) from the screener
// endpoint behind TradingView's heatmaps, yield curves and macro maps. One POST per answer, compact
// arrays out, edge-cached. Only lists of public tickers are sent: nothing about the user.
const TV_SCAN = 'https://scanner.tradingview.com';
const TV_LOGO = 'https://s3-symbol-logo.tradingview.com';
const TV_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
};
const TV_TICKER_RE = /^[A-Z0-9_]{1,20}:[A-Z0-9_.!&-]{1,40}$/;
const LOGO_RE = /^(?:(?:crypto|country|provider|metal|commodity)\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_ECO_TICKERS = 200;
const LOGO_MAX_BYTES = 128 * 1024;
const TTL_ECO_QUOTES = 60;
const TTL_ECO_LISTS = 120; // heatmap, yield curves, crypto
const TTL_ECO_MACRO = 6 * 3600;
const TTL_LOGO = 30 * 86400;

// Index constituents for the heatmap (TradingView symbol sets)
const HEATMAP_SETS = {
  SPX: 'SYML:SP;SPX',
  NDX: 'SYML:NASDAQ;NDX',
  DJI: 'SYML:DJ;DJI',
  SX5E: 'SYML:TVC;SX5E',
  SXXP: 'SYML:TVC;SXXP',
  FTSEMIB: 'SYML:INDEX;FTSEMIB',
  DAX: 'SYML:XETR;DAX',
  CAC: 'SYML:EURONEXT;PX1',
  IBEX: 'SYML:BME;IBC',
  AEX: 'SYML:EURONEXT;AEX',
  SMI: 'SYML:SIX;SMI',
  UKX: 'SYML:TVC;UKX',
  NI225: 'SYML:TVC;NI225',
  HSI: 'SYML:HSI;HSI',
  CSI300: 'SYML:SSE;000300',
};

// Government bond tenors TradingView publishes per country (checked November 2026). Months are
// quoted as yields under TVC:US03MY, years under TVC:US10Y. A tenor that disappears just comes back empty.
const YIELD_TENORS = {
  US: '01M 02M 03M 04M 06M 01Y 02Y 03Y 05Y 07Y 10Y 20Y 30Y',
  CA: '01M 02M 03M 06M 01Y 02Y 03Y 04Y 05Y 07Y 10Y 20Y 30Y',
  GB: '01M 03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 12Y 15Y 20Y 25Y 30Y 40Y 50Y',
  DE: '01M 03M 06M 09M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y',
  FR: '01M 03M 06M 09M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y 50Y',
  IT: '01M 03M 06M 09M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y 50Y',
  ES: '01M 03M 06M 09M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y',
  NL: '01M 03M 06M 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y',
  BE: '03M 06M 09M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 30Y 50Y',
  AT: '03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 25Y 30Y 40Y 50Y',
  PT: '03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 30Y',
  GR: '01M 03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 30Y',
  IE: '01Y 02Y 03Y 04Y 05Y 06Y 07Y 10Y 15Y 20Y 25Y 30Y',
  FI: '02Y 03Y 04Y 05Y 06Y 08Y 10Y 15Y 30Y',
  CH: '01M 02M 03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 30Y 40Y',
  SE: '01M 02M 03M 06M 02Y 05Y 07Y 10Y 15Y 20Y',
  NO: '06M 09M 01Y 03Y 05Y 10Y 20Y',
  DK: '03M 06M 02Y 03Y 05Y 08Y 10Y 20Y 30Y',
  JP: '03M 06M 01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 15Y 20Y 30Y 40Y',
  AU: '01Y 02Y 03Y 04Y 05Y 06Y 07Y 08Y 09Y 10Y 12Y 15Y 20Y 30Y',
  NZ: '01M 02M 03M 04M 06M 01Y 02Y 05Y 07Y 10Y 15Y 20Y',
  CN: '01Y 02Y 03Y 05Y 07Y 10Y 15Y 20Y 30Y',
  KR: '01Y 02Y 03Y 04Y 05Y 10Y 20Y 30Y 50Y',
};

// Macro indicators by TradingView code suffix: inflation YoY, central bank rate, GDP (USD),
// GDP growth YoY, unemployment rate, government debt to GDP
const MACRO_CODES = ['IRYY', 'INTR', 'GDP', 'GDPYY', 'UR', 'GDG'];
const CRYPTO_TOP = 15;

const r4 = (v) => (finite(v) ? Math.round(v * 1e4) / 1e4 : null);
const tvTime = (v) => (finite(v) && v > 0 ? Math.round(v) : null);
const str = (v, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
// 20361001 → '2036-10-01'
function tvDate(v) {
  const s = finite(v) ? String(Math.round(v)) : '';
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null;
}
// Prices in pence or cents (US futures on grains, coffee, sugar: USX) come back in the major currency
const ECO_MINOR_UNITS = { ...MINOR_UNITS, USX: ['USD', 100] };
function majorPrice(price, currency) {
  const [ccy, unit] = ECO_MINOR_UNITS[currency] || [currency || null, 1];
  return [finite(price) ? round(price / unit) : null, ccy];
}

// POST a screener query; resolves with the data rows ([{ s, d: [...] }])
async function tvScan(market, body) {
  let res;
  try {
    res = await fetch(`${TV_SCAN}/${market}/scan`, { method: 'POST', headers: TV_HEADERS, body: JSON.stringify(body), signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, 'TradingView non risponde in questo momento: riprova più tardi.');
  }
  if (res.status === 429) throw new HttpError(503, 'TradingView sta limitando le richieste: riprova tra qualche minuto.');
  let body2 = null;
  try {
    body2 = await res.json();
  } catch {
    body2 = null;
  }
  if (!res.ok || !body2 || !Array.isArray(body2.data)) throw new HttpError(502, 'TradingView ha risposto con un errore: riprova più tardi.');
  return body2.data.filter((r) => r && typeof r.s === 'string' && Array.isArray(r.d));
}

// GET /api/eco/quotes?t=TVC:FTMIB,FX_IDC:EURUSD,… → last price, changes and performance of any public ticker
const QUOTE_COLS = ['close', 'change', 'change_abs', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'time', 'currency', 'description', 'yield_to_maturity', 'maturity_date'];
async function handleEcoQuotes(context, url) {
  const raw = url.searchParams.get('t') || '';
  const tickers = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!tickers.length) throw new HttpError(400, 'Indica almeno un titolo, per esempio ?t=TVC:FTMIB');
  if (tickers.length > MAX_ECO_TICKERS) throw new HttpError(400, `Troppi titoli: massimo ${MAX_ECO_TICKERS} per richiesta.`);
  const bad = tickers.find((s) => !TV_TICKER_RE.test(s));
  if (bad) throw new HttpError(400, `Codice non valido: "${bad.slice(0, 40)}". Usa la forma BORSA:CODICE, per esempio TVC:FTMIB.`);
  const cacheUrl = `${url.origin}/api/eco/quotes?t=${tickers.map(encodeURIComponent).join(',')}`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_QUOTES, async () => {
    const rows = await tvScan('global', { columns: QUOTE_COLS, symbols: { tickers }, range: [0, tickers.length] });
    const out = {};
    for (const { s, d } of rows) {
      const [price, ccy] = majorPrice(d[0], d[10]);
      if (price === null) continue;
      const unit = (ECO_MINOR_UNITS[d[10]] || [null, 1])[1];
      out[s] = [price, r4(d[1]), finite(d[2]) ? round(d[2] / unit) : null, r4(d[3]), r4(d[4]), r4(d[5]), r4(d[6]), r4(d[7]), r4(d[8]), tvTime(d[9]), ccy, str(d[11]), r4(d[12]), tvDate(d[13])];
    }
    // An empty answer is an error, never an empty page kept in the edge cache (and on the phone)
    if (!Object.keys(out).length) throw new HttpError(502, 'TradingView non ha restituito dati per questi titoli: riprova più tardi.');
    return { data: { at: Date.now(), cols: ['price', 'chg', 'chgAbs', 'w', 'm1', 'm3', 'm6', 'ytd', 'y', 'time', 'ccy', 'name', 'ytm', 'maturity'], rows: out } };
  });
}

// GET /api/eco/heatmap?index=SPX → constituents with market cap (USD millions), sector and performance
const HEATMAP_COLS = ['description', 'sector', 'industry', 'market_cap_basic', 'close', 'currency', 'change', 'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.YTD', 'Perf.Y', 'logoid'];
async function handleEcoHeatmap(context, url) {
  const index = (url.searchParams.get('index') || '').toUpperCase();
  if (!Object.hasOwn(HEATMAP_SETS, index)) throw new HttpError(400, `Indice non disponibile: usa uno tra ${Object.keys(HEATMAP_SETS).join(', ')}.`);
  const cacheUrl = `${url.origin}/api/eco/heatmap?index=${index}`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_LISTS, async () => {
    const rows = await tvScan('global', {
      columns: HEATMAP_COLS,
      symbols: { symbolset: [HEATMAP_SETS[index]] },
      sort: { sortBy: 'market_cap_basic', sortOrder: 'desc' },
      range: [0, 800],
    });
    const out = [];
    for (const { s, d } of rows) {
      if (!finite(d[3]) || d[3] <= 0) continue; // no market cap: cannot size the tile
      const [price, ccy] = majorPrice(d[4], d[5]);
      out.push([s, str(d[0]), str(d[1], 60), str(d[2], 80), Math.max(1, Math.round(d[3] / 1e6)), price, ccy, r4(d[6]), r4(d[7]), r4(d[8]), r4(d[9]), r4(d[10]), r4(d[11]), r4(d[12]), str(d[13], 80)]);
    }
    if (!out.length) throw new HttpError(502, 'TradingView non ha restituito i titoli dell\'indice: riprova più tardi.');
    return { data: { at: Date.now(), index, cols: ['symbol', 'name', 'sector', 'industry', 'mcap', 'price', 'ccy', 'chg', 'w', 'm1', 'm3', 'm6', 'ytd', 'y', 'logo'], rows: out } };
  });
}

// GET /api/eco/yields → government yield curves of the countries in YIELD_TENORS
async function handleEcoYields(context, url) {
  const cacheUrl = `${url.origin}/api/eco/yields`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_LISTS, async () => {
    const tickers = [];
    const tenorOf = new Map(); // ticker → [country, months]
    for (const [cc, list] of Object.entries(YIELD_TENORS)) {
      for (const t of list.split(' ')) {
        const n = parseInt(t, 10);
        const months = t.endsWith('M') ? n : n * 12;
        const ticker = `TVC:${cc}${t}${t.endsWith('M') ? 'Y' : ''}`;
        tickers.push(ticker);
        tenorOf.set(ticker, [cc, months]);
      }
    }
    const rows = await tvScan('global', { columns: ['close', 'change_abs', 'Perf.W', 'Perf.1M', 'Perf.YTD', 'Perf.Y', 'time'], symbols: { tickers }, range: [0, tickers.length] });
    const curves = {};
    for (const { s, d } of rows) {
      const k = tenorOf.get(s);
      if (!k || !finite(d[0])) continue;
      (curves[k[0]] ||= []).push([k[1], r4(d[0]), r4(d[1]), r4(d[2]), r4(d[3]), r4(d[4]), r4(d[5]), tvTime(d[6])]);
    }
    for (const list of Object.values(curves)) list.sort((a, b) => a[0] - b[0]);
    if (!Object.keys(curves).length) throw new HttpError(502, 'TradingView non ha restituito i rendimenti: riprova più tardi.');
    return { data: { at: Date.now(), cols: ['months', 'yield', 'chgAbs', 'w', 'm1', 'ytd', 'y', 'time'], curves } };
  });
}

// GET /api/eco/macro → latest value, previous value and period end of each macro indicator, by country
async function handleEcoMacro(context, url) {
  const cacheUrl = `${url.origin}/api/eco/macro`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_MACRO, async () => {
    const rows = await tvScan('economics2', {
      columns: ['name', 'close', 'change_abs', 'time', 'country_code'],
      filter: [{ left: 'name', operation: 'match', right: `^[A-Z]{2}(${MACRO_CODES.join('|')})$` }],
      range: [0, 3000],
    });
    const data = Object.fromEntries(MACRO_CODES.map((c) => [c, {}]));
    for (const { d } of rows) {
      const [name, value, chg, time, cc] = d;
      if (typeof name !== 'string' || typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc) || !name.startsWith(cc) || !finite(value)) continue;
      const code = name.slice(2);
      if (!Object.hasOwn(data, code)) continue;
      data[code][cc] = [round(value), finite(chg) ? round(value - chg) : null, tvTime(time)];
    }
    if (!Object.values(data).some((m) => Object.keys(m).length)) throw new HttpError(502, 'TradingView non ha restituito i dati macro: riprova più tardi.');
    return { data: { at: Date.now(), cols: ['value', 'prev', 'time'], data } };
  });
}

// GET /api/eco/crypto → the largest cryptocurrencies by market cap (stablecoins left out), prices in USD
async function handleEcoCrypto(context, url) {
  const cacheUrl = `${url.origin}/api/eco/crypto`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_LISTS, async () => {
    const rows = await tvScan('coin', {
      columns: ['base_currency', 'base_currency_desc', 'base_currency_logoid', 'close', 'change', 'Perf.W', 'Perf.1M', 'Perf.YTD', 'Perf.Y', 'market_cap_calc', 'crypto_common_categories', 'time'],
      sort: { sortBy: 'crypto_total_rank', sortOrder: 'asc' },
      range: [0, 40],
    });
    const out = [];
    for (const { s, d } of rows) {
      const cats = Array.isArray(d[10]) ? d[10] : [];
      if (cats.includes('stablecoins') || !finite(d[3])) continue;
      out.push([s, str(d[0], 20), str(d[1], 60), str(d[2], 80), round(d[3]), r4(d[4]), r4(d[5]), r4(d[6]), r4(d[7]), r4(d[8]), finite(d[9]) ? Math.round(d[9] / 1e6) : null, tvTime(d[11])]);
      if (out.length >= CRYPTO_TOP) break;
    }
    if (!out.length) throw new HttpError(502, 'TradingView non ha restituito le crypto: riprova più tardi.');
    return { data: { at: Date.now(), cols: ['symbol', 'code', 'name', 'logo', 'price', 'chg', 'w', 'm1', 'ytd', 'y', 'mcap', 'time'], rows: out } };
  });
}

// Flags TradingView leaves as a grey square: Hong Kong, Macao and Taiwan. Drawings of flag-icons
// (github.com/lipis/flag-icons, MIT License, (c) 2013 Panayiotis Lipiridis); Taiwan's sun redrawn as
// its 12 rays (tips 96 and bases 49.7 units from the centre, as on the official flag).
function taiwanFlag() {
  const pts = [];
  for (let k = 0; k < 24; k++) {
    const r = k % 2 ? 49.7 : 96;
    const a = ((k * 15 - 90) * Math.PI) / 180;
    pts.push(`${(192 + r * Math.cos(a)).toFixed(1)} ${(128 + r * Math.sin(a)).toFixed(1)}`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#fe0000" d="M0 0h512v512H0z"/><path fill="#000095" d="M0 0h384v256H0z"/><path fill="#fff" d="M${pts.join('L')}z"/><circle cx="192" cy="128" r="54.4" fill="#000095"/><circle cx="192" cy="128" r="48" fill="#fff"/></svg>`;
}
const OWN_LOGOS = {
  'country/HK': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><path fill="#EC1B2E" d="M0 0h512v512H0"/><path id="hk-a" fill="#fff" d="M282.3 119.2C203 114 166.6 218 241.6 256.4 215.6 234 221 201 231.5 184l1.9 1c-13.8 23.6-11.2 52.8 11 71-12.6-12.2-9.4-39 12.2-48.8s23.6-39.3 16.4-49.1q-14.7-25.6 9.3-39zM243.9 180l-4.7 7.4-1.8-8.6-8.6-2.3 7.8-4.3-.6-9 6.5 6.2 8.3-3.3-3.7 8 5.6 6.9z"/><use xlink:href="#hk-a" transform="rotate(72 248.5 259.5)"/><use xlink:href="#hk-a" transform="rotate(144 248.5 259.5)"/><use xlink:href="#hk-a" transform="rotate(216 248.5 259.5)"/><use xlink:href="#hk-a" transform="rotate(288 248.5 259.5)"/></svg>',
  'country/MO': '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 512 512"><path fill="#00785e" d="M0 0h512v512H0z"/><path fill="#fbd116" d="M272.5 147.4 256 96.5l-16.5 51 43.3-31.5h-53.6z"/><g id="mo-a"><path fill="#fff" d="M256 353.7H146.7a156 156 0 0 1-4-4.2H256a2.3 2.3 0 0 1 1.5 2c0 1-.6 1.9-1.5 2.2m0-33.4c.6-1.3 1.9-4.3 1.3-8a13.2 13.2 0 0 0-1.3-4.1 87.4 87.4 0 0 1-34.7 20.2 86.4 86.4 0 0 1-25 3.7h-67.4a154 154 0 0 0 6.3 8.6h65a86.2 86.2 0 0 0 55.8-20.4M139.1 294a34.4 34.4 0 0 1-10.3 2.2 86.3 86.3 0 0 0 64.8 29.3 86.3 86.3 0 0 0 62.4-26.6 470.3 470.3 0 0 0 4.8-62.9 470.3 470.3 0 0 0-4.8-72.2c-7 6.3-20.2 20-26.4 40.9a86.5 86.5 0 0 0-3.6 24.6 86.1 86.1 0 0 0 14.6 48.1 86.1 86.1 0 0 1-18-52.9 86.1 86.1 0 0 1 8.2-37 34.7 34.7 0 0 1-8-13.8 86 86 0 0 0-11.2 42.6 86.1 86.1 0 0 0 17 51.4 101.4 101.4 0 0 0-78.3-31.5 34.8 34.8 0 0 1 7.2 9.5 101.4 101.4 0 0 1 73.3 31.4 101.3 101.3 0 0 0-65.2-23.6c-13.8 0-27 2.7-39 7.8a86.6 86.6 0 0 0 88 55.6 87 87 0 0 1-15.4 1.4 86.2 86.2 0 0 1-60.1-24.3M256 388.7h-56.6a153 153 0 0 0 56.6 10.8 11.6 11.6 0 0 0 1.3-5.3 11.7 11.7 0 0 0-1.3-5.5m0-26.2h-99.9a154 154 0 0 0 8.4 6.7H256a4.9 4.9 0 0 0 1.4-3.3c0-2-1.2-3.1-1.4-3.4m0 13.4h-81.8a153.2 153.2 0 0 0 15.4 8.5H256a8 8 0 0 0 1.2-4.5 8 8 0 0 0-1.2-4"/><path fill="#fbd116" d="m155.6 211.7-7-36.4-15.7 33.6 32.4-18-36.8-4.5zm49.3-58.8-29.6-22.3 10.8 35.4 12.1-35-30.3 21.3z"/></g><use xlink:href="#mo-a" width="100%" height="100%" transform="matrix(-1 0 0 1 512 0)"/></svg>',
  'country/TW': taiwanFlag(),
};
// TradingView's grey square for a flag it does not draw: answered as "not found", so the app keeps
// the emoji flag it shows underneath
const TV_BLANK_RE = /^(?:<!--[^>]*-->)?\s*<svg[^>]*>\s*<path fill="#DBDBDB" d="M0 0h18v18H0z"\/>\s*<\/svg>\s*$/i;

function svgResponse(svg) {
  return new Response(svg, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': `public, max-age=${TTL_LOGO}, immutable`,
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// GET /api/eco/logo?id=apple → company or crypto logo, country flag (country/IT) or commodity icon
// (metal/gold, crude-oil), as SVG, served from our origin so the app contacts no other site.
// Sandboxed: the SVG cannot run scripts even when opened directly.
async function handleEcoLogo(context, url) {
  const id = url.searchParams.get('id') || '';
  if (!LOGO_RE.test(id) || id.includes('..')) throw new HttpError(400, 'Logo non valido.');
  if (Object.hasOwn(OWN_LOGOS, id)) return svgResponse(OWN_LOGOS[id]);
  const cache = typeof caches !== 'undefined' && caches && caches.default ? caches.default : null;
  const key = cache ? new Request(`${url.origin}/api/eco/logo?id=${encodeURIComponent(id)}`, { method: 'GET' }) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch { /* answer from upstream */ }
  }
  let res;
  try {
    res = await fetch(`${TV_LOGO}/${id}${id.includes('/') ? '' : '--big'}.svg`, { headers: { 'User-Agent': UA, Accept: 'image/svg+xml' }, signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new HttpError(502, 'Logo non disponibile in questo momento.');
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('image/svg+xml')) throw new HttpError(404, 'Logo non trovato.');
  const svg = await res.text();
  if (svg.length > LOGO_MAX_BYTES || !svg.includes('<svg') || TV_BLANK_RE.test(svg)) throw new HttpError(404, 'Logo non trovato.');
  const out = svgResponse(svg);
  if (cache) {
    const put = cache.put(key, out.clone()).catch(() => {});
    if (typeof context.waitUntil === 'function') context.waitUntil(put);
    else await put;
  }
  return out;
}

// GET /api/eco/calendar → economic calendar of the main economies, from 3 days ago to 15 days ahead:
// medium and high importance releases (low ones are mostly auctions and niche statistics)
const TV_CALENDAR = 'https://economic-calendar.tradingview.com/events';
const CALENDAR_COUNTRIES = ['US', 'EU', 'IT', 'DE', 'FR', 'ES', 'GB', 'CH', 'JP', 'CN'];
const TTL_ECO_CALENDAR = 600;
const num2 = (v) => (finite(v) ? Math.round(v * 1e4) / 1e4 : null);
async function handleEcoCalendar(context, url) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  // One answer per day (the window moves at midnight UTC), refreshed every 10 minutes for new results
  const cacheUrl = `${url.origin}/api/eco/calendar?d=${day}`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_CALENDAR, async () => {
    const at = (days) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days)).toISOString();
    const from = at(-3);
    const to = at(15);
    let res;
    try {
      res = await fetch(`${TV_CALENDAR}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=${CALENDAR_COUNTRIES.join(',')}`, { headers: TV_HEADERS, signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
    } catch {
      throw new HttpError(502, 'Il calendario economico non risponde in questo momento: riprova più tardi.');
    }
    if (res.status === 429) throw new HttpError(503, 'TradingView sta limitando le richieste: riprova tra qualche minuto.');
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const list = body && Array.isArray(body.result) ? body.result : null;
    if (!res.ok || !list) throw new HttpError(502, 'Il calendario economico ha risposto con un errore: riprova più tardi.');
    const rows = [];
    for (const e of list) {
      if (!e || !(e.importance >= 0) || typeof e.date !== 'string' || !/^[A-Z]{2}$/.test(e.country || '') || !e.title) continue;
      const t = Date.parse(e.date);
      if (!Number.isFinite(t)) continue;
      rows.push([str(String(e.id ?? ''), 24), new Date(t).toISOString(), e.country, str(e.title, 100), str(e.period || '', 24), num2(e.actual), num2(e.forecast), num2(e.previous), str(e.unit || '', 8), str(e.scale || '', 4), e.importance >= 1 ? 1 : 0]);
    }
    rows.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    if (!rows.length) throw new HttpError(502, 'Il calendario economico è vuoto in questo momento: riprova più tardi.');
    return { data: { at: Date.now(), from, to, cols: ['id', 'date', 'country', 'title', 'period', 'actual', 'forecast', 'previous', 'unit', 'scale', 'high'], rows } };
  });
}

// GET /api/eco/inflation → monthly consumer price index (HICP, Eurostat, 2025 = 100) of Italy and the
// euro area since January 1996: the app deflates returns with it ("rendimento reale")
const EUROSTAT_HICP = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr?geo=IT&geo=EA&coicop18=TOTAL&unit=I25&sinceTimePeriod=1996-01&format=JSON';
const TTL_ECO_INFLATION = 12 * 3600;
async function handleEcoInflation(context, url) {
  const cacheUrl = `${url.origin}/api/eco/inflation`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_INFLATION, async () => {
    let res;
    try {
      res = await fetch(EUROSTAT_HICP, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
    } catch {
      throw new HttpError(502, 'Eurostat non risponde in questo momento: riprova più tardi.');
    }
    let d = null;
    try {
      d = await res.json();
    } catch {
      d = null;
    }
    const dim = d && d.dimension;
    const times = dim && dim.time && dim.time.category && dim.time.category.index;
    const geos = dim && dim.geo && dim.geo.category && dim.geo.category.index;
    if (!res.ok || !times || !geos || !d.value || !Array.isArray(d.size)) throw new HttpError(502, 'Eurostat ha risposto con un errore: riprova più tardi.');
    // JSON-stat: value index = position in the flattened [freq, unit, coicop18, geo, time] array
    const months = Object.entries(times).filter(([m]) => /^\d{4}-\d{2}$/.test(m)).sort((a, b) => a[1] - b[1]);
    const nt = d.size[d.size.length - 1];
    const series = {};
    for (const geo of ['IT', 'EA']) {
      const gi = geos[geo];
      if (!Number.isInteger(gi)) continue;
      series[geo] = months.map(([, ti]) => {
        const v = d.value[String(gi * nt + ti)];
        return finite(v) ? round(v) : null;
      });
    }
    if (!months.length || !series.IT || !series.IT.some((v) => v !== null)) throw new HttpError(502, 'Eurostat non ha restituito i prezzi al consumo: riprova più tardi.');
    return { data: { at: Date.now(), base: '2025=100', start: months[0][0], series } };
  });
}

// GET /api/eco/etf?isin=IE00BK5BQT80 → what is inside an ETF, read from its public justETF profile:
// the 10 largest holdings, the countries and the sectors (the whole lists, opened like the page's
// "Mostra di più" links) and the date of the data. An ISIN justETF does not know, or a product without
// holdings (an ETC on gold), answers { none: true }: cached like the others, so it is not asked again.
const JUSTETF = 'https://www.justetf.com';
const TTL_ECO_ETF = 7 * 24 * 3600;
const JUSTETF_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', Accept: 'text/html,application/xhtml+xml' };
const htmlText = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
// '5,01%' → 5.01; '3.797' → 3797
const itNum = (s) => {
  const v = Number(String(s || '').replace(/[%\s]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
// Rows [name, percent] of the countries or sectors table in a piece of the page
function justEtfRows(html, kind) {
  const re = new RegExp(`data-testid="tl_etf-holdings_${kind}_value_name"[^>]*>([\\s\\S]*?)</td>[\\s\\S]*?data-testid="tl_etf-holdings_${kind}_value_percentage"[^>]*>([^<]*)<`, 'g');
  const out = [];
  for (const m of String(html || '').matchAll(re)) {
    const name = str(htmlText(m[1]), 60);
    const pct = itNum(m[2]);
    if (name && pct !== null && pct >= 0 && pct <= 100) out.push([name, Math.round(pct * 100) / 100]);
  }
  return out.slice(0, 40);
}
export function parseJustEtf(html) {
  const holdings = [];
  const re = /data-testid="tl_etf-holdings_top-holdings_link_name"([^>]*)>([\s\S]*?)<\/a>[\s\S]*?data-testid="tl_etf-holdings_top-holdings_value_percentage"[^>]*>([^<]*)</g;
  for (const m of String(html || '').matchAll(re)) {
    const attrs = m[1];
    const title = (attrs.match(/title="([^"]*)"/) || [])[1];
    const isin = ((attrs.match(/href="[^"]*\/([A-Z]{2}[A-Z0-9]{9}[0-9])(?:[?#"][^"]*)?"/) || [])[1]) || '';
    const name = str(htmlText(title || m[2]), 80);
    const pct = itNum(m[3]);
    if (name && pct !== null && pct >= 0 && pct <= 100) holdings.push([name, Math.round(pct * 100) / 100, isin]);
  }
  const date = (String(html || '').match(/data-testid="tl_etf-holdings_reference-date"[^>]*>[^<]*?(\d{2})\/(\d{2})\/(\d{4})/) || []);
  const count = (String(html || '').match(/data-testid="tl_etf-holdings_top-holdings_count"[^>]*>([^<]*)</) || [])[1];
  const title = (String(html || '').match(/<title>([^<|]*)/) || [])[1];
  return {
    name: str(htmlText(title), 120),
    date: date.length === 4 ? `${date[3]}-${date[2]}-${date[1]}` : null,
    count: count ? itNum(count.replace(/[^\d.,]/g, '')) : null,
    top: holdings.slice(0, 10),
    countries: justEtfRows(html, 'countries'),
    sectors: justEtfRows(html, 'sectors'),
  };
}
async function justEtfMore(html, isin, kind, cookie) {
  const name = kind === 'countries' ? 'Countries' : 'Sectors';
  const path = (String(html).match(new RegExp(`"u":"(/it/etf-profile\\.html\\?[^"]*loadMore${name}[^"]*)"`)) || [])[1];
  if (!path) return null;
  try {
    const res = await fetch(JUSTETF + path, {
      headers: { ...JUSTETF_HEADERS, Accept: 'text/xml', Cookie: cookie, 'Wicket-Ajax': 'true', 'Wicket-Ajax-BaseURL': `it/etf-profile.html?isin=${isin}`, 'X-Requested-With': 'XMLHttpRequest' },
      signal: timeoutSignal(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const rows = justEtfRows(await res.text(), kind);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}
async function handleEcoEtf(context, url) {
  const isin = String(url.searchParams.get('isin') || '').trim().toUpperCase();
  if (!ISIN_RE.test(isin)) throw new HttpError(400, 'ISIN non valido: servono 12 caratteri, come IE00BK5BQT80.');
  const cacheUrl = `${url.origin}/api/eco/etf?isin=${isin}`;
  return withEdgeCache(context, cacheUrl, TTL_ECO_ETF, async () => {
    let res;
    try {
      res = await fetch(`${JUSTETF}/it/etf-profile.html?isin=${isin}`, { headers: JUSTETF_HEADERS, redirect: 'manual', signal: timeoutSignal(UPSTREAM_TIMEOUT_MS) });
    } catch {
      throw new HttpError(502, 'justETF non risponde in questo momento: riprova più tardi.');
    }
    // An unknown ISIN sends to the search page
    if (res.status >= 300 && res.status < 400) return { data: { at: Date.now(), isin, none: true } };
    if (res.status === 404) return { data: { at: Date.now(), isin, none: true } };
    if (res.status === 429) throw new HttpError(503, 'justETF sta limitando le richieste: riprova tra qualche minuto.');
    if (!res.ok) throw new HttpError(502, 'justETF ha risposto con un errore: riprova più tardi.');
    const html = await res.text();
    const out = parseJustEtf(html);
    if (!out.top.length && !out.countries.length && !out.sectors.length) return { data: { at: Date.now(), isin, name: out.name, none: true } };
    // The whole lists of countries and sectors (the page shows the first 4): same session as the page
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
    const cookie = setCookies.map((c) => String(c).split(';')[0].trim()).filter((c) => c.includes('=')).join('; ');
    const [countries, sectors] = await Promise.all([justEtfMore(html, isin, 'countries', cookie), justEtfMore(html, isin, 'sectors', cookie)]);
    if (countries) out.countries = countries;
    if (sectors) out.sectors = sectors;
    return { data: { at: Date.now(), isin, ...out, source: 'justETF' } };
  });
}

const ECO_ROUTES = {
  etf: handleEcoEtf,
  inflation: handleEcoInflation,
  calendar: handleEcoCalendar,
  quotes: handleEcoQuotes,
  heatmap: handleEcoHeatmap,
  yields: handleEcoYields,
  macro: handleEcoMacro,
  crypto: handleEcoCrypto,
  logo: handleEcoLogo,
};

// '/api/chart' → ['chart'], '/api/a/b' → ['a', 'b'] (also works for a Worker mounted at '/')
function routeOf(pathname) {
  const i = pathname.indexOf('/api/');
  const rest = i >= 0 ? pathname.slice(i + 5) : pathname === '/api' ? '' : pathname.replace(/^\/+/, '');
  return rest.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
}

const ROUTES = {
  health: async () => json({ ok: true }),
  search: handleSearch,
  chart: handleChart,
  quotes: handleQuotes,
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const url = new URL(request.url);
    const parts = routeOf(url.pathname);
    const route = parts[0] || 'health';
    let handler = parts.length <= 1 && Object.hasOwn(ROUTES, route) ? ROUTES[route] : null;
    if (route === 'eco' && parts.length === 2 && Object.hasOwn(ECO_ROUTES, parts[1])) handler = ECO_ROUTES[parts[1]];
    if (!handler) throw new HttpError(404, `Indirizzo API sconosciuto: /api/${parts.join('/')}`);
    if (request.method !== 'GET') throw new HttpError(405, 'Metodo non consentito: usa GET.');
    return await handler(context, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: 'Errore interno del server: riprova più tardi.' }, 500);
  }
}

// Standalone Cloudflare Worker entry (ignored by Pages, which uses onRequest)
export default {
  fetch(request, env, ctx) {
    return onRequest({ request, env, waitUntil: ctx && typeof ctx.waitUntil === 'function' ? ctx.waitUntil.bind(ctx) : undefined });
  },
};
