// Tab "Mercati": the economy at a glance, in four pages chosen with the segmented control:
//   Panoramica — indices, government and AAA corporate bonds, commodities, currencies, crypto
//   Heatmap    — the stocks of an index by size and performance, grouped by sector
//   Curve      — government yield curves and a table of every country and maturity
//   Macro      — world map and ranking of inflation, central bank rates, GDP, unemployment, debt
// Public data from TradingView through the app's own /api/eco/* routes (js/eco.js): the last
// answers stay on the phone, so the pages also open offline.
import { S } from '../state.js';
import { ACTIONS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { eco } from '../eco.js';
import { esc, scrollToTop } from '../util.js';
import { prefs, PERIODS } from './eco-common.js';
import * as overview from './eco-overview.js';
import * as heatmap from './eco-heatmap.js';
import * as curves from './eco-curves.js';
import * as macro from './eco-macro.js';

const PAGES = {
  overview: { label: 'Panoramica', render: overview.renderOverview, wants: overview.wants },
  heatmap: { label: 'Heatmap', render: heatmap.renderHeatmap, wants: heatmap.wants },
  curves: { label: 'Curve', render: curves.renderCurves, wants: curves.wants },
  macro: { label: 'Macro', render: macro.renderMacro, wants: macro.wants },
};
const RECHECK_MS = 30e3;

function currentPage() {
  const p = prefs();
  if (!Object.hasOwn(PAGES, p.page)) p.page = 'overview';
  return PAGES[p.page];
}

export function renderMarket() {
  const p = prefs();
  const page = currentPage();
  return `<div class="page eco-page eco-${esc(p.page)}">
    <div class="page-head"><div><p class="eyebrow">Economia e mercati</p><h1 class="page-title">Mercati</h1></div></div>
    <div class="seg full eco-tabs" role="tablist" aria-label="Sezioni dei mercati">${Object.entries(PAGES).map(([k, pg]) => `<button type="button" role="tab" data-act="eco-page" data-page="${k}" aria-selected="${k === p.page}">${esc(pg.label)}</button>`).join('')}</div>
    <div class="eco-body">${page.render()}</div>
  </div>`;
}

// Download what the current page shows (only what is missing or old, unless force)
function ensure(force = false) {
  const list = currentPage().wants();
  return Promise.all(list.map((w) => eco.load(w.key, w.path, { maxAge: w.maxAge, force })));
}

// The refresh button in the header, while the Mercati tab is open
export async function refreshCurrent() {
  await ensure(true);
  const failed = currentPage().wants().filter((w) => eco.failure(w.key));
  if (!failed.length) app.toast('Dati aggiornati');
  else app.toast(failed.some((w) => eco.failure(w.key).offline) ? 'Sei offline: mostro gli ultimi dati salvati' : 'Aggiornamento non riuscito: riprova tra poco');
}

/* ---------- Actions ---------- */
Object.assign(ACTIONS, {
  'eco-page': (el) => {
    const p = prefs();
    if (!Object.hasOwn(PAGES, el.dataset.page) || p.page === el.dataset.page) return;
    p.page = el.dataset.page;
    app.render();
    scrollToTop();
  },
  'eco-period': (el) => {
    if (Object.hasOwn(PERIODS, el.dataset.period)) prefs().period = el.dataset.period;
    app.render();
  },
  'eco-quote': (el) => {
    if (el.dataset.t) app.pushSheet('ecoQuote', { t: el.dataset.t, label: el.dataset.label || '', dp: el.dataset.dp || '' });
  },
  'eco-crypto': (el) => {
    if (el.dataset.t) app.pushSheet('ecoCrypto', { t: el.dataset.t });
  },
  // A country of the government bond list: open its curve
  'eco-curve': (el) => {
    const p = prefs();
    const cc = el.dataset.cc;
    if (!cc) return;
    const list = (Array.isArray(p.ycCountries) ? p.ycCountries : []).filter((x) => x !== cc);
    p.ycCountries = [cc, ...list].slice(0, curves.MAX_CURVES);
    p.page = 'curves';
    app.closeSheets();
    app.render();
    scrollToTop();
  },
  'eco-retry': () => {
    ensure(true);
  },
  'yc-toggle': (el) => {
    const p = prefs();
    const cc = el.dataset.cc;
    if (!cc) return;
    const list = Array.isArray(p.ycCountries) ? [...p.ycCountries] : [];
    const i = list.indexOf(cc);
    if (i >= 0) {
      if (list.length === 1) {
        app.toast('Lascia almeno un Paese nel grafico');
        return;
      }
      list.splice(i, 1);
    } else {
      if (list.length >= curves.MAX_CURVES) {
        app.toast(`Al massimo ${curves.MAX_CURVES} Paesi insieme: togline uno prima`);
        return;
      }
      list.push(cc);
    }
    p.ycCountries = list;
    app.render();
  },
  'yc-compare': (el) => {
    prefs().ycCompare = el.dataset.v || 'none';
    app.render();
  },
});

// Logos come from our API: when one is missing, show the initial behind it
if (typeof document !== 'undefined') {
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.eco-logo, .hm-tile')) t.remove();
  }, true);
}

/* ---------- Sideways scroll positions ---------- */
// Every render rebuilds the page, so rows of chips, the highlights strip and the yield table would
// jump back to their start. Remember where each one (data-keep-x) was and put it back; the first time
// a row appears, bring its pressed chip into view instead.
const keepX = new Map();
if (typeof document !== 'undefined') {
  document.addEventListener('scroll', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.keepX) keepX.set(t.dataset.keepX, t.scrollLeft);
  }, true);
}

function revealPressed(row) {
  const cur = row.querySelector('[aria-pressed="true"]');
  if (!cur || row.scrollWidth <= row.clientWidth) return;
  const peek = 28;
  // Position of the chip inside the scrolling content of the row
  const left = cur.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
  const right = left + cur.getBoundingClientRect().width;
  if (right + peek > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.min(left - peek, right + peek - row.clientWidth);
  else if (left - peek < row.scrollLeft) row.scrollLeft = Math.max(0, left - peek);
}

function restoreSideways() {
  if (typeof document === 'undefined') return;
  for (const el of document.querySelectorAll('#view [data-keep-x]')) {
    if (keepX.has(el.dataset.keepX)) el.scrollLeft = keepX.get(el.dataset.keepX);
    else revealPressed(el);
  }
}

// After each render of the tab: sideways positions back, offline copy open, download what is missing or old
MOUNTS.push(() => {
  if (S.ui.tab !== 'market') return;
  restoreSideways();
  eco.init();
  ensure(false);
});

// While the tab stays open, keep the page fresh (each answer has its own age limit)
if (typeof window !== 'undefined' && typeof setInterval === 'function') {
  setInterval(() => {
    if (!S.loaded || S.ui.tab !== 'market' || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return;
    ensure(false);
  }, RECHECK_MS);
}
