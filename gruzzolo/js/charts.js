// SVG charts rendered as HTML strings, with delegated touch/mouse/keyboard tooltips.
//
// Every chart function returns `<div class="chart" data-chart-id="ID">…<svg>…</svg><div class="chart-tip">…legend…</div>`
// and stores what the tooltip needs in a module Map keyed by id (overwritten on re-render).
// initCharts() installs document-level listeners once; the markup itself carries no handlers.
// All colors are CSS variables, so both themes work without re-rendering. Dots carry a 2px ring in
// var(--chart-ring, var(--surface)): set --chart-ring on a container whose background is not --surface.

import { esc, fmtDate, fmtMonth, MONTHS, compact, num, money, pct, dayDiff } from './util.js';

/* ---------- Palette ---------- */
export const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];
// Fixed order, never cycled: a 9th series folds into the "other" gray.
export const seriesColor = (i) => (i >= 0 && i < PALETTE.length ? PALETTE[i] : 'var(--c-other)');

/* ---------- Registry of rendered charts (id → geometry + data for tooltips) ---------- */
const REG = new Map();
export const chartData = (id) => REG.get(id) || null;

/* ---------- Small helpers ---------- */
const AX_FS = 10.5; // axis text size (px)
const TOUCH_HIDE_MS = 1500;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Rough text width for Manrope-like sans (digits ≈ 0.6em): good enough to avoid overlaps
const textW = (s, fs = AX_FS) => String(s).length * fs * 0.6;
const width = (w, fallback = 320) => Math.max(120, Math.round(isNum(w) && w > 0 ? w : fallback));
const height = (h, fallback) => Math.max(60, Math.round(isNum(h) && h > 0 ? h : fallback));
const fmtFn = (f, fallback) => (typeof f === 'function' ? f : fallback);
const dashArray = (dash) => (dash === true ? '5 4' : typeof dash === 'number' ? `${dash} ${dash}` : typeof dash === 'string' ? dash : '');
const defaultTip = (v) => num(v, 2);
// Gridline y snapped to the pixel grid so hairlines stay 1px sharp
const crisp = (y) => Math.round(y) + 0.5;

// Dates on the x axis: 'YYYY-MM-DD' → '5 ott 2026', 'YYYY-MM' → 'Ottobre 2026'
function fmtX(s) {
  if (typeof s !== 'string') return String(s ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtDate(s);
  if (/^\d{4}-\d{2}$/.test(s)) return fmtMonth(s, true);
  return s;
}

/* ---------- Tick generation (exported for tests and for views that need matching scales) ---------- */

// Round ticks (1, 2, 2.5, 5 × 10^k) covering [min, max]; the returned min/max are the outer ticks.
export function niceTicks(min, max, count = 5) {
  if (!isNum(min) || !isNum(max)) {
    min = 0;
    max = 1;
  }
  if (min > max) [min, max] = [max, min];
  if (max - min <= 1e-12 * Math.max(1, Math.abs(max))) {
    if (min === 0) max = 1;
    else {
      const p = Math.abs(min) * 0.1;
      min -= p;
      max += p;
    }
  }
  const target = Math.max(1, Math.round(count) - 1);
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const dec = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  const fix = (v) => {
    const x = Number(v.toFixed(Math.min(dec, 20)));
    return Object.is(x, -0) ? 0 : x;
  };
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let k = 0; lo + k * step <= hi + step * 1e-6 && k < 200; k++) ticks.push(fix(lo + k * step));
  return { min: fix(lo), max: fix(hi), step, ticks };
}

// Log-scale ticks inside [min, max] (both > 0): 1-2-5 multiples, thinned to powers of ten when crowded.
// Narrow ranges with fewer than two 1-2-5 ticks fall back to round linear ticks inside the range.
export function logTicks(min, max) {
  if (!(min > 0) || !(max > 0)) return [];
  if (min > max) [min, max] = [max, min];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const inside = (v) => v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9);
  let ticks = [];
  for (let d = lo; d <= hi; d++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** d).toPrecision(12));
      if (inside(v)) ticks.push(v);
    }
  }
  if (ticks.length > 7) ticks = ticks.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
  if (ticks.length > 7) {
    const k = Math.ceil(ticks.length / 6);
    ticks = ticks.filter((_, i) => i % k === 0);
  }
  if (ticks.length < 2) {
    const lin = niceTicks(min, max, 5).ticks.filter((t) => t > 0 && inside(t));
    if (lin.length >= 2) ticks = lin;
  }
  return ticks;
}

// Drop the decimals that every tick label has in common as trailing zeros ('5,00%' → '5%', '2,50' → '2,5').
export function tidyTicks(labels) {
  const re = /(\d),(\d+)/;
  let common = Infinity;
  for (const l of labels) {
    const m = re.exec(l);
    if (!m) continue;
    common = Math.min(common, m[2].length - m[2].replace(/0+$/, '').length);
  }
  if (!Number.isFinite(common) || common === 0) return labels;
  return labels.map((l) => l.replace(re, (_, a, dec) => {
    const keep = dec.slice(0, dec.length - common);
    return keep ? `${a},${keep}` : a;
  }));
}

// Time axis ticks: days ('5 ott'), months ('gen 26') or years ('2024') by span; 2–6 labels that never overlap.
// xAt(i) → pixel x of date i; labels are kept inside [left, right].
function pickDateTicks(dates, xAt, left, right, maxLabels) {
  const n = dates.length;
  if (!n) return [];
  if (n === 1) return [{ i: 0, x: clamp(xAt(0), left, right), label: fmtX(dates[0]).replace(/ \d{4}$/, '') }];
  const first = dates[0];
  const last = dates[n - 1];
  const monthly = first.length === 7;
  const span = monthly ? Math.round((+last.slice(0, 4) - +first.slice(0, 4)) * 365 + (+last.slice(5, 7) - +first.slice(5, 7)) * 30.4) : dayDiff(first, last);
  const modes = [];
  if (!monthly && span <= 75) for (const s of [1, 2, 3, 7, 14]) modes.push({ kind: 'day', step: s });
  if (span <= 6 * 366) for (const s of [1, 2, 3, 6]) modes.push({ kind: 'month', step: s });
  for (const s of [1, 2, 5, 10, 20, 50]) modes.push({ kind: 'year', step: s });
  // Indices where a period starts (first date of a month/year present in the data)
  const starts = (kind) => {
    const out = [];
    const len = kind === 'year' ? 4 : 7;
    for (let i = 0; i < n; i++) {
      const key = dates[i].slice(0, len);
      if (i === 0) {
        const atStart = kind === 'year' ? dates[0].slice(4) === (monthly ? '-01' : '-01-01') : monthly || dates[0].slice(8) === '01';
        if (atStart) out.push(i);
      } else if (key !== dates[i - 1].slice(0, len)) out.push(i);
    }
    return out;
  };
  const cache = {};
  const candidates = (m) => {
    if (m.kind === 'day') {
      const out = [];
      for (let i = 0; i < n; i++) if (dayDiff(first, dates[i]) % m.step === 0) out.push(i);
      return out;
    }
    const st = (cache[m.kind] ||= starts(m.kind));
    if (m.kind === 'month') return st.filter((i) => (+dates[i].slice(5, 7) - 1) % m.step === 0);
    return st.filter((i) => +dates[i].slice(0, 4) % m.step === 0);
  };
  const label = (kind, s) => (kind === 'day' ? fmtDate(s, false) : kind === 'month' ? fmtMonth(s.slice(0, 7)) : s.slice(0, 4));
  const layout = (kind, idx) => {
    const out = [];
    let prevRight = -Infinity;
    for (const i of idx) {
      const text = label(kind, dates[i]);
      const tw = textW(text);
      const x = clamp(xAt(i), left + tw / 2, right - tw / 2);
      if (x - tw / 2 < prevRight + 10) return null; // overlap: reject this step
      prevRight = x + tw / 2;
      out.push({ i, x, label: text });
    }
    return out;
  };
  let fallback = null;
  for (const m of modes) {
    const idx = candidates(m);
    if (idx.length > maxLabels || idx.length === 0) continue;
    const placed = layout(m.kind, idx);
    if (!placed) continue;
    if (placed.length >= 2) return placed;
    fallback ||= placed; // keep the finest single-label result in case nothing better exists
  }
  // Ends only (very short or very narrow axes)
  const kind = span <= 75 && !monthly ? 'day' : span <= 900 ? 'month' : 'year';
  const ends = layout(kind, [0, n - 1]);
  if (ends && ends[0].label !== ends[1].label) return ends;
  return fallback || layout(kind, [n - 1]) || [];
}

