// Mercati → Curve: government yield curves of the main countries, compared with each other and with
// the curve of a day, a week, a month or a year ago, plus a table with every country and maturity.
import { eco } from '../eco.js';
import { NAMES } from '../world.js';
import { curveChart, seriesColor } from '../charts.js';
import { esc, contentWidth, isDesktop } from '../util.js';
import { prefs, fmtNum, fmtPct, fmtBp, bpPill, flagSpan, stampLine, emptyState, finiteNum } from './eco-common.js';
import { curve, yieldAt, yieldBefore, EURO_AREA } from './eco-overview.js';

// Countries in the order of the chips (main economies first)
export const CURVE_COUNTRIES = ['IT', 'DE', 'US', 'FR', 'ES', 'GB', 'JP', 'CH', 'CN', 'CA', 'AU', 'NL', 'BE', 'AT', 'PT', 'GR', 'IE', 'FI', 'SE', 'NO', 'DK', 'NZ', 'KR'];
export const MAX_CURVES = 5;
const COMPARE = [['none', 'Nessuno'], ['1D', 'Ieri'], ['1W', '1 settimana fa'], ['1M', '1 mese fa'], ['YTD', 'Inizio anno'], ['1Y', '1 anno fa']];
const TABLE_TENORS = [3, 6, 12, 24, 36, 60, 84, 120, 240, 360];

export const tenorShort = (m) => (m < 12 ? `${m}M` : `${m / 12}A`);
export const tenorLong = (m) => (m < 12 ? `${m} ${m === 1 ? 'mese' : 'mesi'}` : `${m / 12} ${m === 12 ? 'anno' : 'anni'}`);
const countryName = (cc) => NAMES[cc] || cc;

export function wants() {
  return [{ key: 'yields', path: '/eco/yields', maxAge: 180e3 }];
}

// Selected countries that have data, in chip order
function selected(p) {
  const want = new Set(Array.isArray(p.ycCountries) ? p.ycCountries : []);
  return CURVE_COUNTRIES.filter((cc) => want.has(cc) && curve(cc));
}

// Slope of the curve: 10 years minus 2 years (3 months when there is no 2 years), in points
export function slopeOf(cc) {
  const ten = yieldAt(cc, 120);
  const short = yieldAt(cc, 24) || yieldAt(cc, 3);
  return ten && short ? ten.value - short.value : null;
}
const slopeText = (s) => (s === null ? '' : s > 0.25 ? 'Curva normale: i prestiti lunghi rendono di più.' : s < -0.25 ? 'Curva invertita: le scadenze brevi rendono di più, spesso succede prima di un rallentamento.' : 'Curva piatta: scadenze brevi e lunghe rendono quasi uguale.');

function chartBlock(list, p) {
  const months = [...new Set(list.flatMap((cc) => curve(cc).map((x) => x[0])))].sort((a, b) => a - b);
  const cats = months.map((m) => ({ short: tenorShort(m), long: tenorLong(m) }));
  const series = [];
  list.forEach((cc, k) => {
    const c = curve(cc);
    const at = new Map(c.map((x) => [x[0], x]));
    const color = seriesColor(k);
    series.push({ name: countryName(cc), color, values: months.map((m) => (at.has(m) ? at.get(m)[1] : null)) });
    if (p.ycCompare !== 'none') {
      const label = (COMPARE.find((x) => x[0] === p.ycCompare) || ['', ''])[1].toLowerCase();
      series.push({ name: `${countryName(cc)} · ${label}`, color, dash: true, width: 1.6, values: months.map((m) => (at.has(m) ? yieldBefore(at.get(m), p.ycCompare) : null)) });
    }
  });
  const w = Math.min(contentWidth(), isDesktop() ? 860 : 9999) - 32;
  const h = isDesktop() ? 320 : Math.round(Math.min(300, Math.max(220, w * 0.72)));
  // The chips above carry the country colors: the only key needed is solid (today) vs dashed (then)
  const compareLabel = (COMPARE.find((x) => x[0] === p.ycCompare) || ['', ''])[1].toLowerCase();
  const key = p.ycCompare !== 'none'
    ? `<div class="chart-legend eco-yc-key"><span class="chart-key"><i class="k-line" style="background:var(--ink-2)" aria-hidden="true"></i><span>Oggi</span></span><span class="chart-key"><i class="k-dash" style="border-top-color:var(--ink-2)" aria-hidden="true"></i><span>${esc(compareLabel)}</span></span></div>`
    : '';
  return `<div class="card eco-chart-card">
    ${curveChart('eco-yc', { cats, series, w, h, legend: false, yFormat: (v) => `${fmtNum(v, Math.abs(v) < 10 ? 1 : 0)}%`, tooltipValue: (v) => fmtPct(v, 3), ariaLabel: `Curva dei rendimenti: ${list.map(countryName).join(', ')}` })}
    ${key}
  </div>`;
}

function countryChips(p) {
  const on = new Set(selected(p));
  const order = selected(p);
  return `<div class="chips eco-cc-chips" role="group" aria-label="Paesi nel grafico" data-keep-x="yc-cc">${CURVE_COUNTRIES.filter((cc) => curve(cc)).map((cc) => {
    const k = order.indexOf(cc);
    return `<button class="chip" type="button" data-act="yc-toggle" data-cc="${cc}" aria-pressed="${on.has(cc)}">${on.has(cc) ? `<i class="eco-dot" style="background:${seriesColor(k)}" aria-hidden="true"></i>` : flagSpan(cc)}${esc(countryName(cc))}</button>`;
  }).join('')}</div>`;
}

