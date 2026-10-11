// Report sheet 2 "Analisi visiva": equity curve (total, accounts, benchmark), monthly returns,
// monthly active return, asset-allocation evolution, drawdown and rolling volatility over time.
import { D, cached, TYPE_KEYS, TYPE_PLURAL } from '../state.js';
import { cumulative, drawdowns, monthlyReturns, activeMonthly, rollingVol, alignByDate, periodBounds } from '../metrics.js';
import { lineChart, barChart, stackedArea } from '../charts.js';
import { esc, num, pctSigned, fmtDate, fmtMonth } from '../util.js';
import { registerSheet, chartCard, accColor, benchShort } from './report.js';

const MAX_POINTS = 400;
const TOTAL_COLOR = 'var(--accent-line)';
const BENCH_COLOR = 'var(--muted)';

/* ---------- Helpers ---------- */
// Indices to draw (≤ max): first and last always; in each bucket the point of the key series that
// moves most from the previous pick, so peaks and troughs survive
export function sampleIdx(n, max = MAX_POINTS, key = null) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = [0];
  const buckets = Math.max(1, max - 2);
  const size = (n - 2) / buckets;
  let prev = key && Number.isFinite(key[0]) ? key[0] : null;
  for (let b = 0; b < buckets; b++) {
    const a = 1 + Math.floor(b * size);
    const z = Math.min(n - 1, 1 + Math.floor((b + 1) * size));
    if (a >= z) continue;
    let pick = a;
    if (key) {
      let best = -1;
      for (let i = a; i < z; i++) {
        const v = key[i];
        if (!Number.isFinite(v)) continue;
        const d = prev === null ? 0 : Math.abs(v - prev);
        if (d > best) {
          best = d;
          pick = i;
        }
      }
      if (Number.isFinite(key[pick])) prev = key[pick];
    }
    out.push(pick);
  }
  out.push(n - 1);
  return out;
}
const pick = (arr, idx) => (arr ? idx.map((i) => (arr[i] === undefined ? null : arr[i])) : null);

// Axis label for a return: '12%', '2,5%', '−8%'
export function pctAxis(v) {
  if (!Number.isFinite(v)) return '';
  const s = (Math.abs(v) * 100).toLocaleString('it-IT', { maximumFractionDigits: Math.abs(v) < 0.1 && v !== 0 ? 1 : 0 });
  return (v < -1e-12 ? '−' : '') + s + '%';
}

const multiAccount = (ctx) => ctx.scopeKey === 'all' && D().accounts.length > 1;
const hasBench = (ctx) => Boolean(ctx.bench.ret && ctx.bench.ret.coverageStart && ctx.bench.ret.coverageStart <= ctx.to);

function benchMissingText(ctx) {
  const b = ctx.bench;
  if (b.status === 'loading') return 'Carico il benchmark…';
  if (b.status === 'offline') return 'Il benchmark non è disponibile offline: il confronto apparirà quando torni online.';
  if (b.status === 'failed') return 'Non riesco a scaricare i dati del benchmark: riprova più tardi o scegline un altro nei filtri.';
  if (b.status === 'none') return 'Scegli un benchmark nei filtri per vedere il confronto.';
  return `Nessun dato di ${benchShort(b)} nel periodo scelto.`;
}
const noteBox = (text) => `<div class="chart-note">${esc(text)}</div>`;

/* ---------- Data (memoized per scope, period and benchmark) ---------- */
function curves(ctx) {
  const key = `rep-vis-curves:${ctx.scopeKey}:${ctx.from}:${ctx.to}:${ctx.bench.symbol}:${ctx.bench.status}`;
  return cached(key, () => {
    const { series, from, to } = ctx;
    const tot = cumulative(series.dates, series.ret, from, to);
    const dates = tot.dates;
    const accs = [];
    if (multiAccount(ctx)) {
      D().accounts.forEach((a, i) => {
        const s = ctx.accSeries[a.id];
        if (!s) return;
        const c = cumulative(s.dates, s.ret, from, to);
        if (c.dates.length < 2) return;
        accs.push({ id: a.id, name: a.name, color: accColor(i), cum: alignByDate(dates, c.dates, c.cum) });
      });
    }
    let bench = null;
    if (hasBench(ctx)) {
      const c = cumulative(series.dates, ctx.bench.ret, from, to);
      const cs = ctx.bench.ret.coverageStart;
      bench = c.cum.map((v, k) => (dates[k] < cs ? null : v));
    }
    return {
      dates, total: tot.cum, accs, bench,
      dd: {
        total: drawdowns(tot.cum),
        accs: accs.map((a) => drawdowns(a.cum)),
        bench: bench ? drawdowns(bench) : null,
      },
    };
  });
}

