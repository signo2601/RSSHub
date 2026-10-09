// Market data: in-memory cache of price histories (core), plus the network/IndexedDB layer.
// The engine reads histories synchronously through getHistory(); everything async fills the cache.
//
// Network: our own server function (/api/..., see functions/api/[[path]].js) proxies Yahoo Finance.
// Persistence: IndexedDB 'gruzzolo-market', object store 'histories' (key = symbol), loaded into
// memory at init. Demo histories ('demo:' symbols or injected with persist false) stay in memory only.

const histories = new Map();
const listeners = new Set();
const memoryOnly = new Set(); // injected with persist false: never written to IndexedDB

const DB_NAME = 'gruzzolo-market';
const STORE = 'histories';
const SYMBOL_RE = /^[A-Za-z0-9.\-=^_]{1,32}$/;
const REQUEST_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 4000;
const DB_OPEN_TIMEOUT_MS = 3000;
const FULL_MAX_AGE_MS = 12 * 3600e3; // a forced ensureHistory re-downloads 10 years after this
const REFRESH_MIN_GAP_MS = 60e3;
const OFFLINE_RETRY_MS = 20e3; // while offline, ping the server again at most this often
const NOT_FOUND_TTL_MS = 3600e3;
const SEARCH_TTL_MS = 10 * 60e3;
const QUOTE_BATCH = 40;
const HISTORY_CONCURRENCY = 3;
const SPLIT_GUARD = 0.3; // closes differing more than this on the same day → download the full history again

let db = null;
let dbReady = null;
let lastPing = 0;
let pingPromise = null;
let refreshing = null;
let refreshingSet = null;
const pendingFull = new Map();
const notFound = new Map(); // symbol → ms when the server said 404
const searchCache = new Map();

const isDemo = (s) => typeof s === 'string' && s.startsWith('demo:');
const validSymbol = (s) => typeof s === 'string' && SYMBOL_RE.test(s);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function notify() {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function hasRealHistory(symbol) {
  const h = histories.get(symbol);
  return Boolean(h && !h.synthetic && Array.isArray(h.dates) && h.dates.length);
}

const persistable = (h) => Boolean(h && h.symbol && !isDemo(h.symbol) && !h.synthetic && !memoryOnly.has(h.symbol));

function validHistory(h) {
  return Boolean(h && typeof h.symbol === 'string' && Array.isArray(h.dates) && Array.isArray(h.close) && h.close.length === h.dates.length);
}

/* ---------- IndexedDB (best effort: any failure means memory only) ---------- */
function idbOpen() {
  return new Promise((resolve) => {
    let factory = null;
    try {
      factory = globalThis.indexedDB || null; // reading it can throw in sandboxed frames
    } catch {
      factory = null;
    }
    if (!factory || typeof factory.open !== 'function') {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Safari can leave open() pending forever: give up and stay in memory
    const timer = setTimeout(() => finish(null), DB_OPEN_TIMEOUT_MS);
    let req;
    try {
      req = factory.open(DB_NAME, 1);
    } catch {
      finish(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'symbol' });
      } catch {
        /* the open request fails on its own */
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      if (done) {
        try {
          d.close();
        } catch { /* ignore */ }
        return;
      }
      d.onversionchange = () => {
        try {
          d.close();
        } catch { /* ignore */ }
        if (db === d) db = null;
      };
      finish(d);
    };
    req.onerror = () => finish(null);
  });
}

// Run work(store) in one transaction; resolves with the request result (or true), null on failure
function idbRun(mode, work) {
  return new Promise((resolve) => {
    if (!db) {
      resolve(null);
      return;
    }
    let tx;
    let out;
    try {
      tx = db.transaction(STORE, mode);
      out = work(tx.objectStore(STORE));
    } catch {
      try {
        tx && tx.abort();
      } catch { /* ignore */ }
      resolve(null);
      return;
    }
    tx.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : true);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

function writeHistories(list) {
  const rows = list.filter(persistable);
  if (!rows.length || !dbReady) return Promise.resolve(false);
  return dbReady.then(() => idbRun('readwrite', (st) => {
    for (const h of rows) st.put(h);
  }));
}

async function loadFromDb() {
  const rows = await idbRun('readonly', (st) => st.getAll());
  let loaded = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!validHistory(r) || isDemo(r.symbol) || r.synthetic) continue;
    const cur = histories.get(r.symbol);
    if (cur && (cur.updatedAt || 0) >= (r.updatedAt || 0)) continue;
    if (!Array.isArray(r.adj) || r.adj.length !== r.close.length) r.adj = r.close.slice();
    if (!Array.isArray(r.divs)) r.divs = [];
    histories.set(r.symbol, r);
    loaded++;
  }
  if (loaded) {
    market.version++;
    notify();
  }
}

/* ---------- Network ---------- */
function apiRoot() {
  return String(market.apiBase || '').trim().replace(/\/+$/, '') + '/api';
}

function setStatus(status) {
  if (market.status === status) return;
  market.status = status;
  notify();
}

const offlineError = () => Object.assign(new Error('Server dei prezzi non raggiungibile'), { offline: true });

// GET apiRoot + path → parsed JSON. Network failures and non-JSON answers (no API on this host)
// mark the market offline; JSON errors from our server throw with .status.
async function apiGet(path, timeout = REQUEST_TIMEOUT_MS) {
  if (typeof fetch !== 'function') {
    setStatus('offline');
    throw offlineError();
  }
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeout);
  let res;
  let body = null;
  try {
    res = await fetch(apiRoot() + path, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } catch {
    setStatus('offline');
    throw offlineError();
  } finally {
    clearTimeout(timer);
  }
  if (!body || typeof body !== 'object') {
    setStatus('offline');
    throw offlineError();
  }
  setStatus('online');
  if (!res.ok) throw Object.assign(new Error(body.error || `Errore ${res.status}`), { status: res.status });
  return body;
}

async function ensureOnline() {
  if (market.status === 'online') return true;
  if (market.status === 'offline' && Date.now() - lastPing < OFFLINE_RETRY_MS) return false;
  return (await market.ping()) === 'online';
}

/* ---------- Merging ---------- */
function pairs(list) {
  return Array.isArray(list) ? list.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && num(p[1]) !== null) : [];
}

