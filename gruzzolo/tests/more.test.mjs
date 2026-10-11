// Tab "Altro" (js/views/more.js): pure helpers, the import wizard state, backup and wipe,
// the privacy group (data only on the device, storage status), and the HTML of the page and of its sheets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { S, migrate, blankData, bump, FEE_KINDS } from '../js/state.js';
import { SHEETS, ACTIONS, FORMS, INPUTS } from '../js/registry.js';
import { app } from '../js/app.js';
import { demoData } from '../js/demo.js';
import { todayISO, addDays } from '../js/util.js';
import {
  prettyName, csvNum, transactionsCsv, checkBackup, dropAccount, rankListings, findExistingAsset, resolveImportAssets,
  finalizeTxns, externalFromRows, importBatches, normalizeApiBase, normCcy, wipedData, KEEP_ON_WIPE, renderMore, _test,
  deviceName, hasUserContent, fmtBytes, readStorageStatus, refreshStorage, backupReminder, BACKUP_EVERY_DAYS,
} from '../js/views/more.js';

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const today = todayISO();

function useData(d) {
  S.data = migrate(d);
  S.ui.scope = 'all';
  S.ui.hide = false;
  S.sheets = [];
  bump();
  _test.resetImport();
  return S.data;
}
function realData() {
  const d = blankData();
  d.settings.started = true;
  d.accounts = [{ id: 'deg', name: 'DEGIRO', broker: 'DEGIRO', cashMode: 'auto' }];
  return d;
}

/* ---------- Pure helpers ---------- */
test('prettyName: all-caps broker names become readable, codes stay upper case', () => {
  assert.equal(prettyName('APPLE INC. - COMMON STOCK'), 'Apple Inc. - Common Stock');
  assert.equal(prettyName('VANGUARD FTSE ALL-WORLD UCITS ETF USD ACC'), 'Vanguard FTSE All-World UCITS ETF USD ACC');
  assert.equal(prettyName('BTP 3,5% MZ30'), 'BTP 3,5% MZ30');
  assert.equal(prettyName('Already Mixed case'), 'Already Mixed case');
  assert.equal(prettyName('  ENEL   SPA '), 'Enel SPA');
  assert.equal(prettyName(''), '');
  assert.equal(prettyName(null), '');
});

test('csvNum and normCcy', () => {
  assert.equal(csvNum(1234.5, 2), '1234,5');
  assert.equal(csvNum(0.10000000, 8), '0,1');
  assert.equal(csvNum(-0.000000001, 2), '0');
  assert.equal(csvNum(1e-7, 8), '0,0000001');
  assert.equal(csvNum(''), '');
  assert.equal(csvNum(undefined), '');
  assert.equal(csvNum('abc'), '');
  assert.equal(normCcy('usd'), 'USD');
  assert.equal(normCcy('GBp'), 'GBP');
  assert.equal(normCcy('GBX'), 'GBP');
  assert.equal(normCcy('euro'), '');
});

test('transactionsCsv: BOM, Italian decimals, quoting, sorted, FX only on foreign trades', () => {
  const d = realData();
  d.assets = {
    a1: { id: 'a1', name: 'Apple; Inc', ticker: 'AAPL', symbol: 'AAPL', isin: 'US0378331005', type: 'stock', currency: 'USD' },
    a2: { id: 'a2', name: 'Enel', ticker: 'ENEL', symbol: 'ENEL.MI', isin: 'IT0003128367', type: 'stock', currency: 'EUR' },
  };
  d.txns = [
    { id: 't2', acc: 'deg', date: '2024-03-02', type: 'buy', aid: 'a2', qty: 100, price: 6.05, fee: 2 },
    { id: 't1', acc: 'deg', date: '2024-03-01', type: 'buy', aid: 'a1', qty: 2, price: 170.5, fx: 1.08, fee: 1, fxFee: 0.5, note: 'prima "riga"' },
    { id: 't3', acc: 'deg', date: '2024-03-03', type: 'fee', kind: 'connectivity', amount: 2.5 },
  ];
  const csv = transactionsCsv(d);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith('Data;Conto;Tipo;Titolo;Ticker;ISIN;Quantità;Prezzo;Valuta;Cambio'));
  const apple = lines[1].split(';');
  assert.equal(apple[0], '2024-03-01');
  assert.ok(lines[1].includes('"Apple; Inc"'), 'a name with ; is quoted');
  assert.ok(lines[1].includes('"prima ""riga"""'), 'quotes are doubled');
  assert.ok(lines[1].includes(';170,5;USD;1,08;1;0,5;'));
  const enel = lines[2].split(';');
  assert.equal(enel[2], 'Acquisto');
  assert.equal(enel[9], '', 'no exchange rate for a EUR trade');
  assert.equal(enel[13], '-607', 'amount = −(qty × price + fee)');
  const fee = lines[3].split(';');
  assert.deepEqual([fee[0], fee[1], fee[2], fee[13]], ['2024-03-03', 'DEGIRO', FEE_KINDS.connectivity, '-2,5']);
  assert.equal(fee[6], '', 'no quantity on a fee');
});

