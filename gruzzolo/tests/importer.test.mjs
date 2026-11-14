import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, detectPreset, guessMapping, parseDate, parseAmount, buildTxns, importCsv, detectDecimal, degiroAccountKind, typeFromText, PRESETS } from '../js/importer.js';

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const near = (a, b, eps = 0.006) => Math.abs(a - b) <= eps;
const byType = (txns) => txns.reduce((m, t) => ((m[t.type] = (m[t.type] || 0) + 1), m), {});

/* ---------- Parsing primitives ---------- */
test('parseCsv: RFC 4180 quotes, BOM, CRLF, empty lines, delimiter detection', () => {
  const r = parseCsv('﻿a,b,c\r\n1,"x, y",3\r\n\r\n4,"he said ""hi""",6\n7,"multi\nline",9');
  assert.equal(r.delimiter, ',');
  assert.deepEqual(r.headers, ['a', 'b', 'c']);
  assert.deepEqual(r.rows, [['1', 'x, y', '3'], ['4', 'he said "hi"', '6'], ['7', 'multi\nline', '9']]);
  assert.equal(parseCsv('a;b;c\n1,5;2,5;3').delimiter, ';');
  assert.deepEqual(parseCsv('a;b;c\n1,5;2,5;3').rows[0], ['1,5', '2,5', '3']);
  assert.equal(parseCsv('a\tb\n1\t2').delimiter, '\t');
  assert.equal(parseCsv('a|b|c\n1|2|3').delimiter, '|');
  assert.equal(parseCsv('sep=;\na;b\n1;2').delimiter, ';');
  assert.deepEqual(parseCsv('sep=;\na;b\n1;2').headers, ['a', 'b']);
  assert.deepEqual(parseCsv('').rows, []);
});

test('parseDate: dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy, yyyy-mm-dd, invalid', () => {
  assert.equal(parseDate('05-03-2024'), '2024-03-05');
  assert.equal(parseDate('5/3/2024'), '2024-03-05');
  assert.equal(parseDate('05.03.2024'), '2024-03-05');
  assert.equal(parseDate('2024-03-05'), '2024-03-05');
  assert.equal(parseDate('2024-03-05 10:15:22'), '2024-03-05');
  assert.equal(parseDate('2024-03-05T10:15:22Z'), '2024-03-05');
  assert.equal(parseDate('05/03/24'), '2024-03-05');
  assert.equal(parseDate('03/25/2024'), '2024-03-25', 'month/day order when the day cannot be a month');
  assert.equal(parseDate('31-02-2024'), null);
  assert.equal(parseDate('2024-13-01'), null);
  assert.equal(parseDate('ieri'), null);
  assert.equal(parseDate(''), null);
});

test('parseAmount: Italian and English decimals, signs, parentheses, currency symbols', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('-12,5'), -12.5);
  assert.equal(parseAmount('−3,20'), -3.2);
  assert.equal(parseAmount('(1.234,50)'), -1234.5);
  assert.equal(parseAmount('12,50-'), -12.5);
  assert.equal(parseAmount('€ 1 234,56'), 1234.56);
  assert.equal(parseAmount('12,30 EUR'), 12.3);
  assert.equal(parseAmount('EUR -7.10'), -7.1);
  assert.equal(parseAmount('+3'), 3);
  assert.equal(parseAmount('396.4600'), 396.46);
  assert.equal(parseAmount('1.234.567'), 1234567);
  assert.equal(parseAmount('1,234,567'), 1234567);
  assert.equal(parseAmount('1.234', ','), 1234, 'Italian file: thousands');
  assert.equal(parseAmount('1.234'), 1.234);
  assert.equal(parseAmount('1,234', '.'), 1234, 'English file: thousands');
  assert.equal(parseAmount('1,672'), 1.672);
  assert.equal(parseAmount('-0,00'), 0);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('abc')));
  assert.equal(detectDecimal(['1,50', '-2.464,90', '3']), ',');
  assert.equal(detectDecimal(['396.4600', '-792.92']), '.');
  assert.equal(detectDecimal(['3', '10']), null);
});

