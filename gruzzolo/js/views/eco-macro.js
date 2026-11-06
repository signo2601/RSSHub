// Mercati → Macro: a world map colored by an economic indicator (inflation, central bank rate, GDP,
// GDP growth, unemployment, government debt) and the ranking of the countries of a group or continent.
// Tap a country on the map or in the list to see its numbers.
import { ACTIONS } from '../registry.js';
import { app } from '../app.js';
import { eco } from '../eco.js';
import { MAP_W, MAP_H, PATHS, POINTS, NAMES, CONTINENT, VIEWS } from '../world.js';
import { esc, icon, contentWidth, isDesktop, MONTHS } from '../util.js';
import { prefs, fmtNum, fmtPct, fmtBig, flagSpan, stampLine, emptyState, finiteNum } from './eco-common.js';

// [code, chip label, title, explanation, format, 6 thresholds between the 7 color steps]
export const INDICATORS = [
  ['IRYY', 'Inflazione', 'Inflazione', 'Quanto sono aumentati i prezzi al consumo in un anno.', 'pct1', [0, 2, 3, 5, 8, 15]],
  ['INTR', 'Tassi', 'Tasso della banca centrale', 'Il tasso ufficiale a cui la banca centrale presta denaro alle banche.', 'pct2', [1, 2, 3, 5, 8, 15]],
  ['GDP', 'PIL', 'Prodotto interno lordo', 'Il valore di beni e servizi prodotti in un anno, in dollari.', 'usd', [2e10, 1e11, 4e11, 1e12, 3e12, 1e13]],
  ['GDPYY', 'Crescita', 'Crescita del PIL', 'Di quanto è cresciuta l\'economia rispetto a un anno prima.', 'pct1', [-1, 0, 1, 2, 3.5, 5]],
  ['UR', 'Disoccupazione', 'Tasso di disoccupazione', 'Persone che cercano lavoro e non lo trovano, su tutta la forza lavoro.', 'pct1', [3, 5, 7, 10, 15, 25]],
  ['GDG', 'Debito/PIL', 'Debito pubblico / PIL', 'Il debito dello Stato in rapporto a quanto produce il Paese in un anno.', 'pct1', [30, 60, 90, 120, 150, 200]],
];
const G7 = ['CA', 'FR', 'DE', 'IT', 'JP', 'GB', 'US'];
const G20 = ['AR', 'AU', 'BR', 'CA', 'CN', 'FR', 'DE', 'IN', 'ID', 'IT', 'JP', 'KR', 'MX', 'RU', 'SA', 'ZA', 'TR', 'GB', 'US'];
const EURO = ['AT', 'BE', 'BG', 'HR', 'CY', 'EE', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PT', 'SK', 'SI', 'ES'];
const EU27 = [...EURO, 'CZ', 'DK', 'HU', 'PL', 'RO', 'SE'];
// [key, label, map view, members (null = by continent / every country)]
export const REGIONS = [
  ['g20', 'G20', 'world', G20],
  ['g7', 'G7', 'world', G7],
  ['euro', 'Area euro', 'europe', EURO],
  ['eu', 'Unione europea', 'europe', EU27],
  ['europe', 'Europa', 'europe', null],
  ['americas', 'Americhe', 'americas', null],
  ['asia', 'Asia', 'asia', null],
  ['africa', 'Africa', 'africa', null],
  ['oceania', 'Oceania', 'oceania', null],
  ['world', 'Mondo', 'world', null],
];
const STALE_YEARS = 3; // older observations are left out

export function wants() {
  return [{ key: 'macro', path: '/eco/macro', maxAge: 6 * 3600e3 }];
}

const indicator = (code) => INDICATORS.find((x) => x[0] === code) || INDICATORS[0];
const region = (key) => REGIONS.find((x) => x[0] === key) || REGIONS[0];
const countryName = (cc) => NAMES[cc] || cc;

function inRegion(cc, reg) {
  const [key, , , members] = reg;
  if (members) return members.includes(cc);
  if (key === 'world') return cc !== 'EU';
  return CONTINENT[cc] === key && cc !== 'EU';
}

// { cc: { value, prev, time } } of an indicator, without observations older than STALE_YEARS
export function valuesOf(code, nowMs = Date.now()) {
  const d = eco.data('macro');
  const m = d && d.data ? d.data[code] : null;
  const out = {};
  if (!m) return out;
  const oldest = nowMs / 1000 - STALE_YEARS * 365.25 * 86400;
  for (const [cc, row] of Object.entries(m)) {
    if (!Array.isArray(row) || !finiteNum(row[0])) continue;
    if (finiteNum(row[2]) && row[2] < oldest) continue;
    out[cc] = { value: row[0], prev: finiteNum(row[1]) ? row[1] : null, time: row[2] };
  }
  return out;
}

// Color step 0…6 of a value
export function step(v, thresholds) {
  if (!finiteNum(v)) return -1;
  let k = 0;
  while (k < thresholds.length && v >= thresholds[k]) k++;
  return k;
}

export function fmtValue(v, fmt) {
  if (!finiteNum(v)) return '—';
  if (fmt === 'usd') return fmtBig(v, '$');
  return fmtPct(v, fmt === 'pct2' ? 2 : 1);
}
function fmtDelta(v, prev, fmt) {
  if (!finiteNum(v) || !finiteNum(prev)) return '';
  const d = v - prev;
  if (fmt === 'usd') {
    if (!prev) return '';
    const r = (d / Math.abs(prev)) * 100;
    return `${r > 0 ? '▲' : r < 0 ? '▼' : '='} ${fmtNum(Math.abs(r), 1)}%`;
  }
  const dp = fmt === 'pct2' ? 2 : 1;
  const r = Math.round(d * 10 ** dp) / 10 ** dp;
  return r === 0 ? '= invariato' : `${r > 0 ? '▲' : '▼'} ${fmtNum(Math.abs(r), dp)} punti`;
}
// When the number refers to: annual figures show the year, the others the month
export function periodText(sec, code) {
  if (!finiteNum(sec)) return '';
  const d = new Date(sec * 1000);
  const y = d.getUTCFullYear();
  if (code === 'GDP' || code === 'GDG') return String(y);
  if (code === 'GDPYY') return `${Math.floor(d.getUTCMonth() / 3) + 1}° trim. ${y}`;
  return `${MONTHS[d.getUTCMonth()]} ${y}`;
}

/* ---------- Map ---------- */
function mapHtml(vals, ind, reg, sel) {
  const view = VIEWS[reg[2]] || VIEWS.world || [0, 0, MAP_W, MAP_H];
  const [vx, vy, vw, vh] = view;
  const pxW = Math.max(260, Math.min(contentWidth(), isDesktop() ? 900 : 9999) - 2);
  const pxH = Math.round(pxW * (vh / vw));
  const thresholds = ind[5];
  let paths = '';
  let selPath = '';
  for (const [cc, d] of Object.entries(PATHS)) {
    const v = vals[cc];
    const k = v ? step(v.value, thresholds) : -1;
    const member = inRegion(cc, reg);
    const cls = `mc-c${k >= 0 ? ` mc-s${k}` : ' mc-nd'}${member ? '' : ' mc-out'}`;
    const p = `<path class="${cls}" d="${d}" data-act="mc-sel" data-cc="${cc}"><title>${esc(countryName(cc))}${v ? `: ${esc(fmtValue(v.value, ind[4]))}` : ''}</title></path>`;
    if (cc === sel) selPath = `<path class="mc-sel-outline" d="${d}" pointer-events="none"/>`;
    paths += p;
  }
  // Countries too small for a shape (Singapore, Hong Kong, Malta…): a dot
  const r = (2.6 * vw) / pxW;
  let dots = '';
  for (const [cc, v] of Object.entries(vals)) {
    if (PATHS[cc] || !POINTS[cc] || !inRegion(cc, reg)) continue;
    const [x, y] = POINTS[cc];
    if (x < vx || x > vx + vw || y < vy || y > vy + vh) continue;
    const k = step(v.value, thresholds);
    dots += `<circle class="mc-dot mc-s${k}${cc === sel ? ' sel' : ''}" cx="${x}" cy="${y}" r="${r.toFixed(2)}" data-act="mc-sel" data-cc="${cc}"><title>${esc(countryName(cc))}: ${esc(fmtValue(v.value, ind[4]))}</title></circle>`;
  }
  return `<svg class="mc-map" viewBox="${vx} ${vy} ${vw} ${vh}" width="${pxW}" height="${pxH}" role="img" aria-label="Mappa: ${esc(ind[2])} per Paese">${paths}${selPath}${dots}</svg>`;
}

function legendHtml(ind) {
  const [, , , , fmt, t] = ind;
  const lab = (v) => (fmt === 'usd' ? fmtBig(v, '$').replace(' mila mld', 'k mld') : `${fmtNum(v, Number.isInteger(v) ? 0 : 1)}%`);
  const labels = [`< ${lab(t[0])}`, ...t.slice(0, -1).map((v, i) => `${lab(v)}–${lab(t[i + 1])}`), `≥ ${lab(t[t.length - 1])}`];
  return `<div class="mc-legend">${labels.map((l, k) => `<span class="mc-key"><i class="mc-s${k}" aria-hidden="true"></i>${esc(l)}</span>`).join('')}<span class="mc-key"><i class="mc-nd" aria-hidden="true"></i>n.d.</span></div>`;
}

function infoCard(cc, vals, ind, ranked, reg) {
  const v = vals[cc];
  const rank = ranked.findIndex((x) => x.cc === cc);
  const others = INDICATORS.filter((x) => x[0] !== ind[0]).map((x) => {
    const ov = valuesOf(x[0])[cc];
    return `<div class="stat"><span>${esc(x[2])}</span><b>${ov ? esc(fmtValue(ov.value, x[4])) : '—'}</b></div>`;
  }).join('');
  return `<div class="card mc-info" aria-live="polite">
    <div class="mc-info-head">${flagSpan(cc, 'lg')}<div><b>${esc(countryName(cc))}</b><span>${rank >= 0 ? `${rank + 1}° su ${ranked.length} · ${esc(reg[1])}` : esc(reg[1])}</span></div>
      <button class="icon-btn" type="button" data-act="mc-sel" data-cc="" aria-label="Chiudi">${icon('close')}</button></div>
    ${v ? `<div class="mc-info-value"><span class="price-big num">${esc(fmtValue(v.value, ind[4]))}</span><span class="muted">${esc(periodText(v.time, ind[0]))}</span></div>
      <p class="mc-info-prev">${v.prev !== null ? `Dato precedente ${esc(fmtValue(v.prev, ind[4]))} · ${esc(fmtDelta(v.value, v.prev, ind[4]))}` : ''}</p>` : '<p class="muted">Nessun dato per questo indicatore.</p>'}
    <div class="stats mc-info-stats">${others}</div>
  </div>`;
}

function rankRows(ranked, ind, sel) {
  return ranked.map(({ cc, v }, i) => `<button class="row eco-row mc-row" type="button" data-act="mc-sel" data-cc="${cc}" aria-pressed="${cc === sel}">
    <span class="mc-rank num">${i + 1}</span>${flagSpan(cc)}
    <span class="row-main"><span class="row-title">${esc(countryName(cc))}</span><span class="row-sub">${esc([periodText(v.time, ind[0]), v.prev !== null ? `prec. ${fmtValue(v.prev, ind[4])}` : ''].filter(Boolean).join(' · '))}</span></span>
    <span class="row-end"><span class="row-value num">${esc(fmtValue(v.value, ind[4]))}</span><span class="mc-delta">${esc(fmtDelta(v.value, v.prev, ind[4]))}</span></span>
  </button>`).join('');
}

export function renderMacro() {
  const p = prefs();
  const ind = indicator(p.mcInd);
  const reg = region(p.mcRegion);
  p.mcInd = ind[0];
  p.mcRegion = reg[0];
  const chips = `<div class="chips mc-ind-chips" role="group" aria-label="Indicatore">${INDICATORS.map(([code, label]) => `<button class="chip" type="button" data-act="mc-ind" data-v="${code}" aria-pressed="${code === ind[0]}">${esc(label)}</button>`).join('')}</div>
    <div class="chips mc-reg-chips" role="group" aria-label="Paesi">${REGIONS.map(([key, label]) => `<button class="chip" type="button" data-act="mc-region" data-v="${key}" aria-pressed="${key === reg[0]}">${esc(label)}</button>`).join('')}</div>`;
  if (!eco.data('macro')) return `${chips}${emptyState('macro', { what: 'gli indicatori economici' })}`;
  const vals = valuesOf(ind[0]);
  const ranked = Object.entries(vals).filter(([cc]) => inRegion(cc, reg)).map(([cc, v]) => ({ cc, v })).sort((a, b) => b.v.value - a.v.value);
  const sel = p.mcSel && (vals[p.mcSel] || PATHS[p.mcSel]) ? p.mcSel : null;
  p.mcSel = sel;
  const euro = reg[0] === 'euro' || reg[0] === 'eu' ? valuesOf(ind[0]).EU : null;
  return `${chips}
    <div class="mc-head"><h2>${esc(ind[2])}</h2><p class="hint">${esc(ind[3])}</p></div>
    <div class="card mc-card">${mapHtml(vals, ind, reg, sel)}${legendHtml(ind)}</div>
    ${sel ? infoCard(sel, vals, ind, ranked, reg) : '<p class="hint mc-tip">Tocca un Paese sulla mappa o nella classifica per vedere i suoi numeri.</p>'}
    ${stampLine('macro')}
    <section class="section eco-sec" aria-label="Classifica">
      <div class="sec-head"><h2>Classifica · ${esc(reg[1])}</h2><span class="hint">${ranked.length} Paesi</span></div>
      ${euro ? `<div class="list eco-list"><div class="row eco-row mc-agg">${flagSpan('EU')}<span class="row-main"><span class="row-title">Area euro nel complesso</span><span class="row-sub">${esc(periodText(euro.time, ind[0]))}</span></span><span class="row-end"><span class="row-value num">${esc(fmtValue(euro.value, ind[4]))}</span></span></div></div>` : ''}
      ${ranked.length ? `<div class="list eco-list">${rankRows(ranked, ind, sel)}</div>` : '<div class="empty compact"><p>Nessun dato per questi Paesi.</p></div>'}
    </section>
    <p class="hint eco-foot">Dati delle statistiche nazionali raccolti da TradingView: ogni Paese pubblica con tempi diversi, per questo le date cambiano. Mappa: Natural Earth; nomi dei Paesi: mledoze/countries (ODbL).</p>`;
}

/* ---------- Actions ---------- */
Object.assign(ACTIONS, {
  'mc-ind': (el) => {
    const p = prefs();
    if (INDICATORS.some((x) => x[0] === el.dataset.v)) p.mcInd = el.dataset.v;
    app.render();
  },
  'mc-region': (el) => {
    const p = prefs();
    if (REGIONS.some((x) => x[0] === el.dataset.v)) p.mcRegion = el.dataset.v;
    app.render();
  },
  'mc-sel': (el) => {
    const p = prefs();
    const cc = el.dataset.cc || null;
    p.mcSel = cc && cc !== p.mcSel ? cc : null;
    app.render();
  },
});

export const _test = { valuesOf, step, fmtValue, periodText, inRegion, REGIONS, INDICATORS };
