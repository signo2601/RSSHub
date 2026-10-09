// End-to-end encrypted sync of the whole dataset between the user's devices through
// /api/sync/:id (see functions/api/[[path]].js). The server only ever sees ciphertext.
//
// From the passphrase (never stored) two independent values are derived with PBKDF2-SHA256:
//   id  = hex(PBKDF2(passphrase, 'gruzzolo-sync-id-v1', 250000 iterations, 256 bits))  → storage slot
//   key = PBKDF2(passphrase, 'gruzzolo-sync-key-v1', 250000) → AES-GCM 256 key
// localStorage 'gruzzolo:sync' keeps { id, key (raw, base64), lastSync, lastRemote }.
// Blob: JSON → gzip (CompressionStream, flag z: 1) → AES-GCM (random 12-byte iv)
//   → { updatedAt, iv, ct, z } with iv/ct in base64.
// Conflicts: the copy with the newer updatedAt wins (reconcile), except that a device holding
// only example data (or nothing) always adopts an existing remote copy with real data.
import { market } from './market.js';

export const SYNC_KEY = 'gruzzolo:sync';
const ID_SALT = 'gruzzolo-sync-id-v1';
const KEY_SALT = 'gruzzolo-sync-key-v1';
export const ITERATIONS = 250000;
export const MIN_PASSPHRASE = 10;
const REQUEST_TIMEOUT_MS = 20000;
let pushDelayMs = 2000;

export const MESSAGES = {
  short: `La frase segreta deve avere almeno ${MIN_PASSPHRASE} caratteri.`,
  crypto: 'Questo browser non supporta la cifratura necessaria (WebCrypto): aggiorna il browser.',
  off: 'La sincronizzazione non è attiva su questo dispositivo.',
  unavailable: 'Sincronizzazione non attiva sul server: segui la guida in Altro → Sincronizzazione',
  offline: 'Sincronizzazione non riuscita: sei offline o il server non risponde. Riproverò più tardi.',
  decrypt: 'Non riesco a leggere i dati sincronizzati: sono danneggiati o cifrati con un\'altra frase.',
  gzip: 'Questo browser non sa aprire i dati compressi dall\'altro dispositivo: aggiornalo.',
  tooBig: 'I dati sono troppo grandi per la sincronizzazione (massimo 4 MB).',
  server: 'Il server di sincronizzazione ha risposto con un errore. Riprova tra poco.',
};

class SyncError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || MESSAGES.server);
    this.name = 'SyncError';
    this.code = code;
  }
}

/* ---------- Encoding helpers ---------- */
const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(text) {
  const s = atob(String(text || ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle || typeof c.getRandomValues !== 'function') throw new SyncError('crypto');
  return c.subtle;
}

async function pipeBytes(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/* ---------- Keys ---------- */
// Same input → same keys on every device. Leading/trailing spaces are ignored (phone keyboards add them).
export const normalizePassphrase = (p) => String(p ?? '').normalize('NFC').trim();
export const passphraseError = (p) => (normalizePassphrase(p).length < MIN_PASSPHRASE ? MESSAGES.short : '');

async function pbkdf2(pass, salt, iterations) {
  const s = subtle();
  const base = await s.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, base, 256));
}

// → { id: 64 hex chars, key: raw AES key in base64 }
export async function deriveSyncKeys(passphrase, { iterations = ITERATIONS } = {}) {
  const pass = normalizePassphrase(passphrase);
  const [idBits, keyBits] = await Promise.all([pbkdf2(pass, ID_SALT, iterations), pbkdf2(pass, KEY_SALT, iterations)]);
  return { id: toHex(idBits), key: toBase64(keyBits) };
}

const keyCache = new Map();
async function aesKey(keyB64) {
  if (!keyCache.has(keyB64)) {
    keyCache.clear();
    keyCache.set(keyB64, subtle().importKey('raw', fromBase64(keyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']));
  }
  return keyCache.get(keyB64);
}

/* ---------- Envelope ---------- */
export async function seal(data, keyB64, { compress = true } = {}) {
  let bytes = enc.encode(JSON.stringify(data));
  let z = 0;
  if (compress && typeof CompressionStream === 'function') {
    try {
      bytes = await pipeBytes(bytes, new CompressionStream('gzip'));
      z = 1;
    } catch { /* send it uncompressed */ }
  }
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, await aesKey(keyB64), bytes));
  const out = { updatedAt: Number(data && data.updatedAt) || 0, iv: toBase64(iv), ct: toBase64(ct) };
  if (z) out.z = 1;
  return out;
}

export async function open(envelope, keyB64) {
  let bytes;
  try {
    bytes = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(envelope.iv) }, await aesKey(keyB64), fromBase64(envelope.ct)));
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw new SyncError('decrypt');
  }
  if (envelope.z) {
    if (typeof DecompressionStream !== 'function') throw new SyncError('gzip');
    try {
      bytes = await pipeBytes(bytes, new DecompressionStream('gzip'));
    } catch {
      throw new SyncError('decrypt');
    }
  }
  try {
    const data = JSON.parse(dec.decode(bytes));
    if (!data || typeof data !== 'object') throw new Error('not an object');
    return data;
  } catch {
    throw new SyncError('decrypt');
  }
}

