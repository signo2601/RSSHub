// Pure helpers of the portfolio views (home.js, sheets.js, market.js) and two regressions:
// today's change ignores shares bought today; example (synthetic) quotes vanish with the example data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { S, migrate, bump } from '../js/state.js';
import { market } from '../js/market.js';
import { positions } from '../js/engine.js';
import { todayISO, addDays } from '../js/util.js';
import { rangeStart, rangePoints, txAmount, txLabel, _test as homeTest } from '../js/views/home.js';
import { guessCurrency, tickerOf, closeOn, historyPoints, heldQty } from '../js/views/sheets.js';
import { quoteOf, _test as marketTest } from '../js/views/market.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('rangeStart: presets relative to today', () => {
  assert.equal(rangeStart('YTD', '2026-10-09'), '2025-12-31');
  assert.equal(rangeStart('1A', '2026-10-09'), '2025-10-09');
  assert.equal(rangeStart('1S', '2026-10-09'), '2026-10-02');
  assert.equal(rangeStart('3M', '2026-05-31'), '2026-02-28');
  assert.equal(rangeStart('MAX', '2026-10-09'), null);
});

test('rangePoints: gain excludes external flows, perf compounds daily returns', () => {
  const series = {
    dates: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'],
    value: [100, 110, 210, 220, 231],
    invested: [100, 100, 200, 200, 200],
    cash: [0, 0, 0, 0, 0],
    flowIn: [100, 0, 100, 0, 0],
    flowOut: [0, 0, 0, 0, 0],
    ret: [0, 0.1, 0, 10 / 210, 0.05],
  };
  const R = rangePoints(series, 'MAX', '2026-01-05');
  assert.equal(R.base, -1);
  assert.deepEqual(R.gain, [0, 10, 10, 20, 31]);
  close(R.gainTotal, 31);
  close(R.perfTotal, 1.1 * (220 / 210) * 1.05 - 1);
  assert.equal(R.valueEnd, 231);
  // A range starting inside the series is measured from its base close
  const W = rangePoints(series, '1S', '2026-01-09'); // base close: 2 Jan
  assert.equal(W.base, 1);
  assert.equal(W.dates[0], '2026-01-02');
  assert.deepEqual(W.gain, [0, 0, 10, 21]);
  close(W.perfTotal, (220 / 210) * 1.05 - 1);
  // A range longer than the series starts from the first transaction (base -1)
  assert.equal(rangePoints(series, '1A', '2026-01-05').base, -1);
  assert.equal(rangePoints({ dates: [] }, 'MAX', '2026-01-01'), null);
});

test('txAmount and txLabel', () => {
  close(txAmount({ type: 'buy', qty: 10, price: 11, fx: 1.1, fee: 2, fxFee: 1 }), -103);
  close(txAmount({ type: 'sell', qty: 10, price: 11, fx: 1.1, fee: 2, fxFee: 1, tax: 3 }), 94);
  assert.equal(txAmount({ type: 'div', amount: 7.4 }), 7.4);
  assert.equal(txAmount({ type: 'fee', amount: 2.5 }), -2.5);
  assert.equal(txAmount({ type: 'withdraw', amount: 50 }), -50);
  assert.equal(txLabel({ type: 'fee', kind: 'autofx' }), 'Costo cambio valuta');
  assert.equal(txLabel({ type: 'tax', kind: 'stamp' }), 'Imposta di bollo');
  assert.equal(txLabel({ type: 'div' }), 'Dividendo');
});

test('guessCurrency and tickerOf from Yahoo symbols', () => {
  assert.equal(guessCurrency('ENEL.MI'), 'EUR');
  assert.equal(guessCurrency('VUSA.L'), 'GBP');
  assert.equal(guessCurrency('NESN.SW'), 'CHF');
  assert.equal(guessCurrency('AAPL'), 'USD');
  assert.equal(guessCurrency('BTC-EUR'), 'EUR');
  assert.equal(tickerOf('VWCE.DE'), 'VWCE');
  assert.equal(tickerOf('BTC-USD'), 'BTC');
  assert.equal(tickerOf('^GSPC'), 'GSPC');
  assert.equal(tickerOf('EURUSD=X'), 'EURUSD');
});

