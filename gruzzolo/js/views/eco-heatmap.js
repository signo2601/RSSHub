// Mercati → Heatmap: the stocks of an index as rectangles sized by market cap (or all equal) and
// colored by the change over the chosen period, grouped by sector. Tap a sector name to zoom in,
// a stock for its details; below, the sectors and the best and worst stocks as lists.
import { SHEETS, ACTIONS } from '../registry.js';
import { app } from '../app.js';
import { eco } from '../eco.js';
import { nestedTreemap, squarify } from '../treemap.js';
import { esc, icon, contentWidth, isDesktop } from '../util.js';
import { prefs, periodSeg, periodLong, periodField, fmtNum, fmtPct, fmtPctSigned, fmtBig, chgPill, flagSpan, stampLine, emptyState, finiteNum } from './eco-common.js';
import { logoImg, quote, wants as overviewWants } from './eco-overview.js';

// [key, name, country, region, ticker of the index in the Panoramica quotes, weighting]
// Dow Jones and Nikkei 225 weigh their stocks by price, the others by (free-float) market cap. The Nikkei
// also applies a per-stock adjustment factor TradingView does not publish: its weights are estimates.
export const INDEXES = [
  ['SPX', 'S&P 500', 'US', 'America', 'SP:SPX', 'cap'],
  ['NDX', 'Nasdaq 100', 'US', 'America', 'NASDAQ:NDX', 'cap'],
  ['DJI', 'Dow Jones', 'US', 'America', 'DJ:DJI', 'price'],
  ['FTSEMIB', 'FTSE MIB', 'IT', 'Europa', 'TVC:FTMIB', 'cap'],
  ['SX5E', 'Euro Stoxx 50', 'EU', 'Europa', 'TVC:SX5E', 'cap'],
  ['SXXP', 'Stoxx Europe 600', 'EU', 'Europa', 'TVC:SXXP', 'cap'],
  ['DAX', 'DAX 40', 'DE', 'Europa', 'TVC:DEU40', 'cap'],
  ['CAC', 'CAC 40', 'FR', 'Europa', 'TVC:CAC40', 'cap'],
  ['IBEX', 'IBEX 35', 'ES', 'Europa', 'TVC:IBEX35', 'cap'],
  ['AEX', 'AEX', 'NL', 'Europa', 'EURONEXT:AEX', 'cap'],
  ['SMI', 'SMI', 'CH', 'Europa', 'SIX:SMI', 'cap'],
  ['UKX', 'FTSE 100', 'GB', 'Europa', 'TVC:UKX', 'cap'],
  ['NI225', 'Nikkei 225', 'JP', 'Asia', 'TVC:NI225', 'price'],
  ['HSI', 'Hang Seng', 'HK', 'Asia', 'TVC:HSI', 'cap'],
  ['CSI300', 'CSI 300', 'CN', 'Asia', 'SSE:000300', 'cap'],
];
export const HM_PERIODS = ['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y'];
// Change (in %) that gets the strongest color, by period
export const SCALE = { '1D': 3, '1W': 6, '1M': 10, '3M': 15, '6M': 20, YTD: 25, '1Y': 30 };

// TradingView sectors in Italian
export const SECTORS_IT = {
  'Electronic Technology': 'Tecnologia elettronica',
  'Technology Services': 'Servizi tecnologici',
  Finance: 'Finanza',
  'Health Technology': 'Tecnologia sanitaria',
  'Retail Trade': 'Commercio al dettaglio',
  'Consumer Non-Durables': 'Beni non durevoli',
  'Consumer Durables': 'Beni durevoli',
  'Energy Minerals': 'Energia',
  'Producer Manufacturing': 'Manifattura',
  'Consumer Services': 'Servizi al consumo',
  Transportation: 'Trasporti',
  'Health Services': 'Servizi sanitari',
  'Process Industries': 'Industria di processo',
  'Industrial Services': 'Servizi industriali',
  'Commercial Services': 'Servizi commerciali',
  'Distribution Services': 'Distribuzione',
  Communications: 'Telecomunicazioni',
  Utilities: 'Servizi di pubblica utilità',
  'Non-Energy Minerals': 'Minerali non energetici',
  Miscellaneous: 'Varie',
  Government: 'Governo',
};
export const sectorName = (s) => SECTORS_IT[s] || s || 'Altro';

const COL = { symbol: 0, name: 1, sector: 2, industry: 3, mcap: 4, price: 5, ccy: 6, chg: 7, w: 8, m1: 9, m3: 10, m6: 11, ytd: 12, y: 13, logo: 14 };
const indexInfo = (key) => INDEXES.find((x) => x[0] === key) || INDEXES[0];
const keyOf = (index) => `heatmap:${index}`;

