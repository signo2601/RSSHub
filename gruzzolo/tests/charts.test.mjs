import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE, seriesColor, niceTicks, logTicks, tidyTicks, dateTicks, chartData,
  lineChart, barChart, stackedArea, donutChart, scatterChart, sparkline, initCharts, chartScrubHandlers,
} from '../js/charts.js';
import { addDays } from '../js/util.js';

const days = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));
const svgWidth = (html) => +/<svg[^>]*\swidth="(\d+)"/.exec(html)[1];

/* ---------- Palette ---------- */
test('palette: 8 fixed slots, never cycled', () => {
  assert.equal(PALETTE.length, 8);
  assert.equal(PALETTE[0], 'var(--c1)');
  assert.equal(seriesColor(7), 'var(--c8)');
  assert.equal(seriesColor(8), 'var(--c-other)');
  assert.equal(seriesColor(-1), 'var(--c-other)');
});

/* ---------- niceTicks ---------- */
test('niceTicks: round steps that cover the range', () => {
  for (const [lo, hi, count] of [[0, 1, 5], [3, 97, 5], [-0.032, 0.051, 5], [12034, 58230, 5], [0.0001, 0.0009, 4], [-250, -10, 4], [990, 1010, 6], [0.1 + 0.2, 0.7, 5]]) {
    const r = niceTicks(lo, hi, count);
    assert.ok(r.min <= lo && r.max >= hi, `covers [${lo}, ${hi}] → [${r.min}, ${r.max}]`);
    assert.ok(r.ticks.length >= 2 && r.ticks.length <= count + 2, `tick count ${r.ticks.length} for ${lo}..${hi}`);
    const mag = 10 ** Math.floor(Math.log10(r.step));
    const norm = Math.round((r.step / mag) * 1000) / 1000;
    assert.ok([1, 2, 2.5, 5, 10].includes(norm), `step ${r.step} is 1/2/2.5/5 × 10^k`);
    for (let i = 1; i < r.ticks.length; i++) {
      assert.ok(Math.abs(r.ticks[i] - r.ticks[i - 1] - r.step) < r.step * 1e-6, 'evenly spaced');
    }
    // no floating noise like 0.30000000000000004
    for (const t of r.ticks) assert.ok(String(t).length < 12, `clean tick ${t}`);
  }
});

