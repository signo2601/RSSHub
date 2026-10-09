import test from 'node:test';
import assert from 'node:assert/strict';
import { market } from '../js/market.js';
import { sync, seal, open, deriveSyncKeys, hasUserContent, SYNC_KEY, MESSAGES, _test } from '../js/sync.js';

/* ---------- Fakes: localStorage and the /api/sync server ---------- */
function fakeLocalStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

// Same behavior as functions/api/[[path]].js for /api/sync/:id
function fakeServer({ mode = 'ok' } = {}) {
  const kv = new Map();
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, body: init.body });
    if (mode === 'offline') throw new TypeError('Failed to fetch');
    if (mode === 'nokv') return json(501, { error: 'La sincronizzazione non è attiva su questo server' });
    if (mode === 'static') return new Response('<!doctype html><title>404</title>', { status: 404, headers: { 'Content-Type': 'text/html' } });
    const id = String(url).split('/api/sync/')[1];
    if (!/^[0-9a-f]{64}$/.test(id)) return json(400, { error: 'Codice non valido' });
    if (method === 'GET') return kv.has(id) ? new Response(kv.get(id), { status: 200 }) : json(404, { error: 'Nessun dato' });
    if (method === 'PUT') {
      const body = JSON.parse(init.body);
      if (!Number.isFinite(body.updatedAt) || typeof body.iv !== 'string' || typeof body.ct !== 'string') return json(400, { error: 'incompleti' });
      kv.set(id, init.body);
      return json(200, { ok: true, updatedAt: body.updatedAt });
    }
    return json(405, { error: 'Metodo' });
  };
  return { kv, calls, fetch };
}

const PASS = 'cavallo batteria graffetta';

function userData(updatedAt, note = 'mio') {
  return {
    v: 2,
    updatedAt,
    settings: { started: true },
    accounts: [{ id: 'a1', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'track' }],
    assets: { e: { id: 'e', name: 'Enel', symbol: 'ENEL.MI', type: 'stock', currency: 'EUR', priceSource: 'auto' } },
    txns: [{ id: 't1', acc: 'a1', date: '2024-02-01', type: 'buy', aid: 'e', qty: 100, price: 6.2, fee: 4.9, note }],
    prices: {},
    watch: [],
  };
}
function demoOnly(updatedAt) {
  return {
    v: 2,
    updatedAt,
    settings: { started: false },
    accounts: [{ id: 'demo-degiro', name: 'DEGIRO', demo: true }],
    assets: { 'demo-enel': { id: 'demo-enel', name: 'Enel', demo: true } },
    txns: [{ id: 'demo-t001', acc: 'demo-degiro', date: '2024-01-02', type: 'deposit', amount: 3000, demo: true }],
    prices: {},
    watch: [],
  };
}

function setup(mode) {
  globalThis.localStorage = fakeLocalStorage();
  const server = fakeServer({ mode });
  globalThis.fetch = server.fetch;
  market.apiBase = '';
  _test.reset();
  return server;
}

/* ---------- Crypto ---------- */
test('keys: deterministic per passphrase, 64-hex id, spaces around are ignored', async () => {
  const a = await deriveSyncKeys(PASS);
  const b = await deriveSyncKeys('  ' + PASS + ' ');
  const c = await deriveSyncKeys(PASS + '!');
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(a.id, b.id);
  assert.equal(a.key, b.key);
  assert.notEqual(a.id, c.id);
  assert.notEqual(a.key, c.key);
  assert.notEqual(a.id, Buffer.from(a.key, 'base64').toString('hex'), 'id and key are independent');
  assert.equal(Buffer.from(a.key, 'base64').length, 32);
});

test('envelope: AES-GCM roundtrip with and without gzip; wrong key fails', async () => {
  const { key } = await deriveSyncKeys(PASS);
  const data = userData(1234);
  const z = await seal(data, key);
  assert.equal(z.z, 1);
  assert.equal(z.updatedAt, 1234);
  assert.equal(Buffer.from(z.iv, 'base64').length, 12);
  assert.ok(!Buffer.from(z.ct, 'base64').toString('latin1').includes('Enel'));
  assert.deepEqual(await open(z, key), data);
  const plain = await seal(data, key, { compress: false });
  assert.equal(plain.z, undefined);
  assert.deepEqual(await open(plain, key), data);
  const again = await seal(data, key);
  assert.notEqual(again.iv, z.iv, 'fresh iv every time');
  const other = await deriveSyncKeys('un\'altra frase segreta');
  await assert.rejects(open(z, other.key), (e) => e.code === 'decrypt' && /Non riesco a leggere/.test(e.message));
});

test('hasUserContent: example data does not count', () => {
  assert.equal(hasUserContent(demoOnly(1)), false);
  assert.equal(hasUserContent(userData(1)), true);
  assert.equal(hasUserContent(null), false);
});

/* ---------- Enable, second device, reconcile ---------- */
test('enable: short passphrase rejected, passphrase never stored', async () => {
  setup();
  await assert.rejects(sync.enable('corta'), (e) => e.message === MESSAGES.short);
  assert.equal(sync.enabled(), false);
  assert.equal(sync.status().state, 'off');
  const res = await sync.enable(PASS, userData(100));
  assert.equal(res.action, 'pushed');
  assert.equal(sync.enabled(), true);
  const stored = globalThis.localStorage.getItem(SYNC_KEY);
  assert.ok(!stored.includes('cavallo'));
  const cfg = JSON.parse(stored);
  assert.deepEqual(Object.keys(cfg).sort(), ['id', 'key', 'lastRemote', 'lastSync']);
  assert.equal(cfg.lastRemote, 100);
  assert.ok(cfg.lastSync > 0);
  assert.equal(sync.status().state, 'ok');
});