// The constituents, plus the Panoramica quotes for the real change of the index itself
export function wants() {
  const p = prefs();
  const index = indexInfo(p.hmIndex)[0];
  return [{ key: keyOf(index), path: `/eco/heatmap?index=${index}`, maxAge: 150e3 }, overviewWants()[0]];
}

// Stocks of the current index: [{ s, ticker, name, sector, industry, mcap, price, ccy, perf, logo, row }]
function stocks(index) {
  const d = eco.data(keyOf(index));
  if (!d || !Array.isArray(d.rows)) return null;
  return d.rows.map((r) => ({
    s: r[COL.symbol],
    ticker: String(r[COL.symbol]).split(':').pop(),
    name: r[COL.name],
    sector: r[COL.sector] || 'Miscellaneous',
    industry: r[COL.industry],
    mcap: r[COL.mcap],
    price: r[COL.price],
    ccy: r[COL.ccy],
    logo: r[COL.logo],
    row: r,
  }));
}
const perfOf = (st, period) => st.row[COL[periodField(period)]];

// Color bucket −4…+4 (n4…p4) of a change in percent, for the period's scale
export function bucket(v, period) {
  if (!finiteNum(v)) return 'na';
  const k = Math.max(-4, Math.min(4, Math.round((v / (SCALE[period] || 3)) * 4)));
  return k > 0 ? `p${k}` : k < 0 ? `n${-k}` : '0';
}

// Weight of a stock in its index: market cap, or the price for price-weighted indices (Dow, Nikkei)
const weightOf = (st, mode) => (mode === 'price' ? st.price : st.mcap);

// Weighted average change of a list (what the group as a whole did)
export function weightedChange(list, period, mode = 'cap') {
  let sw = 0;
  let s = 0;
  for (const st of list) {
    const v = perfOf(st, period);
    const wt = weightOf(st, mode);
    if (!finiteNum(v) || !(wt > 0)) continue;
    sw += wt;
    s += wt * v;
  }
  return sw > 0 ? s / sw : null;
}
// Share of each stock in the index (0…1), with the index's own weighting
export function weightShare(st, all, mode = 'cap') {
  const total = all.reduce((s, x) => s + (weightOf(x, mode) > 0 ? weightOf(x, mode) : 0), 0);
  const wt = weightOf(st, mode);
  return total > 0 && wt > 0 ? wt / total : null;
}

/* ---------- The map ---------- */
function mapSize() {
  // Desktop: as wide as the Mercati column (max 980px, css/markets.css)
  const w = Math.max(280, Math.floor(Math.min(contentWidth(), isDesktop() ? 980 : Infinity)));
  const h = isDesktop() ? Math.round(Math.min(720, w * 0.56)) : Math.round(Math.max(400, Math.min(680, w * 1.3)));
  return { w, h };
}

// Text of a tile, sized to fit: ticker and change, the logo when there is room
function tileInner(st, x, w, h, v) {
  if (w < 30 || h < 22) return '';
  const label = st.ticker.length > 8 ? st.ticker.slice(0, 7) + '…' : st.ticker;
  let fs = Math.min(Math.sqrt(w * h) / 5.2, 30, (w - 8) / (label.length * 0.64));
  // text under 10px cannot be read on a phone: such tiles show only their colour (tap for details)
  if (fs < 10) return '';
  const pctFs = fs * 0.72;
  const withPct = pctFs >= 10 && h >= fs * 2.3 && w >= 34;
  const logo = st.logo && w >= 62 && h >= 74 && fs >= 12 ? `<img class="hm-logo" src="${esc(eco.logoUrl(st.logo))}" alt="" loading="lazy" decoding="async" style="width:${Math.round(Math.min(w, h) * 0.3)}px;height:${Math.round(Math.min(w, h) * 0.3)}px">` : '';
  return `${logo}<span class="hm-t" style="font-size:${fs.toFixed(1)}px">${esc(label)}</span>${withPct ? `<span class="hm-p" style="font-size:${pctFs.toFixed(1)}px">${esc(fmtPctSigned(v))}</span>` : ''}`;
}

function tileHtml(st, r, period) {
  const v = perfOf(st, period);
  const w = Math.max(0, r.w - 1);
  const h = Math.max(0, r.h - 1);
  if (w < 0.5 || h < 0.5) return '';
  return `<button class="hm-tile hm-${bucket(v, period)}" type="button" data-act="hm-stock" data-s="${esc(st.s)}" style="left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px" aria-label="${esc(`${st.name}: ${fmtPctSigned(v)}`)}">${tileInner(st, r.x, w, h, v)}</button>`;
}

