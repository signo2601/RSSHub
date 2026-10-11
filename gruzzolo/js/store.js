// Persistence of the user's data: only this device's localStorage (key 'gruzzolo:data:v2').
// The data never leaves the phone: there is no cloud copy and no sync. Market prices are kept
// separately by market.js in IndexedDB. The same storage is used when the page runs as a Claude
// artifact preview (that copy lives in the preview's own browser storage).
//
// store = await pickStore() → { kind: 'local', load(), save(data), flush() }
//   load()  → raw data object or null (main.js passes it through migrate())
//   save()  → never throws; problems are shown with app.toast
//   flush() → nothing to do (writes are synchronous); kept for callers
import { app } from './app.js';
import { migrate } from './state.js';

export const LOCAL_KEY = 'gruzzolo:data:v2';
export const LOCAL_KEY_V1 = 'gruzzolo:data:v1';
export const CORRUPT_KEY = 'gruzzolo:data:v2:corrupt';

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
        if (!warned) app.toast('Salvataggio non riuscito: la memoria del telefono per l\'app è piena o bloccata. Esporta un backup da Altro.');
        warned = true;
      }
    },
    async flush() {},
  };
}

// Entry point used by main.js: the data always stays on this device
export async function pickStore() {
  return localStore();
}