test('detectPreset and guessMapping for every supported file', () => {
  const cases = {
    'degiro-transactions-it.csv': 'degiro-transactions',
    'degiro-transactions-en.csv': 'degiro-transactions',
    'degiro-account-it.csv': 'degiro-account',
    'degiro-account-en.csv': 'degiro-account',
    'scalable-en.csv': 'scalable',
    'scalable-de.csv': 'scalable',
    'generic-it.csv': 'generic',
  };
  for (const [file, preset] of Object.entries(cases)) {
    const { headers } = parseCsv(fixture(file));
    assert.equal(detectPreset(headers), preset, file);
    assert.ok(PRESETS[preset].label);
  }
  const it = guessMapping(parseCsv(fixture('degiro-transactions-it.csv')).headers, 'degiro-transactions');
  assert.deepEqual(
    { date: it.date, time: it.time, name: it.name, isin: it.isin, qty: it.qty, price: it.price, currency: it.currency, amount: it.amount, fx: it.fx, fee: it.fee, total: it.total, ref: it.ref },
    { date: 0, time: 1, name: 2, isin: 3, qty: 6, price: 7, currency: 8, amount: 11, fx: 13, fee: 14, total: 16, ref: 18 },
  );
  for (const k of ['date', 'time', 'type', 'isin', 'symbol', 'name', 'qty', 'price', 'currency', 'fx', 'fee', 'amount', 'total', 'ref', 'description']) assert.ok(k in it, k);
  const en = guessMapping(parseCsv(fixture('degiro-transactions-en.csv')).headers);
  assert.equal(en.fxFee, 13);
  assert.equal(en.fee, 14);
  assert.equal(en.total, 15);
  const sc = guessMapping(parseCsv(fixture('scalable-de.csv')).headers, 'scalable');
  assert.deepEqual([sc.date, sc.type, sc.isin, sc.qty, sc.price, sc.amount, sc.fee, sc.tax, sc.currency, sc.ref], [0, 6, 7, 8, 9, 10, 11, 12, 13, 3]);
  const gen = guessMapping(parseCsv(fixture('generic-it.csv')).headers);
  assert.deepEqual([gen.date, gen.type, gen.isin, gen.name, gen.qty, gen.price, gen.currency, gen.fx, gen.fee, gen.amount, gen.description], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('keyword classification', () => {
  assert.equal(typeFromText('Acquisto'), 'buy');
  assert.equal(typeFromText('Savings plan'), 'buy');
  assert.equal(typeFromText('Verkauf'), 'sell');
  assert.equal(typeFromText('Ausschüttung'), 'div');
  assert.equal(typeFromText('Cedola'), 'div');
  assert.equal(typeFromText('Ritenuta sul dividendo'), 'tax');
  assert.equal(typeFromText('Einzahlung'), 'deposit');
  assert.equal(typeFromText('Prelievo'), 'withdraw');
  assert.equal(typeFromText('Zinsen'), 'interest');
  assert.equal(typeFromText('Gebühr'), 'fee');
  assert.equal(typeFromText('Giroconto'), null);
  assert.equal(degiroAccountKind('Ritenuta sul dividendo'), 'wht');
  assert.equal(degiroAccountKind('Dividend Tax'), 'wht');
  assert.equal(degiroAccountKind('DEGIRO Exchange Connection Fee 2024 (Nasdaq - NDQ)'), 'connectivity');
  assert.equal(degiroAccountKind('Cambio valuta (Addebito)'), 'fx');
  assert.equal(degiroAccountKind('FX Debit commission'), 'autofx');
  assert.equal(degiroAccountKind('flatex Interest Income'), 'interest');
  assert.equal(degiroAccountKind('iDEAL Deposit'), 'deposit');
  assert.equal(degiroAccountKind('Imposta di bollo'), 'stamp');
  assert.equal(degiroAccountKind('Money Market fund conversion: Buy'), 'mmf');
  assert.equal(degiroAccountKind('Buy 4 NVIDIA Corp@880.08 USD'), 'trade');
  assert.equal(degiroAccountKind('Interessi su conto corrente'), 'interest');
});

/* ---------- DEGIRO ---------- */
test('DEGIRO Transazioni (Italian export): buys, sells, fees, FX, bonds, partial fills', () => {
  const r = importCsv(fixture('degiro-transactions-it.csv'), { acc: 'deg', src: 'b1' });
  assert.equal(r.preset, 'degiro-transactions');
  assert.equal(r.txns.length, 8);
  assert.equal(r.skipped, 0);
  assert.deepEqual(byType(r.txns), { buy: 7, sell: 1 });
  assert.deepEqual(r.txns.map((t) => t.date), [...r.txns.map((t) => t.date)].sort(), 'sorted by date');
  for (const t of r.txns) {
    assert.equal(t.acc, 'deg');
    assert.equal(t.src, 'b1');
    assert.ok(t.ref);
    assert.ok(!('aid' in t));
  }
  const sell = r.txns.find((t) => t.type === 'sell');
  assert.deepEqual([sell.assetKey, sell.qty, sell.price, sell.fee], ['IT0003128367', 150, 6.712, 4.9]);
  const apple = r.txns.filter((t) => t.assetKey === 'US0378331005');
  assert.equal(apple.length, 2, 'partial fills of one order are both kept');
  assert.equal(apple[0].fx, 1.0877);
  assert.equal(apple[0].price, 172.62);
  assert.equal(apple[0].fee, 2);
  assert.equal(apple[1].fee, undefined);
  const vwce = r.txns.find((t) => t.assetKey === 'IE00BK5BQT80');
  assert.equal(vwce.fx, undefined, 'no fx for EUR');
  const btp = r.txns.find((t) => t.assetKey === 'IT0005024234');
  assert.equal(btp.qty, 20, '2000 nominal → 20 lots of 100');
  assert.equal(btp.price, 98.75);
  assert.ok(near((btp.qty * btp.price), 1975));
  assert.ok(r.warnings.some((w) => /lotti da 100/.test(w)));
  const assets = Object.fromEntries(r.assets.map((a) => [a.key, a]));
  assert.equal(assets.US0378331005.currency, 'USD');
  assert.equal(assets.US0378331005.exchange, 'NDQ');
  assert.equal(assets.IT0005024234.type, 'bond');
  assert.equal(assets.IE00BK5BQT80.type, 'etf');
  assert.equal(r.assets.length, 5);
});

test('DEGIRO Transactions (English, newer layout): AutoFX column and GBX prices', () => {
  const r = importCsv(fixture('degiro-transactions-en.csv'), { acc: 'deg' });
  assert.equal(r.txns.length, 4);
  assert.deepEqual(byType(r.txns), { buy: 3, sell: 1 });
  const nv = r.txns.find((t) => t.assetKey === 'US67066G1040' && t.type === 'buy');
  assert.deepEqual([nv.qty, nv.price, nv.fx, nv.fee, nv.fxFee], [4, 924.79, 1.0858, 2, 8.52]);
  const lg = r.txns.find((t) => t.assetKey === 'GB0005603997');
  assert.equal(lg.price, 2.365, 'pence → pounds');
  assert.ok(near(lg.fx, 0.85495, 1e-9));
  assert.ok(near((lg.qty * lg.price) / lg.fx, 829.87, 0.01));
  assert.equal(r.assets.find((a) => a.key === 'GB0005603997').currency, 'GBP');
  assert.ok(r.src.startsWith('imp'), 'default batch id');
});

test('DEGIRO Estratto conto (Italian): dividends with withholding, fees, cash movements, skipped rows', () => {
  const r = importCsv(fixture('degiro-account-it.csv'), { acc: 'deg', src: 'b2' });
  assert.equal(r.preset, 'degiro-account');
  assert.equal(r.rows, 24);
  assert.deepEqual(byType(r.txns), { deposit: 2, fee: 4, div: 3, tax: 1, withdraw: 1, interest: 1 });
  assert.equal(r.txns.length, 12);
  assert.equal(r.skipped, 9);
  assert.equal(r.txns.length + r.skipped + 3, r.rows, '3 withholding rows merged into their dividends');
  assert.equal(r.skippedReasons['compravendita (nel file Transazioni)'], 2);
  assert.equal(r.skippedReasons['commissione già nel file Transazioni'], 2);
  assert.equal(r.skippedReasons['cambio valuta'], 2);
  assert.equal(r.skippedReasons['fondo monetario'], 1);
  assert.equal(r.skippedReasons['trasferimento interno'], 1);
  assert.equal(r.skippedReasons['movimento non riconosciuto'], 1);
  assert.ok(r.warnings.some((w) => w.includes('Spin-off ABC Holding')));

  const enel = r.txns.find((t) => t.type === 'div' && t.assetKey === 'IT0003128367');
  assert.deepEqual([enel.date, enel.gross, enel.tax, enel.amount], ['2024-07-24', 86, 22.36, 63.64]);
  const btp = r.txns.find((t) => t.type === 'div' && t.assetKey === 'IT0005024234');
  assert.deepEqual([btp.gross, btp.tax, btp.amount], [35, 4.38, 30.62]);
  // USD dividend converted with the AutoFX conversion booked the same day (1,63 USD → 1,50 EUR)
  const aapl = r.txns.find((t) => t.type === 'div' && t.assetKey === 'US0378331005');
  assert.deepEqual([aapl.gross, aapl.tax, aapl.amount], [1.77, 0.27, 1.5]);

  const fees = r.txns.filter((t) => t.type === 'fee');
  assert.deepEqual(fees.map((f) => f.kind).sort(), ['autofx', 'connectivity', 'connectivity', 'other']);
  assert.ok(fees.filter((f) => f.kind === 'connectivity').every((f) => f.amount === 2.5 && /connessione/.test(f.note)));
  assert.equal(fees.find((f) => f.kind === 'autofx').amount, 1.98);
  assert.equal(fees.find((f) => f.kind === 'other').amount, 0.05, 'negative interest is a cost');
  const tax = r.txns.find((t) => t.type === 'tax');
  assert.deepEqual([tax.kind, tax.amount], ['stamp', 3.4]);
  assert.deepEqual(r.txns.filter((t) => t.type === 'deposit').map((t) => t.amount), [2000, 1000]);
  assert.equal(r.txns.find((t) => t.type === 'withdraw').amount, 300);
  assert.equal(r.txns.find((t) => t.type === 'interest').amount, 0.42);
  for (const t of r.txns) assert.ok(!(t.amount < 0), 'amounts are positive');
});

test('DEGIRO Account (English, amount before currency): FX rows, unconverted dividends, injected fx lookup', () => {
  const r = importCsv(fixture('degiro-account-en.csv'), { acc: 'deg' });
  assert.deepEqual(byType(r.txns), { fee: 1, deposit: 1, withdraw: 1, tax: 1, div: 2 });
  const realty = r.txns.find((t) => t.assetKey === 'US7561091049');
  assert.deepEqual([realty.gross, realty.tax, realty.amount], [1.17, 0.17, 1]);
  assert.equal(r.txns.find((t) => t.type === 'tax').kind, 'capital');
  // Verizon has no conversion nearby: kept in USD with a warning
  const vz = r.txns.find((t) => t.assetKey === 'US92343V1044');
  assert.deepEqual([vz.gross, vz.tax, vz.amount], [3.26, 0.49, 2.77]);
  assert.ok(r.warnings.some((w) => /USD non sono stati convertiti/.test(w)));
  assert.equal(r.skippedReasons['importo zero'], 1);
  // With the app's exchange rates the amount is converted
  const r2 = importCsv(fixture('degiro-account-en.csv'), { acc: 'deg', fxOn: (ccy) => (ccy === 'USD' ? 1.1 : 1) });
  const vz2 = r2.txns.find((t) => t.assetKey === 'US92343V1044');
  assert.deepEqual([vz2.gross, vz2.tax, vz2.amount], [2.96, 0.45, 2.52]);
  assert.ok(!r2.warnings.some((w) => /non sono stati convertiti/.test(w)));
});

/* ---------- Scalable Capital ---------- */
test('Scalable Capital (English export): types, status, decimal comma, fees and taxes', () => {
  const r = importCsv(fixture('scalable-en.csv'), { acc: 'sc', src: 'b3' });
  assert.equal(r.preset, 'scalable');
  assert.equal(r.txns.length, 12);
  assert.deepEqual(byType(r.txns), { deposit: 2, tax: 1, withdraw: 1, buy: 4, fee: 1, interest: 1, sell: 1, div: 1 });
  assert.equal(r.skipped, 2);
  assert.equal(r.skippedReasons['non eseguita'], 1);
  assert.equal(r.skippedReasons['operazione societaria o trasferimento'], 1);
  const plan = r.txns.filter((t) => t.note === 'Piano di accumulo');
  assert.equal(plan.length, 2);
  assert.deepEqual([plan[1].qty, plan[1].price, plan[1].fee], [1.672, 119.6, undefined]);
  const sell = r.txns.find((t) => t.type === 'sell');
  assert.deepEqual([sell.qty, sell.price, sell.fee, sell.ref], [2, 265.4, 0.99, 'WWEK 99887700']);
  const div = r.txns.find((t) => t.type === 'div');
  assert.deepEqual([div.assetKey, div.amount, div.tax, div.gross], ['DE0008404005', 10.21, 3.79, 14]);
  assert.deepEqual(r.txns.filter((t) => t.type === 'deposit').map((t) => t.amount), [2000, 1000]);
  assert.equal(r.txns.find((t) => t.type === 'withdraw').amount, 150);
  assert.deepEqual([r.txns.find((t) => t.type === 'fee').amount, r.txns.find((t) => t.type === 'fee').kind], [4.99, 'other']);
  assert.deepEqual([r.txns.find((t) => t.type === 'tax').amount, r.txns.find((t) => t.type === 'tax').kind], [7.8, 'capital']);
  assert.ok(r.txns.every((t) => t.ref && t.src === 'b3'));
});

test('Scalable Capital (German export)', () => {
  const r = importCsv(fixture('scalable-de.csv'), { acc: 'sc' });
  assert.deepEqual(byType(r.txns), { deposit: 1, div: 1, buy: 1 });
  const buy = r.txns.find((t) => t.type === 'buy');
  assert.deepEqual([buy.date, buy.qty, buy.price, buy.assetKey], ['2024-10-01', 1.612, 124.05, 'IE00BK5BQT80']);
  const div = r.txns.find((t) => t.type === 'div');
  assert.deepEqual([div.amount, div.tax, div.gross], [20.42, 7.58, 28]);
});

/* ---------- Generic ---------- */
test('generic Italian CSV: keyword types, sign of quantity, fx column, cash movements', () => {
  const r = importCsv(fixture('generic-it.csv'), { acc: 'g' });
  assert.equal(r.preset, 'generic');
  assert.equal(r.txns.length, 8);
  assert.deepEqual(byType(r.txns), { buy: 2, div: 1, sell: 1, deposit: 1, tax: 1, fee: 1, interest: 1 });
  assert.equal(r.skipped, 1);
  assert.ok(r.warnings.some((w) => w.includes('Giroconto')));
  const apple = r.txns.find((t) => t.assetKey === 'US0378331005');
  assert.deepEqual([apple.qty, apple.price, apple.fx, apple.fee], [3, 182.3, 1.079, 1]);
  const sell = r.txns.find((t) => t.type === 'sell');
  assert.equal(sell.qty, 50);
  assert.equal(r.txns.find((t) => t.type === 'deposit').amount, 1500);
  assert.equal(r.txns.find((t) => t.type === 'tax').kind, 'stamp');
  assert.equal(r.txns.find((t) => t.type === 'fee').kind, 'connectivity');
  assert.equal(r.txns.find((t) => t.type === 'div').note, 'Dividendo netto; saldo 2023');
  // Without a type column the sign of the quantity decides
  const r2 = importCsv('Date,Ticker,Quantity,Price\n2024-01-05,MSFT,2,370.5\n2024-02-05,MSFT,-1,400\n', { acc: 'g' });
  assert.deepEqual(r2.txns.map((t) => [t.type, t.assetKey, t.qty, t.price]), [['buy', 'MSFT', 2, 370.5], ['sell', 'MSFT', 1, 400]]);
  assert.equal(r2.assets[0].symbol, 'MSFT');
});

/* ---------- Duplicates ---------- */
test('duplicates: same order id or same trade already in the account are skipped', () => {
  const first = importCsv(fixture('degiro-transactions-it.csv'), { acc: 'deg', src: 'b1' });
  const again = importCsv(fixture('degiro-transactions-it.csv'), { acc: 'deg', src: 'b2', existing: first.txns });
  assert.equal(again.txns.length, 0);
  assert.equal(again.duplicates, 8);
  // Another account: not duplicates
  const other = importCsv(fixture('degiro-transactions-it.csv'), { acc: 'other', existing: first.txns });
  assert.equal(other.txns.length, 8);

  // After the UI committed them: asset ids instead of keys, no refs (e.g. typed by hand)
  const assets = {};
  const committed = first.txns.map((t, i) => {
    const aid = 'a' + t.assetKey;
    assets[aid] = { id: aid, isin: t.assetKey, name: 'x' };
    const { assetKey, ref, ...rest } = t;
    return { ...rest, id: 'c' + i, aid };
  });
  const third = importCsv(fixture('degiro-transactions-it.csv'), { acc: 'deg', existing: committed, assets });
  assert.equal(third.duplicates, 8);
  assert.equal(third.txns.length, 0);

  // Account statement imported twice: cash movements recognized by date, type and amount
  const acc1 = importCsv(fixture('degiro-account-it.csv'), { acc: 'deg' });
  const acc2 = importCsv(fixture('degiro-account-it.csv'), { acc: 'deg', existing: acc1.txns.map(({ assetKey, ...t }) => ({ ...t, aid: assetKey ? 'a' + assetKey : undefined })), assets: Object.fromEntries(acc1.assets.map((a) => ['a' + a.key, { isin: a.isin }])) });
  assert.equal(acc2.txns.length, 0);
  assert.equal(acc2.duplicates, 12);
});

test('buildTxns with a hand-made mapping', () => {
  const { headers, rows } = parseCsv('Quando;Cosa;Codice;Pezzi;Prezzo unitario\n02/01/2025;acquisto;IE00BK5BQT80;3;120,50');
  assert.equal(detectPreset(headers), 'generic');
  const mapping = { ...guessMapping(headers, 'generic'), date: 0, type: 1, isin: 2 };
  const r = buildTxns(rows, mapping, { preset: 'generic', acc: 'x', src: 's' });
  assert.deepEqual(r.txns, [{ id: 's-1', acc: 'x', date: '2025-01-02', type: 'buy', assetKey: 'IE00BK5BQT80', qty: 3, price: 120.5, src: 's' }]);
});