function mapHtml(list, p, period) {
  const { w, h } = mapSize();
  const value = p.hmSize === 'equal' ? () => 1 : (st) => st.mcap;
  let inner = '';
  if (p.hmSector || !p.hmGroup) {
    for (const r of squarify(list, { x: 0, y: 0, w, h }, value)) inner += tileHtml(r.item, r, period);
  } else {
    const groups = new Map();
    for (const st of list) {
      if (!groups.has(st.sector)) groups.set(st.sector, []);
      groups.get(st.sector).push(st);
    }
    const layout = nestedTreemap([...groups].map(([key, items]) => ({ key, items })), { x: 0, y: 0, w, h }, { value, header: 21, minHeaderW: 70, minHeaderH: 64, gap: 3 });
    for (const g of layout) {
      for (const t of g.tiles) inner += tileHtml(t.item, t, period);
      if (g.header) {
        inner += `<button class="hm-sector" type="button" data-act="hm-sector" data-sector="${esc(g.key)}" style="left:${g.x.toFixed(1)}px;top:${g.y.toFixed(1)}px;width:${Math.max(0, g.w - 1).toFixed(1)}px;height:${g.header - 1}px"><span>${esc(sectorName(g.key))}</span>${icon('chevRight')}</button>`;
      }
    }
  }
  return `<div class="hm" style="width:${w}px;height:${h}px" role="group" aria-label="Heatmap: tocca un titolo per i dettagli">${inner}</div>`;
}

function legendHtml(period) {
  const s = SCALE[period] || 3;
  const steps = ['n4', 'n3', 'n2', 'n1', '0', 'p1', 'p2', 'p3', 'p4'];
  const labels = [-s, -s / 2, 0, s / 2, s];
  return `<div class="hm-legend" aria-hidden="true"><div class="hm-legend-bar">${steps.map((k) => `<i class="hm-${k}"></i>`).join('')}</div>
    <div class="hm-legend-labels">${labels.map((v) => `<span>${v === 0 ? '0%' : fmtPctSigned(v, Number.isInteger(v) ? 0 : 1)}</span>`).join('')}</div></div>`;
}

/* ---------- Lists under the map ---------- */
function sectorRows(list, period, mode) {
  const total = list.reduce((s, st) => s + (weightOf(st, mode) > 0 ? weightOf(st, mode) : 0), 0);
  const groups = new Map();
  for (const st of list) {
    if (!groups.has(st.sector)) groups.set(st.sector, []);
    groups.get(st.sector).push(st);
  }
  const rows = [...groups].map(([key, items]) => ({ key, items, weight: items.reduce((s, st) => s + (weightOf(st, mode) > 0 ? weightOf(st, mode) : 0), 0) / (total || 1), chg: weightedChange(items, period, mode) }))
    .sort((a, b) => (b.chg ?? -Infinity) - (a.chg ?? -Infinity));
  return rows.map((g) => `<button class="row eco-row hm-sec-row" type="button" data-act="hm-sector" data-sector="${esc(g.key)}">
    <span class="hm-swatch hm-${bucket(g.chg, period)}" aria-hidden="true"></span>
    <span class="row-main"><span class="row-title">${esc(sectorName(g.key))}</span><span class="row-sub">${g.items.length} ${g.items.length === 1 ? 'titolo' : 'titoli'} · peso ${fmtPct(g.weight * 100, 1)}</span></span>
    <span class="row-end">${chgPill(g.chg)}</span>
  </button>`).join('');
}

function moverRows(list, period, best) {
  const withV = list.filter((st) => finiteNum(perfOf(st, period)));
  withV.sort((a, b) => (best ? perfOf(b, period) - perfOf(a, period) : perfOf(a, period) - perfOf(b, period)));
  return withV.slice(0, 5).map((st) => `<button class="row eco-row" type="button" data-act="hm-stock" data-s="${esc(st.s)}">
    ${logoImg(st.logo, st.ticker, 'round')}
    <span class="row-main"><span class="row-title">${esc(st.name)}</span><span class="row-sub">${esc(st.ticker)} · ${esc(sectorName(st.sector))}</span></span>
    <span class="row-end"><span class="row-value num">${fmtNum(st.price)} <small>${esc(st.ccy || '')}</small></span>${chgPill(perfOf(st, period))}</span>
  </button>`).join('');
}