/* ---------- Local configuration ---------- */
function readCfg() {
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem(SYNC_KEY);
    const c = raw ? JSON.parse(raw) : null;
    return c && /^[0-9a-f]{64}$/.test(c.id) && typeof c.key === 'string' ? c : null;
  } catch {
    return null;
  }
}
function writeCfg(c) {
  try {
    if (c) globalThis.localStorage.setItem(SYNC_KEY, JSON.stringify(c));
    else globalThis.localStorage.removeItem(SYNC_KEY);
    return true;
  } catch {
    return false;
  }
}
function patchCfg(patch) {
  const c = readCfg();
  if (c) writeCfg({ ...c, ...patch });
}
function requireCfg() {
  const c = readCfg();
  if (!c) throw new SyncError('off');
  return c;
}

/* ---------- Status ---------- */
const listeners = new Set();
let current = { state: readCfg() ? 'idle' : 'off', message: '' };

function setStatus(state, message = '') {
  if (current.state === state && current.message === message) return;
  current = { state, message };
  const snap = sync.status();
  for (const fn of [...listeners]) {
    try {
      fn(snap);
    } catch { /* a listener must not break sync */ }
  }
}

function fail(e) {
  const code = e && e.code;
  if (code === 'unavailable') setStatus('unavailable', MESSAGES.unavailable);
  else setStatus('error', (e instanceof SyncError && e.message) || MESSAGES.server);
}

/* ---------- Network ---------- */
function syncUrl(id) {
  return String(market.apiBase || '').trim().replace(/\/+$/, '') + '/api/sync/' + id;
}

async function request(method, id, body = null) {
  if (typeof globalThis.fetch !== 'function') throw new SyncError('offline');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let json = null;
  try {
    const init = { method, headers: { Accept: 'application/json' }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined };
    if (body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = body;
    }
    res = await globalThis.fetch(syncUrl(id), init);
    try {
      json = await res.json();
    } catch {
      json = null;
    }
  } catch {
    throw new SyncError('offline');
  } finally {
    clearTimeout(timer);
  }
  return { status: res.status, ok: res.ok, json: json && typeof json === 'object' ? json : null };
}

// Remote envelope or null when nothing is stored yet
async function getEnvelope(id) {
  const r = await request('GET', id);
  if (r.ok) {
    if (r.json && typeof r.json.iv === 'string' && typeof r.json.ct === 'string') return r.json;
    throw new SyncError(r.json ? 'decrypt' : 'unavailable'); // HTML page: no sync API on this host
  }
  // A 404 from our server is JSON; a static host without the API answers with an HTML page
  if (r.status === 404 && r.json) return null;
  if (r.status === 404 || r.status === 405 || r.status === 501) throw new SyncError('unavailable');
  throw new SyncError('server', `${MESSAGES.server} (errore ${r.status})`);
}

async function putEnvelope(id, envelope) {
  const r = await request('PUT', id, JSON.stringify(envelope));
  if (r.ok && r.json) return;
  if (r.status === 413) throw new SyncError('tooBig');
  if (r.ok || r.status === 404 || r.status === 405 || r.status === 501) throw new SyncError('unavailable');
  throw new SyncError('server', `${MESSAGES.server} (errore ${r.status})`);
}

/* ---------- Decisions ---------- */
// True when the dataset holds something the user created (not only the example portfolio)
export function hasUserContent(d) {
  if (!d || typeof d !== 'object') return false;
  const txns = Array.isArray(d.txns) ? d.txns : [];
  const assets = d.assets && typeof d.assets === 'object' ? Object.values(d.assets) : [];
  const watch = Array.isArray(d.watch) ? d.watch : [];
  return txns.some((t) => t && !t.demo) || assets.some((a) => a && !a.demo) || watch.some((w) => w && !w.demo);
}

/* ---------- Push queue ---------- */
let timer = null;
let queued = null;
let chain = Promise.resolve();

async function pushNow(data) {
  const c = requireCfg();
  setStatus('syncing');
  try {
    const envelope = await seal(data, c.key);
    await putEnvelope(c.id, envelope);
    patchCfg({ lastSync: Date.now(), lastRemote: envelope.updatedAt });
    setStatus('ok');
    return envelope.updatedAt;
  } catch (e) {
    fail(e);
    throw e;
  }
}