test('checkBackup: v2, v1 conversion, newer version, garbage, broken transactions', () => {
  const d = realData();
  d.txns = [{ id: 't', acc: 'deg', date: '2024-01-02', type: 'deposit', amount: 100 }];
  d.updatedAt = 1700000000000;
  const ok = checkBackup(JSON.parse(JSON.stringify(d)));
  assert.equal(ok.ok, true);
  assert.equal(ok.version, 2);
  assert.equal(ok.txns, 1);
  assert.equal(ok.accounts, 1);
  assert.equal(ok.updatedAt, 1700000000000);
  assert.equal(checkBackup({ v: 3, txns: [], assets: {} }).ok, false);
  assert.match(checkBackup({ v: 3, txns: [], assets: {} }).error, /più recente/);
  assert.equal(checkBackup([]).ok, false);
  assert.equal(checkBackup(null).ok, false);
  assert.equal(checkBackup({ hello: 1 }).ok, false);
  const broken = checkBackup({ v: 2, txns: [{ id: 'x' }], assets: {}, accounts: [] });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /operazioni non valide/);
});

test('dropAccount: never the last account, removes its transactions', () => {
  const d = realData();
  d.accounts.push({ id: 'sc', name: 'Scalable Capital', broker: 'Scalable Capital', cashMode: 'auto' });
  d.txns = [
    { id: '1', acc: 'deg', date: '2024-01-01', type: 'deposit', amount: 1 },
    { id: '2', acc: 'sc', date: '2024-01-01', type: 'deposit', amount: 1 },
    { id: '3', acc: 'sc', date: '2024-01-02', type: 'deposit', amount: 1 },
  ];
  assert.equal(dropAccount(d, 'nope'), -1);
  assert.equal(dropAccount(d, 'sc'), 2);
  assert.deepEqual(d.accounts.map((a) => a.id), ['deg']);
  assert.deepEqual(d.txns.map((t) => t.id), ['1']);
  assert.equal(dropAccount(d, 'deg'), -1, 'the only account stays');
});

test('rankListings: broker venue first, then the preferred listing for the currency', () => {
  const results = [{ symbol: 'VWCE.MI' }, { symbol: 'VWCE.DE' }, { symbol: 'VWCE.F' }, { symbol: 'VWRA.L' }, { symbol: '' }];
  assert.deepEqual(rankListings(results, { currency: 'EUR', exchange: 'XET' }).map((r) => r.symbol), ['VWCE.DE', 'VWCE.MI', 'VWCE.F', 'VWRA.L']);
  assert.deepEqual(rankListings(results, { currency: 'EUR' }).map((r) => r.symbol), ['VWCE.MI', 'VWCE.DE', 'VWCE.F', 'VWRA.L']);
  assert.equal(rankListings([{ symbol: 'AAPL.MX' }, { symbol: 'AAPL' }], { currency: 'USD', exchange: 'NDQ' })[0].symbol, 'AAPL');
  assert.deepEqual(rankListings(null), []);
});

test('findExistingAsset: ISIN first, then Yahoo symbol, then exact name without ISIN', () => {
  const assets = {
    a1: { id: 'a1', name: 'Enel', isin: 'IT0003128367', symbol: 'ENEL.MI', ticker: 'ENEL' },
    a2: { id: 'a2', name: 'Polizza Vita', isin: '', symbol: '', ticker: 'POL' },
  };
  assert.equal(findExistingAsset(assets, { isin: 'it0003128367' }), 'a1');
  assert.equal(findExistingAsset(assets, { symbol: 'enel.mi' }), 'a1');
  assert.equal(findExistingAsset(assets, { symbol: 'POL' }), 'a2');
  assert.equal(findExistingAsset(assets, { name: 'POLIZZA VITA' }), 'a2');
  assert.equal(findExistingAsset(assets, { isin: 'XX0000000000', name: 'Enel' }), null, 'a different ISIN is a different security');
});