// Exported for tests: date ticks for an axis `width` px wide (index-proportional positions).
export function dateTicks(dates, widthPx = 320, maxLabels) {
  const n = dates.length;
  const xAt = (i) => (n <= 1 ? widthPx / 2 : (i / (n - 1)) * widthPx);
  return pickDateTicks(dates, xAt, 0, widthPx, maxLabels ?? clamp(Math.floor(widthPx / 62), 2, 6));
}

const yTickCount = (ih) => clamp(Math.round(ih / 42) + 1, 3, 6);

/* ---------- Markup fragments ---------- */

function wrap(id, type, inner, { w, h, aria, title, legend = '', attrs = '' }) {
  return `<div class="chart chart-${type}" data-chart-id="${esc(id)}" style="position:relative"${attrs}>`
    + `<svg class="chart-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" tabindex="0" aria-label="${esc(aria)}" style="touch-action:pan-y">`
    + `<title>${esc(title || aria)}</title>${inner}</svg>`
    + `<div class="chart-tip" role="status" hidden></div>${legend}</div>`;
}

function emptyChart(id, w, h, aria) {
  REG.delete(id);
  const base = crisp(h - 24);
  return `<div class="chart chart-empty" data-chart-id="${esc(id)}" style="position:relative">`
    + `<svg class="chart-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(aria)}: nessun dato">`
    + `<title>${esc(aria)}: nessun dato</title>`
    + `<line x1="0" x2="${w}" y1="${base}" y2="${base}" style="stroke:var(--grid)" stroke-width="1"/>`
    + `<text x="${w / 2}" y="${r1((h - 24) / 2 + 4)}" text-anchor="middle" style="fill:var(--muted);font-size:12px">Nessun dato</text>`
    + '</svg></div>';
}

// Legend keys mirror the mark: short line for lines, dashed line, rounded square for bars/areas, dot for points.
function legendHtml(items) {
  if (!items.length) return '';
  return `<div class="chart-legend">${items.map((it) => {
    const c = esc(it.color);
    const style = it.kind === 'dash' ? `border-top-color:${c}` : `background:${c}`;
    return `<span class="chart-key"><i class="k-${it.kind}" style="${style}" aria-hidden="true"></i><span>${esc(it.name)}</span></span>`;
  }).join('')}</div>`;
}
const showLegend = (flag, count) => (flag === undefined || flag === null ? count >= 2 : !!flag);

// Horizontal hairline grid + tick labels. side: 'right' (default) or 'left'.
function yAxis(ticks, labels, Y, x1, x2, w, { side = 'right', zeroLine = false } = {}) {
  let grid = '';
  let text = '';
  for (let k = 0; k < ticks.length; k++) {
    const y = crisp(Y(ticks[k]));
    if (!(zeroLine && ticks[k] === 0)) grid += `<line x1="${r1(x1)}" x2="${r1(x2)}" y1="${y}" y2="${y}"/>`;
    const tx = side === 'right' ? w - 1 : x1 - 8;
    text += `<text x="${r1(tx)}" y="${r1(Y(ticks[k]) + 3.5)}" text-anchor="end">${esc(labels[k])}</text>`;
  }
  return `<g class="chart-grid" style="stroke:var(--grid)" stroke-width="1" shape-rendering="crispEdges">${grid}</g>`
    + `<g class="chart-ax" style="fill:var(--muted);font-size:${AX_FS}px;font-variant-numeric:tabular-nums">${text}</g>`;
}

function xLabels(ticks, y) {
  return `<g class="chart-ax" style="fill:var(--muted);font-size:${AX_FS}px;font-variant-numeric:tabular-nums">${ticks
    .map((t) => `<text x="${r1(t.x)}" y="${y}" text-anchor="middle">${esc(t.label)}</text>`)
    .join('')}</g>`;
}

// Polyline segments (gaps at missing values), compressed to ≤ 4 points per pixel column (M4) so
// thousands of daily points stay light without losing peaks and troughs.
function segments(n, xAt, yAt) {
  const segs = [];
  let seg = null;
  let col = null;
  let a = -1; // first index in column
  let z = -1; // last
  let lo = -1; // index with min y
  let hi = -1; // index with max y
  const flushCol = () => {
    if (col === null) return;
    const idx = [...new Set([a, lo, hi, z])].sort((p, q) => p - q);
    for (const i of idx) seg.push([r1(xAt(i)), r1(yAt(i))]);
    col = null;
  };
  for (let i = 0; i < n; i++) {
    const y = yAt(i);
    if (y === null) {
      flushCol();
      if (seg && seg.length) segs.push(seg);
      seg = null;
      continue;
    }
    if (!seg) seg = [];
    const c = Math.round(xAt(i));
    if (c !== col) {
      flushCol();
      col = c;
      a = z = lo = hi = i;
    } else {
      z = i;
      if (y < yAt(lo)) lo = i;
      if (y > yAt(hi)) hi = i;
    }
  }
  flushCol();
  if (seg && seg.length) segs.push(seg);
  return segs;
}
const pathOf = (segs) => segs.map((s) => 'M' + s.map((p) => p.join(',')).join('L') + (s.length === 1 ? 'h0.01' : '')).join('');
const areaOf = (segs, base) => segs
  .filter((s) => s.length > 1)
  .map((s) => `M${s.map((p) => p.join(',')).join('L')}L${s[s.length - 1][0]},${r1(base)}L${s[0][0]},${r1(base)}Z`)
  .join('');

// Column / bar with a 4px rounded data end and a square base. up: data end on top.
function barPath(x, y, w, h, up) {
  const r = Math.min(4, w / 2, h);
  const X = r1(x);
  if (up) {
    const b = r1(y + h);
    return `M${X},${b}V${r1(y + r)}Q${X},${r1(y)} ${r1(x + r)},${r1(y)}H${r1(x + w - r)}Q${r1(x + w)},${r1(y)} ${r1(x + w)},${r1(y + r)}V${b}Z`;
  }
  const e = y + h;
  return `M${X},${r1(y)}V${r1(e - r)}Q${X},${r1(e)} ${r1(x + r)},${r1(e)}H${r1(x + w - r)}Q${r1(x + w)},${r1(e)} ${r1(x + w)},${r1(e - r)}V${r1(y)}Z`;
}

const dot = (cx, cy, color, r = 4, extra = '') => `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" style="fill:${esc(color)};stroke:var(--chart-ring, var(--surface))" stroke-width="2"${extra}/>`;

/* ======================================================================
   Line chart
   ====================================================================== */