test('a second device adopts the existing data, then newest wins', async () => {
  const server = setup();
  // Device A
  const a = await sync.enable(PASS, userData(100, 'A'));
  assert.equal(a.action, 'pushed');
  assert.equal(server.kv.size, 1);
  const blob = JSON.parse([...server.kv.values()][0]);
  assert.deepEqual(Object.keys(blob).sort(), ['ct', 'iv', 'updatedAt', 'z']);
  assert.equal(blob.updatedAt, 100);

  // Device B: fresh install with the example portfolio, even with a newer timestamp
  sync.disable();
  assert.equal(sync.status().state, 'off');
  const b = await sync.enable(PASS, demoOnly(999));
  assert.equal(b.action, 'pulled');
  assert.equal(b.data.txns[0].note, 'A');

  // Without local data enable() only reads
  sync.disable();
  const c = await sync.enable(PASS);
  assert.equal(c.action, 'pulled');
  assert.equal(c.data.updatedAt, 100);

  // Equal timestamps: nothing to do
  const same = await sync.reconcile(userData(100, 'A'));
  assert.equal(same.action, 'none');
  // Local newer: pushed
  const puts = server.calls.filter((x) => x.method === 'PUT').length;
  const newer = await sync.reconcile(userData(200, 'B'));
  assert.equal(newer.action, 'pushed');
  assert.equal(server.calls.filter((x) => x.method === 'PUT').length, puts + 1);
  // Remote newer: pulled
  const older = await sync.reconcile(userData(150, 'old'));
  assert.equal(older.action, 'pulled');
  assert.equal(older.data.txns[0].note, 'B');
  assert.equal(older.data.updatedAt, 200);
  // pull() returns the stored data
  assert.equal((await sync.pull()).txns[0].note, 'B');
});

test('nothing stored yet: pull returns null, reconcile pushes', async () => {
  setup();
  await sync.enable(PASS);
  assert.equal(await sync.pull(), null);
  const r = await sync.reconcile(userData(10));
  assert.equal(r.action, 'pushed');
  assert.equal((await sync.pull()).updatedAt, 10);
});

/* ---------- Errors ---------- */
test('server without KV (501) or without API: state unavailable with the guide message', async () => {
  setup('nokv');
  const events = [];
  const off = sync.onChange((s) => events.push(s.state));
  await assert.rejects(sync.enable(PASS, userData(1)), (e) => e.code === 'unavailable');
  assert.equal(sync.enabled(), true, 'stays on: the server can be fixed later');
  assert.deepEqual(sync.status().state, 'unavailable');
  assert.equal(sync.status().message, 'Sincronizzazione non attiva sul server: segui la guida in Altro → Sincronizzazione');
  assert.ok(events.includes('syncing') && events.includes('unavailable'));
  off();

  setup('static');
  await assert.rejects(sync.enable(PASS), (e) => e.code === 'unavailable');
  assert.equal(sync.status().state, 'unavailable');
});

test('schedulePush: debounced, never throws, errors become status', async () => {
  const server = setup();
  _test.setPushDelay(30);
  await sync.enable(PASS);
  sync.schedulePush(userData(1, 'one'));
  sync.schedulePush(userData(2, 'two'));
  sync.schedulePush(userData(3, 'three'));
  await new Promise((r) => setTimeout(r, 120));
  const puts = server.calls.filter((x) => x.method === 'PUT');
  assert.equal(puts.length, 1, 'one push for a burst of changes');
  assert.equal(JSON.parse(puts[0].body).updatedAt, 3);
  assert.equal(sync.status().state, 'ok');

  // Offline: no exception, status error with an Italian message
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.doesNotThrow(() => sync.schedulePush(userData(4)));
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sync.status().state, 'error');
  assert.equal(sync.status().message, MESSAGES.offline);

  // flush() pushes a scheduled change right away
  globalThis.fetch = server.fetch;
  _test.setPushDelay(60000);
  sync.schedulePush(userData(5));
  await sync.flush();
  assert.equal(JSON.parse([...server.kv.values()][0]).updatedAt, 5);
  assert.equal(sync.status().state, 'ok');

  // Disabled: schedulePush is a no-op
  sync.disable();
  const before = server.calls.length;
  sync.schedulePush(userData(6));
  await sync.flush();
  assert.equal(server.calls.length, before);
  _test.setPushDelay(2000);
});

test('pull and push on a disabled sync throw a clear error', async () => {
  setup();
  await assert.rejects(sync.pull(), (e) => e.code === 'off');
  await assert.rejects(sync.push(userData(1)), (e) => e.code === 'off');
});

test('works against the real server function (in-memory KV)', async () => {
  const { onRequest } = await import('../functions/api/[[path]].js');
  globalThis.localStorage = fakeLocalStorage();
  _test.reset();
  market.apiBase = 'https://gruzzolo.example';
  const store = new Map();
  const env = { GRUZZOLO_KV: { get: async (k) => (store.has(k) ? store.get(k) : null), put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) } };
  globalThis.fetch = (url, init = {}) => onRequest({ request: new Request(url, init), env, waitUntil() {} });
  const first = await sync.enable(PASS, userData(42, 'server'));
  assert.equal(first.action, 'pushed');
  assert.equal(store.size, 1);
  assert.match([...store.keys()][0], /^sync:[0-9a-f]{64}$/);
  sync.disable();
  const second = await sync.enable(PASS, demoOnly(0));
  assert.equal(second.action, 'pulled');
  assert.equal(second.data.txns[0].note, 'server');
  sync.disable();
  market.apiBase = '';
});
