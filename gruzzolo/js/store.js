// Persistence of the user's data: the Claude artifact private database when the page runs
// as an artifact (window.claude.use('db') + use('user')), otherwise this device's localStorage.
//
// store = await pickStore() → { kind: 'local' | 'db', load(), save(data), flush() }
//   load()  → raw data object or null (main.js passes it through migrate()); rejects only when
//             the artifact database cannot be read (saves are then refused, so nothing is overwritten)
//   save()  → never throws; problems are shown with app.toast
//   flush() → write pending changes now (resolves when written)
import { app } from './app.js';
import { migrate } from './state.js';

export const LOCAL_KEY = 'gruzzolo:data:v2';
export const LOCAL_KEY_V1 = 'gruzzolo:data:v1';
export const BACKUP_KEY = 'gruzzolo:backup:v1';
const CORRUPT_KEY = 'gruzzolo:data:v2:corrupt';
const DB_DEBOUNCE_MS = 500;
const USE_TIMEOUT_MS = 12000;
// Artifact db documents are limited to 256 KiB: a year of transactions is split in chunks below this size
const DOC_MAX_CHARS = 200000;
const BACKUP_DOC_MAX_CHARS = 240000;

/* ---------- localStorage helpers (access itself can throw in private mode or sandboxes) ---------- */
function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
function lsGet(key) {
  try {
    const ls = storage();
    return ls ? ls.getItem(key) : null;
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  const ls = storage();
  if (!ls) return false;
  ls.setItem(key, value); // may throw (quota): callers decide
  return true;
}
function trySet(key, value) {
  try {
    return lsSet(key, value);
  } catch {
    return false;
  }
}

const isV1 = (raw) => Boolean(raw && typeof raw === 'object' && raw.v !== 2);

// One-time copy of data in the first Gruzzolo format before it gets overwritten
function backupV1(json) {
  if (!json || lsGet(BACKUP_KEY)) return false;
  return trySet(BACKUP_KEY, json);
}

/* ---------- Device storage ---------- */
export function localStore() {
  let warned = false;
  return {
    kind: 'local',
    async load() {
      const raw = lsGet(LOCAL_KEY);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {
          // Keep the unreadable text aside instead of overwriting it at the next save
          trySet(CORRUPT_KEY, raw);
          app.toast('I dati salvati su questo dispositivo sono danneggiati: ne ho tenuto una copia e riparto da zero.');
          return null;
        }
      }
      // First start of v2 on a device that used the first version: convert, keep the v1 copy
      const old = lsGet(LOCAL_KEY_V1);
      if (!old) return null;
      try {
        return migrate(JSON.parse(old));
      } catch {
        return null;
      }
    },
    save(data) {
      try {
        if (!lsSet(LOCAL_KEY, JSON.stringify(data))) throw new Error('no storage');
        warned = false;
      } catch {
        if (!warned) app.toast('Salvataggio non riuscito: la memoria del browser è piena o bloccata. Esporta un backup da Altro.');
        warned = true;
      }
    },
    async flush() {},
  };
}

/* ---------- Claude artifact database ---------- */
// Document layout (same as the first version, so its data is found and converted):
//   data/users/<id>/app              → everything except txns and prices
//   data/users/<id>/app/tx/y<year>   → { items: Txn[] }  (y<year>-<n> for further chunks of a big year)
//   data/users/<id>/app/px/<aid>     → { points: [[date, price], ...] }
export function splitDocs(data) {
  const docs = new Map();
  const { txns = [], prices = {}, ...rest } = data || {};
  docs.set('app', rest);
  const years = new Map();
  for (const t of txns) {
    const y = 'y' + String((t && t.date) || '0000').slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(t);
  }
  for (const [y, items] of years) {
    let chunk = [];
    let size = 0;
    let n = 1;
    const put = () => {
      docs.set('tx/' + (n === 1 ? y : `${y}-${n}`), { items: chunk });
      n++;
      chunk = [];
      size = 0;
    };
    for (const t of items) {
      const len = JSON.stringify(t).length + 1;
      if (chunk.length && size + len > DOC_MAX_CHARS) put();
      chunk.push(t);
      size += len;
    }
    if (chunk.length) put();
  }
  for (const [aid, points] of Object.entries(prices || {})) {
    if (!Array.isArray(points) || !points.length) continue;
    const id = docId(aid);
    docs.set('px/' + id, id === aid ? { points } : { aid, points });
  }
  return docs;
}

// Document ids allow only letters, digits and _ - . ~ : @ + (max 200 bytes): other asset ids are
// stored under a hashed id with the real id inside the body
const SAFE_ID = /^[A-Za-z0-9_\-.~:@+]{1,150}$/;
function docId(aid) {
  const s = String(aid);
  if (SAFE_ID.test(s) && s !== '.' && s !== '..') return s;
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return 'id~' + h.toString(36) + '~' + s.length;
}

// 'y2024' → [2024, 1], 'y2024-3' → [2024, 3]: chunks are read back in order
function chunkOrder(id) {
  const m = /^y(\d+)(?:-(\d+))?$/.exec(id);
  return m ? [Number(m[1]), Number(m[2] || 1)] : [Infinity, 0];
}

const plain = (x) => JSON.parse(JSON.stringify(x));
const errCode = (e) => (e && typeof e === 'object' && e.code) || '';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry after a short random pause for transient platform errors
async function withRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    if (errCode(e) !== 'unavailable') throw e;
    await pause(300 + Math.random() * 700);
    return fn();
  }
}

