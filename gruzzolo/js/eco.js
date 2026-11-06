// Data of the Mercati tab: public economy and market data (heatmaps, yield curves, macro indicators,
// indices, commodities, currencies, crypto) from the app's own /api/eco/* routes, which read the
// TradingView screener. Nothing here is user data.
//
// Every answer is an "entry" { key, path, data, fetchedAt } kept in memory and in IndexedDB
// ('gruzzolo-eco', store 'answers'), so the pages open offline with the last data downloaded.
// Views ask for what they show with load(key, path, { maxAge }): a fresh entry is not downloaded again,
// a failed download waits RETRY_MS before the next automatic try (force skips both rules).
import { market } from './market.js';

const DB_NAME = 'gruzzolo-eco';
const STORE = 'answers';
const REQUEST_TIMEOUT_MS = 15000;
const DB_OPEN_TIMEOUT_MS = 3000;
const RETRY_MS = 30e3;
const KEEP_HEATMAPS = 6; // heatmaps of other indices kept for offline use (least recently downloaded go)

const entries = new Map(); // key → { key, path, data, fetchedAt }
const pending = new Map(); // key → Promise
const failures = new Map(); // key → { message, at, offline }
const listeners = new Set();

let db = null;
let dbReady = null;

function notify() {
  eco.version++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

/* ---------- IndexedDB (best effort: any failure means memory only) ---------- */
function idbOpen() {
  return new Promise((resolve) => {
    let factory = null;
    try {
      factory = globalThis.indexedDB || null;
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
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      } catch { /* the open request fails on its own */ }
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

const validEntry = (e) => Boolean(e && typeof e.key === 'string' && e.data && typeof e.data === 'object' && Number.isFinite(e.fetchedAt));

/* ---------- Network ---------- */
function apiRoot() {
  return String(market.apiBase || '').trim().replace(/\/+$/, '') + '/api';
}

// GET apiRoot + path → parsed JSON; throws { message, offline } on failure
async function apiGet(path) {
  if (typeof fetch !== 'function') throw Object.assign(new Error('Rete non disponibile'), { offline: true });
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), REQUEST_TIMEOUT_MS);
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
    throw Object.assign(new Error('Server non raggiungibile'), { offline: true });
  } finally {
    clearTimeout(timer);
  }
  // No JSON at all: there is no API on this host (static preview) or the connection broke
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Server non raggiungibile'), { offline: true });
  if (!res.ok) throw new Error(body.error || `Errore ${res.status}`);
  return body;
}

function forgetOldHeatmaps(keep) {
  const maps = [...entries.values()].filter((e) => e.key.startsWith('heatmap:') && e.key !== keep).sort((a, b) => b.fetchedAt - a.fetchedAt);
  const gone = maps.slice(KEEP_HEATMAPS - 1).map((e) => e.key);
  if (!gone.length) return;
  for (const k of gone) entries.delete(k);
  idbRun('readwrite', (st) => {
    for (const k of gone) st.delete(k);
  });
}

async function download(key, path) {
  try {
    const data = await apiGet(path);
    const entry = { key, path, data, fetchedAt: Date.now() };
    entries.set(key, entry);
    failures.delete(key);
    if (key.startsWith('heatmap:')) forgetOldHeatmaps(key);
    if (dbReady) dbReady.then(() => idbRun('readwrite', (st) => st.put(entry)));
    return entry;
  } catch (e) {
    failures.set(key, { message: e && e.message ? e.message : 'Errore', at: Date.now(), offline: Boolean(e && e.offline) });
    return entries.get(key) || null;
  }
}

/* ---------- Public object ---------- */
export const eco = {
  version: 0,

  // Open the offline copy once (never throws); views call it when the Mercati tab opens
  init() {
    if (!dbReady) {
      dbReady = (async () => {
        db = await idbOpen();
        if (!db) return;
        const rows = await idbRun('readonly', (st) => st.getAll());
        let loaded = 0;
        for (const r of Array.isArray(rows) ? rows : []) {
          if (!validEntry(r)) continue;
          const cur = entries.get(r.key);
          if (cur && cur.fetchedAt >= r.fetchedAt) continue;
          entries.set(r.key, r);
          loaded++;
        }
        if (loaded) notify();
      })().catch(() => {
        db = null;
      });
    }
    return dbReady;
  },

  entry(key) {
    return entries.get(key) || null;
  },

  data(key) {
    const e = entries.get(key);
    return e ? e.data : null;
  },

  isLoading(key) {
    return pending.has(key);
  },

  // Last failure of a key, or null when the last download worked
  failure(key) {
    return failures.get(key) || null;
  },

  // Download key from path unless a fresh copy exists (age < maxAge) or a recent try failed.
  // Resolves with the entry (old or new) or null; notifies listeners when something changed.
  load(key, path, { maxAge = 60e3, force = false } = {}) {
    if (pending.has(key)) return pending.get(key);
    const cur = entries.get(key);
    const fresh = cur && cur.path === path && Date.now() - cur.fetchedAt < maxAge;
    const failed = failures.get(key);
    if (!force && (fresh || (failed && Date.now() - failed.at < RETRY_MS))) return Promise.resolve(cur || null);
    const p = (async () => {
      await this.init();
      return download(key, path);
    })().finally(() => {
      pending.delete(key);
      notify();
    });
    pending.set(key, p);
    notify();
    return p;
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // URL of a company or crypto logo, served by our own API (the app contacts no other site)
  logoUrl(id) {
    return `${apiRoot()}/eco/logo?id=${encodeURIComponent(id)}`;
  },

  // Forget every downloaded answer (memory and IndexedDB)
  async clear() {
    entries.clear();
    failures.clear();
    if (dbReady) await dbReady;
    await idbRun('readwrite', (st) => st.clear());
    notify();
  },
};
