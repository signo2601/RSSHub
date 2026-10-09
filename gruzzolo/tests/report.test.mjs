// Report tab: shared building blocks, period logic, metric explanations and the first three sheets
// rendered on the example portfolio (summary, visual analysis, composition).
import test from 'node:test';
import assert from 'node:assert/strict';
import { S, bump, migrate } from '../js/state.js';
import { SHEETS } from '../js/registry.js';
import { demoData, installDemoMarket } from '../js/demo.js';
import { todayISO, addDays, addMonths } from '../js/util.js';
import { INFO, infoBtn } from '../js/info.js';
import {
  registerSheet, sheetDefs, kpiCard, chartCard, tableCard, emptyCard, badgeFor, accColor, renderReport, reportPeriod, _test as R,
} from '../js/views/report.js';
import { _test as SUM } from '../js/views/sheet-summary.js';
import { _test as VIS } from '../js/views/sheet-visual.js';
import { _test as COMP } from '../js/views/sheet-composition.js';

const T = todayISO();

function loadDemo() {
  S.data = migrate(demoData({ today: T }));
  installDemoMarket({ today: T });
  bump();
  S.loaded = true;
  Object.assign(S.ui, { tab: 'report', scope: 'all', sheet: 0, period: 'ALL', from: null, to: null, base100: false, logScale: false, allocBy: 'class', allocSel: null });
}
const errorOf = (html) => {
  const m = html.match(/class="error-card"[\s\S]*?<code>([\s\S]*?)<\/code>/);
  return m ? m[1] : null;
};

const CONTRACT_KEYS = ['saldoFinale', 'saldoIniziale', 'twr', 'liquidita', 'plRealizzato', 'plNonRealizzato', 'plCambio', 'attivoVsBenchmark',
  'flussiNetti', 'irr', 'volatilita', 'sharpe', 'cagr', 'maxDrawdown', 'sortino', 'beta', 'alpha', 'correlazione', 'trackingError', 'var95',
  'cvar95', 'gainLoss', 'periodiPositivi', 'equityCurve', 'rendimentiMensili', 'rendimentoAttivo', 'evoluzioneAllocazione', 'drawdownSeries',
  'rollingVol', 'allocazione', 'posizioniEffettive', 'dividendiTotali', 'dividendYield12m', 'valutaDividendi', 'valutaBond', 'calendarioIncome',
  'incomeCumulato', 'yieldDistribuzione', 'incomeTotale', 'prezzoVsIncome', 'incomeStimato', 'frequenzaDistribuzione', 'dividendiMancanti',
  'transactionFees', 'autofxFees', 'connectivityFees', 'costiBroker', 'ter', 'tassePlusvalenze', 'tasseDividendi', 'bollo', 'totaleImposte',
  'zainoFiscale', 'frontiera', 'rischioRetro', 'benchmark', 'riskFree', 'base100', 'scalaLog'];

test('INFO explains every key of the contract in plain Italian', () => {
  for (const k of CONTRACT_KEYS) {
    assert.ok(INFO[k], `missing INFO.${k}`);
    assert.equal(typeof INFO[k].title, 'string');
    assert.ok(INFO[k].title.length > 2, k);
    assert.ok(INFO[k].text.length > 40, `${k}: text too short`);
    if (INFO[k].formula !== undefined) assert.equal(typeof INFO[k].formula, 'string');
  }
  const btn = infoBtn('twr');
  assert.match(btn, /class="info-btn"/);
  assert.match(btn, /data-act="info"/);
  assert.match(btn, /data-key="twr"/);
  assert.match(infoBtn('"x<'), /data-key="&quot;x&lt;"/);
});

test('info sheet shows title, text and formula; unknown keys do not crash', () => {
  const s = SHEETS.info({ key: 'twr' });
  assert.equal(s.title, INFO.twr.title);
  assert.match(s.body, /Come si calcola/);
  const u = SHEETS.info({ key: 'nope' });
  assert.equal(u.title, 'Informazioni');
});

test('badgeFor and accColor', () => {
  assert.equal(badgeFor(0.01), 'up');
  assert.equal(badgeFor(-0.01), 'down');
  assert.equal(badgeFor(0.00001), 'flat');
  assert.equal(badgeFor(3, 5), 'flat');
  assert.equal(badgeFor(null), null);
  assert.equal(badgeFor(NaN), null);
  assert.equal(accColor(0), 'var(--c1)');
  assert.equal(accColor(7), 'var(--c8)');
  assert.equal(accColor(8), 'var(--c1)');
});