export function lineChart(id, opts = {}) {
  const { dates = [], series = [], yFormat, log = false, zero = false, legend, tooltipValue, ariaLabel = 'Grafico a linee' } = opts;
  const w = width(opts.w);
  const h = height(opts.h, 220);
  const n = dates.length;
  const ser = series.map((s, k) => ({
    name: s.name ?? `Serie ${k + 1}`,
    color: s.color || seriesColor(k),
    values: s.values || [],
    width: isNum(s.width) ? s.width : 2,
    dash: dashArray(s.dash),
    area: s.area ?? (series.length === 1 && k === 0),
  }));
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of ser) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (isNum(v)) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!n || !ser.length || lo === Infinity) return emptyChart(id, w, h, ariaLabel);

  const fmtY = fmtFn(yFormat, compact);
  const fmtTip = typeof tooltipValue === 'function' ? tooltipValue : typeof yFormat === 'function' ? (v) => yFormat(v) : defaultTip;
  let useLog = !!log;
  let note = '';
  if (useLog && lo <= 0) {
    useLog = false;
    note = 'Scala logaritmica non disponibile perché ci sono valori pari a zero o negativi: mostrata la scala lineare.';
  }
  if (zero && !useLog) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const padT = 10;
  const padB = 24;
  const padL = 4;
  const ih = h - padT - padB;
  let ticks;
  let Y;
  if (useLog) {
    const l0 = Math.log(lo);
    const l1 = Math.log(hi);
    const pad = (l1 - l0) * 0.04 || 0.05;
    const a = l0 - pad;
    const b = l1 + pad;
    ticks = logTicks(Math.exp(a), Math.exp(b));
    Y = (v) => padT + ih - ((Math.log(v) - a) / (b - a)) * ih;
  } else {
    const nt = niceTicks(lo, hi, yTickCount(ih));
    ticks = nt.ticks;
    Y = (v) => padT + ih - ((v - nt.min) / (nt.max - nt.min)) * ih;
  }
  const labels = tidyTicks(ticks.map((t) => fmtY(t)));
  const padR = Math.ceil(Math.max(0, ...labels.map((l) => textW(l)))) + 12;
  const iw = Math.max(20, w - padL - padR);
  const X = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const showZero = zero && !useLog;

  let body = yAxis(ticks, labels, Y, padL, padL + iw, w, { zeroLine: showZero });
  if (showZero) {
    const zy = crisp(Y(0));
    body += `<line class="chart-zero" x1="${padL}" x2="${r1(padL + iw)}" y1="${zy}" y2="${zy}" style="stroke:var(--muted)" stroke-width="1" shape-rendering="crispEdges"/>`;
  }
  const xt = pickDateTicks(dates, X, 0, w, clamp(Math.floor(iw / 62), 2, 6));
  body += xLabels(xt, h - 6);

  // Geometry per series
  const baseY = showZero ? clamp(Y(0), padT, padT + ih) : padT + ih;
  const geo = ser.map((s) => segments(n, X, (i) => (isNum(s.values[i]) ? Y(s.values[i]) : null)));
  let areas = '';
  let lines = '';
  let ends = '';
  for (let k = ser.length - 1; k >= 0; k--) {
    const s = ser[k];
    const c = esc(s.color);
    if (s.area) areas += `<path d="${areaOf(geo[k], baseY)}" style="fill:${c}" fill-opacity="0.1"/>`;
    lines += `<path class="chart-line" d="${pathOf(geo[k])}" fill="none" style="stroke:${c}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
    let last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (isNum(s.values[i])) {
        last = i;
        break;
      }
    }
    if (last >= 0) ends += dot(X(last), Y(s.values[last]), s.color, 4, ' class="chart-end"');
  }
  body += areas + lines + ends;
  body += `<g class="ch-hover" visibility="hidden" pointer-events="none">`
    + `<line class="ch-x" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" style="stroke:var(--ink-2)" stroke-opacity="0.45" stroke-width="1"/>`
    + ser.map((s, k) => `<circle class="ch-dot" data-k="${k}" r="4" style="fill:${esc(s.color)};stroke:var(--chart-ring, var(--surface))" stroke-width="2"/>`).join('')
    + '</g>';

  REG.set(id, {
    type: 'line', w, h, padT, ih, x0: padL, iw, n, dates, X, Y,
    ser: ser.map((s) => ({ name: s.name, color: s.color, values: s.values, dash: !!s.dash })),
    fmtTip,
  });
  const leg = showLegend(legend, ser.length) ? legendHtml(ser.map((s) => ({ name: s.name, color: s.color, kind: s.dash ? 'dash' : 'line' }))) : '';
  return wrap(id, 'line', body, {
    w, h, aria: ariaLabel, title: note ? `${ariaLabel}. ${note}` : ariaLabel, legend: leg,
    attrs: note ? ' data-log-fallback="1"' : '',
  });
}

/* ======================================================================
   Grouped bar chart (negatives grow down from a visible zero line)
   ====================================================================== */
// Category labels: 'YYYY-MM' keys are formatted as months ('gen' when all in one year, else 'gen 26').
function catLabels(labels) {
  const months = labels.length && labels.every((l) => typeof l === 'string' && /^\d{4}-\d{2}$/.test(l));
  if (months) {
    const oneYear = new Set(labels.map((l) => l.slice(0, 4))).size === 1;
    return {
      axis: labels.map((l) => (oneYear ? MONTHS[+l.slice(5, 7) - 1] : fmtMonth(l))),
      tip: labels.map((l) => fmtMonth(l, true)),
    };
  }
  const axis = labels.map((l) => (typeof l === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l) ? fmtDate(l, false) : String(l ?? '')));
  return { axis, tip: labels.map((l) => fmtX(l)) };
}

