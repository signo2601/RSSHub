import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../js/app.js';
import { migrate, blankData } from '../js/state.js';
import { pickStore, localStore, dbStore, splitDocs, LOCAL_KEY, LOCAL_KEY_V1, BACKUP_KEY } from '../js/store.js';

/* ---------- Fakes ---------- */
function fakeLocalStorage({ failWrites = false } = {}) {
  const map = new Map();
  return {
    map,
    failWrites,
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (this.failWrites) throw Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' });
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
  };
}

const copy = (x) => JSON.parse(JSON.stringify(x));

// Minimal Claude artifact db: documents by path, collections list their direct children
function fakeDb() {
  const docs = new Map();
  const log = [];
  let failNext = null;
  const docRef = (path) => ({
    id: path.split('/').pop(),
    path,
    async get() {
      const b = docs.get(path);
      return { id: path.split('/').pop(), exists: b !== undefined, data: () => (b === undefined ? undefined : copy(b)) };
    },
    async set(body) {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      log.push(['set', path]);
      docs.set(path, copy(body));
    },
    async delete() {
      log.push(['delete', path]);
      docs.delete(path);
    },
    collection(name) {
      return colRef(path + '/' + name);
    },
  });
  const colRef = (path) => ({
    path,
    doc: (id) => docRef(path + '/' + id),
    async get() {
      const list = [...docs.keys()]
        .filter((k) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
        .sort()
        .map((k) => ({ id: k.slice(path.length + 1), exists: true, data: () => copy(docs.get(k)) }));
      return { docs: list, size: list.length, empty: !list.length };
    },
  });
  return {
    docs,
    log,
    failOnce(err) {
      failNext = err;
    },
    api: { doc: docRef, collection: colRef },
  };
}

const toasts = [];
app.toast = (m) => toasts.push(m);

function sampleV2() {
  const d = blankData();
  d.updatedAt = 1700000000000;
  d.settings.started = true;
  d.accounts = [{ id: 'a1', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }];
  d.assets.x = { id: 'x', name: 'Enel', ticker: 'ENEL', symbol: 'ENEL.MI', isin: 'IT0003128367', type: 'stock', currency: 'EUR', exchange: 'Milano', sector: 'Utility', region: 'Italia', ter: null, priceSource: 'auto' };
  d.assets.m = { id: 'm', name: 'BTP', ticker: 'BTP', symbol: '', isin: '', type: 'bond', currency: 'EUR', exchange: '', sector: '', region: '', ter: null, priceSource: 'manual' };
  d.txns = [
    { id: 't1', acc: 'a1', date: '2024-03-01', type: 'deposit', amount: 1000 },
    { id: 't2', acc: 'a1', date: '2024-03-02', type: 'buy', aid: 'x', qty: 100, price: 6.1, fee: 4.9 },
    { id: 't3', acc: 'a1', date: '2025-01-22', type: 'div', aid: 'x', amount: 15.9, gross: 21.5, tax: 5.6 },
  ];
  d.prices.m = [['2025-01-31', 99.5], ['2025-02-28', 100.1]];
  return d;
}

// Data in the first Gruzzolo format (single portfolio list, txns with pid, prices in EUR)
const V1 = {
  v: 1,
  settings: { started: true },
  portfolios: [{ id: 'p1', name: 'Conto titoli' }, { id: 'p2', name: 'Crypto' }],
  assets: { a: { id: 'a', name: 'Vanguard FTSE All-World', ticker: 'VWCE', type: 'etf', sector: 'Diversificato', region: 'Globale' } },
  txns: [
    { id: 'v1a', pid: 'p1', aid: 'a', type: 'buy', date: '2023-05-02', qty: 3, price: 100, fee: 2 },
    { id: 'v1b', pid: 'p2', aid: 'a', type: 'buy', date: '2024-02-01', qty: 1, price: 110, fee: 0 },
  ],
  prices: { a: [['2024-06-03', 118]] },
  watch: [{ id: 'w', name: 'ASML', ticker: 'ASML', price: 640, target: 600, note: '' }],
};

/* ---------- Device storage ---------- */
test('pickStore falls back to localStorage outside a Claude artifact', async () => {
  globalThis.localStorage = fakeLocalStorage();
  delete globalThis.window;
  const store = await pickStore();
  assert.equal(store.kind, 'local');
  assert.equal(await store.load(), null);
});

test('local store: save and load roundtrip under gruzzolo:data:v2', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  const store = localStore();
  const data = sampleV2();
  store.save(data);
  await store.flush();
  assert.ok(ls.map.has(LOCAL_KEY));
  const back = await store.load();
  assert.deepEqual(back, data);
  assert.deepEqual(migrate(back), migrate(data));
});