function compareChips(p) {
  return `<div class="chips eco-compare" role="group" aria-label="Confronta con" data-keep-x="yc-cmp">${COMPARE.map(([k, label]) => `<button class="chip" type="button" data-act="yc-compare" data-v="${k}" aria-pressed="${p.ycCompare === k}">${esc(label)}</button>`).join('')}</div>`;
}

// One card per country in the chart: 10 and 2 years with today's change, slope, spread on the Bund
function statCards(list) {
  const bund = yieldAt('DE', 120);
  return `<div class="eco-yc-cards">${list.map((cc, k) => {
    const ten = yieldAt(cc, 120);
    const two = yieldAt(cc, 24);
    const s = slopeOf(cc);
    const spread = EURO_AREA.has(cc) && cc !== 'DE' && ten && bund ? (ten.value - bund.value) : null;
    const kpi = (label, value, extra = '') => `<div class="eco-yc-kpi"><span>${esc(label)}</span><b class="num">${value}</b>${extra}</div>`;
    return `<div class="eco-yc-card" style="--cc:${seriesColor(k)}">
      <div class="eco-yc-card-head"><i class="eco-dot" style="background:${seriesColor(k)}" aria-hidden="true"></i>${flagSpan(cc)}<b>${esc(countryName(cc))}</b></div>
      <div class="eco-yc-kpis">
        ${kpi('10 anni', ten ? fmtPct(ten.value) : '—', ten ? bpPill(ten.change) : '')}
        ${kpi('2 anni', two ? fmtPct(two.value) : '—', two ? bpPill(two.change) : '')}
        ${kpi('10A − 2A', s === null ? '—' : fmtBp(s, 0))}
        ${spread !== null ? kpi('Spread Bund', `${fmtNum(spread * 100, 0)} pb`) : ''}
      </div>
      ${s !== null ? `<p class="eco-yc-note">${esc(slopeText(s))}</p>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// Heat colors for the table: 7 steps from the lowest to the highest yield shown
function heatClass(v, lo, hi) {
  if (!finiteNum(v) || hi <= lo) return '';
  const k = Math.max(0, Math.min(6, Math.floor(((v - lo) / (hi - lo)) * 7)));
  return ` eco-heat${k}`;
}

function tableBlock(p) {
  const on = new Set(selected(p));
  const rows = CURVE_COUNTRIES.filter((cc) => curve(cc));
  const vals = rows.flatMap((cc) => TABLE_TENORS.map((m) => (yieldAt(cc, m) || {}).value).filter(finiteNum));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return `<section class="section eco-sec" aria-label="Confronta i rendimenti">
    <div class="sec-head"><h2>Confronta i rendimenti</h2></div>
    <div class="table-wrap eco-yc-table-wrap" data-keep-x="yc-table"><table class="table eco-yc-table">
      <thead><tr><th scope="col">Paese</th>${TABLE_TENORS.map((m) => `<th scope="col" class="num">${tenorShort(m)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((cc) => `<tr data-act="yc-toggle" data-cc="${cc}"${on.has(cc) ? ' class="on"' : ''}>
        <th scope="row"><button class="eco-yc-country" type="button" data-act="yc-toggle" data-cc="${cc}" aria-pressed="${on.has(cc)}">${flagSpan(cc)}<span>${esc(countryName(cc))}</span></button></th>
        ${TABLE_TENORS.map((m) => {
    const y = yieldAt(cc, m);
    return `<td class="num${heatClass(y && y.value, lo, hi)}">${y ? fmtNum(y.value, 2) : '<span class="muted">—</span>'}</td>`;
  }).join('')}
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="hint">Rendimenti annui in percentuale (M = mesi, A = anni). Più il colore è intenso, più il rendimento è alto. Tocca un Paese per aggiungerlo al grafico o toglierlo.</p>
  </section>`;
}

export function renderCurves() {
  const p = prefs();
  if (!eco.data('yields')) return emptyState('yields', { what: 'le curve dei rendimenti' });
  if (!COMPARE.some((x) => x[0] === p.ycCompare)) p.ycCompare = 'none';
  let list = selected(p);
  if (!list.length) {
    p.ycCountries = ['IT', 'DE', 'US'];
    list = selected(p);
  }
  return `${stampLine('yields')}
    <section class="section eco-sec" aria-label="Curva dei rendimenti">
      <div class="sec-head"><h2>Curva dei rendimenti</h2><span class="hint">Fino a ${MAX_CURVES} Paesi</span></div>
      ${countryChips(p)}
      ${chartBlock(list, p)}
      <div class="eco-compare-row"><span class="eco-compare-label">Confronta con</span>${compareChips(p)}</div>
      <p class="hint">Quanto rende ogni anno un titolo di Stato a seconda della scadenza. Le linee tratteggiate mostrano la curva del giorno scelto.</p>
    </section>
    ${statCards(list)}
    ${tableBlock(p)}`;
}

export const _test = { tenorShort, tenorLong, slopeOf };