function saveError(e) {
  const code = errCode(e);
  if (code === 'quota_exceeded') return 'Salvataggio non riuscito: lo spazio dati è esaurito. Esporta un backup da Altro.';
  if (code === 'invalid_argument') return 'Salvataggio non riuscito: un gruppo di dati è troppo grande. Esporta un backup da Altro.';
  if (code === 'revoked' || code === 'not_granted') return 'Salvataggio non riuscito: questa pagina non ha più accesso ai dati salvati. Ricarica la pagina.';
  return 'Salvataggio non riuscito (connessione o permessi). Riproverò alla prossima modifica; intanto puoi esportare un backup da Altro.';
}

export function dbStore(db, userId) {
  const root = db.doc(`data/users/${userId}/app`);
  const last = new Map(); // doc key → JSON written (or read) last
  let queue = Promise.resolve();
  let timer = null;
  let pending = null;
  let retry = null; // data of a failed write, written again at the next flush
  let failing = false;
  let blocked = false; // the stored data could not be read: never overwrite it
  let v1Json = null; // data found in the first-version format, backed up before the first overwrite

  const ref = (key) => {
    if (key === 'app') return root;
    const i = key.indexOf('/');
    return root.collection(key.slice(0, i)).doc(key.slice(i + 1));
  };

  async function write(data) {
    if (v1Json) {
      backupV1(v1Json);
      if (v1Json.length < BACKUP_DOC_MAX_CHARS) {
        try {
          await root.collection('backup').doc('v1').set(JSON.parse(v1Json));
        } catch { /* the localStorage copy is the main backup */ }
      }
      v1Json = null;
    }
    const docs = splitDocs(data);
    // 'app' goes last: while it still holds first-version data, the old format stays readable
    const keys = [...docs.keys()].filter((k) => k !== 'app');
    keys.push('app');
    for (const key of keys) {
      const body = docs.get(key);
      const json = JSON.stringify(body);
      if (last.get(key) === json) continue;
      await withRetry(() => ref(key).set(body));
      last.set(key, json);
    }
    for (const key of [...last.keys()]) {
      if (docs.has(key)) continue;
      await withRetry(() => ref(key).delete());
      last.delete(key);
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending && retry) pending = retry;
    retry = null;
    if (!pending || blocked) return queue;
    const data = plain(pending);
    pending = null;
    queue = queue
      .then(() => write(data))
      .then(() => {
        failing = false;
      })
      .catch((e) => {
        if (!pending) retry = data;
        if (!failing) app.toast(saveError(e));
        failing = true;
      });
    return queue;
  }

  return {
    kind: 'db',
    async load() {
      let main;
      let tx;
      let px;
      try {
        [main, tx, px] = await withRetry(() => Promise.all([root.get(), root.collection('tx').get(), root.collection('px').get()]));
      } catch (e) {
        // Never overwrite data that could not be read: saves stay off, the caller tells the user
        blocked = true;
        throw Object.assign(new Error('Non riesco a leggere i dati salvati. Ricarica la pagina.'), { code: errCode(e) || 'unavailable' });
      }
      if (!main.exists && tx.empty && px.empty) return null;
      const base = main.exists ? plain(main.data() || {}) : {};
      if (main.exists) last.set('app', JSON.stringify(main.data()));
      const raw = { ...base, txns: [], prices: {} };
      const txDocs = [...tx.docs].sort((a, b) => {
        const [ya, na] = chunkOrder(a.id);
        const [yb, nb] = chunkOrder(b.id);
        return ya - yb || na - nb || (a.id < b.id ? -1 : 1);
      });
      for (const d of txDocs) {
        const body = d.data() || {};
        raw.txns.push(...plain(Array.isArray(body.items) ? body.items : []));
        last.set('tx/' + d.id, JSON.stringify(body));
      }
      for (const d of px.docs) {
        const body = d.data() || {};
        raw.prices[typeof body.aid === 'string' ? body.aid : d.id] = plain(Array.isArray(body.points) ? body.points : []);
        last.set('px/' + d.id, JSON.stringify(body));
      }
      if (isV1(raw)) {
        // A write interrupted halfway can leave v2 transactions (acc) beside the v1 main document
        for (const t of raw.txns) if (t && !t.pid && t.acc) t.pid = t.acc;
        v1Json = JSON.stringify(raw);
      }
      return raw;
    },
    save(data) {
      if (blocked || !data) return;
      try {
        pending = data;
        clearTimeout(timer);
        timer = setTimeout(flush, DB_DEBOUNCE_MS);
      } catch { /* never throw from save */ }
    },
    flush,
  };
}

function withTimeout(promise, ms) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// Claude artifact database when available (signed-in viewer), else this device
export async function pickStore() {
  const w = typeof window !== 'undefined' ? window : globalThis;
  const claude = w && w.claude;
  if (claude && typeof claude.use === 'function') {
    try {
      const pair = await withTimeout((async () => {
        const db = await claude.use('db');
        const user = db ? await claude.use('user') : null;
        const userId = user && typeof user.id === 'function' ? await user.id() : null;
        return db && userId ? { db, userId } : null;
      })(), USE_TIMEOUT_MS);
      if (pair) return dbStore(pair.db, pair.userId);
    } catch { /* fall back to device storage */ }
  }
  return localStore();
}