/* ---------- Page ---------- */
export function renderHeatmap() {
  const p = prefs();
  const [index, indexName, cc, , indexTicker, mode] = indexInfo(p.hmIndex);
  p.hmIndex = index;
  const period = HM_PERIODS.includes(p.hmPeriod) ? p.hmPeriod : '1D';
  const all = stocks(index);
  const controls = `<div class="eco-toolbar hm-toolbar">
      <button class="pill-btn hm-index-btn" type="button" data-act="hm-index-picker" aria-haspopup="dialog">${flagSpan(cc)}<span>${esc(indexName)}</span>${icon('chevDown')}</button>
      <span class="hm-toolbar-gap"></span>
      <button class="chip hm-chip" type="button" data-act="hm-group" aria-pressed="${Boolean(p.hmGroup)}" title="Raggruppa le aziende per settore">${icon('layers')}Settori</button>
      <button class="chip hm-chip" type="button" data-act="hm-size" data-v="${p.hmSize === 'equal' ? 'cap' : 'equal'}" aria-pressed="${p.hmSize === 'equal'}" title="Rettangoli tutti uguali invece che grandi quanto il valore dell'azienda">${icon('grid')}Uguali</button>
    </div>
    ${periodSeg(HM_PERIODS, period, 'hm-period', 'Variazione su')}`;
  if (!all) return `${controls}${emptyState(keyOf(index), { what: `i titoli del ${indexName}` })}`;

  const sectorKey = p.hmSector && all.some((st) => st.sector === p.hmSector) ? p.hmSector : null;
  p.hmSector = sectorKey;
  const list = sectorKey ? all.filter((st) => st.sector === sectorKey) : all;
  const up = list.filter((st) => perfOf(st, period) > 0.005).length;
  const down = list.filter((st) => perfOf(st, period) < -0.005).length;
  // The whole index: its real change from the Panoramica quotes; a sector: the weighted average
  const idx = quote(indexTicker);
  const real = !sectorKey && idx ? idx[{ chg: 1, w: 3, m1: 4, m3: 5, m6: 6, ytd: 7, y: 8 }[periodField(period)]] : null;
  const avg = finiteNum(real) ? real : weightedChange(list, period, mode);
  const avgTitle = finiteNum(real) ? `Variazione del ${indexName}` : `Media delle variazioni pesata ${mode === 'price' ? 'sul prezzo, come l\'indice' : 'sulla capitalizzazione'}`;
  const crumb = sectorKey
    ? `<div class="hm-crumb"><button class="link-btn" type="button" data-act="hm-sector" data-sector="">${icon('chevLeft')}Tutti i settori</button><b>${esc(sectorName(sectorKey))}</b></div>`
    : '';
  return `${controls}
    ${stampLine(keyOf(index), { note: `Variazioni ${esc(periodLong(period))}` })}
    ${crumb}
    <div class="hm-wrap">${mapHtml(list, p, period)}</div>
    ${legendHtml(period)}
    <div class="hm-summary">
      <div><span>In rialzo</span><b class="up num">${up}</b></div>
      <div><span>In ribasso</span><b class="down num">${down}</b></div>
      <div title="${esc(avgTitle)}"><span>${sectorKey ? 'Settore' : 'Indice'}</span><b class="num">${avg === null ? '—' : fmtPctSigned(avg)}</b></div>
    </div>
    ${sectorKey ? '' : `<section class="section eco-sec" aria-label="Settori"><div class="sec-head"><h2>Settori</h2><span class="hint">Tocca per ingrandire</span></div><div class="list eco-list">${sectorRows(all, period, mode)}</div></section>`}
    <section class="section eco-sec" aria-label="I migliori"><div class="sec-head"><h2>I migliori</h2></div><div class="list eco-list">${moverRows(list, period, true)}</div></section>
    <section class="section eco-sec" aria-label="I peggiori"><div class="sec-head"><h2>I peggiori</h2></div><div class="list eco-list">${moverRows(list, period, false)}</div></section>
    <p class="hint eco-foot">Ogni rettangolo è un'azienda: più è grande, più l'azienda vale in Borsa (capitalizzazione). Verde se è salita, rosso se è scesa.${mode === 'price' ? ` Il ${esc(indexName)} però pesa le aziende in base al prezzo dell'azione: pesi dei settori e media seguono questa regola.` : ''} Dati TradingView, in ritardo fino a 15 minuti.</p>`;
}