test('local store: first v2 start converts gruzzolo:data:v1 and keeps it', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  ls.setItem(LOCAL_KEY_V1, JSON.stringify(V1));
  const store = localStore();
  const d = await store.load();
  assert.equal(d.v, 2);
  assert.deepEqual(d.accounts.map((a) => a.id), ['p1', 'p2']);
  assert.deepEqual(d.txns.map((t) => t.acc), ['p1', 'p2']);
  assert.equal(d.assets.a.priceSource, 'manual');
  assert.equal(d.watch[0].target, 600);
  // main.js runs migrate again: still the same v2 data
  assert.deepEqual(migrate(d), d);
  store.save(d);
  assert.ok(ls.map.has(LOCAL_KEY), 'v2 data written under the new key');
  assert.equal(JSON.parse(ls.getItem(LOCAL_KEY_V1)).v, 1, 'v1 copy untouched');
  // Next start reads v2
  const again = await localStore().load();
  assert.equal(again.v, 2);
});

test('local store: unreadable data is kept aside, save never throws', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  ls.setItem(LOCAL_KEY, '{broken');
  toasts.length = 0;
  const store = localStore();
  assert.equal(await store.load(), null);
  assert.equal(ls.getItem('gruzzolo:data:v2:corrupt'), '{broken');
  assert.equal(toasts.length, 1);
  ls.failWrites = true;
  toasts.length = 0;
  assert.doesNotThrow(() => store.save(sampleV2()));
  assert.doesNotThrow(() => store.save(sampleV2()));
  assert.equal(toasts.length, 1, 'one toast per failure streak');
  assert.match(toasts[0], /Salvataggio non riuscito/);
});

/* ---------- Claude artifact database ---------- */
test('splitDocs: app document, one document per year, one per manual price list', () => {
  const docs = splitDocs(sampleV2());
  assert.deepEqual([...docs.keys()].sort(), ['app', 'px/m', 'tx/y2024', 'tx/y2025']);
  assert.equal(docs.get('app').txns, undefined);
  assert.equal(docs.get('app').prices, undefined);
  assert.equal(docs.get('tx/y2024').items.length, 2);
  assert.equal(docs.get('px/m').points.length, 2);
});

test('db store: v1 documents load as raw v1 data, then the first save writes v2, backs up v1 and deletes stale docs', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  const db = fakeDb();
  // Layout written by the first version
  const root = 'data/users/u1/app';
  const { txns, prices, ...rest } = V1;
  db.docs.set(root, copy(rest));
  db.docs.set(root + '/tx/y2023', { items: [txns[0]] });
  db.docs.set(root + '/tx/y2024', { items: [txns[1]] });
  db.docs.set(root + '/px/a', { points: prices.a });
  globalThis.window = { claude: { use: async (name) => (name === 'db' ? db.api : name === 'user' ? { id: async () => 'u1' } : null) } };
  const store = await pickStore();
  delete globalThis.window;
  assert.equal(store.kind, 'db');
  const raw = await store.load();
  assert.equal(raw.v, 1);
  assert.equal(raw.portfolios.length, 2);
  assert.equal(raw.txns.length, 2);
  const d = migrate(raw);
  assert.equal(d.v, 2);
  assert.deepEqual(d.txns.map((t) => t.acc).sort(), ['p1', 'p2']);
  assert.deepEqual(d.prices.a, [['2024-06-03', 118]]);

  // The user deletes the 2023 transaction and saves
  d.txns = d.txns.filter((t) => t.id !== 'v1a');
  d.updatedAt = 5;
  store.save(d);
  await store.flush();
  const app = db.docs.get(root);
  assert.equal(app.v, 2);
  assert.equal(app.portfolios, undefined, 'set() replaces the whole document');
  assert.ok(!db.docs.has(root + '/tx/y2023'), 'empty year deleted');
  assert.equal(db.docs.get(root + '/tx/y2024').items[0].acc, 'p2');
  assert.equal(db.log.filter(([op, p]) => op === 'set' && p === root).length, 1);
  assert.deepEqual(db.log.filter(([op]) => op === 'set').at(-1), ['set', root], 'main document written last');
  // One-time backup of the v1 data
  const backup = JSON.parse(ls.getItem(BACKUP_KEY));
  assert.equal(backup.v, 1);
  assert.equal(backup.txns.length, 2);
  assert.equal(db.docs.get(root + '/backup/v1').portfolios.length, 2);

  // Next load returns v2 data
  const store2 = dbStore(db.api, 'u1');
  const raw2 = await store2.load();
  assert.equal(raw2.v, 2);
  assert.equal(raw2.txns.length, 1);
});