test('resolveImportAssets: ISIN → Yahoo listing in the CSV currency, existing assets reused, merges, pence', async () => {
  const calls = [];
  const search = async (q) => {
    calls.push(q);
    if (q === 'IE00BK5BQT80') return [{ symbol: 'VWRA.L', name: 'Vanguard (USD)' }, { symbol: 'VWCE.MI' }, { symbol: 'VWCE.DE' }];
    if (q === 'US0378331005') return [{ symbol: 'AAPL', name: 'Apple Inc.' }];
    if (q === 'GB00B03MLX29') return [{ symbol: 'SHEL.L' }];
    return [];
  };
  const lookup = async (s) => ({
    'VWRA.L': { symbol: 'VWRA.L', currency: 'USD', type: 'etf', name: 'VWRA' },
    'VWCE.DE': { symbol: 'VWCE.DE', currency: 'EUR', type: 'etf', name: 'Vanguard FTSE All-World UCITS ETF (Acc)', exchange: 'XETRA' },
    'VWCE.MI': { symbol: 'VWCE.MI', currency: 'EUR', type: 'etf', name: 'Vanguard FTSE All-World (Milano)', exchange: 'Milano' },
    AAPL: { symbol: 'AAPL', currency: 'USD', type: 'stock', name: 'Apple Inc.', exchange: 'NASDAQ' },
    'SHEL.L': { symbol: 'SHEL.L', currency: 'GBP', type: 'stock', name: 'Shell plc' },
  }[s] || null);
  const assets = { old: { id: 'old', name: 'Enel', isin: 'IT0003128367', symbol: 'ENEL.MI' } };
  let n = 0;
  const items = [
    { key: 'k1', isin: 'IE00BK5BQT80', name: 'VANGUARD FTSE ALL-WORLD UCITS ETF USD ACC', currency: 'EUR', type: 'etf', exchange: 'XET' },
    { key: 'k2', isin: 'IT0003128367', name: 'ENEL', currency: 'EUR', type: 'stock' },
    { key: 'k3', isin: 'US0378331005', name: 'APPLE INC. - COMMON STOCK', currency: 'USD', type: 'stock' },
    { key: 'k4', isin: '', symbol: 'VWCE.DE', name: 'Vanguard All-World', currency: 'EUR', type: 'etf' },
    { key: 'k5', isin: 'GB00B03MLX29', name: 'SHELL PLC', currency: 'GBX', type: 'stock' },
    { key: 'k6', isin: 'IT0005024234', name: 'BTP 3,5% MZ30', currency: 'EUR', type: 'bond' },
  ];
  const progress = [];
  const r = await resolveImportAssets(items, { assets, online: true, search, lookup, idFor: () => `n${++n}`, onProgress: (d, t) => progress.push(`${d}/${t}`) });
  const byKey = (k) => r.created.find((a) => a.id === r.map[k]) || assets[r.map[k]];
  assert.equal(byKey('k1').symbol, 'VWCE.DE', 'the XETRA listing for a DEGIRO XET row, not the USD one');
  assert.equal(byKey('k1').currency, 'EUR');
  assert.equal(byKey('k1').priceSource, 'auto');
  assert.equal(r.map.k2, 'old', 'an asset already in the data is reused without searching');
  assert.ok(!calls.includes('IT0003128367'));
  assert.equal(byKey('k3').symbol, 'AAPL');
  assert.equal(byKey('k3').currency, 'USD');
  assert.equal(byKey('k3').ticker, 'AAPL');
  assert.equal(r.map.k4, r.map.k1, 'two rows with the same listing share one asset');
  assert.equal(byKey('k5').currency, 'GBP');
  assert.ok(r.pence.has('k5'));
  assert.equal(byKey('k6').priceSource, 'manual', 'not on Yahoo: manual prices');
  assert.equal(byKey('k6').symbol, '');
  assert.equal(byKey('k6').type, 'bond');
  assert.equal(r.created.length, 4);
  assert.equal(progress.at(-1), '6/6');
});

test('resolveImportAssets offline: the curated catalog links known ETFs, the rest is manual', async () => {
  const r = await resolveImportAssets([
    { key: 'v', isin: 'IE00BK5BQT80', name: 'VANGUARD FTSE ALL-WORLD', currency: 'EUR', type: 'etf', exchange: 'XET' },
    { key: 'x', isin: 'XS0000000001', name: 'OBBLIGAZIONE SCONOSCIUTA', currency: 'EUR', type: 'bond' },
  ], { online: false, idFor: (() => { let i = 0; return () => `c${++i}`; })() });
  const v = r.created.find((a) => a.id === r.map.v);
  assert.equal(v.symbol, 'VWCE.DE');
  assert.ok(v.ter > 0, 'TER from the catalog');
  assert.equal(r.created.find((a) => a.id === r.map.x).priceSource, 'manual');
});