function mergePairs(a, b) {
  const map = new Map(pairs(a).map((p) => [p[0], p[1]]));
  for (const p of pairs(b)) map.set(p[0], p[1]);
  return [...map.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

// Shape an API chart/quote answer as a History fragment
function normalizeIncoming(j) {
  const dates = Array.isArray(j.dates) ? j.dates : [];
  const close = Array.isArray(j.close) ? j.close : [];
  const adj = Array.isArray(j.adj) && j.adj.length === close.length ? j.adj : close;
  return {
    currency: j.currency || null,
    name: j.name || '',
    type: j.type || '',
    exchange: j.exchange || '',
    dates: dates.slice(0, close.length),
    close,
    adj,
    divs: pairs(j.divs),
    splits: pairs(j.splits),
    price: num(j.price),
    prev: num(j.prev),
    time: num(j.time),
  };
}

// Union by date of an existing history and new data (new wins). Old adjusted closes are rebased
// on the new adjustment factor, so dividends that went ex since the last download stay consistent.
// A full download refreshes fullAt. price/prev/time come from whichever quote is more recent.
export function mergeHistory(old, inc, { symbol, full = false, now = 0 } = {}) {
  const base = old && !old.synthetic && Array.isArray(old.dates) ? old : null;
  const rows = new Map();
  if (base) {
    for (let i = 0; i < base.dates.length; i++) {
      const c = num(base.close[i]);
      if (c === null) continue;
      const a = base.adj ? num(base.adj[i]) : null;
      rows.set(base.dates[i], [c, a === null ? c : a]);
    }
  }
  const n = inc.dates.length;
  if (base && n) {
    let ratio = 1;
    for (let i = 0; i < n; i++) {
      const o = rows.get(inc.dates[i]);
      if (o && o[0] > 0 && o[1] > 0 && inc.close[i] > 0 && inc.adj[i] > 0) {
        ratio = inc.adj[i] / inc.close[i] / (o[1] / o[0]);
        break;
      }
    }
    if (Number.isFinite(ratio) && Math.abs(ratio - 1) > 1e-9) for (const v of rows.values()) v[1] *= ratio;
  }
  // An answer older than what we hold (edge-cached history) must not overwrite a fresher last bar
  const staleFrom = base && n && inc.time && base.time && inc.time < base.time ? inc.dates[n - 1] : null;
  for (let i = 0; i < n; i++) {
    const d = inc.dates[i];
    const c = num(inc.close[i]);
    if (c === null || typeof d !== 'string') continue;
    if (staleFrom && d >= staleFrom && rows.has(d)) continue;
    const a = num(inc.adj[i]);
    rows.set(d, [c, a === null ? c : a]);
  }
  const dates = [...rows.keys()].sort();
  const newer = !base || !base.time || (inc.time || 0) >= base.time;
  const pick = (k) => (newer ? inc[k] ?? (base ? base[k] : null) : base[k] ?? inc[k]) ?? null;
  return {
    symbol: symbol || (base && base.symbol) || '',
    currency: inc.currency || (base && base.currency) || null,
    name: inc.name || (base && base.name) || '',
    type: inc.type || (base && base.type) || 'other',
    exchange: inc.exchange || (base && base.exchange) || '',
    dates,
    close: dates.map((d) => rows.get(d)[0]),
    adj: dates.map((d) => rows.get(d)[1]),
    divs: mergePairs(base && base.divs, inc.divs),
    splits: mergePairs(base && base.splits, inc.splits),
    price: pick('price'),
    prev: pick('prev'),
    time: pick('time'),
    updatedAt: now,
    fullAt: full ? now : (base && base.fullAt) || 0,
  };
}

// The 5-day quote cannot be appended safely: gap since the last stored day, or a split
function needsFullHistory(old, q) {
  if (!old || !old.dates.length) return true;
  if (!q.dates.length) return false;
  if (old.dates[old.dates.length - 1] < q.dates[0]) return true;
  const known = new Set(pairs(old.splits).map((p) => p[0]));
  if (q.splits.some((p) => !known.has(p[0]))) return true;
  const at = new Map();
  for (let i = old.dates.length - 1; i >= 0 && old.dates[i] >= q.dates[0]; i--) at.set(old.dates[i], old.close[i]);
  for (let i = 0; i < q.dates.length - 1; i++) {
    const o = at.get(q.dates[i]);
    if (o > 0 && q.close[i] > 0 && Math.abs(q.close[i] / o - 1) > SPLIT_GUARD) return true;
  }
  return false;
}

function fxFor(ccy) {
  return typeof ccy === 'string' && /^[A-Z]{3}$/.test(ccy) && ccy !== 'EUR' ? market.fxSymbol(ccy) : null;
}

// Download 10 years of daily data and merge it into memory (no notify, no persist)
function fetchFull(symbol) {
  if (pendingFull.has(symbol)) return pendingFull.get(symbol);
  const p = (async () => {
    const nf = notFound.get(symbol);
    if (nf && Date.now() - nf < NOT_FOUND_TTL_MS) return null;
    try {
      const j = await apiGet(`/chart?symbol=${encodeURIComponent(symbol)}&range=10y&interval=1d`);
      if (!Array.isArray(j.dates)) return null;
      const now = Date.now();
      const merged = mergeHistory(histories.get(symbol), normalizeIncoming(j), { symbol, full: true, now });
      histories.set(symbol, merged);
      memoryOnly.delete(symbol);
      return merged;
    } catch (e) {
      if (e.status === 404) notFound.set(symbol, Date.now());
      return null;
    }
  })().finally(() => pendingFull.delete(symbol));
  pendingFull.set(symbol, p);
  return p;
}

// Run fn over items with at most `limit` in flight
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

async function runRefresh(symbols, { onProgress, force = false } = {}) {
  const input = Array.isArray(symbols) ? symbols : [];
  const list = [...new Set(input.filter((s) => validSymbol(s) && !isDemo(s)))];
  const updated = new Set();
  const failed = new Set(input.filter((s) => s && !isDemo(s) && !validSymbol(s)));
  const result = () => ({ updated: [...updated], failed: [...failed] });
  if (!list.length) return result();

  const recent = !force && Date.now() - market.lastRefresh < REFRESH_MIN_GAP_MS;
  const missing = list.filter((s) => !hasRealHistory(s));
  if (recent && !missing.length) return { ...result(), skipped: true };
  if (!(await ensureOnline())) {
    for (const s of list) failed.add(s);
    return { ...result(), offline: true };
  }

  const changed = new Map();
  const handled = new Set(list);
  let done = 0;
  let total = 0;
  const tick = (k = 1) => {
    done += k;
    if (typeof onProgress === 'function') {
      try {
        onProgress(Math.min(done, total), total);
      } catch { /* a progress callback must not stop the refresh */ }
    }
  };
  // EUR exchange rates for the currencies of these symbols (when known)
  const fxOf = (symbols) => {
    const out = [];
    for (const s of symbols) {
      const f = fxFor((histories.get(s) || {}).currency);
      if (f && !handled.has(f)) {
        handled.add(f);
        out.push(f);
      }
    }
    return out;
  };

  // Latest days for symbols we already hold, batched through /api/quotes.
  // A quote that cannot be appended (gap, split) moves the symbol to needFull.
  const quoteRound = async (symbolsToQuote, needFull) => {
    for (let i = 0; i < symbolsToQuote.length; i += QUOTE_BATCH) {
      const batch = symbolsToQuote.slice(i, i + QUOTE_BATCH);
      if (market.status === 'offline') {
        for (const s of batch) failed.add(s);
        tick(batch.length);
        continue;
      }
      let answer = null;
      try {
        answer = await apiGet('/quotes?symbols=' + batch.map(encodeURIComponent).join(','));
      } catch {
        answer = null;
      }
      const quotes = (answer && answer.quotes) || {};
      let resolved = 0;
      const now = Date.now();
      for (const s of batch) {
        const raw = quotes[s];
        if (!raw) {
          failed.add(s);
          resolved++;
          continue;
        }
        const q = normalizeIncoming(raw);
        const old = histories.get(s);
        if (needsFullHistory(old, q)) {
          needFull.add(s);
          continue;
        }
        const merged = mergeHistory(old, q, { symbol: s, now });
        histories.set(s, merged);
        changed.set(s, merged);
        updated.add(s);
        resolved++;
      }
      tick(resolved);
    }
  };

  // Full 10-year downloads (new symbols, gaps, splits), three at a time
  const fullRound = async (needFull) => {
    await mapLimit([...needFull], HISTORY_CONCURRENCY, async (s) => {
      const merged = market.status === 'offline' ? null : await fetchFull(s);
      if (merged) {
        changed.set(s, merged);
        updated.add(s);
      } else failed.add(s);
      tick();
    });
  };

  const round = async (symbolsInRound) => {
    const needFull = new Set(symbolsInRound.filter((s) => !hasRealHistory(s)));
    const toQuote = recent ? [] : symbolsInRound.filter((s) => !needFull.has(s));
    total += toQuote.length + needFull.size;
    await quoteRound(toQuote, needFull);
    await fullRound(needFull);
  };

  await round([...list, ...fxOf(list)]);
  // Currencies discovered by the downloads just made
  const moreFx = fxOf([...handled]);
  if (moreFx.length) await round(moreFx);
  if (!recent) market.lastRefresh = Date.now();
  if (changed.size || !recent) {
    market.version++;
    notify();
  }
  if (changed.size) writeHistories([...changed.values()]);
  return result();
}

/* ---------- Public object ---------- */
export const market = {
  version: 0,
  apiBase: '',
  status: 'unknown', // 'unknown' | 'online' | 'offline'
  lastRefresh: 0,
  health: null, // last /api/health answer: { ok, sync }

  getHistory(symbol) {
    return (symbol && histories.get(symbol)) || null;
  },

  // Store a history in memory (and in IndexedDB when persist is true and it is not demo data)
  inject(symbol, history, { persist = false } = {}) {
    histories.set(symbol, { ...history, symbol });
    if (persist && !isDemo(symbol) && !history.synthetic) memoryOnly.delete(symbol);
    else memoryOnly.add(symbol);
    this.version++;
    if (persist) this._persist(symbol);
    notify();
  },

  _persist(symbol) {
    const h = histories.get(symbol);
    if (h) writeHistories([h]);
  },

  symbols() {
    return [...histories.keys()];
  },

  fxSymbol(ccy) {
    return `EUR${ccy}=X`;
  },

  isDemoSymbol(s) {
    return isDemo(s);
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Open the IndexedDB cache (once), load it into memory, then check the server (≤ 4 s).
  // Never throws: without a reachable /api the status ends as 'offline'.
  async init({ apiBase = '' } = {}) {
    const base = String(apiBase || '').trim();
    if (base !== this.apiBase) {
      this.apiBase = base;
      searchCache.clear();
      notFound.clear();
    }
    if (!dbReady) {
      dbReady = (async () => {
        db = await idbOpen();
        if (db) await loadFromDb();
      })().catch(() => {
        db = null;
      });
    }
    await dbReady;
    if (pingPromise) await pingPromise;
    lastPing = 0;
    return this.ping();
  },

  // Check /api/health; resolves with the new status
  async ping() {
    if (pingPromise) return pingPromise;
    pingPromise = (async () => {
      try {
        const j = await apiGet('/health', HEALTH_TIMEOUT_MS);
        this.health = j;
        setStatus(j.ok ? 'online' : 'offline');
      } catch {
        this.health = null;
        setStatus('offline');
      }
      lastPing = Date.now();
      return this.status;
    })().finally(() => {
      pingPromise = null;
    });
    return pingPromise;
  },

  // Search Yahoo Finance by name, ticker or ISIN; [] when offline or on errors
  async search(query) {
    const q = String(query ?? '').trim().slice(0, 64);
    if (!q) return [];
    const key = q.toLowerCase();
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.t < SEARCH_TTL_MS) return hit.results;
    if (!(await ensureOnline())) return [];
    try {
      const j = await apiGet('/search?q=' + encodeURIComponent(q));
      const results = Array.isArray(j.results) ? j.results.filter((r) => r && r.symbol) : [];
      searchCache.set(key, { t: Date.now(), results });
      if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
      return results;
    } catch {
      return [];
    }
  },

  // 10 years of daily prices and dividends. Downloads when missing, or with force when the last
  // full download is older than 12 hours. Also fetches the EUR exchange rate of a new currency.
  async ensureHistory(symbol, { force = false } = {}) {
    if (!validSymbol(symbol) || isDemo(symbol)) return this.getHistory(symbol);
    const h = histories.get(symbol);
    if (hasRealHistory(symbol) && (!force || Date.now() - (h.fullAt || 0) < FULL_MAX_AGE_MS)) return h;
    if (!(await ensureOnline())) return this.getHistory(symbol);
    const merged = await fetchFull(symbol);
    if (!merged) return this.getHistory(symbol);
    const toSave = [merged];
    const fx = fxFor(merged.currency);
    if (fx && fx !== symbol && !hasRealHistory(fx)) {
      const fxHist = await fetchFull(fx);
      if (fxHist) toSave.push(fxHist);
    }
    this.version++;
    writeHistories(toSave);
    notify();
    return histories.get(symbol) || merged;
  },

  // Append the latest quotes to every symbol (and the FX rates of their currencies).
  // Symbols without a history get the full 10 years. Skipped if the last refresh was less
  // than 60 s ago, unless force (new symbols are still downloaded).
  // onProgress(done, total) is called as symbols complete.
  async refresh(symbols, opts = {}) {
    const wanted = (Array.isArray(symbols) ? symbols : []).filter((s) => validSymbol(s) && !isDemo(s));
    if (refreshing) {
      if (!opts.force && wanted.every((s) => refreshingSet.has(s))) return refreshing;
      await refreshing.catch(() => {});
    }
    refreshingSet = new Set(wanted);
    const run = runRefresh(symbols, opts);
    refreshing = run;
    try {
      return await run;
    } finally {
      if (refreshing === run) {
        refreshing = null;
        refreshingSet = null;
      }
    }
  },

  // Name, currency, type, exchange and last price of one symbol (to add an asset); null if unknown
  async lookup(symbol) {
    if (!validSymbol(symbol) || isDemo(symbol)) return null;
    const fromCache = () => {
      const h = hasRealHistory(symbol) ? histories.get(symbol) : null;
      return h ? { symbol, name: h.name || symbol, currency: h.currency, type: h.type || 'other', exchange: h.exchange || '', price: h.price ?? h.close[h.close.length - 1], prev: h.prev ?? null, time: h.time ?? null } : null;
    };
    if (!(await ensureOnline())) return fromCache();
    try {
      const j = await apiGet(`/chart?symbol=${encodeURIComponent(symbol)}&range=5d&interval=1d`);
      const close = Array.isArray(j.close) ? j.close : [];
      return {
        symbol: j.symbol || symbol,
        name: j.name || symbol,
        currency: j.currency || null,
        type: j.type || 'other',
        exchange: j.exchange || '',
        price: num(j.price) ?? (close.length ? close[close.length - 1] : null),
        prev: num(j.prev),
        time: num(j.time),
      };
    } catch (e) {
      return e.offline ? fromCache() : null;
    }
  },

  // Forget every downloaded price (memory and IndexedDB); demo data stays
  async clearCache() {
    for (const [k, h] of [...histories.entries()]) {
      if (isDemo(k) || (h && h.synthetic)) continue;
      histories.delete(k);
      memoryOnly.delete(k);
    }
    searchCache.clear();
    notFound.clear();
    this.lastRefresh = 0;
    if (dbReady) await dbReady;
    await idbRun('readwrite', (st) => st.clear());
    this.version++;
    notify();
  },
};