test('db store: debounced, writes only changed documents, survives failures', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const db = fakeDb();
  const store = dbStore(db.api, 'u2');
  assert.equal(await store.load(), null);
  const d = sampleV2();
  store.save(d);
  store.save(d);
  assert.equal(db.log.length, 0, 'nothing written before the debounce');
  await new Promise((r) => setTimeout(r, 600));
  await store.flush();
  const first = db.log.length;
  assert.equal(first, 4); // app, tx/y2024, tx/y2025, px/m

  // Change only a 2025 transaction
  const d2 = copy(d);
  d2.txns[2].amount = 16;
  store.save(d2);
  await store.flush();
  assert.deepEqual(db.log.slice(first), [['set', 'data/users/u2/app/tx/y2025']]);

  // A failing write: toast, no throw, retried at the next flush
  toasts.length = 0;
  const d3 = copy(d2);
  d3.settings.riskFree = 0.03;
  db.failOnce({ code: 'quota_exceeded', message: 'full' });
  store.save(d3);
  await store.flush();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /spazio dati è esaurito/);
  assert.notEqual(db.docs.get('data/users/u2/app').settings.riskFree, 0.03);
  await store.flush();
  assert.equal(db.docs.get('data/users/u2/app').settings.riskFree, 0.03);

  const back = await dbStore(db.api, 'u2').load();
  assert.deepEqual(migrate(back), migrate(d3));
});

test('db store: a very large year is split in chunks and read back in order', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const db = fakeDb();
  const store = dbStore(db.api, 'u3');
  await store.load();
  const d = sampleV2();
  d.txns = [];
  for (let i = 0; i < 3000; i++) {
    d.txns.push({ id: 'big' + i, acc: 'a1', date: '2024-05-' + String((i % 28) + 1).padStart(2, '0'), type: 'buy', aid: 'x', qty: 1, price: 6 + i / 1000, fee: 0, note: 'Acquisto ricorrente numero ' + i });
  }
  store.save(d);
  await store.flush();
  const keys = [...db.docs.keys()].filter((k) => k.includes('/tx/'));
  assert.ok(keys.length > 1, 'split in several documents');
  for (const k of keys) assert.ok(JSON.stringify(db.docs.get(k)).length < 256 * 1024);
  const back = await dbStore(db.api, 'u3').load();
  assert.deepEqual(back.txns.map((t) => t.id), d.txns.map((t) => t.id));
});

test('db store: asset ids that are not valid document ids still roundtrip', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const db = fakeDb();
  const store = dbStore(db.api, 'u5');
  await store.load();
  const d = sampleV2();
  d.prices = { 'BTP 2030/03': [['2025-01-31', 99]], ok: [['2025-01-31', 5]] };
  store.save(d);
  await store.flush();
  const keys = [...db.docs.keys()].filter((k) => k.includes('/px/')).map((k) => k.split('/px/')[1]);
  assert.ok(keys.includes('ok'));
  assert.ok(keys.every((k) => /^[A-Za-z0-9_\-.~:@+]+$/.test(k)), keys.join(' '));
  const back = await dbStore(db.api, 'u5').load();
  assert.deepEqual(back.prices, d.prices);
});

test('db store: unreadable database blocks saves instead of overwriting it', async () => {
  globalThis.localStorage = fakeLocalStorage();
  const db = fakeDb();
  db.docs.set('data/users/u4/app', { v: 2, accounts: [] });
  const api = { ...db.api, doc: (p) => ({ ...db.api.doc(p), get: async () => Promise.reject({ code: 'revoked' }) }) };
  const store = dbStore(api, 'u4');
  await assert.rejects(store.load(), (e) => e.code === 'revoked' && /Non riesco a leggere/.test(e.message));
  store.save(sampleV2());
  await store.flush();
  assert.equal(db.log.length, 0);
});