function monthly(ctx) {
  const key = `rep-vis-monthly:${ctx.scopeKey}:${ctx.from}:${ctx.to}:${ctx.bench.symbol}:${ctx.bench.status}`;
  return cached(key, () => {
    const { series, from, to } = ctx;
    const tot = monthlyReturns(series.dates, series.ret, from, to);
    const months = tot.map((m) => m.month);
    const accs = [];
    if (multiAccount(ctx)) {
      D().accounts.forEach((a, i) => {
        const s = ctx.accSeries[a.id];
        if (!s) return;
        const map = new Map(monthlyReturns(s.dates, s.ret, from, to).map((m) => [m.month, m.r]));
        accs.push({ name: a.name, color: accColor(i), values: months.map((m) => (map.has(m) ? map.get(m) : null)) });
      });
    }
    let bench = null;
    let active = null;
    if (hasBench(ctx)) {
      const csMonth = ctx.bench.ret.coverageStart.slice(0, 7);
      const map = new Map(monthlyReturns(series.dates, ctx.bench.ret, from, to).map((m) => [m.month, m.r]));
      bench = months.map((m) => (m >= csMonth && map.has(m) ? map.get(m) : null));
      const am = new Map(activeMonthly(series.dates, series.ret, ctx.bench.ret, from, to).map((x) => [x.month, x.active]));
      active = months.map((m) => (m >= csMonth && am.has(m) ? am.get(m) : null));
    }
    return { months, total: tot.map((m) => m.r), accs, bench, active };
  });
}

function allocation(ctx) {
  const key = `rep-vis-alloc:${ctx.scopeKey}:${ctx.from}:${ctx.to}`;
  return cached(key, () => {
    const { series } = ctx;
    const { i0, i1 } = periodBounds(series, ctx.from, ctx.to);
    const idx = [];
    for (let k = i0; k <= i1; k += 7) idx.push(k);
    if (idx[idx.length - 1] !== i1) idx.push(i1);
    const out = [];
    TYPE_KEYS.forEach((type, t) => {
      const arr = series.byType[type];
      if (!arr) return;
      const values = idx.map((k) => Math.max(0, arr[k] || 0));
      if (!values.some((v) => v > 0.005)) return;
      out.push({ name: TYPE_PLURAL[type] || type, color: t < 8 ? `var(--c${t + 1})` : 'var(--c-other)', values });
    });
    return { dates: idx.map((k) => series.dates[k]), series: out };
  });
}

function rolling(ctx) {
  const key = `rep-vis-rvol:${ctx.scopeKey}:${ctx.from}:${ctx.to}:${ctx.bench.symbol}:${ctx.bench.status}`;
  return cached(key, () => {
    const { series, from, to } = ctx;
    const rv = rollingVol(series.dates, series.ret, 60, { from, to });
    let bench = null;
    if (hasBench(ctx)) {
      const cs = ctx.bench.ret.coverageStart;
      const ci = Math.max(0, series.index(cs));
      const bv = rollingVol(series.dates.slice(ci), Array.from(ctx.bench.ret.slice(ci)), 60, { from, to });
      bench = alignByDate(rv.dates, bv.dates, bv.vol);
    }
    return { dates: rv.dates, vol: rv.vol, bench };
  });
}