test('kpiCard, chartCard, tableCard and emptyCard markup', () => {
  const k = kpiCard({ label: 'P&L <x>', value: '1 €', badge: 'down', sub: 'sub', info: 'twr', cls: 'danger', bar: 0.25 });
  assert.match(k, /class="kpi rkpi danger"/);
  assert.match(k, /P&amp;L &lt;x&gt;/);
  assert.match(k, /class="badge down"/);
  assert.match(k, /data-key="twr"/);
  assert.match(k, /width:25\.0%/);
  assert.doesNotMatch(kpiCard({ label: 'a', value: '1' }), /badge|info-btn|kpi-bar/);

  const c = chartCard({ title: 'Curva equity (portafoglio, conti e benchmark)', subtitle: 'Sotto', body: '<svg></svg>', cls: 'full' });
  assert.match(c, /Curva equity <span class="ct-paren">\(portafoglio, conti e benchmark\)<\/span>/);
  assert.match(c, /chart-card rcard full/);
  assert.match(c, /<svg><\/svg>/);
  assert.equal(R.titleHtml('Senza parentesi <b>'), 'Senza parentesi &lt;b&gt;');

  const t = tableCard({ title: 'T', columns: [{ label: 'A', align: 'left' }, { label: 'B', align: 'right' }], rows: [['x', '1']], foot: ['Tot', '1'] });
  assert.match(t, /<th scope="col" class="num">B<\/th>/);
  assert.match(t, /<td class="num">1<\/td>/);
  assert.match(t, /<tfoot>/);
  const e = tableCard({ title: 'T', columns: [{ label: 'A' }, { label: 'B' }], rows: [], empty: 'Vuoto' });
  assert.match(e, /colspan="2">Vuoto</);
  assert.doesNotMatch(e, /<tfoot>/);
  assert.match(emptyCard('<niente>'), /&lt;niente&gt;/);
});

test('registerSheet keeps the sheets sorted and replaces an id', () => {
  const ids = sheetDefs().map((d) => d.id);
  assert.deepEqual(ids.slice(0, 3), ['summary', 'visual', 'composition']);
  registerSheet({ id: 'zz-test', order: 0.5, title: 'Test', subtitle: '', render: () => 'A' });
  assert.equal(sheetDefs()[0].id, 'zz-test');
  registerSheet({ id: 'zz-test', order: 99, title: 'Test 2', subtitle: '', render: () => 'B' });
  const defs = sheetDefs();
  assert.equal(defs.filter((d) => d.id === 'zz-test').length, 1);
  assert.equal(defs[defs.length - 1].title, 'Test 2');
  registerSheet({ id: 'broken' }); // no render: ignored
  assert.ok(!sheetDefs().some((d) => d.id === 'broken'));
});

test('reportPeriod: presets end today, start clamped to the first transaction', () => {
  const series = { start: addMonths(T, -30) };
  const p = (period, extra = {}) => reportPeriod(series, T, { period, from: null, to: null, ...extra });
  assert.deepEqual(p('ALL'), { period: 'ALL', from: series.start, to: T });
  assert.deepEqual(p('1M'), { period: '1M', from: addDays(addMonths(T, -1), 1), to: T });
  assert.equal(p('YTD').from, T.slice(0, 4) + '-01-01' < series.start ? series.start : T.slice(0, 4) + '-01-01');
  assert.equal(p('bogus').period, 'ALL');
  const young = { start: addDays(T, -10) };
  assert.equal(reportPeriod(young, T, { period: '1Y' }).from, young.start);
  // custom: swapped dates, end before the start of the data
  const c = p('CUSTOM', { from: addDays(T, -5), to: addDays(T, -20) });
  assert.deepEqual([c.from, c.to], [addDays(T, -20), addDays(T, -5)]);
  const early = reportPeriod(series, T, { period: 'CUSTOM', from: '2000-01-01', to: '2000-02-01' });
  assert.equal(early.from, series.start);
  assert.equal(early.to, series.start);
});

test('every sheet renders on the example portfolio for every period and scope', () => {
  loadDemo();
  const n = sheetDefs().filter((d) => ['summary', 'visual', 'composition'].includes(d.id)).length;
  assert.equal(n, 3);
  const idx = (id) => sheetDefs().findIndex((d) => d.id === id);
  for (const scope of ['all', 'demo-degiro', 'demo-scalable']) {
    for (const period of ['ALL', '1M', '3M', '6M', '1Y', 'YTD']) {
      for (const id of ['summary', 'visual', 'composition']) {
        Object.assign(S.ui, { scope, period, sheet: idx(id) });
        const html = renderReport();
        assert.equal(errorOf(html), null, `${scope} ${period} ${id}: ${errorOf(html)}`);
        assert.match(html, /Analisi della performance/);
      }
    }
  }
  Object.assign(S.ui, { scope: 'all', period: 'CUSTOM', from: addMonths(T, -14), to: addMonths(T, -2), base100: true, logScale: true, sheet: idx('visual') });
  const v = renderReport();
  assert.equal(errorOf(v), null);
  assert.match(v, /data-chart-id="rep-equity"/);
  assert.match(v, /Personalizzato/);
});