test('closeOn and historyPoints use the latest quote when newer', () => {
  const t = new Date(2026, 9, 9, 15, 30).getTime();
  const h = { dates: ['2026-10-07', '2026-10-08'], close: [10, 11], price: 12, time: t };
  assert.equal(closeOn(h, '2026-10-06'), null);
  assert.equal(closeOn(h, '2026-10-07'), 10);
  assert.equal(closeOn(h, '2026-10-08'), 11);
  assert.equal(closeOn(h, '2026-10-09'), 12);
  assert.deepEqual(historyPoints(h), [['2026-10-07', 10], ['2026-10-08', 11], ['2026-10-09', 12]]);
  const same = { dates: ['2026-10-08', '2026-10-09'], close: [11, 11.5], price: 12, time: t };
  assert.deepEqual(historyPoints(same), [['2026-10-08', 11], ['2026-10-09', 12]]);
  assert.deepEqual(historyPoints(null), []);
});

// A small portfolio priced by a demo history ending today
function setupPortfolio({ demo = true } = {}) {
  const today = todayISO();
  const dates = [];
  const closes = [];
  for (let i = 10; i >= 0; i--) {
    dates.push(addDays(today, -i));
    closes.push(i === 0 ? 11 : 10);
  }
  market.inject('demo:ZZT.MI', { symbol: 'demo:ZZT.MI', currency: 'EUR', name: 'Zeta', type: 'stock', exchange: 'Milano', dates, close: closes, adj: closes, divs: [], synthetic: true });
  S.data = migrate({
    v: 2,
    accounts: [{ id: 'a1', name: 'Conto', broker: 'Altro', cashMode: 'auto' }],
    assets: { z: { id: 'z', name: 'Zeta', ticker: 'ZZT', symbol: 'ZZT.MI', type: 'stock', currency: 'EUR', priceSource: 'demo', ...(demo ? { demo: true } : {}) } },
    txns: [
      { id: 't1', acc: 'a1', date: addDays(today, -5), type: 'buy', aid: 'z', qty: 10, price: 10 },
      { id: 't2', acc: 'a1', date: today, type: 'buy', aid: 'z', qty: 10, price: 11 },
    ],
  });
  bump();
  return today;
}

test("today's change counts only shares held at the previous close", () => {
  const today = setupPortfolio();
  const open = positions({}).filter((p) => p.qty > 0);
  assert.equal(open.length, 1);
  close(open[0].dayChange, 20); // engine: 20 shares × (11 − 10)
  const info = homeTest.todayChange(open, today, null);
  assert.ok(info, 'today change computed');
  close(info.change, 10); // only the 10 shares held yesterday moved for the user
  close(info.pct, 0.1);
  assert.equal(info.isToday, true);
  assert.equal(heldQty('a1', 'z', today), 20);
  assert.equal(heldQty('a1', 'z', addDays(today, -1)), 10);
  assert.equal(heldQty('a1', 'z', today, 't2'), 10);
});

test('quoteOf shows synthetic example prices only while example data is loaded', () => {
  setupPortfolio({ demo: true });
  const q = quoteOf('ZZT.MI');
  assert.ok(q && q.demo, 'demo quote while the example portfolio is loaded');
  close(q.changePct, 0.1);
  setupPortfolio({ demo: false });
  assert.equal(quoteOf('ZZT.MI'), null);
});

test('search results: one offline note only (the page shows it)', () => {
  const before = market.status;
  market.status = 'offline';
  try {
    const html = marketTest.resultsHtml('enel');
    assert.ok(html.includes('ENEL.MI'), 'catalog results offline');
    assert.ok(!html.includes('non disponibile'), 'no duplicate offline note');
  } finally {
    market.status = before;
  }
});