test('finalizeTxns: account and batch id, trades without a security dropped, pence prices to pounds', () => {
  const { txns, dropped } = finalizeTxns([
    { type: 'buy', date: '2024-01-02', assetKey: 'k5', qty: 10, price: 2500, fx: 85 },
    { type: 'div', date: '2024-02-02', assetKey: 'missing', amount: 3 },
    { type: 'deposit', date: '2024-01-01', amount: 500 },
  ], { map: { k5: 'a5' }, pence: new Set(['k5']), acc: 'deg', src: 'imp-x' });
  assert.equal(dropped, 1);
  assert.equal(txns.length, 2);
  assert.deepEqual(txns[0], { type: 'buy', date: '2024-01-02', qty: 10, price: 25, fx: 0.85, acc: 'deg', src: 'imp-x', aid: 'a5' });
  assert.equal(txns[1].acc, 'deg');
  assert.equal('assetKey' in txns[1], false);
});

test('externalFromRows: sign from the select, minus sign wins, empty and zero skipped', () => {
  assert.deepEqual(externalFromRows([
    { year: '2023', sign: -1, amount: '500' },
    { year: '2022', sign: 1, amount: '1.234,56' },
    { year: '2021', sign: 1, amount: '-75' },
    { year: '2020', sign: -1, amount: '0' },
    { year: '2019', sign: -1, amount: 'abc' },
    { year: '20x8', sign: -1, amount: '10' },
    { year: 2018, sign: -1, amount: 10.005 },
  ]), { 2023: -500, 2022: 1234.56, 2021: -75, 2018: -10.01 });
});

test('importBatches: one entry per import, newest first, import time decoded from the id', () => {
  const t1 = 1760000000000;
  const t2 = 1760003600000;
  const d = realData();
  d.txns = [
    { acc: 'deg', date: '2024-01-01', type: 'deposit', src: `imp-${t1.toString(36)}-aaaa` },
    { acc: 'deg', date: '2024-03-01', type: 'deposit', src: `imp-${t1.toString(36)}-aaaa` },
    { acc: 'deg', date: '2024-02-01', type: 'deposit', src: `imp-${t2.toString(36)}-bbbb` },
    { acc: 'deg', date: '2024-02-01', type: 'deposit', src: 'manual' },
    { acc: 'deg', date: '2024-02-01', type: 'deposit' },
  ];
  const b = importBatches(d);
  assert.equal(b.length, 2);
  assert.equal(b[0].time, t2);
  assert.equal(b[1].count, 2);
  assert.equal(b[1].first, '2024-01-01');
  assert.equal(b[1].last, '2024-03-01');
});

test('normalizeApiBase', () => {
  assert.deepEqual(normalizeApiBase(''), { ok: true, value: '' });
  assert.deepEqual(normalizeApiBase(' https://x.workers.dev/ '), { ok: true, value: 'https://x.workers.dev' });
  assert.deepEqual(normalizeApiBase('https://x.workers.dev/api/'), { ok: true, value: 'https://x.workers.dev' });
  assert.deepEqual(normalizeApiBase('https://example.com/gruzzolo'), { ok: true, value: 'https://example.com/gruzzolo' });
  assert.equal(normalizeApiBase('ftp://x').ok, false);
  assert.equal(normalizeApiBase('x.workers.dev').ok, false);
  assert.equal(normalizeApiBase('https://a b.dev').ok, false);
});

/* ---------- Wipe ---------- */
test('wipedData: everything entered goes, preferences (rates, benchmark, server, theme) stay', () => {
  const prev = realData();
  Object.assign(prev.settings, {
    riskFree: 0.035, taxRate: 0.2, govTaxRate: 0.1, stampDuty: 0.0015, theme: 'dark', apiBase: 'https://x.dev',
    benchmark: { symbol: 'SWDA.MI', name: 'iShares Core MSCI World' }, externalPL: { 2023: -500 },
  });
  prev.txns = [{ id: 't', acc: 'deg', date: '2024-01-01', type: 'deposit', amount: 1 }];
  prev.assets = { a: { id: 'a', name: 'X' } };
  prev.watch = [{ id: 'w', symbol: 'AAPL' }];
  prev.prices = { a: [['2024-01-01', 1]] };
  const d = wipedData(prev);
  assert.deepEqual(d.txns, []);
  assert.deepEqual(d.assets, {});
  assert.deepEqual(d.watch, []);
  assert.deepEqual(d.prices, {});
  assert.deepEqual(d.settings.externalPL, {});
  assert.equal(d.accounts.length, 1);
  assert.equal(d.settings.started, true);
  for (const k of KEEP_ON_WIPE) assert.deepEqual(d.settings[k], prev.settings[k], k);
  d.settings.benchmark.symbol = 'CHANGED';
  assert.equal(prev.settings.benchmark.symbol, 'SWDA.MI', 'settings are copied, not shared');
  assert.equal(wipedData().settings.taxRate, 0.26);
  assert.equal(wipedData(null).settings.started, true);
});