test('summary figures are consistent with the engine', () => {
  loadDemo();
  S.ui.sheet = sheetDefs().findIndex((d) => d.id === 'summary');
  const html = renderReport();
  for (const label of ['Saldo finale', 'Dall&#39;inizio performance (TWR)', 'Saldo iniziale', 'Liquidità', 'P&amp;L realizzato', 'P&amp;L non realizzato',
    'P&amp;L cambio (n.r.)', 'Attivo vs benchmark', 'Flussi netti', 'IRR investitore (ann.)', 'Volatilità (ann.)', 'Sharpe (ann.)', 'CAGR', 'Drawdown massimo']) {
    assert.ok(html.includes(`<span class="kpi-label">${label}</span>`), `missing KPI ${label}`);
  }
  assert.match(html, /kpi rkpi danger/);
  assert.match(html, /Fotografia per conto/);
  // Liquidity: DEGIRO tracks cash, Scalable does not
  const snap = SUM.snapshot(null, T);
  const deg = SUM.snapshot(['demo-degiro'], T);
  const sca = SUM.snapshot(['demo-scalable'], T);
  assert.ok(Math.abs(snap.liquidity - deg.liquidity - sca.liquidity) < 1e-6);
  assert.equal(sca.cashBal, 0);
  assert.ok(Math.abs(snap.unreal - deg.unreal - sca.unreal) < 1e-6);
});

test('allocationGroups: fixed colors, cash balance, top 7 + Altro', () => {
  const pos = (aid, type, value, extra = {}) => ({ aid, value, qty: 1, asset: { id: aid, name: aid.toUpperCase(), type, currency: 'EUR', ...extra } });
  const open = [pos('a', 'stock', 50), pos('b', 'etf', 30, { currency: 'USD', region: 'USA' }), pos('c', 'bond', 20, { region: 'Italia' })];
  const byClass = COMP.allocationGroups(open, 'class', 10);
  assert.deepEqual(byClass.map((g) => g.key), ['stock', 'etf', 'bond', 'cash']);
  assert.deepEqual(byClass.map((g) => g.color), ['var(--c1)', 'var(--c2)', 'var(--c4)', 'var(--c6)']);
  assert.ok(Math.abs(byClass.reduce((s, g) => s + g.share, 0) - 1) < 1e-12);
  const byCcy = COMP.allocationGroups(open, 'currency', 10);
  assert.deepEqual(byCcy.map((g) => [g.key, g.value]), [['EUR', 80], ['USD', 30]]);
  const byRegion = COMP.allocationGroups(open, 'region', 0);
  assert.equal(byRegion.find((g) => g.key === 'Italia').color, 'var(--c1)');
  assert.equal(byRegion.find((g) => g.key === 'USA').color, 'var(--c3)');
  const unknown = byRegion.find((g) => g.key === '—');
  assert.equal(unknown.label, 'Non specificato');
  assert.ok(!['var(--c1)', 'var(--c3)'].includes(unknown.color));
  const many = Array.from({ length: 11 }, (_, i) => pos('x' + i, 'stock', 100 - i));
  const g = COMP.allocationGroups(many, 'asset');
  assert.equal(g.length, 8);
  assert.equal(g[7].key, '__other');
  assert.equal(g[7].label, 'Altro');
  assert.equal(g[7].count, 4);
  assert.equal(g[7].color, 'var(--c-other)');
  assert.equal(g[7].value, 93 + 92 + 91 + 90);
});

test('diversification: effective positions and concentration', () => {
  const pos = (v) => ({ value: v, asset: { type: 'stock', name: 'x' } });
  const d = COMP.diversification([pos(25), pos(25), pos(25), pos(25)]);
  assert.equal(d.count, 4);
  assert.ok(Math.abs(d.effective - 4) < 1e-9);
  assert.equal(d.topWeight, 0.25);
  assert.equal(d.top5, 1);
  const c = COMP.diversification([pos(90), pos(10)]);
  assert.ok(Math.abs(c.effective - 1 / (0.81 + 0.01)) < 1e-9);
  assert.equal(COMP.diversification([]).effective, 0);
});

test('sampleIdx keeps first, last and extremes; pctAxis formats Italian percentages', () => {
  assert.deepEqual(VIS.sampleIdx(5, 400), [0, 1, 2, 3, 4]);
  const n = 2000;
  const key = Array.from({ length: n }, (_, i) => Math.sin(i / 50));
  key[1234] = -5; // a deep trough must survive
  const idx = VIS.sampleIdx(n, 400, key);
  assert.ok(idx.length <= 400);
  assert.equal(idx[0], 0);
  assert.equal(idx[idx.length - 1], n - 1);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1]);
  assert.ok(idx.includes(1234));
  assert.equal(VIS.pctAxis(0.12), '12%');
  assert.equal(VIS.pctAxis(0.025), '2,5%');
  assert.equal(VIS.pctAxis(-0.08), '−8%');
  assert.equal(VIS.pctAxis(0), '0%');
});

test('empty portfolio shows the empty state, not an error', () => {
  S.data = migrate({ v: 2, settings: { started: true } });
  bump();
  const html = renderReport();
  assert.equal(errorOf(html), null);
  assert.match(html, /Il report si riempie da solo/);
});