test('niceTicks: known values', () => {
  assert.deepEqual(niceTicks(0, 1, 5).ticks, [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(3, 97, 5).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(12034, 58230, 4).ticks, [0, 20000, 40000, 60000]);
  assert.ok(niceTicks(-0.032, 0.051, 5).ticks.includes(0), 'zero is a tick when the range crosses it');
});

test('niceTicks: degenerate input', () => {
  assert.deepEqual(niceTicks(0, 0, 5).ticks[0], 0);
  assert.ok(niceTicks(0, 0, 5).max > 0);
  const flat = niceTicks(100, 100, 5);
  assert.ok(flat.min < 100 && flat.max > 100);
  const rev = niceTicks(10, -10, 5);
  assert.ok(rev.min <= -10 && rev.max >= 10);
  const bad = niceTicks(NaN, Infinity, 5);
  assert.deepEqual([bad.min, bad.max], [0, 1]);
  assert.ok(!Object.is(niceTicks(-1, 1, 5).ticks.find((t) => t === 0), -0), 'no negative zero');
});

/* ---------- logTicks ---------- */
test('logTicks: 1-2-5 multiples inside the range', () => {
  assert.deepEqual(logTicks(50, 300), [50, 100, 200]);
  assert.deepEqual(logTicks(0.9, 11), [1, 2, 5, 10]);
});
test('logTicks: thinned to powers of ten on wide ranges', () => {
  assert.deepEqual(logTicks(1, 1e6), [1, 10, 100, 1000, 10000, 100000, 1000000]);
  assert.ok(logTicks(1e-3, 1e9).length <= 7);
});
test('logTicks: narrow range falls back to round linear ticks', () => {
  const t = logTicks(77, 145);
  assert.ok(t.length >= 2);
  for (const v of t) assert.ok(v >= 77 && v <= 145);
  assert.deepEqual(t, [80, 100, 120, 140]);
});
test('logTicks: non-positive input gives no ticks', () => {
  assert.deepEqual(logTicks(0, 10), []);
  assert.deepEqual(logTicks(-5, 10), []);
});

/* ---------- tidyTicks ---------- */
test('tidyTicks: drops only the trailing zeros all labels share', () => {
  assert.deepEqual(tidyTicks(['0,00%', '5,00%', '10,00%']), ['0%', '5%', '10%']);
  assert.deepEqual(tidyTicks(['0,00%', '2,50%', '5,00%']), ['0,0%', '2,5%', '5,0%']);
  assert.deepEqual(tidyTicks(['1.000,00 €', '2.000,00 €']), ['1.000 €', '2.000 €']);
  assert.deepEqual(tidyTicks(['10k', '20k']), ['10k', '20k']);
  assert.deepEqual(tidyTicks(['1,25', '1,50']), ['1,25', '1,50']);
});

/* ---------- dateTicks ---------- */
const noOverlap = (ticks) => {
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1];
    const b = ticks[i];
    const aw = a.label.length * 10.5 * 0.6;
    const bw = b.label.length * 10.5 * 0.6;
    assert.ok(b.x - bw / 2 >= a.x + aw / 2 + 9, `labels "${a.label}" and "${b.label}" overlap`);
  }
};
test('dateTicks: years for multi-year spans', () => {
  const d = days('2023-01-02', 1376);
  const t = dateTicks(d, 300);
  assert.deepEqual(t.map((x) => x.label), ['2024', '2025', '2026']);
  noOverlap(t);
});
test('dateTicks: months (gen 26 style) for medium spans, ≤ 6 labels', () => {
  const d = days('2025-09-01', 400);
  const t = dateTicks(d, 1000);
  assert.ok(t.length >= 3 && t.length <= 6, `count ${t.length}`);
  for (const x of t) assert.match(x.label, /^(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic) \d{2}$/);
  noOverlap(t);
  const narrow = dateTicks(d, 300);
  assert.ok(narrow.length >= 2 && narrow.length <= 4);
  noOverlap(narrow);
});
test('dateTicks: days for short spans', () => {
  const t = dateTicks(days('2026-09-01', 30), 300);
  assert.ok(t.length >= 3 && t.length <= 6);
  for (const x of t) assert.match(x.label, /^\d{1,2} [a-z]{3}$/);
  noOverlap(t);
});
test('dateTicks: monthly keys and tiny inputs', () => {
  const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
  const t = dateTicks(months, 320);
  assert.ok(t.length >= 2);
  noOverlap(t);
  assert.equal(dateTicks([], 300).length, 0);
  assert.equal(dateTicks(['2026-10-08'], 300).length, 1);
  const two = dateTicks(['2026-10-07', '2026-10-08'], 300);
  assert.ok(two.length >= 1 && two.length <= 2);
  for (const w of [120, 200, 390, 1200]) noOverlap(dateTicks(days('2016-01-01', 3650), w));
});

/* ---------- Charts return HTML with an SVG drawn at the given width ---------- */
const dates = days('2025-01-01', 400);
const wave = (k) => dates.map((_, i) => 100 + k * 3 + Math.sin(i / (20 + k)) * 10 + i * 0.05);

test('lineChart: wrapper, svg at width w, legend for ≥ 2 series, registry', () => {
  const html = lineChart('t-line', { dates, w: 357.6, h: 200, yFormat: (v) => `${v}`, series: [{ name: 'Totale', values: wave(0) }, { name: 'Benchmark', values: wave(1), dash: true, color: 'var(--muted)' }] });
  assert.match(html, /^<div class="chart chart-line" data-chart-id="t-line" style="position:relative">/);
  assert.ok(html.includes('<svg'));
  assert.equal(svgWidth(html), 358);
  assert.ok(html.includes('viewBox="0 0 358 200"'));
  assert.ok(html.includes('touch-action:pan-y'));
  assert.ok(html.includes('<div class="chart-tip" role="status" hidden></div>'));
  assert.ok(html.includes('class="chart-legend"') && html.includes('k-dash'));
  assert.ok(html.includes('stroke-width="2"') && html.includes('stroke-linejoin="round"'));
  const d = chartData('t-line');
  assert.equal(d.type, 'line');
  assert.equal(d.n, dates.length);
  assert.equal(d.ser.length, 2);
});

