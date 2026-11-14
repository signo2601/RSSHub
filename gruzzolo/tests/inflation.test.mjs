// Real returns: inflation between two dates on the monthly HICP, deflating a return, annualizing,
// and the "Rendimento reale" of the Report summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonth, inflationBetween, realReturn, annualize, lastMonth, yearOnYear } from '../js/inflation.js';
import { realOf } from '../js/views/sheet-summary.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
// Index from 2024-01: +0,2% a month on Italy, flat euro area; the last 2 months not published yet
const IT = Array.from({ length: 34 }, (_, i) => (i < 32 ? +(100 * 1.002 ** i).toFixed(6) : null));
const DATA = { start: '2024-01', series: { IT, EA: Array.from({ length: 34 }, () => 100) } };

test('months and the last one published', () => {
  assert.equal(addMonth('2024-11', 2), '2025-01');
  assert.equal(addMonth('2024-01', -1), '2023-12');
  assert.equal(addMonth('2024-01', -13), '2022-12');
  assert.equal(lastMonth(DATA), '2026-08');
  assert.equal(lastMonth(DATA, 'EA'), '2026-10');
});

test('inflation of a calendar year goes from December to December', () => {
  const y = inflationBetween(DATA, '2025-01-01', '2025-12-31');
  assert.equal(y.fromMonth, '2024-12');
  assert.equal(y.toMonth, '2025-12');
  close(y.rate, 1.002 ** 12 - 1, 1e-6);
  assert.equal(y.partial, false);
  // A period after the last month published stops there and says so
  const p = inflationBetween(DATA, '2026-01-01', '2026-10-31');
  assert.equal(p.toMonth, '2026-08');
  assert.equal(p.partial, true);
  close(p.rate, 1.002 ** 8 - 1, 1e-6);
  assert.equal(inflationBetween(DATA, '2023-06-01', '2024-06-30'), null, 'before the series starts');
  assert.equal(inflationBetween(DATA, '2025-06-01', '2025-01-01'), null);
  assert.equal(inflationBetween({}, '2025-01-01', '2025-12-31'), null);
  close(inflationBetween(DATA, '2025-01-01', '2025-12-31', 'EA').rate, 0);
});

test('real return and annualized rates', () => {
  close(realReturn(0.05, 0.03), 1.05 / 1.03 - 1);
  close(realReturn(-0.1, 0.02), 0.9 / 1.02 - 1);
  assert.equal(realReturn(0.05, null), null);
  close(annualize(0.21, 730), Math.sqrt(1.21) - 1, 1e-6);
  assert.equal(annualize(0.1, 0), null);
  const yoy = yearOnYear(DATA);
  assert.equal(yoy.month, '2026-08');
  close(yoy.rate, 1.002 ** 12 - 1, 1e-6);
});

test('report summary: TWR net of Italian inflation, yearly when the period is long enough', () => {
  const st = { from: '2025-01-01', to: '2025-12-31', twr: 0.1, days: 365, cagr: 0.1 };
  const r = realOf(st, DATA);
  const infl = 1.002 ** 12 - 1;
  close(r.real, 1.1 / (1 + infl) - 1, 1e-6);
  close(r.infl, infl, 1e-6);
  close(r.realYear, 1.1 / (1 + infl) - 1, 1e-4);
  const short = realOf({ ...st, to: '2025-03-31', days: 90 }, DATA);
  assert.equal(short.realYear, undefined, 'no yearly figure under a year');
  assert.equal(realOf(st, null), null);
});
