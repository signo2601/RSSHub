// Gruzzolo API: a small Yahoo Finance proxy (search, price history, quotes) plus storage
// for the end-to-end encrypted sync blob.
//
// Cloudflare Pages Function: this file lives at functions/api/[[path]].js and answers every
// /api/... request of the site. It is self-contained (no imports), so it can also be pasted
// as a standalone Cloudflare Worker: the default export at the bottom is the Worker entry.
//
// Routes (all JSON, CORS enabled):
//   GET  /api/health                              → { ok: true, sync: boolean }
//   GET  /api/search?q=enel                       → { results: [...] }
//   GET  /api/chart?symbol=VWCE.DE&range=10y&interval=1d
//   GET  /api/quotes?symbols=AAPL,ENEL.MI         → { quotes: { [symbol]: {...} }, errors? }
//   GET  /api/sync/:id   PUT /api/sync/:id   DELETE /api/sync/:id   (needs the KV binding GRUZZOLO_KV)

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
const SYNC_ID_RE = /^[a-f0-9]{64}$/;
const MAX_QUOTES = 50;
const QUOTE_CONCURRENCY = 8;
const MAX_SUBREQUESTS = 48; // Cloudflare free plan allows 50 outbound requests per invocation
const MAX_SYNC_BYTES = 4 * 1024 * 1024;

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
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
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

async function handleSync(request, env, id) {
  const kv = env && env.GRUZZOLO_KV;
  if (!kv) throw new HttpError(501, 'La sincronizzazione non è attiva su questo server: manca lo spazio dati KV "GRUZZOLO_KV".');
  if (!SYNC_ID_RE.test(id || '')) throw new HttpError(400, 'Codice di sincronizzazione non valido.');
  const key = 'sync:' + id;
  if (request.method === 'GET') {
    const stored = await kv.get(key);
    if (stored === null || stored === undefined) throw new HttpError(404, 'Nessun dato sincronizzato per questo codice.');
    return new Response(typeof stored === 'string' ? stored : JSON.stringify(stored), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (request.method === 'PUT') {
    const declared = Number(request.headers.get('Content-Length') || 0);
    if (declared > MAX_SYNC_BYTES) throw new HttpError(413, 'Dati troppo grandi per la sincronizzazione (massimo 4 MB).');
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_SYNC_BYTES) throw new HttpError(413, 'Dati troppo grandi per la sincronizzazione (massimo 4 MB).');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Il contenuto inviato non è un JSON valido.');
    }
    if (!body || typeof body !== 'object' || !finite(body.updatedAt) || typeof body.iv !== 'string' || typeof body.ct !== 'string') {
      throw new HttpError(400, 'Dati di sincronizzazione incompleti: servono updatedAt (numero), iv e ct (testo).');
    }
    await kv.put(key, text);
    return json({ ok: true, updatedAt: body.updatedAt });
  }
  if (request.method === 'DELETE') {
    if (typeof kv.delete === 'function') await kv.delete(key);
    return json({ ok: true });
  }
  throw new HttpError(405, 'Metodo non consentito: usa GET, PUT o DELETE.');
}

// '/api/chart' → ['chart'], '/api/sync/abc' → ['sync', 'abc'] (also works for a Worker mounted at '/')
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

export async function onRequest(context) {
  const { request } = context;
  const env = context.env || {};
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const url = new URL(request.url);
    const [route = 'health', param] = routeOf(url.pathname);
    if (route === 'sync') return await handleSync(request, env, param);
    if (request.method !== 'GET') throw new HttpError(405, 'Metodo non consentito: usa GET.');
    switch (route) {
      case 'health':
        return json({ ok: true, sync: Boolean(env.GRUZZOLO_KV) });
      case 'search':
        return await handleSearch(context, url);
      case 'chart':
        return await handleChart(context, url);
      case 'quotes':
        return await handleQuotes(context, url);
      default:
        throw new HttpError(404, `Indirizzo API sconosciuto: /api/${route}`);
    }
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