/* ---------- Charts ---------- */
function equityChart(ctx, c, h) {
  const n = c.dates.length;
  if (n < 2) return noteBox('Il periodo è troppo breve per disegnare la curva: scegline uno più lungo.');
  const idx = sampleIdx(n, MAX_POINTS, c.total);
  const base100 = ctx.base100;
  const log = ctx.logScale;
  // Index values (1 + cum) when the axis is base 100 or logarithmic
  const tf = base100 ? (v) => (v === null || v === undefined ? null : 100 * (1 + v))
    : log ? (v) => (v === null || v === undefined ? null : 1 + v)
      : (v) => (v === null || v === undefined ? null : v);
  const series = [{ name: 'Portafoglio', color: TOTAL_COLOR, values: pick(c.total, idx).map(tf), width: 2.5, area: !c.accs.length && !c.bench }];
  for (const a of c.accs) series.push({ name: a.name, color: a.color, values: pick(a.cum, idx).map(tf), width: 1.6 });
  if (c.bench) series.push({ name: `Benchmark (${benchShort(ctx.bench)})`, color: BENCH_COLOR, values: pick(c.bench, idx).map(tf), width: 1.6, dash: true });
  const yFormat = base100 ? (v) => num(v, v < 10 ? 1 : 0) : log ? (v) => pctAxis(v - 1) : pctAxis;
  const tooltipValue = base100 ? (v) => num(v, 1) : log ? (v) => pctSigned(v - 1) : (v) => pctSigned(v);
  return lineChart('rep-equity', {
    dates: pick(c.dates, idx),
    series,
    w: ctx.w, h,
    log,
    zero: !base100 && !log,
    yFormat,
    tooltipValue,
    legend: series.length > 1,
    ariaLabel: 'Curva equity: rendimento cumulato del portafoglio',
  });
}

function drawdownChart(ctx, c, w, h) {
  const n = c.dates.length;
  if (n < 2) return noteBox('Il periodo è troppo breve per il grafico.');
  const idx = sampleIdx(n, MAX_POINTS, c.dd.total);
  const series = [{ name: 'Portafoglio', color: TOTAL_COLOR, values: pick(c.dd.total, idx), width: 2, area: true }];
  if (c.dd.bench) series.push({ name: `Benchmark (${benchShort(ctx.bench)})`, color: BENCH_COLOR, values: pick(c.dd.bench, idx), width: 1.5, dash: true });
  c.accs.forEach((a, k) => series.push({ name: a.name, color: a.color, values: pick(c.dd.accs[k], idx), width: 1.4 }));
  return lineChart('rep-dd', {
    dates: pick(c.dates, idx),
    series, w, h,
    zero: true,
    yFormat: pctAxis,
    tooltipValue: (v) => pctSigned(v),
    legend: series.length > 1,
    ariaLabel: 'Drawdown nel tempo: distanza dal massimo precedente',
  });
}

function monthlyChart(ctx, m, w, h, maxMonths) {
  if (!m.months.length) return { body: noteBox('Nessun mese nel periodo.'), cut: 0 };
  const start = Math.max(0, m.months.length - maxMonths);
  const cut = start;
  const sl = (arr) => (arr ? arr.slice(start) : null);
  const series = [{ name: 'Totale', color: TOTAL_COLOR, values: sl(m.total) }];
  for (const a of m.accs) series.push({ name: a.name, color: a.color, values: sl(a.values) });
  if (m.bench) series.push({ name: `Benchmark (${benchShort(ctx.bench)})`, color: BENCH_COLOR, values: sl(m.bench) });
  const body = barChart('rep-monthly', {
    labels: m.months.slice(start),
    series, w, h,
    yFormat: pctAxis,
    tooltipValue: (v) => pctSigned(v),
    legend: series.length > 1,
    ariaLabel: 'Rendimenti mensili',
  });
  return { body, cut };
}

function activeChart(ctx, m, w, h, maxMonths) {
  if (!m.active) return noteBox(benchMissingText(ctx));
  const start = Math.max(0, m.months.length - maxMonths);
  const values = m.active.slice(start);
  if (!values.some((v) => Number.isFinite(v))) return noteBox(benchMissingText(ctx));
  return barChart('rep-active', {
    labels: m.months.slice(start),
    series: [{ name: `Portafoglio − ${benchShort(ctx.bench)}`, color: 'var(--c1)', values }],
    w, h,
    yFormat: pctAxis,
    tooltipValue: (v) => pctSigned(v),
    legend: false,
    ariaLabel: 'Rendimento attivo mensile rispetto al benchmark',
  });
}

function allocationChart(ctx, a, w, h) {
  if (!a.series.length || a.dates.length < 1) return noteBox('Nessuna posizione nel periodo.');
  return stackedArea('rep-alloc', {
    dates: a.dates,
    series: a.series,
    w, h,
    percent: true,
    legend: true,
    ariaLabel: 'Evoluzione dell\'asset allocation per classe',
  });
}