/* ---------- Import wizard ---------- */
test('import with the example data loaded: example accounts are not targets and do not affect the new name', () => {
  useData(demoData({ today }));
  assert.ok(S.data.accounts.some((a) => a.demo && a.name === 'DEGIRO'), 'the demo has a DEGIRO account');
  assert.equal(_test.newAccName('degiro-transactions'), 'DEGIRO');
  assert.equal(_test.defaultAccFor('degiro-transactions'), _test.NEW_ACC);
  _test.loadImportText('degiro-transactions-it.csv', fixture('degiro-transactions-it.csv'));
  assert.equal(_test.imp.preset, 'degiro-transactions');
  assert.equal(_test.imp.acc, _test.NEW_ACC);
  assert.equal(_test.imp.result.txns.length, 8);
  const html = _test.importStep3();
  assert.match(html, /Creo il conto «DEGIRO»\./);
  assert.match(html, /dati di esempio verranno rimossi/);
  assert.doesNotMatch(html, /DEGIRO 2/);
  const sheet = SHEETS['more-import']();
  assert.match(sheet.body, /Nuovo conto «DEGIRO»/);
  assert.doesNotMatch(sheet.body, /<option value="[^"]*demo/);
});

test('import into an account that already has the file: duplicates skipped with a clear message', () => {
  useData(realData());
  _test.loadImportText('degiro-transactions-it.csv', fixture('degiro-transactions-it.csv'));
  assert.equal(_test.imp.acc, 'deg', 'the DEGIRO account is picked for a DEGIRO file');
  const first = _test.imp.result;
  assert.equal(first.txns.length, 8);
  // pretend the file was imported
  const map = Object.fromEntries(first.assets.map((a, i) => [a.key, `a${i}`]));
  for (const [k, id] of Object.entries(map)) {
    const item = first.assets.find((a) => a.key === k);
    S.data.assets[id] = { id, name: item.name, isin: item.isin, symbol: '', ticker: '', type: item.type, currency: item.currency, priceSource: 'manual' };
  }
  S.data.txns.push(...finalizeTxns(first.txns, { map, acc: 'deg', src: 'imp-test' }).txns);
  bump();
  _test.computeImport();
  assert.equal(_test.imp.result.txns.length, 0);
  assert.equal(_test.imp.result.duplicates, 8);
  const html = _test.previewHtml();
  assert.match(html, /Le 8 operazioni del file sono già presenti nel conto «DEGIRO»/);
  assert.match(html, /niente di nuovo/);
  assert.doesNotMatch(html, /tipo di file/, 'the file type is right: no hint to change it');
  // a second account does not see them as duplicates
  S.data.accounts.push({ id: 'b', name: 'Banca', broker: 'Altro', cashMode: 'auto' });
  _test.imp.acc = 'b';
  _test.computeImport();
  assert.equal(_test.imp.result.txns.length, 8);
});

test('newAccName: a free name for each broker', () => {
  useData(realData());
  assert.equal(_test.newAccName('degiro-account'), 'DEGIRO 2');
  assert.equal(_test.newAccName('scalable'), 'Scalable Capital');
  assert.equal(_test.newAccName('generic'), 'Conto importato');
  assert.equal(_test.newAccName('degiro-transactions', []), 'DEGIRO');
});