test('lineChart: single series has no legend and a ~10% area wash', () => {
  const html = lineChart('t-one', { dates, w: 320, series: [{ name: 'Valore', values: wave(0) }] });
  assert.ok(!html.includes('chart-legend'));
  assert.ok(html.includes('fill-opacity="0.1"'));
  assert.ok(html.includes('class="chart-end"'), 'end dot');
});

test('lineChart: gaps (null/NaN) split the path; all-null shows the placeholder', () => {
  const vals = wave(0).map((v, i) => (i < 60 ? null : i === 200 ? NaN : v));
  const html = lineChart('t-gap', { dates, w: 320, series: [{ name: 'Vol', values: vals }] });
  const d = /class="chart-line" d="([^"]+)"/.exec(html)[1];
  assert.equal((d.match(/M/g) || []).length, 2, 'two segments around the NaN');
  const empty = lineChart('t-gap', { dates, w: 320, series: [{ name: 'Vol', values: dates.map(() => null) }] });
  assert.ok(empty.includes('<svg') && empty.includes('Nessun dato'));
  assert.equal(chartData('t-gap'), null, 'placeholder clears stale registry data');
});

test('lineChart: thousands of points are compressed per pixel column', () => {
  const long = days('2016-01-01', 3650);
  const vals = long.map((_, i) => 100 + Math.sin(i / 7) * 5 + Math.cos(i / 3));
  const html = lineChart('t-long', { dates: long, w: 300, series: [{ name: 'A', values: vals }] });
  const d = /class="chart-line" d="([^"]+)"/.exec(html)[1];
  const pts = d.split(/[ML]/).filter(Boolean).length;
  assert.ok(pts <= 4 * 300, `points ${pts}`);
  assert.ok(html.length < 40000, `html size ${html.length}`);
});

test('lineChart: log scale', () => {
  const html = lineChart('t-log', { dates, w: 320, log: true, series: [{ name: 'Base 100', values: dates.map((_, i) => 100 * 1.004 ** i) }] });
  assert.ok(!html.includes('data-log-fallback'));
  const { Y } = chartData('t-log');
  assert.ok(Math.abs((Y(100) - Y(200)) - (Y(200) - Y(400))) < 1e-6, 'equal ratios → equal distances');
});

test('lineChart: log with non-positive values falls back to linear and says so', () => {
  const html = lineChart('t-logfb', { dates, w: 320, log: true, series: [{ name: 'Rend.', values: dates.map((_, i) => Math.sin(i / 30) * 0.1) }] });
  assert.ok(html.includes('data-log-fallback="1"'));
  assert.match(html, /<title>[^<]*logaritmica non disponibile[^<]*<\/title>/);
  const { Y } = chartData('t-logfb');
  assert.ok(Math.abs((Y(0) - Y(0.05)) - (Y(0.05) - Y(0.1))) < 1e-6, 'linear spacing');
});

test('lineChart: zero option includes 0 and draws a stronger zero line', () => {
  const html = lineChart('t-zero', { dates, w: 320, zero: true, series: [{ name: 'DD', values: dates.map((_, i) => -0.05 - (i % 50) / 1000) }] });
  assert.ok(html.includes('class="chart-zero"'));
  const { Y } = chartData('t-zero');
  assert.ok(Y(0) >= 10 - 1e-9, 'zero inside plot');
});

