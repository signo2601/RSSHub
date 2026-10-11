// Persistence: the data lives only in this device's localStorage (no Claude database, no sync).
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../js/app.js';
import { migrate, blankData } from '../js/state.js';
import { pickStore, localStore, LOCAL_KEY, LOCAL_KEY_V1, CORRUPT_KEY } from '../js/store.js';
import * as storeMod from '../js/store.js';

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
  d.watch = [{ id: 'w1', symbol: 'ASML.AS', ticker: 'ASML', name: 'ASML', currency: 'EUR', price: 640, target: 600, note: 'da seguire' }];
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

/* ---------- Device storage only ---------- */
test('pickStore always returns the device store', async () => {
  globalThis.localStorage = fakeLocalStorage();
  delete globalThis.window;
  const store = await pickStore();
  assert.equal(store.kind, 'local');
  assert.equal(await store.load(), null);
});

test('pickStore stays on the device even inside a Claude artifact preview', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  const asked = [];
  // A host that would offer a database: it must never be used
  globalThis.window = { claude: { use: async (name) => { asked.push(name); return { doc() { throw new Error('no cloud storage'); } }; } } };
  try {
    const store = await pickStore();
    assert.equal(store.kind, 'local');
    store.save(sampleV2());
    await store.flush();
    assert.deepEqual(asked, [], 'the artifact capabilities are never requested');
    assert.ok(ls.map.has(LOCAL_KEY));
  } finally {
    delete globalThis.window;
  }
});

test('store.js exposes only local storage (no artifact database, no sync)', () => {
  assert.deepEqual(Object.keys(storeMod).sort(), ['CORRUPT_KEY', 'LOCAL_KEY', 'LOCAL_KEY_V1', 'localStore', 'pickStore']);
});

test('local store: save and load roundtrip under gruzzolo:data:v2', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  const store = localStore();
  const data = sampleV2();
  store.save(data);
  await store.flush();
  assert.deepEqual([...ls.map.keys()], [LOCAL_KEY], 'one key, nothing else written');
  const back = await store.load();
  assert.deepEqual(back, data);
  assert.deepEqual(migrate(back), migrate(data));
  // A fresh store (next app start) reads the same data
  assert.deepEqual(await localStore().load(), data);
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

test('local store: unreadable v1 data is ignored without touching it', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  ls.setItem(LOCAL_KEY_V1, 'not json');
  assert.equal(await localStore().load(), null);
  assert.equal(ls.getItem(LOCAL_KEY_V1), 'not json');
});

test('local store: unreadable data is kept aside, save never throws', async () => {
  const ls = (globalThis.localStorage = fakeLocalStorage());
  ls.setItem(LOCAL_KEY, '{broken');
  toasts.length = 0;
  const store = localStore();
  assert.equal(await store.load(), null);
  assert.equal(ls.getItem(CORRUPT_KEY), '{broken');
  assert.equal(CORRUPT_KEY, 'gruzzolo:data:v2:corrupt');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /danneggiati/);
  ls.failWrites = true;
  toasts.length = 0;
  assert.doesNotThrow(() => store.save(sampleV2()));
  assert.doesNotThrow(() => store.save(sampleV2()));
  assert.equal(toasts.length, 1, 'one toast per failure streak');
  assert.match(toasts[0], /Salvataggio non riuscito/);
  // Writes work again: the next failure warns again
  ls.failWrites = false;
  store.save(sampleV2());
  ls.failWrites = true;
  store.save(sampleV2());
  assert.equal(toasts.length, 2);
});

test('local store: no localStorage at all (blocked) → load null, save warns once', async () => {
  delete globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    toasts.length = 0;
    const store = localStore();
    assert.equal(await store.load(), null);
    assert.doesNotThrow(() => store.save(sampleV2()));
    assert.equal(toasts.length, 1);
  } finally {
    delete globalThis.localStorage;
  }
});