/* ---------- Page and sheets HTML ---------- */
test('renderMore: eight groups, names escaped, demo rows depend on the data', () => {
  const d = realData();
  d.accounts[0].name = '<img src=x onerror=alert(1)>';
  useData(d);
  const html = renderMore();
  assert.equal((html.match(/class="more-group"/g) || []).length, 8);
  assert.ok(!html.includes('<img src=x'), 'account names are escaped');
  assert.ok(html.includes('&lt;img src=x'));
  assert.match(html, /data-act="demo-load"/, 'empty portfolio: offer the example');
  assert.doesNotMatch(html, /data-act="demo-remove"/);
  assert.match(html, /<h2 class="more-group-title" id="mg-accounts"><span class="more-gico">/, 'icon inline in the section title');
  useData(demoData({ today }));
  const demo = renderMore();
  assert.match(demo, /data-act="demo-remove"/);
  assert.doesNotMatch(demo, /data-act="demo-load"/);
  assert.match(demo, /more-switch" type="button" role="switch" aria-checked="false"/);
});

test('sheets: long forms keep the save button in a sticky bar; TER avatars use the 4-letter style', () => {
  useData(demoData({ today }));
  for (const name of ['more-rates', 'more-extpl', 'more-ter']) {
    const body = SHEETS[name]({}).body;
    assert.match(body, /<div class="sheet-actions more-sticky"><button class="btn primary" type="submit">Salva<\/button><\/div>/, name);
  }
  const ter = SHEETS['more-ter']({}).body;
  assert.match(ter, /<span class="avatar sm l4"[^>]*>VWCE<\/span>/);
  assert.match(SHEETS['more-account']({ id: 'gone' }).body, /non esiste più/);
  const acc = SHEETS['more-account']({ id: S.data.accounts[0].id });
  assert.equal(acc.title, 'Modifica conto');
  assert.match(acc.body, /data-act="more-account-delete"/);
  // drafts survive a re-render (sheet underneath another one)
  const draft = SHEETS['more-extpl']({ draft: { a2023: '42', s2023: '1' } }).body;
  assert.match(draft, /name="a2023"[^>]*value="42"/);
  assert.match(draft, /<option value="1" selected>Guadagno/);
});

test('renderMore: the example tag sits on the subtitle line, not next to the account name', () => {
  useData(demoData({ today }));
  const html = renderMore();
  const deg = S.data.accounts.find((a) => a.demo);
  const row = html.slice(html.indexOf(`data-id="${deg.id}"`), html.indexOf('</button>', html.indexOf(`data-id="${deg.id}"`)));
  assert.match(row, /<span class="row-title">[^<]+<\/span><span class="row-sub"><span class="tag">esempio<\/span> /);
});

test('renderMore: account subtitle skips the broker when it repeats the name', () => {
  const d = realData();
  d.accounts.push({ id: 'p', name: 'Conto Fineco', broker: 'Altro', cashMode: 'track' });
  useData(d);
  const html = renderMore();
  assert.match(html, /<span class="row-title">DEGIRO<\/span><span class="row-sub">Solo investimenti · 0 operazioni<\/span>/);
  assert.match(html, /<span class="row-title">Conto Fineco<\/span><span class="row-sub">Altro intermediario · Con liquidità · 0 operazioni<\/span>/);
});

/* ---------- Data only on the device: no sync, privacy group ---------- */
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function withNavigator(nav, fn) {
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
    else delete globalThis.navigator;
  }
}
function groupHtml(html, id) {
  const start = html.indexOf(`aria-labelledby="mg-${id}"`);
  assert.ok(start > 0, `group ${id} is on the page`);
  return html.slice(start, html.indexOf('</section>', start));
}