// Pushes run one after the other
function enqueue(data) {
  const run = chain.then(() => pushNow(data));
  chain = run.catch(() => {});
  return run;
}

/* ---------- Public API ---------- */
export const sync = {
  enabled() {
    return Boolean(readCfg());
  },

  status() {
    const c = readCfg();
    const state = c ? (current.state === 'off' ? 'idle' : current.state) : 'off';
    return { state, lastSync: c ? c.lastSync || 0 : 0, message: state === 'off' ? '' : current.message };
  },

  // Derive the keys and turn sync on. With localData the first exchange is a reconcile
  // (→ { data, action }); without it the remote copy is only read (→ { data|null, action: 'pulled'|'none' }).
  // Throws a SyncError (Italian message) for a short passphrase, missing WebCrypto or network problems;
  // after a network problem sync stays on and status() tells what happened.
  async enable(passphrase, localData = null) {
    const err = passphraseError(passphrase);
    if (err) throw new SyncError('short', err);
    subtle();
    clearTimeout(timer);
    timer = null;
    queued = null;
    setStatus('syncing', 'Preparo le chiavi di cifratura…');
    let keys;
    try {
      keys = await deriveSyncKeys(passphrase);
    } catch (e) {
      setStatus(readCfg() ? 'error' : 'off', '');
      throw e instanceof SyncError ? e : new SyncError('crypto');
    }
    writeCfg({ id: keys.id, key: keys.key, lastSync: 0, lastRemote: 0 });
    if (localData) return this.reconcile(localData);
    const data = await this.pull();
    return { data, action: data ? 'pulled' : 'none' };
  },

  disable() {
    clearTimeout(timer);
    timer = null;
    queued = null;
    writeCfg(null);
    setStatus('off');
  },

  // Remote data (raw, to pass through migrate) or null when nothing is stored yet
  async pull() {
    const c = requireCfg();
    setStatus('syncing');
    try {
      const envelope = await getEnvelope(c.id);
      if (!envelope) {
        setStatus('ok');
        return null;
      }
      const data = await open(envelope, c.key);
      patchCfg({ lastSync: Date.now(), lastRemote: Number(envelope.updatedAt) || 0 });
      setStatus('ok');
      return data;
    } catch (e) {
      fail(e);
      throw e;
    }
  },

  async push(data) {
    if (queued === data) {
      clearTimeout(timer);
      timer = null;
      queued = null;
    }
    await enqueue(data);
  },

  // Debounced push (2 s) of the latest data; never throws
  schedulePush(data) {
    if (!data || !readCfg()) return;
    queued = data;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const d = queued;
      queued = null;
      if (d) enqueue(d).catch(() => {});
    }, pushDelayMs);
  },

  // Push a scheduled change right away (e.g. when the page is hidden); never throws
  async flush() {
    if (!queued) return chain;
    clearTimeout(timer);
    timer = null;
    const d = queued;
    queued = null;
    return enqueue(d).catch(() => {});
  },

  // Compare with the remote copy: newer remote → { data: remote, action: 'pulled' };
  // newer local (or nothing remote) → push, 'pushed'; same updatedAt → 'none'.
  async reconcile(localData) {
    const c = requireCfg();
    setStatus('syncing');
    try {
      await chain;
      const envelope = await getEnvelope(c.id);
      if (!envelope) {
        await enqueue(localData);
        return { data: localData, action: 'pushed' };
      }
      const remoteAt = Number(envelope.updatedAt) || 0;
      const localAt = Number(localData && localData.updatedAt) || 0;
      let remote = null;
      const adopt = async () => {
        remote ||= await open(envelope, c.key);
        patchCfg({ lastSync: Date.now(), lastRemote: remoteAt });
        setStatus('ok');
        return { data: remote, action: 'pulled' };
      };
      // A device with only the example portfolio (or nothing) takes over the real data
      if (!hasUserContent(localData)) {
        remote = await open(envelope, c.key);
        if (hasUserContent(remote)) return adopt();
      }
      if (remoteAt > localAt) return adopt();
      if (localAt > remoteAt) {
        await enqueue(localData);
        return { data: localData, action: 'pushed' };
      }
      patchCfg({ lastSync: Date.now(), lastRemote: remoteAt });
      setStatus('ok');
      return { data: localData, action: 'none' };
    } catch (e) {
      fail(e);
      throw e;
    }
  },

  // fn(status) after every status change; returns an unsubscribe function
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  passphraseError,
};

export const _test = {
  setPushDelay(ms) {
    pushDelayMs = ms;
  },
  reset() {
    clearTimeout(timer);
    timer = null;
    queued = null;
    chain = Promise.resolve();
    keyCache.clear();
    current = { state: readCfg() ? 'idle' : 'off', message: '' };
  },
  SyncError,
};