test('barChart: grouped bars, negatives below a zero line, thin bars', () => {
  const labels = ['2025-10', '2025-11', '2025-12', '2026-01'];
  const html = barChart('t-bar', { labels, w: 320, yFormat: (v) => `${Math.round(v * 100)}%`, series: [{ name: 'Totale', values: [0.02, -0.03, 0.01, null] }, { name: 'Benchmark', values: [0.01, -0.02, 0, 0.015] }] });
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('class="chart-zero"'));
  const bars = html.match(/<path d="M[^"]+" style="fill:var\(--c[12]\)"/g) || [];
  assert.equal(bars.length, 6, 'null and zero values draw no bar (3 + 3 bars)');
  assert.ok(html.includes('chart-legend') && html.includes('k-rect'));
  const d = chartData('t-bar');
  assert.equal(d.labels[0], 'Ottobre 2025', 'month keys become readable tooltip labels');
  assert.ok(html.includes('>ott 25<'), 'axis label');
  // Bar width capped at 24px even when the slot is wide
  const wide = barChart('t-bar-w', { labels: ['A', 'B'], w: 900, series: [{ name: 'X', values: [1, -2] }] });
  const widths = [...wide.matchAll(/<path d="M([\d.]+),[\d.]+V[^H]+H([\d.]+)/g)].map((m) => +m[2] - +m[1]);
  for (const bw of widths) assert.ok(bw <= 24, `bar width ${bw}`);
});

test('barChart: crowded labels are thinned, never rotated', () => {
  const labels = days('2024-01-01', 36 * 30).filter((d) => d.endsWith('-01')).map((d) => d.slice(0, 7));
  const html = barChart('t-bar-many', { labels, w: 300, series: [{ name: 'R', values: labels.map((_, i) => Math.sin(i) / 20) }] });
  const shown = (html.match(/<text [^>]*text-anchor="middle">[a-z]{3} \d{2}</g) || []).length;
  assert.ok(shown >= 2 && shown < labels.length, `shown ${shown}`);
  assert.ok(!html.includes('rotate('));
});

test('barChart: empty input', () => {
  assert.ok(barChart('t-bar-e', { labels: [], series: [] }).includes('Nessun dato'));
  assert.ok(barChart('t-bar-e', { labels: ['a'], series: [{ name: 'x', values: [null] }] }).includes('Nessun dato'));
  assert.ok(barChart('t-bar-e').includes('<svg'));
});

test('stackedArea: percent normalizes per date and clamps negatives', () => {
  const d3 = days('2026-01-01', 5);
  const html = stackedArea('t-stack', { dates: d3, w: 320, series: [{ name: 'A', values: [1, 2, 0, 3, -1] }, { name: 'B', values: [1, 2, 0, 1, 4] }] });
  assert.ok(html.includes('<svg') && html.includes('chart-legend'));
  const d = chartData('t-stack');
  for (let i = 0; i < 5; i++) {
    const s = d.vals[0][i] + d.vals[1][i];
    assert.ok(Math.abs(s - 1) < 1e-12, `date ${i} sums to 1 (got ${s})`);
  }
  assert.equal(d.vals[0][4], 0, 'negative clamped to 0');
  assert.equal(d.vals[0][2], d.vals[0][1], 'empty interior date carries the previous shares');
  assert.ok(html.includes('>100%<'));
});

test('stackedArea: absolute mode and empty input', () => {
  const html = stackedArea('t-stack-abs', { dates: days('2026-01-01', 3), w: 320, percent: false, series: [{ name: 'A', values: [100, 200, 300] }] });
  assert.ok(!html.includes('>100%<'));
  assert.ok(stackedArea('t-stack-e', { dates: days('2026-01-01', 3), series: [{ name: 'A', values: [0, null, -2] }] }).includes('Nessun dato'));
  assert.ok(stackedArea('t-stack-e').includes('Nessun dato'));
});

test('donutChart: segments, center text, selection and data-act', () => {
  const items = [
    { key: 'etf', label: 'ETF', value: 600 },
    { key: 'stock', label: 'Azioni <b>', value: 300 },
    { key: 'zero', label: 'Zero', value: 0 },
    { key: 'cash', label: 'Liquidità', value: 100, color: 'var(--c-other)' },
  ];
  const html = donutChart('t-donut', { items, size: 180, centerValue: '1.000,00 €', centerLabel: 'Totale', selected: 'stock', actKey: 'alloc-sel' });
  assert.ok(html.includes('<svg') && html.includes('width="180"'));
  assert.equal((html.match(/class="ch-seg"/g) || []).length, 3, 'zero-value item skipped');
  assert.ok(html.includes('data-act="alloc-sel" data-key="etf"'));
  assert.ok(html.includes('1.000,00 €') && html.includes('Totale'));
  assert.equal((html.match(/fill-opacity="0.32"/g) || []).length, 2, 'non-selected segments dimmed');
  assert.ok(html.includes('Azioni &lt;b&gt;') && !html.includes('Azioni <b>'), 'labels escaped');
  const d = chartData('t-donut');
  assert.ok(Math.abs(d.segs.reduce((s, x) => s + x.share, 0) - 1) < 1e-12);
  assert.ok(donutChart('t-donut-e', { items: [] }).includes('Nessun dato'));
  assert.ok(donutChart('t-donut-e', { items: [{ key: 'a', value: -3 }] }).includes('Nessun dato'));
  const one = donutChart('t-donut-1', { items: [{ key: 'a', label: 'Solo', value: 5 }] });
  assert.ok(one.includes('class="ch-seg"') && !one.includes('chart-legend'));
});

test('scatterChart: lines under points, legend for lines and groups, direct labels for special points', () => {
  const html = scatterChart('t-sc', {
    w: 520, h: 300, xLabel: 'Volatilità →', yLabel: '↑ Rendimento', xFormat: (v) => `${Math.round(v * 100)}%`, yFormat: (v) => `${Math.round(v * 100)}%`,
    lines: [{ name: 'Frontiera', points: [{ x: 0.08, y: 0.04 }, { x: 0.12, y: 0.07 }, { x: 0.2, y: 0.1 }] }, { name: 'CML', color: 'var(--muted)', dash: true, points: [{ x: 0, y: 0.02 }, { x: 0.22, y: 0.13 }] }],
    points: [
      { x: 0.15, y: 0.06, label: 'VWCE', group: 'Titoli', color: 'var(--c-other)' },
      { x: 0.3, y: 0.12, label: 'NVDA', group: 'Titoli', color: 'var(--c-other)' },
      { x: 0.14, y: 0.065, label: 'Portafoglio attuale', special: true, group: 'Attuale', color: 'var(--accent-line)', r: 6 },
    ],
  });
  assert.ok(html.includes('<svg'));
  const firstPath = html.indexOf('stroke-dasharray');
  const firstPoint = html.indexOf('<circle cx=');
  assert.ok(firstPath > 0 && firstPath < firstPoint, 'lines drawn before points');
  for (const name of ['Frontiera', 'CML', 'Titoli', 'Attuale']) assert.ok(html.includes(`<span>${name}</span>`), `legend ${name}`);
  assert.ok(html.includes('>Portafoglio attuale</text>'), 'direct label');
  assert.ok(!html.includes('>VWCE</text>'), 'ordinary points rely on the tooltip');
  const d = chartData('t-sc');
  assert.equal(d.targets.length, 3 + 5);
  assert.equal(d.yLabel, 'Rendimento', 'arrows removed for the tooltip');
  assert.ok(scatterChart('t-sc-e', { points: [], lines: [] }).includes('Nessun dato'));
  assert.ok(scatterChart('t-sc-e', { points: [{ x: NaN, y: 1 }] }).includes('Nessun dato'));
});

test('sparkline: tiny svg, gaps allowed, flat placeholder when empty', () => {
  const s = sparkline([1, 2, null, 4, 3], { w: 80, h: 28, color: 'var(--up)' });
  assert.ok(s.startsWith('<svg class="spark"') && s.includes('stroke:var(--up)'));
  assert.ok(!s.includes('<text'), 'no axes or labels');
  assert.ok(sparkline([]).includes('<svg'));
  assert.ok(sparkline([null, null]).includes('Nessun dato'));
  assert.ok(sparkline(new Float64Array([5, 5, 5])).includes('<path'), 'flat series still draws');
  assert.ok(sparkline(undefined).includes('<svg'));
});

test('every chart survives missing options', () => {
  for (const fn of [lineChart, barChart, stackedArea, donutChart, scatterChart]) {
    const html = fn('t-none');
    assert.ok(html.includes('<svg') && html.includes('Nessun dato'), fn.name);
  }
});

test('ids, names and colors are escaped', () => {
  const html = lineChart('x"><img src=x>', { dates: dates.slice(0, 10), w: 320, series: [{ name: '<script>alert(1)</script>', values: wave(0).slice(0, 10) }, { name: 'B&B', values: wave(1).slice(0, 10), color: 'red"><x' }] });
  assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('"><x'));
  assert.ok(html.includes('&lt;script&gt;') && html.includes('B&amp;B'));
});

test('re-render overwrites registry data and drops scrub handlers', () => {
  const opts = { dates, w: 320, series: [{ name: 'A', values: wave(0) }] };
  lineChart('t-re', opts);
  chartScrubHandlers('t-re', { onScrub() {}, onEnd() {} });
  assert.equal(typeof chartData('t-re').onScrub, 'function');
  lineChart('t-re', { ...opts, dates: dates.slice(0, 50) });
  assert.equal(chartData('t-re').n, 50);
  assert.equal(chartData('t-re').onScrub, undefined);
  chartScrubHandlers('missing-id', { onScrub() {} }); // no throw
});

test('initCharts is a no-op without a DOM', () => {
  assert.doesNotThrow(() => initCharts());
});