test('no sync anywhere: no sync sheets, forms, actions, inputs, rows or copy; sync.js is not imported', () => {
  useData(realData());
  for (const reg of [SHEETS, FORMS, ACTIONS, INPUTS]) {
    assert.deepEqual(Object.keys(reg).filter((k) => /sync/i.test(k)), []);
  }
  const html = renderMore();
  assert.doesNotMatch(html, /sincronizz|sync|frase segreta|PC\b|Cloudflare|KV/i);
  assert.doesNotMatch(html, /data-topic="pc"/, 'no «Installa su PC» guide');
  assert.match(html, /data-topic="iphone"/);
  const src = readFileSync(new URL('../js/views/more.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from '\.\.\/sync\.js'/);
  assert.doesNotMatch(src, /window\.claude|GRUZZOLO_ARTIFACT/, 'no Claude storage branch');
  for (const topic of ['iphone', 'offline', 'prices']) {
    const g = SHEETS['more-guide']({ topic });
    assert.doesNotMatch(g.body, /sincronizz|sync|\bPC\b/i, topic);
  }
  assert.equal(SHEETS['more-guide']({ topic: 'pc' }).title, 'Da dove arrivano i prezzi', 'an old topic falls back to the prices guide');
  const server = SHEETS['more-server']({}).body;
  assert.doesNotMatch(server, /sincronizz|KV|Cloudflare/i);
  assert.match(server, /solo i nomi e i ticker dei titoli/);
});

test('wipe and backup import confirmations: no sync wording, a backup reminder instead', async () => {
  const d = realData();
  d.txns = [{ id: 't', acc: 'deg', date: '2024-01-02', type: 'deposit', amount: 100 }];
  useData(d);
  const asked = [];
  const prev = app.askConfirm;
  app.askConfirm = (o) => asked.push(o);
  try {
    ACTIONS['more-wipe']();
    const backup = JSON.stringify({ ...realData(), v: 2, txns: [{ id: 'x', acc: 'deg', date: '2024-02-01', type: 'deposit', amount: 5 }], updatedAt: 1700000000000 });
    const file = { name: 'gruzzolo-backup.json', size: backup.length, arrayBuffer: async () => new TextEncoder().encode(backup).buffer };
    await INPUTS['more-import-file']({ files: [file], value: 'x' }, { type: 'change' });
  } finally {
    app.askConfirm = prev;
  }
  assert.equal(asked.length, 2);
  for (const o of asked) {
    assert.doesNotMatch(o.text, /sincronizz|altro dispositivo/i, o.title);
    assert.match(o.text, /esporta prima un backup/, o.title);
  }
  assert.equal(asked[1].title, 'Importare il backup?');
  assert.match(asked[1].text, /1 operazione in 1 conto/);
  // confirming the import replaces the data
  asked[1].onOk();
  assert.deepEqual(S.data.txns.map((t) => t.id), ['x']);
});

test('deviceName, hasUserContent, fmtBytes', () => {
  assert.equal(deviceName(IPHONE_UA), 'iPhone');
  assert.equal(deviceName('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'iPad');
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64) Chrome/130'), '');
  assert.equal(hasUserContent(null), false);
  assert.equal(hasUserContent(migrate(demoData({ today }))), false, 'example data does not count');
  assert.equal(hasUserContent({ txns: [], assets: {}, watch: [{ symbol: 'AAPL' }] }), true);
  assert.equal(hasUserContent({ txns: [{ demo: true }], assets: { a: { id: 'a' } } }), true);
  assert.equal(fmtBytes(0), '0 byte');
  assert.equal(fmtBytes(850000), '850 kB');
  assert.equal(fmtBytes(2400000), '2,4 MB');
  assert.equal(fmtBytes(1.5e9), '1,5 GB');
  assert.equal(fmtBytes(NaN), '—');
  assert.equal(fmtBytes(null), '—');
});

test('readStorageStatus: works with the helper missing, throwing or returning odd values', async () => {
  const none = { persisted: null, usage: null, quota: null };
  assert.deepEqual(await readStorageStatus(undefined), none);
  assert.deepEqual(await readStorageStatus(null), none);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(await readStorageStatus(async () => {
      throw new Error('boom');
    }), none);
    assert.deepEqual(await readStorageStatus(() => {
      throw new Error('sync boom');
    }), none);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(await readStorageStatus(async () => null), none);
  assert.deepEqual(await readStorageStatus(async () => ({ persisted: 'yes', usage: NaN, quota: -1 })), none);
  assert.deepEqual(await readStorageStatus(async () => ({ persisted: true, usage: 2400000, quota: 1e9 })), { persisted: true, usage: 2400000, quota: 1e9 });
  assert.deepEqual(await readStorageStatus(() => ({ persisted: false, usage: 0, quota: null })), { persisted: false, usage: 0, quota: null });
});

test('privacy group: data only on this device, storage status (unknown, granted, refused, unavailable), backup button', async () => {
  useData(realData());
  _test.resetStorage();
  let html = renderMore();
  assert.equal((html.match(/class="more-group"/g) || []).length, 8);
  let g = groupHtml(html, 'privacy');
  assert.match(g, /Dove sono i tuoi dati/);
  assert.match(g, /I tuoi dati restano solo su questo dispositivo/);
  assert.match(g, /Niente account e niente cloud/);
  assert.match(g, /Cosa passa da internet/);
  assert.match(g, /Mai importi, quantità, conti o operazioni/);
  assert.match(g, /id="more-storage" data-state="loading"/);
  assert.match(g, /Controllo la memoria/);
  assert.match(g, /data-act="more-backup-export"/, 'a direct backup button');
  assert.match(g, /Non hai ancora fatto un backup/);
  assert.doesNotMatch(g, /data-topic="iphone"/, 'no install hint off iOS');

  // granted, with the space used
  let calls = 0;
  await refreshStorage({ force: true, read: async () => (calls++, { persisted: true, usage: 2400000, quota: 5e9 }) });
  g = groupHtml(renderMore(), 'privacy');
  assert.match(g, /<span class="dot online"><\/span>/);
  assert.match(g, /Memoria permanente attiva/);
  assert.match(g, /<span class="row-value">2,4 MB<\/span><span class="row-sub">usati<\/span>/);
  // throttled: a second read within 30 s reuses the result, force reads again
  await refreshStorage({ read: async () => (calls++, { persisted: false }) });
  assert.equal(calls, 1);
  assert.equal(_test.storage.persisted, true);

  // refused, with navigator.storage.persist available: the row asks again on tap
  await refreshStorage({ force: true, read: async () => ({ persisted: false, usage: null, quota: null }) });
  g = withNavigator({ userAgent: 'test', storage: { persist: async () => true } }, () => groupHtml(renderMore(), 'privacy'));
  assert.match(g, /<button class="row more-row more-status more-note" type="button" id="more-storage"[^>]*data-act="more-storage-persist"/);
  assert.match(g, /Memoria permanente non ancora concessa/);
  assert.match(g, /Tocca per chiederla di nuovo/);
  assert.doesNotMatch(g, /usati/, 'no size when unknown');
  // refused without the API: plain row, no tap hint
  g = withNavigator({ userAgent: 'test' }, () => groupHtml(renderMore(), 'privacy'));
  assert.doesNotMatch(g, /more-storage-persist|Tocca per chiederla/);

  // helper missing (another build): «not available», the page still renders
  await refreshStorage({ force: true, read: undefined });
  g = groupHtml(renderMore(), 'privacy');
  assert.match(g, /Stato della memoria non disponibile/);
  assert.match(g, /<span class="dot offline"><\/span>/);
  _test.resetStorage();
});

test('privacy group on iPhone: names the phone, install hint in Safari, iOS wording in backup rows', async () => {
  useData(realData());
  _test.resetStorage();
  await refreshStorage({ force: true, read: async () => ({ persisted: true, usage: 1200, quota: 1e9 }) });
  const html = withNavigator({ userAgent: IPHONE_UA, maxTouchPoints: 5, standalone: false }, () => renderMore());
  const g = groupHtml(html, 'privacy');
  assert.match(g, /I tuoi dati restano solo su questo iPhone/);
  assert.match(g, /qui sul telefono/);
  assert.match(g, /iOS conserva i dati di Gruzzolo/);
  assert.match(g, /1 kB/);
  assert.match(g, /data-act="more-guide" data-topic="iphone"/, 'opened in Safari: suggest the Home Screen icon');
  assert.match(g, /se elimini l&#39;icona di Gruzzolo, iOS cancella anche i suoi dati/);
  const data = groupHtml(html, 'data');
  assert.match(data, /Si apre Condividi: scegli «Salva su File» → «Sul mio iPhone»/);
  assert.match(data, /Scegli il file \.json nell&#39;app File/);
  // in Safari a refused storage points to the Home Screen icon instead of a tap that cannot help
  await refreshStorage({ force: true, read: async () => ({ persisted: false, usage: null, quota: null }) });
  const safari = withNavigator({ userAgent: IPHONE_UA, standalone: false, storage: { persist: async () => false } }, () => groupHtml(renderMore(), 'privacy'));
  assert.match(safari, /se il telefono resta senza spazio iOS potrebbe cancellarli\. Si attiva aprendo Gruzzolo dall&#39;icona/);
  assert.doesNotMatch(safari, /more-storage-persist/);
  // installed (standalone): no install hint, the guide row says it is done
  const inst = withNavigator({ userAgent: IPHONE_UA, standalone: true }, () => renderMore());
  assert.doesNotMatch(groupHtml(inst, 'privacy'), /data-topic="iphone"/);
  assert.match(groupHtml(inst, 'guide'), /Fatto: stai usando l&#39;app installata/);
  _test.resetStorage();
});

test('backupReminder: never, recent, today, overdue', () => {
  const now = Date.now();
  assert.deepEqual(backupReminder(0, { today, content: true }), { due: true, text: 'Non hai ancora fatto un backup: fanne uno ogni mese' });
  assert.equal(backupReminder(0, { today, content: false }).due, false, 'nothing to save yet');
  const recent = backupReminder(new Date(`${addDays(today, -10)}T12:00:00`).getTime(), { today });
  assert.equal(recent.due, false);
  assert.match(recent.text, /^Ultimo backup il \d+ \w+ \d{4}$/);
  assert.match(backupReminder(now, { today }).text, /^Ultimo backup oggi alle \d\d:\d\d$/);
  const old = backupReminder(new Date(`${addDays(today, -(BACKUP_EVERY_DAYS + 5))}T12:00:00`).getTime(), { today });
  assert.equal(old.due, true);
  assert.match(old.text, /è ora di farne uno nuovo/);
});

test('guide «Installa su iPhone»: Safari, Condividi, Home Screen, always from the icon, first launch online', () => {
  const body = SHEETS['more-guide']({ topic: 'iphone' }).body;
  for (const re of [/Safari/, /Condividi/, /Aggiungi alla schermata Home/, /sempre dall'icona/, /resta online/, /Inizia da zero/, /esporta un backup/]) assert.match(body, re);
  const off = SHEETS['more-guide']({ topic: 'offline' });
  assert.equal(off.title, 'Senza internet');
  assert.match(off.body, /funziona anche in aereo/);
  assert.match(SHEETS['more-guide']({ topic: 'prices' }).body, /mai importi, quantità, conti o operazioni/);
});