/* ---------- Sheets ---------- */
SHEETS.hmIndexPicker = () => {
  const p = prefs();
  const groups = ['Europa', 'America', 'Asia'];
  return {
    title: 'Scegli l\'indice',
    body: groups.map((g) => `<p class="eco-group-label">${esc(g)}</p><div class="list">${INDEXES.filter((x) => x[3] === g).map(([key, name, cc]) => `<button class="row" type="button" data-act="hm-index" data-v="${key}" aria-pressed="${p.hmIndex === key}">
      ${flagSpan(cc, 'lg')}<span class="row-main"><span class="row-title">${esc(name)}</span></span>
      ${p.hmIndex === key ? `<span class="check-ico">${icon('check')}</span>` : ''}</button>`).join('')}</div>`).join(''),
  };
};

SHEETS.hmStock = (args = {}) => {
  const p = prefs();
  const [index, indexName, , , , mode] = indexInfo(p.hmIndex);
  const all = stocks(index) || [];
  const st = all.find((x) => x.s === args.s);
  if (!st) return { title: 'Titolo', body: '<div class="empty compact"><p>Dati non disponibili.</p></div>' };
  const share = weightShare(st, all, mode);
  const perf = [['Oggi', 'chg'], ['1 settimana', 'w'], ['1 mese', 'm1'], ['3 mesi', 'm3'], ['6 mesi', 'm6'], ['Da inizio anno', 'ytd'], ['1 anno', 'y']];
  const [exchange] = String(st.s).split(':');
  return {
    title: st.ticker,
    body: `<div class="eco-sheet">
      <div class="detail-head">${logoImg(st.logo, st.ticker, 'round lg')}<div class="detail-title"><h3>${esc(st.name)}</h3><div class="tags"><span class="tag">${esc(st.ticker)}</span><span class="tag">${esc(exchange)}</span></div></div></div>
      <div class="quote-price"><div class="price-big num">${fmtNum(st.price)} <small>${esc(st.ccy || '')}</small></div><div class="price-change">${chgPill(st.row[COL.chg])} <span class="muted">oggi</span></div></div>
      <div class="stats eco-stats">
        <div class="stat"><span>Capitalizzazione</span><b>${fmtBig(st.mcap * 1e6, '$')}</b></div>
        <div class="stat"><span>Peso nel ${esc(indexName)}${index === 'NI225' ? ' (stima)' : ''}</span><b>${share === null ? '—' : fmtPct(share * 100, 2)}</b></div>
        <div class="stat"><span>Settore</span><b>${esc(sectorName(st.sector))}</b></div>
        <div class="stat"><span>Attività</span><b>${esc(st.industry || '—')}</b></div>
      </div>
      <h3 class="eco-sheet-h">Andamento</h3>
      <div class="eco-perf-grid">${perf.map(([label, f]) => `<div class="eco-perf"><span>${esc(label)}</span>${chgPill(st.row[COL[f]])}</div>`).join('')}</div>
      <p class="hint">Capitalizzazione in dollari.${mode === 'price' ? ` Il ${esc(indexName)} pesa le aziende in base al prezzo dell'azione, non alla capitalizzazione.` : ''} Fonte TradingView, con un ritardo fino a 15 minuti.</p>
    </div>`,
  };
};

/* ---------- Actions ---------- */
Object.assign(ACTIONS, {
  'hm-index-picker': () => app.pushSheet('hmIndexPicker'),
  'hm-index': (el) => {
    const p = prefs();
    const key = el.dataset.v;
    if (INDEXES.some((x) => x[0] === key)) {
      p.hmIndex = key;
      p.hmSector = null;
    }
    app.closeSheets();
    app.render();
  },
  'hm-period': (el) => {
    const p = prefs();
    if (HM_PERIODS.includes(el.dataset.period)) p.hmPeriod = el.dataset.period;
    app.render();
  },
  'hm-size': (el) => {
    prefs().hmSize = el.dataset.v === 'equal' ? 'equal' : 'cap';
    app.render();
  },
  'hm-group': () => {
    const p = prefs();
    p.hmGroup = !p.hmGroup;
    p.hmSector = null;
    app.render();
  },
  'hm-sector': (el) => {
    const p = prefs();
    p.hmSector = el.dataset.sector || null;
    app.render();
    const wrap = typeof document !== 'undefined' ? document.querySelector('.hm-wrap') : null;
    if (wrap && typeof wrap.scrollIntoView === 'function') wrap.scrollIntoView({ block: 'nearest' });
  },
  'hm-stock': (el) => {
    if (el.dataset.s) app.pushSheet('hmStock', { s: el.dataset.s });
  },
});

export const _test = { bucket, weightedChange, weightShare, sectorName, stocks };