function rollingChart(ctx, r, w, h) {
  if (!r.vol.some((v) => Number.isFinite(v))) return noteBox('Servono almeno 60 giorni di borsa di storia per questo grafico.');
  const n = r.dates.length;
  const idx = sampleIdx(n, MAX_POINTS, r.vol);
  const series = [{ name: 'Portafoglio', color: TOTAL_COLOR, values: pick(r.vol, idx), width: 2 }];
  if (r.bench && r.bench.some((v) => Number.isFinite(v))) series.push({ name: `Benchmark (${benchShort(ctx.bench)})`, color: BENCH_COLOR, values: pick(r.bench, idx), width: 1.5, dash: true });
  return lineChart('rep-rvol', {
    dates: pick(r.dates, idx),
    series, w, h,
    zero: true,
    yFormat: pctAxis,
    tooltipValue: (v) => pctSigned(v).replace('+', ''),
    legend: series.length > 1,
    ariaLabel: 'Volatilità rolling a 60 giorni, annualizzata',
  });
}

/* ---------- Sheet ---------- */
function renderVisual(ctx) {
  const desk = ctx.desktop;
  const hBig = desk ? 290 : 230;
  const h = desk ? 230 : 210;
  const maxMonths = desk ? 24 : 12;
  const c = curves(ctx);
  const m = monthly(ctx);
  const a = allocation(ctx);
  const r = rolling(ctx);
  const bName = esc(benchShort(ctx.bench));
  const benchNote = hasBench(ctx) ? '' : ` · ${esc(benchMissingText(ctx))}`;

  const scale = ctx.base100 ? 'base 100 all\'inizio' : 'rendimento cumulato in %';
  const equitySub = `TWR dal ${fmtDate(ctx.from)} al ${fmtDate(ctx.to)}, ${scale}${ctx.logScale ? ', scala logaritmica' : ''}${benchNote}`;

  const mon = monthlyChart(ctx, m, ctx.w, h, maxMonths);
  const monSub = mon.cut
    ? `Rendimento di ogni mese: ultimi ${maxMonths} mesi del periodo (da ${fmtMonth(m.months[mon.cut], true).toLowerCase()})`
    : 'Rendimento di ogni mese: barre sopra lo zero = mese positivo';

  return `<div class="chart-grid visual-grid">
    ${chartCard({ title: 'Curva equity (portafoglio, conti e benchmark)', subtitle: equitySub, info: 'equityCurve', body: equityChart(ctx, c, hBig), cls: 'full' })}
    ${chartCard({ title: 'Rendimenti mensili (totale, conti e benchmark)', subtitle: monSub, info: 'rendimentiMensili', body: mon.body, cls: 'full' })}
    ${chartCard({ title: 'Rendimento attivo mensile (totale − benchmark)', subtitle: hasBench(ctx) ? `Sopra lo zero: quel mese hai battuto ${bName}` : esc(benchMissingText(ctx)), info: 'rendimentoAttivo', body: activeChart(ctx, m, ctx.wHalf, h, maxMonths) })}
    ${chartCard({ title: 'Evoluzione asset allocation (per classe)', subtitle: 'Peso di ogni classe sul totale, settimana per settimana', info: 'evoluzioneAllocazione', body: allocationChart(ctx, a, ctx.wHalf, h) })}
    ${chartCard({ title: 'Drawdown nel tempo (TWR)', subtitle: 'Distanza dal massimo precedente: più la linea scende, più profondo il calo', info: 'drawdownSeries', body: drawdownChart(ctx, c, ctx.wHalf, h) })}
    ${chartCard({ title: 'Volatilità rolling (60 gg, ann.)', subtitle: `Oscillazione annualizzata degli ultimi 60 giorni di borsa${hasBench(ctx) ? `, portafoglio e ${bName}` : ''}`, info: 'rollingVol', body: rollingChart(ctx, r, ctx.wHalf, h) })}
  </div>`;
}

registerSheet({
  id: 'visual',
  order: 2,
  title: 'Analisi visiva',
  subtitle: 'Andamento del portafoglio, dei conti e del benchmark: rendimenti mensili, composizione nel tempo e rischio.',
  render: renderVisual,
});

export const _test = { sampleIdx, pctAxis, curves, monthly, allocation, rolling };