export function barChart(id, opts = {}) {
  const { labels = [], series = [], yFormat, legend, tooltipValue, ariaLabel = 'Grafico a barre' } = opts;
  const w = width(opts.w);
  const h = height(opts.h, 220);
  const n = labels.length;
  const ser = series.map((s, k) => ({ name: s.name ?? `Serie ${k + 1}`, color: s.color || seriesColor(k), values: s.values || [] }));
  let lo = 0;
  let hi = 0;
  let cnt = 0;
  for (const s of ser) {
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      if (isNum(v)) {
        cnt++;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (!n || !ser.length || !cnt) return emptyChart(id, w, h, ariaLabel);

  const fmtY = fmtFn(yFormat, compact);
  const fmtTip = typeof tooltipValue === 'function' ? tooltipValue : typeof yFormat === 'function' ? (v) => yFormat(v) : defaultTip;
  const padT = 10;
  const padB = 24;
  const padL = 2;
  const ih = h - padT - padB;
  const nt = niceTicks(lo, hi, yTickCount(ih));
  const Y = (v) => padT + ih - ((v - nt.min) / (nt.max - nt.min)) * ih;
  const tl = tidyTicks(nt.ticks.map((t) => fmtY(t)));
  const padR = Math.ceil(Math.max(0, ...tl.map((l) => textW(l)))) + 10;
  const iw = Math.max(20, w - padL - padR);
  const slot = iw / n;
  const k = ser.length;

  // Bar thickness ≤ 24px with a 2px surface gap between adjacent bars; shrink the gap only when crowded
  const avail = Math.min(slot * 0.72, k * 24 + (k - 1) * 2);
  let gap = k > 1 ? 2 : 0;
  let bw = (avail - gap * (k - 1)) / k;
  if (bw < 3 && k > 1) {
    gap = 1;
    bw = (avail - gap * (k - 1)) / k;
  }
  if (bw < 1.5) {
    gap = 0;
    bw = avail / k;
  }
  bw = Math.max(1, Math.min(24, bw));
  const groupW = k * bw + (k - 1) * gap;

  let body = yAxis(nt.ticks, tl, Y, padL, padL + iw, w, { zeroLine: true });
  const zy = Y(0);
  let bars = '';
  for (let i = 0; i < n; i++) {
    const gx = padL + i * slot + (slot - groupW) / 2;
    for (let j = 0; j < k; j++) {
      const v = ser[j].values[i];
      if (!isNum(v) || v === 0) continue;
      const x = gx + j * (bw + gap);
      const yv = Y(v);
      const bh = Math.max(1, Math.abs(yv - zy));
      const d = v > 0 ? barPath(x, zy - bh, bw, bh, true) : barPath(x, zy, bw, bh, false);
      bars += `<path d="${d}" style="fill:${esc(ser[j].color)}"/>`;
    }
  }
  const zc = crisp(zy);
  body += `<rect class="ch-band" x="0" y="${padT}" width="${r1(slot)}" height="${ih}" rx="4" style="fill:var(--ink)" fill-opacity="0.06" visibility="hidden" pointer-events="none"/>`;
  body += `<g class="chart-bars">${bars}</g>`;
  body += `<line class="chart-zero" x1="${padL}" x2="${r1(padL + iw)}" y1="${zc}" y2="${zc}" style="stroke:var(--muted)" stroke-width="1" shape-rendering="crispEdges"/>`;

  // Category labels, every k-th when crowded (never rotated)
  const cl = catLabels(labels);
  const maxLw = Math.max(...cl.axis.map((l) => textW(l)));
  let every = Math.max(1, Math.ceil((maxLw + 8) / slot));
  let xt = [];
  for (;;) {
    // Edge labels are pulled inside the box, so re-check spacing after clamping
    xt = [];
    let prevRight = -Infinity;
    let ok = true;
    for (let i = 0; i < n; i += every) {
      const tw = textW(cl.axis[i]);
      const x = clamp(padL + (i + 0.5) * slot, tw / 2, w - tw / 2);
      if (x - tw / 2 < prevRight + 8) {
        ok = false;
        break;
      }
      prevRight = x + tw / 2;
      xt.push({ x, label: cl.axis[i] });
    }
    if (ok || every >= n) break;
    every++;
  }
  body += xLabels(xt, h - 6);

  REG.set(id, {
    type: 'bar', w, h, padT, ih, x0: padL, iw, n, slot, labels: cl.tip,
    ser: ser.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    fmtTip,
  });
  const leg = showLegend(legend, ser.length) ? legendHtml(ser.map((s) => ({ name: s.name, color: s.color, kind: 'rect' }))) : '';
  return wrap(id, 'bar', body, { w, h, aria: ariaLabel, legend: leg });
}

/* ======================================================================
   Stacked area (percent by default)
   ====================================================================== */
export function stackedArea(id, opts = {}) {
  const { dates = [], series = [], percent = true, legend, yFormat, tooltipValue, ariaLabel = 'Grafico ad aree sovrapposte' } = opts;
  const w = width(opts.w);
  const h = height(opts.h, 220);
  const n = dates.length;
  const ser = series.map((s, k) => ({ name: s.name ?? `Serie ${k + 1}`, color: s.color || seriesColor(k), values: s.values || [] }));
  const m = ser.length;
  if (!n || !m) return emptyChart(id, w, h, ariaLabel);

  // Per-date values (negatives and gaps → 0), optionally normalized to shares
  const vals = ser.map((s) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const v = s.values[i];
      a[i] = isNum(v) && v > 0 ? v : 0;
    }
    return a;
  });
  const valid = new Uint8Array(n);
  let firstValid = -1;
  let maxTotal = 0;
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (let k = 0; k < m; k++) t += vals[k][i];
    if (t > 0) {
      valid[i] = 1;
      if (firstValid < 0) firstValid = i;
      if (t > maxTotal) maxTotal = t;
      if (percent) for (let k = 0; k < m; k++) vals[k][i] /= t;
    } else if (percent && firstValid >= 0) {
      // Interior empty date: carry the previous shares so the 100% band does not collapse
      valid[i] = 1;
      for (let k = 0; k < m; k++) vals[k][i] = vals[k][i - 1];
    } else if (!percent && firstValid >= 0) valid[i] = 1;
  }
  if (firstValid < 0) return emptyChart(id, w, h, ariaLabel);
  // Cumulative tops: cum[k][i] = Σ_{j ≤ k} vals[j][i]  (series 0 at the bottom)
  const cum = [];
  for (let k = 0; k < m; k++) {
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = (k ? cum[k - 1][i] : 0) + vals[k][i];
    cum.push(c);
  }

  const fmtY = percent ? (v) => pct(v, 0) : fmtFn(yFormat, compact);
  const fmtTip = typeof tooltipValue === 'function' ? tooltipValue : percent ? (v) => pct(v, 1) : typeof yFormat === 'function' ? (v) => yFormat(v) : defaultTip;
  const padT = 10;
  const padB = 24;
  const padL = 2;
  const ih = h - padT - padB;
  const ticks = percent ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, maxTotal, yTickCount(ih)).ticks;
  const top = ticks[ticks.length - 1];
  const Y = (v) => padT + ih - (v / top) * ih;
  const tl = tidyTicks(ticks.map((t) => fmtY(t)));
  const padR = Math.ceil(Math.max(0, ...tl.map((l) => textW(l)))) + 10;
  const iw = Math.max(20, w - padL - padR);
  const X = (i) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);

  // Sampled indices: about 2 per pixel, always keeping the first valid and the last date
  const stepI = Math.max(1, Math.floor((n - firstValid) / (iw * 2)));
  const idx = [];
  for (let i = firstValid; i < n; i += stepI) if (valid[i]) idx.push(i);
  if (idx[idx.length - 1] !== n - 1 && valid[n - 1]) idx.push(n - 1);

  let body = yAxis(ticks, tl, Y, padL, padL + iw, w);
  let bands = '';
  let edges = '';
  for (let k = 0; k < m; k++) {
    const topPts = idx.map((i) => `${r1(X(i))},${r1(Y(cum[k][i]))}`);
    const botPts = idx.map((i) => `${r1(X(i))},${r1(Y(k ? cum[k - 1][i] : 0))}`).reverse();
    const single = idx.length === 1;
    const d = single
      ? `M${r1(X(idx[0]) - 1)},${r1(Y(cum[k][idx[0]]))}h2V${r1(Y(k ? cum[k - 1][idx[0]] : 0))}h-2Z`
      : `M${topPts.join('L')}L${botPts.join('L')}Z`;
    bands += `<path class="chart-band" d="${d}" style="fill:${esc(ser[k].color)}" fill-opacity="0.32"/>`;
    // Band edge = line: the top of each band in the series color (skip the flat 100% edge)
    if (!single && !(percent && k === m - 1)) {
      edges += `<path d="M${topPts.join('L')}" fill="none" style="stroke:${esc(ser[k].color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
  }
  body += `<g class="chart-bands">${bands}${edges}</g>`;
  const xt = pickDateTicks(dates, X, 0, w, clamp(Math.floor(iw / 62), 2, 6));
  body += xLabels(xt, h - 6);
  body += `<g class="ch-hover" visibility="hidden" pointer-events="none">`
    + `<line class="ch-x" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" style="stroke:var(--ink)" stroke-opacity="0.55" stroke-width="1"/>`
    + ser.map((s, k) => `<circle class="ch-dot" data-k="${k}" r="3.5" style="fill:${esc(s.color)};stroke:var(--chart-ring, var(--surface))" stroke-width="2"/>`).join('')
    + '</g>';

  REG.set(id, {
    type: 'stack', w, h, padT, ih, x0: padL, iw, n, dates, X, Y, valid, vals, cum, percent,
    ser: ser.map((s) => ({ name: s.name, color: s.color, values: s.values })),
    fmtTip,
  });
  const leg = showLegend(legend, m) ? legendHtml(ser.map((s) => ({ name: s.name, color: s.color, kind: 'rect' }))) : '';
  return wrap(id, 'stack', body, { w, h, aria: ariaLabel, legend: leg });
}

/* ======================================================================
   Donut
   ====================================================================== */
function arcPath(cx, cy, r0, r1_, a0, a1) {
  // Annular sector from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise)
  const pt = (r, a) => `${r1(cx + r * Math.sin(a))},${r1(cy - r * Math.cos(a))}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1_, a0)}A${r1_},${r1_} 0 ${large} 1 ${pt(r1_, a1)}L${pt(r0, a1)}A${r0},${r0} 0 ${large} 0 ${pt(r0, a0)}Z`;
}
function ringPath(cx, cy, r0, r1_) {
  return `M${cx - r1_},${cy}A${r1_},${r1_} 0 1 1 ${cx + r1_},${cy}A${r1_},${r1_} 0 1 1 ${cx - r1_},${cy}Z`
    + `M${cx - r0},${cy}A${r0},${r0} 0 1 0 ${cx + r0},${cy}A${r0},${r0} 0 1 0 ${cx - r0},${cy}Z`;
}

export function donutChart(id, opts = {}) {
  const { items = [], centerValue, centerLabel, selected, actKey, legend, format, ariaLabel = 'Grafico a ciambella' } = opts;
  const size = Math.max(80, Math.round(isNum(opts.size) ? opts.size : 200));
  const list = items
    .map((it, k) => ({ key: it.key ?? String(k), label: it.label ?? String(it.key ?? ''), value: it.value, color: it.color || seriesColor(k) }))
    .filter((it) => isNum(it.value) && it.value > 0);
  const total = list.reduce((s, it) => s + it.value, 0);
  if (!list.length || !(total > 0)) return emptyChart(id, size, size, ariaLabel);

  const cx = size / 2;
  const cy = size / 2;
  const rO = size / 2 - 6; // leave room for the hover/selected lift
  const t = Math.max(10, Math.round(size * 0.13));
  const rI = rO - t;
  const gapA = list.length > 1 ? 2 / ((rO + rI) / 2) : 0; // 2px surface gap at mid radius
  const hasSel = selected !== undefined && selected !== null && list.some((it) => it.key === selected);
  let a = 0;
  const segs = list.map((it) => {
    const sweep = (it.value / total) * Math.PI * 2;
    const a0 = a;
    const a1 = a + sweep;
    a = a1;
    let s0 = a0 + gapA / 2;
    let s1 = a1 - gapA / 2;
    if (s1 - s0 < 0.012) {
      const mid = (a0 + a1) / 2;
      s0 = mid - 0.006;
      s1 = mid + 0.006;
    }
    const full = list.length === 1;
    return {
      ...it, a0, a1, share: it.value / total,
      d: full ? ringPath(cx, cy, rI, rO) : arcPath(cx, cy, rI, rO, s0, s1),
      d2: full ? ringPath(cx, cy, rI, rO + 4) : arcPath(cx, cy, rI, rO + 4, s0, s1),
    };
  });
  let body = `<circle cx="${cx}" cy="${cy}" r="${r1((rO + rI) / 2)}" fill="none" style="stroke:var(--surface-2)" stroke-width="${t}" opacity="0.5"/>`;
  body += segs.map((s, k) => {
    const isSel = hasSel && s.key === selected;
    const dim = hasSel && !isSel ? ' fill-opacity="0.32"' : '';
    const act = actKey ? ` data-act="${esc(actKey)}" data-key="${esc(s.key)}" style="fill:${esc(s.color)};cursor:pointer"` : ` style="fill:${esc(s.color)}"`;
    return `<path class="ch-seg" data-i="${k}" d="${isSel ? s.d2 : s.d}" fill-rule="evenodd"${act}${dim}/>`;
  }).join('');

  // Center text sized to fit the hole
  const hole = rI * 2 * 0.8;
  if (centerValue !== undefined && centerValue !== null && centerValue !== '') {
    const cv = String(centerValue);
    const fs = clamp(Math.min(size * 0.12, hole / (cv.length * 0.6)), 10, 30);
    const y = centerLabel ? cy + fs * 0.12 : cy + fs * 0.35;
    body += `<text x="${cx}" y="${r1(y)}" text-anchor="middle" class="chart-center-value" style="fill:var(--ink);font-size:${r1(fs)}px;font-weight:700;font-variant-numeric:tabular-nums">${esc(cv)}</text>`;
    if (centerLabel) {
      const maxCh = Math.max(4, Math.floor(hole / (12 * 0.56)));
      const cl = String(centerLabel);
      const txt = cl.length > maxCh ? cl.slice(0, maxCh - 1) + '…' : cl;
      body += `<text x="${cx}" y="${r1(y + 17)}" text-anchor="middle" style="fill:var(--muted);font-size:12px">${esc(txt)}</text>`;
    }
  } else if (centerLabel) {
    body += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" style="fill:var(--muted);font-size:12px">${esc(centerLabel)}</text>`;
  }

  REG.set(id, {
    type: 'donut', w: size, h: size, cx, cy, rO, rI, total, hasSel, selected,
    segs: segs.map((s) => ({ key: s.key, label: s.label, value: s.value, color: s.color, share: s.share, a0: s.a0, a1: s.a1, d: s.d, d2: s.d2 })),
    fmtTip: fmtFn(format, money),
  });
  const leg = showLegend(legend, segs.length) ? legendHtml(segs.map((s) => ({ name: s.label, color: s.color, kind: 'rect' }))) : '';
  return wrap(id, 'donut', body, { w: size, h: size, aria: ariaLabel, legend: leg });
}

/* ======================================================================
   Scatter (with lines drawn under the points)
   ====================================================================== */
export function scatterChart(id, opts = {}) {
  const { points = [], lines = [], xFormat, yFormat, xLabel = '', yLabel = '', legend, ariaLabel = 'Grafico a dispersione' } = opts;
  const w = width(opts.w);
  const h = height(opts.h, 300);
  const pts = points.filter((p) => p && isNum(p.x) && isNum(p.y));
  const lns = lines
    .map((l, k) => ({ name: l.name ?? '', color: l.color || seriesColor(k), dash: dashArray(l.dash), points: (l.points || []).filter((p) => p && isNum(p.x) && isNum(p.y)) }))
    .filter((l) => l.points.length);
  if (!pts.length && !lns.length) return emptyChart(id, w, h, ariaLabel);

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const take = (p) => {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  };
  pts.forEach(take);
  lns.forEach((l) => l.points.forEach(take));
  const fx = fmtFn(xFormat, compact);
  const fy = fmtFn(yFormat, compact);
  const padT = 10 + (yLabel ? 18 : 0);
  const padB = 22 + (xLabel ? 18 : 0);
  const padR = 10;
  const ih = h - padT - padB;
  const yt = niceTicks(y0, y1, yTickCount(ih));
  const yl = tidyTicks(yt.ticks.map((t) => fy(t)));
  const padL = Math.ceil(Math.max(0, ...yl.map((l) => textW(l)))) + 10;
  const iw = Math.max(20, w - padL - padR);
  const xt = niceTicks(x0, x1, clamp(Math.floor(iw / 60), 3, 7));
  const xl = tidyTicks(xt.ticks.map((t) => fx(t)));
  const X = (v) => padL + ((v - xt.min) / (xt.max - xt.min)) * iw;
  const Y = (v) => padT + ih - ((v - yt.min) / (yt.max - yt.min)) * ih;

  let body = yAxis(yt.ticks, yl, Y, padL, padL + iw, w, { side: 'left' });
  // Vertical hairlines + x tick labels (skip labels that would collide)
  let vgrid = '';
  let xtext = '';
  let prevRight = -Infinity;
  xt.ticks.forEach((t, k) => {
    const x = crisp(X(t));
    vgrid += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${padT + ih}"/>`;
    const tw = textW(xl[k]);
    const cxl = clamp(X(t), tw / 2, w - tw / 2);
    if (cxl - tw / 2 > prevRight + 8) {
      xtext += `<text x="${r1(cxl)}" y="${padT + ih + 16}" text-anchor="middle">${esc(xl[k])}</text>`;
      prevRight = cxl + tw / 2;
    }
  });
  body += `<g class="chart-grid" style="stroke:var(--grid)" stroke-width="1" shape-rendering="crispEdges">${vgrid}</g>`;
  body += `<g class="chart-ax" style="fill:var(--muted);font-size:${AX_FS}px;font-variant-numeric:tabular-nums">${xtext}</g>`;
  if (xLabel) body += `<text x="${r1(padL + iw)}" y="${h - 4}" text-anchor="end" style="fill:var(--ink-2);font-size:11px;font-weight:600">${esc(xLabel)}</text>`;
  if (yLabel) body += `<text x="0" y="13" text-anchor="start" style="fill:var(--ink-2);font-size:11px;font-weight:600">${esc(yLabel)}</text>`;

  // Lines under points
  for (const l of lns) {
    const sorted = l.points;
    const d = 'M' + sorted.map((p) => `${r1(X(p.x))},${r1(Y(p.y))}`).join('L');
    body += `<path d="${d}" fill="none" style="stroke:${esc(l.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${l.dash ? ` stroke-dasharray="${l.dash}"` : ''}/>`;
  }
  // Points (special points last so they sit on top)
  const order = pts.map((p, i) => i).sort((a, b) => (pts[a].special ? 1 : 0) - (pts[b].special ? 1 : 0));
  const geo = pts.map((p) => ({ x: X(p.x), y: Y(p.y), r: isNum(p.r) ? p.r : 5 }));
  for (const i of order) {
    const p = pts[i];
    body += dot(geo[i].x, geo[i].y, p.color || 'var(--c1)', geo[i].r);
  }
  // Direct labels for special points when there is room (no overlap with other labels, points or the edges)
  const boxes = geo.map((g) => ({ x0: g.x - g.r - 1, x1: g.x + g.r + 1, y0: g.y - g.r - 1, y1: g.y + g.r + 1 }));
  const hit = (b) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  let labelsSvg = '';
  for (const i of order.slice().reverse()) {
    const p = pts[i];
    if (!p.special || !p.label) continue;
    const txt = String(p.label).length > 22 ? String(p.label).slice(0, 21) + '…' : String(p.label);
    const tw = textW(txt, 11);
    const g = geo[i];
    const cands = [
      { x: g.x + g.r + 5, anchor: 'start', bx: g.x + g.r + 5, y: g.y + 4 },
      { x: g.x - g.r - 5, anchor: 'end', bx: g.x - g.r - 5 - tw, y: g.y + 4 },
      { x: g.x, anchor: 'middle', bx: g.x - tw / 2, y: g.y - g.r - 6 },
      { x: g.x, anchor: 'middle', bx: g.x - tw / 2, y: g.y + g.r + 14 },
    ];
    for (const c of cands) {
      const b = { x0: c.bx - 2, x1: c.bx + tw + 2, y0: c.y - 10, y1: c.y + 3 };
      if (b.x0 < padL || b.x1 > w || b.y0 < padT - 6 || b.y1 > padT + ih) continue;
      if (hit(b)) continue;
      boxes.push(b);
      labelsSvg += `<text x="${r1(c.x)}" y="${r1(c.y)}" text-anchor="${c.anchor}" style="fill:var(--ink-2);font-size:11px;font-weight:600;paint-order:stroke;stroke:var(--chart-ring, var(--surface));stroke-width:3px;stroke-linejoin:round">${esc(txt)}</text>`;
      break;
    }
  }
  body += labelsSvg;
  body += `<circle class="ch-ring" r="8" fill="none" style="stroke:var(--ink)" stroke-width="1.5" visibility="hidden" pointer-events="none"/>`;

  // Hover targets: points first, then line vertices (e.g. frontier portfolios)
  const targets = pts.map((p, i) => ({ x: geo[i].x, y: geo[i].y, vx: p.x, vy: p.y, label: p.label || p.group || '', color: p.color || 'var(--c1)', sub: p.sub || '', kind: 'dot', bias: 3 }));
  for (const l of lns) {
    for (const p of l.points) {
      targets.push({ x: X(p.x), y: Y(p.y), vx: p.x, vy: p.y, label: p.label || l.name, color: l.color, sub: p.sub || '', kind: l.dash ? 'dash' : 'line', bias: 0 });
    }
  }
  // Axis titles may carry direction arrows ('↑ Rendimento'): drop them inside the tooltip
  const plain = (s) => String(s).replace(/[↑↓←→]/g, '').trim();
  REG.set(id, { type: 'scatter', w, h, targets, fx: fmtFn(opts.tooltipX, fx), fy: fmtFn(opts.tooltipY, fy), xLabel: plain(xLabel), yLabel: plain(yLabel) });

  // Legend: named lines and named point groups
  const keys = [];
  for (const l of lns) if (l.name) keys.push({ name: l.name, color: l.color, kind: l.dash ? 'dash' : 'line' });
  const seen = new Set();
  for (const p of pts) {
    if (!p.group || seen.has(p.group)) continue;
    seen.add(p.group);
    keys.push({ name: p.group, color: p.color || 'var(--c1)', kind: 'dot' });
  }
  const leg = showLegend(legend, keys.length) ? legendHtml(keys) : '';
  return wrap(id, 'scatter', body, { w, h, aria: ariaLabel, legend: leg });
}

/* ======================================================================
   Sparkline (no axes, no tooltip)
   ====================================================================== */
export function sparkline(values, opts = {}) {
  const w = Math.max(16, Math.round(isNum(opts.w) ? opts.w : 80));
  const h = Math.max(8, Math.round(isNum(opts.h) ? opts.h : 28));
  const color = opts.color || 'var(--muted)';
  const vals = Array.from(values || []);
  const n = vals.length;
  let lo = Infinity;
  let hi = -Infinity;
  let cnt = 0;
  for (const v of vals) {
    if (isNum(v)) {
      cnt++;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (cnt < 2) {
    const y = crisp(h / 2);
    return `<svg class="spark spark-empty" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Nessun dato"><line x1="2" x2="${w - 2}" y1="${y}" y2="${y}" style="stroke:var(--grid)" stroke-width="1"/></svg>`;
  }
  const pad = 2;
  const span = hi - lo || 1;
  const X = (i) => pad + (i / (n - 1)) * (w - pad * 2);
  const Y = (v) => (hi === lo ? h / 2 : pad + (1 - (v - lo) / span) * (h - pad * 2));
  const segs = segments(n, X, (i) => (isNum(vals[i]) ? Y(vals[i]) : null));
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true" focusable="false">`
    + `<path d="${pathOf(segs)}" fill="none" style="stroke:${esc(color)}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

/* ======================================================================
   Interaction (document-level delegation)
   ====================================================================== */

export function chartScrubHandlers(id, { onScrub, onEnd } = {}) {
  const d = REG.get(id);
  if (!d) return;
  d.onScrub = typeof onScrub === 'function' ? onScrub : null;
  d.onEnd = typeof onEnd === 'function' ? onEnd : null;
}

// Pointer → index (or target) per chart type, in SVG coordinates. Returns -1 for "nothing here".
function locate(d, x, y, scale) {
  switch (d.type) {
    case 'line':
    case 'stack':
      if (d.n === 1) return 0;
      return clamp(Math.round(((x - d.x0) / d.iw) * (d.n - 1)), 0, d.n - 1);
    case 'bar':
      return clamp(Math.floor((x - d.x0) / d.slot), 0, d.n - 1);
    case 'scatter': {
      const tol = 24 * scale;
      let best = -1;
      let bd = Infinity;
      d.targets.forEach((t, i) => {
        const dist = Math.hypot(t.x - x, t.y - y) - t.bias * scale;
        if (dist < bd) {
          bd = dist;
          best = i;
        }
      });
      return bd <= tol ? best : -1;
    }
    case 'donut': {
      const dx = x - d.cx;
      const dy = y - d.cy;
      const r = Math.hypot(dx, dy);
      if (r < d.rI - 10 * scale || r > d.rO + 12 * scale) return -1;
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += Math.PI * 2;
      return d.segs.findIndex((s) => a >= s.a0 && a < s.a1);
    }
    default:
      return -1;
  }
}

// Update hover marks for index i and return tooltip content + anchor (SVG coordinates).
function present(el, d, i) {
  const svg = el.querySelector('svg.chart-svg');
  if (!svg) return null;
  if (d.type === 'line' || d.type === 'stack') {
    const g = svg.querySelector('.ch-hover');
    const x = d.X(i);
    const lineEl = g.querySelector('.ch-x');
    lineEl.setAttribute('x1', r1(x));
    lineEl.setAttribute('x2', r1(x));
    const rows = [];
    g.querySelectorAll('.ch-dot').forEach((c) => {
      const k = +c.dataset.k;
      let yv = null;
      if (d.type === 'line') {
        const v = d.ser[k].values[i];
        if (isNum(v)) yv = d.Y(v);
      } else if (d.valid[i]) yv = d.Y(d.cum[k][i]);
      if (yv === null) c.setAttribute('visibility', 'hidden');
      else {
        c.setAttribute('visibility', 'visible');
        c.setAttribute('cx', r1(x));
        c.setAttribute('cy', r1(yv));
      }
    });
    if (d.type === 'line') {
      d.ser.forEach((s, k) => {
        const v = s.values[i];
        rows.push({ color: s.color, kind: s.dash ? 'dash' : 'line', value: isNum(v) ? d.fmtTip(v, k, i) : '—', name: s.name });
      });
    } else {
      // Top band first, matching the vertical order on screen
      for (let k = d.ser.length - 1; k >= 0; k--) {
        const s = d.ser[k];
        const v = d.percent ? d.vals[k][i] : s.values[i];
        rows.push({ color: s.color, kind: 'rect', value: d.valid[i] && isNum(v) ? d.fmtTip(v, k, i) : '—', name: s.name });
      }
    }
    g.setAttribute('visibility', 'visible');
    return { head: fmtX(d.dates[i]), rows, ax: x, ay: d.padT, place: 'side' };
  }
  if (d.type === 'bar') {
    const band = svg.querySelector('.ch-band');
    band.setAttribute('x', r1(d.x0 + i * d.slot));
    band.setAttribute('width', r1(d.slot));
    band.setAttribute('visibility', 'visible');
    const rows = d.ser.map((s, k) => {
      const v = s.values[i];
      return { color: s.color, kind: 'rect', value: isNum(v) ? d.fmtTip(v, k, i) : '—', name: s.name };
    });
    return { head: d.labels[i], rows, ax: d.x0 + (i + 0.5) * d.slot, ay: d.padT, place: 'side', gap: d.slot / 2 };
  }
  if (d.type === 'scatter') {
    const t = d.targets[i];
    const ring = svg.querySelector('.ch-ring');
    ring.setAttribute('cx', r1(t.x));
    ring.setAttribute('cy', r1(t.y));
    ring.setAttribute('visibility', 'visible');
    const rows = [
      { kind: 'none', value: d.fy(t.vy), name: d.yLabel || 'y' },
      { kind: 'none', value: d.fx(t.vx), name: d.xLabel || 'x' },
    ];
    if (t.sub) rows.push({ kind: 'none', value: '', name: t.sub });
    return { head: t.label, headColor: t.color, headKind: t.kind, rows, ax: t.x, ay: t.y, place: 'above' };
  }
  if (d.type === 'donut') {
    const s = d.segs[i];
    svg.querySelectorAll('.ch-seg').forEach((p) => {
      const k = +p.dataset.i;
      const seg = d.segs[k];
      const lifted = k === i || (d.hasSel && seg.key === d.selected);
      p.setAttribute('d', lifted ? seg.d2 : seg.d);
    });
    const mid = (s.a0 + s.a1) / 2;
    return {
      head: s.label,
      headColor: s.color,
      headKind: 'rect',
      rows: [{ kind: 'none', value: d.fmtTip(s.value), name: pct(s.share, 1) }],
      ax: d.cx + d.rO * Math.sin(mid),
      ay: d.cy - d.rO * Math.cos(mid),
      place: 'above',
    };
  }
  return null;
}

function clearMarks(el, d) {
  const svg = el.querySelector('svg.chart-svg');
  if (!svg) return;
  svg.querySelectorAll('.ch-hover, .ch-band, .ch-ring').forEach((g) => g.setAttribute('visibility', 'hidden'));
  if (d && d.type === 'donut') {
    svg.querySelectorAll('.ch-seg').forEach((p) => {
      const seg = d.segs[+p.dataset.i];
      if (seg) p.setAttribute('d', d.hasSel && seg.key === d.selected ? seg.d2 : seg.d);
    });
  }
}

function keyEl(kind, color) {
  const k = document.createElement('i');
  k.className = `k-${kind || 'line'}`;
  if (kind === 'none') return k;
  if (kind === 'dash') k.style.borderTopColor = color;
  else k.style.background = color;
  return k;
}

// Tooltip DOM (textContent only: names and labels may come from imported files or the network)
function fillTip(tip, c) {
  tip.textContent = '';
  if (c.head) {
    const head = document.createElement('div');
    head.className = 'chart-tip-head';
    if (c.headColor) head.append(keyEl(c.headKind || 'rect', c.headColor));
    const span = document.createElement('span');
    span.textContent = c.head;
    head.append(span);
    tip.append(head);
  }
  if (c.rows && c.rows.length) {
    const grid = document.createElement('div');
    grid.className = 'chart-tip-grid';
    for (const r of c.rows) {
      const v = document.createElement('b');
      v.textContent = r.value;
      const nm = document.createElement('span');
      nm.textContent = r.name || '';
      grid.append(keyEl(r.kind, r.color), v, nm);
    }
    tip.append(grid);
  }
}

// Position the tooltip inside the chart box: beside the crosshair (flipping near the right edge) or above a point.
function placeTip(el, svg, tip, c, d) {
  const wr = el.getBoundingClientRect();
  const sr = svg.getBoundingClientRect();
  const k = sr.width ? sr.width / d.w : 1;
  const ax = sr.left - wr.left + c.ax * k;
  const ay = sr.top - wr.top + c.ay * k;
  const W = el.clientWidth;
  const H = el.clientHeight;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left;
  let top;
  if (c.place === 'side') {
    const off = (c.gap || 0) * k + 12;
    left = ax + off;
    if (left + tw > W) left = ax - off - tw;
    if (left < 0) left = clamp(ax - tw / 2, 0, Math.max(0, W - tw));
    top = ay;
  } else {
    left = clamp(ax - tw / 2, 0, Math.max(0, W - tw));
    top = ay - th - 14;
    if (top < 0) top = ay + 16;
  }
  top = clamp(top, 0, Math.max(0, H - th));
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

const P = { active: null, shown: null, timer: 0 };

function showAt(el, i) {
  const d = REG.get(el.dataset.chartId);
  if (!d) return;
  const svg = el.querySelector('svg.chart-svg');
  const tip = el.querySelector('.chart-tip');
  if (!svg || !tip) return;
  if (P.shown && P.shown !== el) hide(P.shown);
  if (i < 0) {
    if (P.shown === el) hide(el);
    return;
  }
  const c = present(el, d, i);
  if (!c) return;
  fillTip(tip, c);
  tip.hidden = false;
  placeTip(el, svg, tip, c, d);
  P.shown = el;
  d.cur = i;
  if (d.onScrub) {
    try {
      d.onScrub(i);
    } catch (err) {
      console.error(err);
    }
  }
}

function hide(el) {
  if (!el) return;
  const d = REG.get(el.dataset.chartId);
  const tip = el.querySelector('.chart-tip');
  if (tip) tip.hidden = true;
  clearMarks(el, d);
  if (P.shown === el) P.shown = null;
  if (d && d.onEnd) {
    try {
      d.onEnd();
    } catch (err) {
      console.error(err);
    }
  }
}

function inspect(el, e) {
  const d = REG.get(el.dataset.chartId);
  const svg = el.querySelector('svg.chart-svg');
  if (!d || !svg) return;
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const scale = d.w / r.width;
  const x = (e.clientX - r.left) * scale;
  const y = (e.clientY - r.top) * (d.h / r.height);
  showAt(el, locate(d, x, y, scale));
}

const chartOf = (target) => {
  if (!target || typeof target.closest !== 'function') return null;
  const svg = target.closest('svg.chart-svg');
  if (!svg) return null;
  const el = svg.closest('.chart[data-chart-id]');
  return el && REG.has(el.dataset.chartId) ? el : null;
};
const clearTimer = () => {
  clearTimeout(P.timer);
  P.timer = 0;
};

function onDown(e) {
  const el = chartOf(e.target);
  if (!el) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  clearTimer();
  P.active = { el, id: e.pointerId, type: e.pointerType };
  inspect(el, e);
}
function onMove(e) {
  if (P.active && e.pointerId === P.active.id) {
    if (!P.active.el.isConnected) {
      P.active = null;
      return;
    }
    inspect(P.active.el, e);
    return;
  }
  if (e.pointerType !== 'mouse' || P.active) return;
  const el = chartOf(e.target);
  if (!el) {
    if (P.shown && !P.timer) hide(P.shown);
    return;
  }
  clearTimer();
  inspect(el, e);
}
function onUp(e) {
  if (!P.active || e.pointerId !== P.active.id) return;
  const { el, type } = P.active;
  P.active = null;
  if (type === 'mouse') {
    if (chartOf(e.target) !== el) hide(el);
    return;
  }
  clearTimer();
  P.timer = setTimeout(() => {
    P.timer = 0;
    hide(el);
  }, TOUCH_HIDE_MS);
}
function onCancel(e) {
  if (!P.active || e.pointerId !== P.active.id) return;
  const { el } = P.active;
  P.active = null;
  clearTimer();
  hide(el); // the browser took over (vertical scroll)
}
function onLeave(e) {
  if (e.pointerType !== 'mouse') return;
  const t = e.target;
  if (!t || typeof t.matches !== 'function' || !t.matches('svg.chart-svg')) return;
  if (P.active && P.active.type === 'mouse') return; // dragging: keep scrubbing until pointerup
  const el = t.closest('.chart[data-chart-id]');
  if (el && P.shown === el) hide(el);
}

// Keyboard: focus a chart and use ←/→ (Home/End) to move through dates, bars, points or segments.
function count(d) {
  if (d.type === 'scatter') return d.targets.length;
  if (d.type === 'donut') return d.segs.length;
  return d.n;
}
// Where keyboard reading starts: the latest date on time charts, the first item elsewhere
const startIndex = (d, n) => (isNum(d.cur) && d.cur < n ? d.cur : d.type === 'line' || d.type === 'stack' ? n - 1 : 0);
function onFocusIn(e) {
  const t = e.target;
  if (!t || typeof t.matches !== 'function' || !t.matches('svg.chart-svg')) return;
  let fv = false;
  try {
    fv = t.matches(':focus-visible');
  } catch {
    fv = false;
  }
  if (!fv) return; // pointer focus: the pointer handlers already show the tooltip
  const el = chartOf(t);
  if (!el) return;
  const d = REG.get(el.dataset.chartId);
  const n = count(d);
  if (!n) return;
  showAt(el, startIndex(d, n));
}
function onFocusOut(e) {
  const el = chartOf(e.target);
  if (el && P.shown === el && !P.active) hide(el);
}
function onKey(e) {
  const el = chartOf(e.target);
  if (!el) return;
  const d = REG.get(el.dataset.chartId);
  const n = count(d);
  if (!n) return;
  // First key press only reveals the current position; later presses move
  const cur = startIndex(d, n);
  const shown = P.shown === el;
  const big = Math.max(1, Math.round(n / 10));
  let i = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = cur + (e.shiftKey ? big : 1);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = cur - (e.shiftKey ? big : 1);
  else if (e.key === 'Home') i = 0;
  else if (e.key === 'End') i = n - 1;
  else if (e.key === 'Escape') {
    hide(el);
    return;
  }
  if (i === null) return;
  e.preventDefault();
  if (!shown && e.key.startsWith('Arrow')) i = cur;
  showAt(el, clamp(i, 0, n - 1));
}

/* ---------- Styles (injected once; css/app.css may override, it loads later in the cascade) ---------- */
export const CHART_CSS = `
.chart { position: relative; max-width: 100%; }
.chart-svg { display: block; max-width: 100%; height: auto; overflow: visible; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
.chart-svg:focus { outline: none; }
.chart-svg:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 3px; border-radius: 6px; }
.chart-svg text { font-family: inherit; }
.chart-tip { position: absolute; left: 0; top: 0; z-index: 6; pointer-events: none; box-sizing: border-box;
  max-width: min(260px, 100%); padding: 7px 10px 8px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--surface); color: var(--ink); box-shadow: 0 8px 24px rgba(0, 0, 0, .16);
  font-size: 12px; line-height: 1.35; }
.chart-tip[hidden] { display: none !important; }
.chart-tip-head { display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--muted); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chart-tip-grid { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; column-gap: 7px; row-gap: 2px; }
.chart-tip-grid b { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; color: var(--ink); }
.chart-tip-grid span { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chart-tip i, .chart-key i { flex: none; display: inline-block; width: 12px; height: 2.5px; border-radius: 2px; }
.chart-tip i.k-rect, .chart-key i.k-rect { width: 10px; height: 10px; border-radius: 3px; }
.chart-tip i.k-dot, .chart-key i.k-dot { width: 9px; height: 9px; border-radius: 50%; }
.chart-tip i.k-dash, .chart-key i.k-dash { height: 0; border-top: 2.5px dashed; border-radius: 0; background: none; }
.chart-tip i.k-none { width: 0; height: 0; }
.chart-key i.k-line, .chart-key i.k-dash { width: 16px; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 12px; line-height: 1.5; color: var(--ink-2); }
.chart-key { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.chart-key > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spark { display: block; overflow: visible; }
/* Stacked-area washes need more body on the dark surface */
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .chart-band { fill-opacity: .5; } }
:root[data-theme="dark"] .chart-band { fill-opacity: .5; }
@media (prefers-reduced-motion: reduce) { .chart *, .spark { transition: none !important; animation: none !important; } }
`;

let listening = false;
function injectCss() {
  if (typeof document === 'undefined' || document.getElementById('chart-css')) return;
  const st = document.createElement('style');
  st.id = 'chart-css';
  st.textContent = CHART_CSS;
  document.head.prepend(st);
}

export function initCharts() {
  if (typeof document === 'undefined') return;
  injectCss();
  if (listening) return;
  listening = true;
  document.addEventListener('pointerdown', onDown, { passive: true });
  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerup', onUp, { passive: true });
  document.addEventListener('pointercancel', onCancel, { passive: true });
  document.addEventListener('pointerleave', onLeave, { capture: true, passive: true }); // non-bubbling: capture
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('keydown', onKey);
}
