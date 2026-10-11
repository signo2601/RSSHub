// Modal sheets of the portfolio: asset detail ('asset'), asset editor ('assetForm'),
// transaction detail ('tx') and form ('txForm'), manual prices ('prices').
// Form sheets are never re-rendered while open: their live behavior (asset search, prefilled
// prices and exchange rates, totals, validation) works directly on the DOM of the open sheet.
import {
  S, D, asset, account, accName, scopeIds, assetCode, setPrice, commit, incomeLabel,
  TYPE_KEYS, TYPE_LABEL, SECTORS, REGIONS, CURRENCIES, FEE_KINDS, TAX_KINDS,
} from '../state.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, FORM_SHEETS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { priceSeries, priceOn, fxOn, lastQuote, positions, sortTxns, assetHistory, historyFor } from '../engine.js';
import { searchCatalog, findInCatalog } from '../catalog.js';
import { lineChart } from '../charts.js';
import {
  esc, icon, fmt, money, moneySigned, moneyLocal, priceFmt, pct, pctSigned, pctPlain, num, qtyFmt, numInput, parseNum,
  fmtDate, fmtTime, tone, todayISO, addDays, addMonths, newId, debounce, isDesktop, iso, compact,
} from '../util.js';
import { avatar, pctPill, txRow, unitFor, txLabel, txAmount, txFx, feeKindLabel, taxKindLabel } from './home.js';

/* ======================================================================
   Shared helpers (also used by market.js)
   ====================================================================== */
const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const topSheet = () => S.sheets[S.sheets.length - 1] || null;
const isTop = (name, pred = () => true) => {
  const t = topSheet();
  return Boolean(t && t.name === name && pred(t.args || {}));
};
const sheetBody = () => (typeof document !== 'undefined' ? document.getElementById('sheet-body') : null);

// Inner width of the sheet body (matches the paddings of css/app.css)
export function sheetInnerWidth(wide = false) {
  if (typeof document === 'undefined') return 320;
  const vw = document.documentElement.clientWidth || window.innerWidth || 390;
  if (isDesktop()) return (wide ? 880 : 560) - 2 - 44;
  return Math.max(240, Math.min(vw, 640) - 32);
}

// Ticker shown for a Yahoo symbol: 'VWCE.DE' → 'VWCE', 'BTC-EUR' → 'BTC'
export const tickerOf = (symbol) => String(symbol || '').replace(/\.[A-Z]{1,4}$/, '').replace(/-(USD|EUR|GBP|CHF)$/, '').replace(/=X$/, '').replace(/^\^/, '');

const SUFFIX_CCY = {
  MI: 'EUR', DE: 'EUR', F: 'EUR', BE: 'EUR', DU: 'EUR', MU: 'EUR', SG: 'EUR', HM: 'EUR', PA: 'EUR', AS: 'EUR', BR: 'EUR', MC: 'EUR', LS: 'EUR',
  VI: 'EUR', HE: 'EUR', IR: 'EUR', L: 'GBP', IL: 'USD', SW: 'CHF', TO: 'CAD', V: 'CAD', AX: 'AUD', T: 'JPY', HK: 'HKD', ST: 'SEK', OL: 'NOK',
  CO: 'DKK', SS: 'CNY', SZ: 'CNY',
};
// Best guess of the quote currency from the Yahoo symbol (confirmed later by the price history)
export function guessCurrency(symbol) {
  const s = String(symbol || '').toUpperCase();
  const pair = s.match(/-([A-Z]{3})$/);
  if (pair) return pair[1];
  const m = s.match(/\.([A-Z]{1,3})$/);
  if (m) return SUFFIX_CCY[m[1]] || 'EUR';
  return 'USD';
}
const SECTOR_IT = {
  technology: 'Tecnologia', 'financial services': 'Finanza', financial: 'Finanza', healthcare: 'Sanità', 'consumer defensive': 'Beni di consumo',
  'consumer cyclical': 'Beni voluttuari', industrials: 'Industria', energy: 'Energia', utilities: 'Utility', 'basic materials': 'Materiali',
  'real estate': 'Immobiliare', 'communication services': 'Telecomunicazioni',
};
const mapSector = (s) => SECTOR_IT[String(s || '').toLowerCase()] || (SECTORS.includes(s) ? s : '');
function guessRegion(symbol, type) {
  if (type !== 'stock') return '';
  const m = String(symbol || '').toUpperCase().match(/\.([A-Z]{1,3})$/);
  if (!m) return 'USA';
  if (m[1] === 'MI') return 'Italia';
  if (['T', 'HK', 'SS', 'SZ', 'KS', 'TW'].includes(m[1])) return 'Asia';
  if (['TO', 'V', 'AX'].includes(m[1])) return 'Altro';
  return 'Europa';
}

// Last close at or before a date in a History (with the latest quote), or null
export function closeOn(h, date) {
  if (!h || !Array.isArray(h.dates) || !h.dates.length) return null;
  if (h.price > 0 && h.time && iso(new Date(h.time)) <= date && iso(new Date(h.time)) >= h.dates[h.dates.length - 1]) return h.price;
  let lo = 0;
  let hi = h.dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h.dates[mid] <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && h.close[ans] > 0 ? h.close[ans] : null;
}

// Price points of a History ([[date, close]], plus the latest quote when newer)
export function historyPoints(h) {
  if (!h || !Array.isArray(h.dates)) return [];
  const pts = [];
  for (let i = 0; i < h.dates.length; i++) if (h.close[i] > 0) pts.push([h.dates[i], h.close[i]]);
  if (h.price > 0 && h.time) {
    const qd = iso(new Date(h.time));
    if (!pts.length || qd > pts[pts.length - 1][0]) pts.push([qd, h.price]);
    else if (qd === pts[pts.length - 1][0]) pts[pts.length - 1] = [qd, h.price];
  }
  return pts;
}

const roundPrice = (p) => Number(p.toFixed(p < 1 ? 4 : p < 20 ? 3 : 2));
const roundFx = (r) => Number(r.toFixed(r >= 20 ? 2 : 4));

export const PRICE_RANGES = [['1M', '1M', 1], ['6M', '6M', 6], ['1A', '1A', 12], ['5A', '5A', 60], ['MAX', 'Max', 0]];
const PRICE_RANGE_TEXT = { '1M': "nell'ultimo mese", '6M': 'negli ultimi 6 mesi', '1A': "nell'ultimo anno", '5A': 'negli ultimi 5 anni' };

// Price chart with its range chips (asset and quote sheets). points: [[date, price]] sorted.
export function priceChartBlock({ id, points, range, ccy = 'EUR', act, w, h = 180, today = todayISO() }) {
  const r = PRICE_RANGES.find((x) => x[0] === range) || PRICE_RANGES[2];
  const chips = `<div class="chips range-chips" role="group" aria-label="Periodo del grafico">${PRICE_RANGES.map(([k, l]) => `<button class="chip" type="button" data-act="${esc(act)}" data-range="${k}" aria-pressed="${k === r[0]}">${l}</button>`).join('')}</div>`;
  const start = r[2] ? addMonths(today, -r[2]) : null;
  let pts = points;
  if (start) {
    const i = points.findIndex((p) => p[0] >= start);
    pts = i < 0 ? [] : points.slice(Math.max(0, i - 1));
  }
  if (pts.length < 2) {
    return `<div class="price-chart"><p class="chart-note">${points.length < 2 ? 'Non ci sono ancora abbastanza prezzi per disegnare il grafico.' : 'Nessun prezzo in questo periodo: prova un periodo più lungo.'}</p>${points.length >= 2 ? chips : ''}</div>`;
  }
  const first = pts[0][1];
  const last = pts[pts.length - 1][1];
  const ret = first > 0 ? last / first - 1 : null;
  const color = ret === null || ret >= 0 ? 'var(--up)' : 'var(--down)';
  const chart = lineChart(id, {
    dates: pts.map((p) => p[0]),
    series: [{ name: 'Prezzo', color, values: pts.map((p) => p[1]), area: true, width: 2 }],
    w, h, legend: false,
    yFormat: (v) => compact(v),
    tooltipValue: (v) => priceFmt(v, ccy),
    ariaLabel: 'Andamento del prezzo',
  });
  const when = PRICE_RANGE_TEXT[r[0]] || `dal ${fmtDate(pts[0][0])}`;
  return `<div class="price-chart">
    <p class="price-chart-head">${ret === null ? '' : `<span class="${tone(ret, 0.00005)}">${pctSigned(ret)}</span> `}<span class="muted">${esc(when)}</span></p>
    <div class="chart-box">${chart}</div>
    ${chips}
  </div>`;
}

const stat = (label, value, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${value}</b></div>`;

/* ======================================================================
   Asset detail
   ====================================================================== */
const isLinked = (a) => Boolean(a && a.symbol && (a.priceSource === 'auto' || a.priceSource === 'demo'));

function sourceLine(a, q, today) {
  if (a.type === 'cash') return '';
  const h = assetHistory(a);
  if (q && q.source === 'market') {
    if (a.priceSource === 'demo') return `Prezzo simulato del ${fmtDate(q.date)} · dati di esempio`;
    if (q.date === today && h && h.time) return `Prezzo da Yahoo Finance · ${fmtTime(h.time)}`;
    return `Prezzo da Yahoo Finance · chiusura del ${fmtDate(q.date)}`;
  }
  if (isLinked(a) && a.priceSource === 'auto' && !h) {
    if (market.status === 'offline') return `Server prezzi non raggiungibile${q ? `: uso il prezzo del ${fmtDate(q.date)}` : ''}`;
    return 'Carico i prezzi da Yahoo Finance…';
  }
  if (q && q.source === 'manual') return `Prezzo manuale del ${fmtDate(q.date)}`;
  if (q && q.source === 'trade') return `Prezzo dell'ultima operazione (${fmtDate(q.date)}): aggiornalo a mano o collega il titolo a Yahoo Finance`;
  return 'Nessun prezzo: inseriscilo a mano qui sotto';
}

function assetTags(a) {
  const tags = [TYPE_LABEL[a.type] || 'Altro', assetCode(a), a.exchange, a.currency, a.sector, a.region, a.ter > 0 ? `TER ${pct(a.ter, 2)}` : '', a.isin]
    .filter(Boolean);
  return [...new Set(tags)].map((t) => `<span class="tag">${esc(t)}</span>`).join('');
}

function priceForm(a, q, today) {
  const ccy = a.currency || 'EUR';
  return `<form class="form price-form" data-form="price-one" data-aid="${esc(a.id)}" novalidate>
    <div class="grid2">
      <div class="field"><label for="po-price">Prezzo (${esc(ccy)})</label><input id="po-price" name="price" inputmode="decimal" autocomplete="off" placeholder="${q ? esc(numInput(roundPrice(q.price))) : '0,00'}"></div>
      <div class="field"><label for="po-date">Del giorno</label><input id="po-date" name="date" type="date" value="${today}" max="${today}"></div>
    </div>
    <p class="form-error" data-error hidden></p>
    <button class="btn block" type="submit">${icon('check')}Salva prezzo</button>
  </form>`;
}

SHEETS.asset = (args = {}) => {
  const aid = args.aid;
  const a = D().assets[aid];
  if (!a) return { title: 'Titolo', body: '<div class="empty"><p>Questo titolo non esiste più.</p><button class="btn" type="button" data-act="back-sheet">Indietro</button></div>' };
  const today = todayISO();
  const ids = scopeIds();
  let pos = positions({ accIds: ids }).find((p) => p.aid === aid) || null;
  let scopedNote = '';
  if (!pos && ids) {
    pos = positions({}).find((p) => p.aid === aid) || null;
    if (pos) scopedNote = '<p class="hint">Non è nel conto scelto: mostro i dati di tutti i conti.</p>';
  }
  const ccy = a.currency || 'EUR';
  const cash = a.type === 'cash';
  const q = lastQuote(aid);
  const own = sortTxns(D().txns.filter((t) => t.aid === aid)).reverse();

  // Price block
  let priceBlock = '';
  if (!cash) {
    const change = q && q.prev > 0 && q.date ? `${pctPill(q.changePct)} <span class="muted num">${q.change >= 0 ? '+' : '−'}${priceFmt(Math.abs(q.change), ccy)}</span>` : '';
    priceBlock = `<div class="quote-price">
      <div class="price-big num">${q ? priceFmt(q.price, ccy) : '—'}</div>
      <div class="price-change">${change}</div>
    </div>
    <p class="src-line">${esc(sourceLine(a, q, today))}</p>`;
  }

  // Chart
  let chartBlock = '';
  if (!cash) {
    const pts = priceSeries(aid);
    if (pts.length >= 2) chartBlock = priceChartBlock({ id: 'asset-chart', points: pts, range: args.range || '1A', ccy, act: 'pf-asset-range', w: sheetInnerWidth(), today });
    else if (isLinked(a) && a.priceSource === 'auto' && !assetHistory(a) && market.status !== 'offline') chartBlock = '<div class="skeleton chart-skel" aria-label="Carico il grafico"></div>';
  }

  // Position
  let stats = '';
  if (pos && (pos.qty > 0 || own.length)) {
    const nonEur = ccy !== 'EUR';
    const avg = pos.qty > 0 ? `${moneyLocal(pos.avgLocal, ccy)}${nonEur ? ` · ${money(pos.avgEUR)}` : ''}` : '—';
    const unit = unitFor(a);
    stats = `<div class="stats pos-stats">
      ${cash ? stat('Saldo', money(pos.value)) : stat('Quantità', `${qtyFmt(pos.qty)}${unit ? ' ' + esc(unit) : ''}`) + stat('Prezzo medio di carico', avg)}
      ${stat('Valore', money(pos.value))}
      ${stat('Capitale investito', money(pos.cost))}
      ${pos.qty > 0 ? stat('Plus/minus latente', `${moneySigned(pos.unreal)} (${pctSigned(pos.unrealPct)})`, tone(pos.unreal)) : ''}
      ${nonEur && pos.qty > 0 ? stat('di cui effetto cambio', moneySigned(pos.fxPL), tone(pos.fxPL)) : ''}
      ${stat('Plus/minus realizzata', moneySigned(pos.realized), tone(pos.realized))}
      ${stat(a.type === 'bond' ? 'Cedole incassate' : cash ? 'Interessi' : 'Dividendi incassati', money(pos.income))}
      ${stat('Commissioni', money(pos.fees))}
      ${pos.taxes > 0 ? stat('Imposte', money(pos.taxes)) : ''}
      ${pos.qty > 0 ? stat('Peso nel portafoglio', pctPlain(pos.weight)) : ''}
      ${pos.accounts.length ? stat(pos.accounts.length === 1 ? 'Conto' : 'Conti', esc(pos.accounts.map(accName).join(', '))) : ''}
    </div>
    ${nonEur && pos.qty > 0 ? `<p class="hint">Il titolo è quotato in ${esc(ccy)}: l'effetto cambio è la parte del risultato dovuta al movimento dell'euro.</p>` : ''}
    ${scopedNote}`;
  }

  const held = pos && pos.qty > 0;
  const incomeWord = a.type === 'bond' ? 'Cedola' : cash ? 'Interessi' : 'Dividendo';
  const actions = `<div class="btn-row asset-actions">
    <button class="btn primary" type="button" data-act="add-tx" data-aid="${esc(aid)}" data-type="buy">${icon('plus')}Compra</button>
    ${held ? `<button class="btn" type="button" data-act="add-tx" data-aid="${esc(aid)}" data-type="sell">${icon('upArrow')}Vendi</button>` : ''}
    ${held ? `<button class="btn" type="button" data-act="add-tx" data-aid="${esc(aid)}" data-type="div">${icon('euro')}${incomeWord}</button>` : ''}
  </div>`;

  let manual = '';
  if (!cash) {
    manual = isLinked(a)
      ? `<details class="disclosure"><summary>${icon('edit')}Inserisci un prezzo a mano</summary>
          <p class="hint">Un prezzo inserito a mano vale per quel giorno al posto di quello di Yahoo Finance.</p>${priceForm(a, q, today)}</details>`
      : `<section class="section"><div class="sec-head"><h2>Aggiorna il prezzo</h2></div>
          <p class="hint">Questo titolo non è collegato a Yahoo Finance: aggiorna il prezzo quando cambia, oppure collegalo da “Modifica”.</p>${priceForm(a, q, today)}</section>`;
  }

  const txList = own.length
    ? `<div class="list">${own.slice(0, 50).map((t) => txRow(t, { showAsset: false, showAcc: new Set(own.map((x) => x.acc)).size > 1 })).join('')}</div>${own.length > 50 ? `<p class="hint">Mostro le 50 operazioni più recenti su ${own.length}.</p>` : ''}`
    : '<p class="muted">Nessuna operazione registrata su questo titolo.</p>';

  return {
    title: TYPE_LABEL[a.type] || 'Titolo',
    body: `<div class="detail-head">${avatar(a, 'lg')}<div class="detail-title"><h3>${esc(a.name)}</h3><div class="tags">${assetTags(a)}</div></div></div>
      ${priceBlock}
      ${chartBlock}
      ${stats}
      ${actions}
      ${manual}
      <div class="group-label">Operazioni</div>
      ${txList}
      <div class="btn-row sheet-foot-actions">
        <button class="btn" type="button" data-act="edit-asset" data-aid="${esc(aid)}">${icon('edit')}Modifica</button>
        <button class="btn danger" type="button" data-act="delete-asset" data-aid="${esc(aid)}">${icon('trash')}Elimina</button>
      </div>`,
    after: () => {
      // Linked asset without (enough) market history: download it once, then show it
      if (!a.symbol || a.priceSource !== 'auto' || args.histTried) return;
      const h = market.getHistory(a.symbol);
      if (h && !h.synthetic && (h.fullAt || h.dates.length >= 60)) return;
      args.histTried = true;
      const before = market.version;
      market.ensureHistory(a.symbol).then(() => {
        if (market.version !== before && isTop('asset', (x) => x.aid === aid)) app.renderSheet();
      }).catch(() => {});
    },
  };
};

/* ======================================================================
   Asset editor (link to Yahoo Finance, classification, TER, price source)
   ====================================================================== */
SHEETS.assetForm = (args = {}) => {
  const a = D().assets[args.aid];
  if (!a) return { title: 'Modifica titolo', body: '<p class="muted">Questo titolo non esiste più.</p>' };
  const dr = args.draft || null;
  const v = (name, fallback) => (dr && name in dr ? dr[name] : fallback);
  const symbol = v('symbol', a.symbol || '');
  const source = v('priceSource', a.priceSource === 'manual' || !a.symbol ? 'manual' : 'auto');
  const type = v('type', a.type || 'other');
  const sector = v('sector', a.sector || '');
  const region = v('region', a.region || '');
  const ccy = v('currency', a.currency || 'EUR');
  const ccys = CURRENCIES.includes(ccy) ? CURRENCIES : [...CURRENCIES, ccy];
  const hasTx = D().txns.some((t) => t.aid === a.id);
  const radio = (val, label) => `<label><input type="radio" name="priceSource" value="${val}"${source === val ? ' checked' : ''}><span class="seg-lbl">${label}</span></label>`;
  return {
    title: 'Modifica titolo',
    body: `<form class="form" data-form="pf-asset" data-aid="${esc(a.id)}" data-input="pf-af" novalidate>
      <div class="field"><label for="af-name">Nome</label><input id="af-name" name="name" value="${esc(v('name', a.name))}" autocomplete="off"></div>
      <div class="grid2">
        <div class="field"><label for="af-ticker">Ticker</label><input id="af-ticker" name="ticker" value="${esc(v('ticker', a.ticker || ''))}" autocomplete="off" autocapitalize="characters" placeholder="Es. VWCE"></div>
        <div class="field"><label for="af-isin">ISIN</label><input id="af-isin" name="isin" value="${esc(v('isin', a.isin || ''))}" autocomplete="off" autocapitalize="characters" placeholder="Facoltativo"></div>
      </div>
      <div class="fieldset" role="group" aria-labelledby="af-link-title">
        <div class="fieldset-title" id="af-link-title">Prezzo automatico da Yahoo Finance</div>
        <input type="hidden" name="symbol" value="${esc(symbol)}">
        <input type="hidden" name="exchange" value="${esc(v('exchange', a.exchange || ''))}">
        <div class="linked-line" id="af-linked">${linkedLine(symbol, v('exchange', a.exchange || ''))}</div>
        <div class="field combo">
          <label for="af-q">${symbol ? 'Cambia il collegamento' : 'Cerca il titolo per collegarlo'}</label>
          <div class="search-box sm">${icon('search')}<input id="af-q" name="q" type="search" data-input="pf-af-search" value="${esc(v('q', ''))}" placeholder="Nome, ticker o ISIN" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></div>
          <div class="combo-results" id="af-results"></div>
        </div>
        <div class="field"><span class="label">Da dove arriva il prezzo</span>
          <div class="seg full" role="radiogroup" aria-label="Fonte del prezzo">${radio('auto', 'Automatico')}${radio('manual', 'Lo inserisco io')}</div>
          <span class="hint" id="af-source-hint">${source === 'auto' ? 'Il prezzo si aggiorna da solo con Yahoo Finance.' : 'Aggiorni tu il prezzo dalla scheda del titolo.'}</span>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label for="af-type">Tipo</label><select id="af-type" name="type">${TYPE_KEYS.map((k) => opt(k, TYPE_LABEL[k], k === type)).join('')}</select></div>
        <div class="field"><label for="af-ccy">Valuta</label><select id="af-ccy" name="currency">${ccys.map((c) => opt(c, c, c === ccy)).join('')}</select></div>
      </div>
      ${hasTx ? '<p class="hint">Attenzione: i prezzi delle operazioni sono nella valuta del titolo. Cambia la valuta solo se era sbagliata.</p>' : ''}
      <div class="grid2">
        <div class="field"><label for="af-sector">Settore</label><select id="af-sector" name="sector">${opt('', '—', !sector)}${SECTORS.map((s) => opt(s, s, s === sector)).join('')}</select></div>
        <div class="field"><label for="af-region">Regione</label><select id="af-region" name="region">${opt('', '—', !region)}${REGIONS.map((s) => opt(s, s, s === region)).join('')}</select></div>
      </div>
      <div class="field"><label for="af-ter">TER (costo annuo dell'ETF o del fondo, %)</label><input id="af-ter" name="ter" inputmode="decimal" autocomplete="off" placeholder="Es. 0,22" value="${esc(v('ter', a.ter > 0 ? numInput(+(a.ter * 100).toFixed(4)) : ''))}"><span class="hint">Lo trovi nella scheda del fondo (KID). Lascia vuoto per le azioni.</span></div>
      <p class="form-error" data-error hidden></p>
      <button class="btn primary block" type="submit">Salva</button>
    </form>`,
    after: (body) => {
      const q = body.querySelector('#af-q');
      enterPicksFirst('af', q);
      if (q && q.value.trim()) runCombo('af', q);
    },
  };
};
FORM_SHEETS.add('assetForm');

function linkedLine(symbol, exchange) {
  if (!symbol) return `<span class="muted">${icon('alert')}Non collegato: il prezzo va inserito a mano.</span>`;
  return `<span class="linked-ok">${icon('check')}Collegato a <b>${esc(symbol)}</b>${exchange ? ` · ${esc(exchange)}` : ''}</span>
    <button class="link-btn" type="button" data-act="pf-af-unlink">Scollega</button>`;
}

INPUTS['pf-af'] = (form, ev) => {
  const t = ev.target;
  if (t && t.name === 'priceSource') {
    const hint = form.querySelector('#af-source-hint');
    if (hint) hint.textContent = t.value === 'auto' ? 'Il prezzo si aggiorna da solo con Yahoo Finance.' : 'Aggiorni tu il prezzo dalla scheda del titolo.';
  }
};

ACTIONS['pf-af-unlink'] = (el) => {
  const form = el.closest('form');
  if (!form) return;
  form.elements.symbol.value = '';
  form.elements.exchange.value = '';
  const manual = form.querySelector('input[name="priceSource"][value="manual"]');
  if (manual) manual.checked = true;
  form.querySelector('#af-linked').innerHTML = linkedLine('', '');
  INPUTS['pf-af'](form, { target: manual || form });
};

function setAfLink(form, item) {
  const el = form.elements;
  el.symbol.value = item.symbol;
  el.exchange.value = item.exchange || '';
  if (!el.name.value.trim()) el.name.value = item.name || item.symbol;
  if (!el.ticker.value.trim()) el.ticker.value = tickerOf(item.symbol);
  if (item.isin && !el.isin.value.trim()) el.isin.value = item.isin;
  if (item.type && TYPE_KEYS.includes(item.type)) el.type.value = item.type;
  if (item.currency) {
    if (![...el.currency.options].some((o) => o.value === item.currency)) el.currency.insertAdjacentHTML('beforeend', opt(item.currency, item.currency, false));
    el.currency.value = item.currency;
  }
  if (item.sector && !el.sector.value && SECTORS.includes(item.sector)) el.sector.value = item.sector;
  if (item.region && !el.region.value && REGIONS.includes(item.region)) el.region.value = item.region;
  if (item.ter > 0 && !el.ter.value.trim()) el.ter.value = numInput(+(item.ter * 100).toFixed(4));
  const auto = form.querySelector('input[name="priceSource"][value="auto"]');
  if (auto) auto.checked = true;
  INPUTS['pf-af'](form, { target: auto || form });
  form.querySelector('#af-linked').innerHTML = linkedLine(item.symbol, item.exchange);
  el.q.value = '';
  form.querySelector('#af-results').innerHTML = '';
  // Confirm the currency with the real price history
  if (!item.ccyOk && market.status !== 'offline') {
    market.ensureHistory(item.symbol).then((h) => {
      if (!h || !h.currency || !form.isConnected || el.symbol.value !== item.symbol) return;
      if (![...el.currency.options].some((o) => o.value === h.currency)) el.currency.insertAdjacentHTML('beforeend', opt(h.currency, h.currency, false));
      el.currency.value = h.currency;
    }).catch(() => {});
  }
}

FORMS['pf-asset'] = (form) => {
  const a = D().assets[form.dataset.aid];
  const showErr = formError(form);
  if (!a) return showErr('Questo titolo non esiste più.');
  const el = form.elements;
  const name = el.name.value.trim();
  if (!name) return showErr('Scrivi il nome del titolo.', el.name);
  let ter = null;
  if (el.ter.value.trim()) {
    const t = parseNum(el.ter.value);
    if (!(t >= 0) || t > 10) return showErr('Il TER è una percentuale tra 0 e 10, ad esempio 0,22.', el.ter);
    ter = t > 0 ? t / 100 : null;
  }
  const symbol = el.symbol.value.trim();
  let source = (form.querySelector('input[name="priceSource"]:checked') || {}).value === 'auto' ? 'auto' : 'manual';
  if (!symbol) source = 'manual';
  // Example assets keep their synthetic prices while the link does not change
  if (a.priceSource === 'demo' && source === 'auto' && symbol === a.symbol) source = 'demo';
  const changedLink = symbol !== (a.symbol || '') || (source === 'auto' && a.priceSource !== 'auto');
  Object.assign(a, {
    name,
    ticker: el.ticker.value.trim().toUpperCase(),
    isin: el.isin.value.trim().toUpperCase(),
    symbol,
    exchange: el.exchange.value.trim(),
    type: TYPE_KEYS.includes(el.type.value) ? el.type.value : 'other',
    currency: el.currency.value || 'EUR',
    sector: el.sector.value,
    region: el.region.value,
    ter,
    priceSource: source,
  });
  commit('Titolo aggiornato');
  app.popSheet();
  if (changedLink && source === 'auto') app.refreshPrices();
};

/* ======================================================================
   Asset search (combobox) shared by the transaction form and the asset editor
   ====================================================================== */
const combos = {}; // name → { items, q, gen }

function fromAsset(a) {
  return { kind: 'asset', aid: a.id, symbol: a.symbol || '', name: a.name, exchange: a.exchange || '', type: a.type, currency: a.currency || 'EUR', ccyOk: true };
}
function fromCatalog(c) {
  return {
    kind: 'catalog', symbol: c.symbol, name: c.name, exchange: c.exchange || '', type: c.type || 'other', currency: c.currency || guessCurrency(c.symbol),
    isin: c.isin || '', sector: c.sector || '', region: c.region || '', ter: c.ter ?? null, ccyOk: true,
  };
}
function fromSearch(r) {
  const cat = findInCatalog(r.symbol);
  if (cat && cat.symbol === r.symbol) return fromCatalog(cat);
  const h = market.getHistory(r.symbol);
  const type = TYPE_KEYS.includes(r.type) ? r.type : 'other';
  return {
    kind: 'market', symbol: r.symbol, name: r.name || r.symbol, exchange: r.exchange || '', type, typeDisp: r.typeDisp || '',
    currency: (h && h.currency) || guessCurrency(r.symbol), ccyOk: Boolean(h && h.currency),
    isin: '', sector: mapSector(r.sector), region: guessRegion(r.symbol, type), ter: null,
  };
}
// Pick for a symbol coming from the market tab (catalog, cached history or watchlist)
export function pickFromSymbol(symbol, extra = {}) {
  const cat = findInCatalog(symbol);
  if (cat && cat.symbol === symbol) return fromCatalog(cat);
  const h = historyFor(symbol);
  const w = D().watch.find((x) => x.symbol === symbol);
  const type = (h && TYPE_KEYS.includes(h.type) && h.type) || (TYPE_KEYS.includes(extra.type) && extra.type) || 'stock';
  return {
    kind: 'market', symbol, name: (h && h.name) || extra.name || (w && w.name) || symbol, exchange: (h && h.exchange) || extra.exchange || '',
    type, currency: (h && h.currency) || (w && w.currency) || guessCurrency(symbol), ccyOk: Boolean(h && h.currency),
    isin: '', sector: '', region: guessRegion(symbol, type), ter: null,
  };
}

const assetBySymbol = (symbol) => (symbol ? Object.values(D().assets).find((a) => a.symbol === symbol) || null : null);

function localAssetMatches(q) {
  const k = q.trim().toLowerCase();
  const list = Object.values(D().assets).filter((a) => a.type !== 'cash' || k);
  const held = new Set(positions({}).filter((p) => p.qty > 0).map((p) => p.aid));
  const hits = !k ? list : list.filter((a) => [a.name, a.ticker, a.symbol, a.isin].some((s) => s && String(s).toLowerCase().includes(k)));
  return hits.sort((x, y) => Number(held.has(y.id)) - Number(held.has(x.id)) || x.name.localeCompare(y.name, 'it'));
}

// Items of a combo for a query: own assets (transaction form only), catalog, Yahoo results
function comboItems(name, q, live = []) {
  const items = [];
  const seen = new Set();
  const add = (it) => {
    const key = it.kind === 'asset' ? 'a:' + it.aid : 's:' + it.symbol;
    if (seen.has(key) || (it.symbol && seen.has('s:' + it.symbol))) return;
    seen.add(key);
    if (it.symbol) seen.add('s:' + it.symbol);
    items.push(it);
  };
  if (name === 'tx') for (const a of localAssetMatches(q).slice(0, q ? 6 : 5)) add(fromAsset(a));
  if (q.trim()) {
    for (const c of searchCatalog(q, 8)) {
      const own = name === 'tx' ? assetBySymbol(c.symbol) : null;
      add(own ? fromAsset(own) : fromCatalog(c));
    }
    for (const r of live.slice(0, 12)) {
      const own = name === 'tx' ? assetBySymbol(r.symbol) : null;
      add(own ? fromAsset(own) : fromSearch(r));
    }
  }
  return items;
}

function itemRow(name, it, i) {
  const sub = it.kind === 'asset'
    ? [assetCode(asset(it.aid)), it.currency, 'già nel portafoglio'].filter(Boolean).join(' · ')
    : [it.symbol, it.exchange, it.typeDisp || TYPE_LABEL[it.type], it.currency && it.ccyOk ? it.currency : ''].filter(Boolean).join(' · ');
  const av = it.kind === 'asset' ? asset(it.aid) : { name: it.name, ticker: tickerOf(it.symbol), symbol: it.symbol, type: it.type };
  return `<button class="row result-row" type="button" role="option" data-act="pf-pick" data-combo="${name}" data-i="${i}">
    ${avatar(av, 'sm')}
    <span class="row-main"><span class="row-title">${esc(it.name)}</span><span class="row-sub">${esc(sub)}</span></span>
    ${it.kind === 'asset' ? '' : `<span class="tag">${it.kind === 'catalog' ? 'Catalogo' : 'Yahoo'}</span>`}
  </button>`;
}

function renderCombo(name, root, { pending = false } = {}) {
  const st = combos[name];
  const box = root && root.querySelector(name === 'tx' ? '#tx-results' : '#af-results');
  if (!box || !st) return;
  const q = st.q.trim();
  let html = st.items.map((it, i) => itemRow(name, it, i)).join('');
  let note = '';
  if (q && pending) note = '<p class="combo-note"><span class="dot busy"></span>Cerco su Yahoo Finance…</p>';
  else if (q && market.status === 'offline') note = '<p class="combo-note">Ricerca online non disponibile: mostro il catalogo.</p>';
  else if (q && !st.items.length) note = '<p class="combo-note">Nessun risultato. Prova con il ticker (es. VWCE) o l\'ISIN.</p>';
  if (name === 'tx' && (q || st.items.length)) {
    html += `<button class="row result-row manual-row" type="button" data-act="pf-pick" data-combo="tx" data-i="manual">
      <span class="tx-ico">${icon('edit')}</span>
      <span class="row-main"><span class="row-title">Titolo non quotato: inseriscilo a mano</span><span class="row-sub">Per fondi, polizze, obbligazioni o titoli che Yahoo non conosce</span></span></button>`;
  }
  if (!q && name === 'tx' && st.items.length) note = '<p class="combo-note">I tuoi titoli. Scrivi per cercarne altri.</p>';
  box.innerHTML = html ? `${note}<div class="list combo-list" role="listbox">${html}</div>` : note;
}

const liveSearch = debounce((name, q, gen) => {
  market.search(q).then((res) => {
    const st = combos[name];
    if (!st || st.gen !== gen) return;
    st.items = comboItems(name, st.q, res || []);
    renderCombo(name, sheetBody());
  }).catch(() => {
    const st = combos[name];
    if (st && st.gen === gen) renderCombo(name, sheetBody());
  });
}, 300);

function runCombo(name, input) {
  const q = input.value || '';
  const st = (combos[name] ||= { items: [], q: '', gen: 0 });
  st.q = q;
  st.gen++;
  st.items = comboItems(name, q);
  const online = market.status !== 'offline';
  const pending = Boolean(q.trim().length >= 2 && online);
  renderCombo(name, input.closest('form'), { pending });
  if (pending) liveSearch(name, q.trim(), st.gen);
}

INPUTS['pf-af-search'] = (input, ev) => {
  if (ev && ev.type === 'change') return;
  runCombo('af', input);
};
INPUTS['pf-tx-asset'] = (input, ev) => {
  if (ev && ev.type === 'change') return;
  runCombo('tx', input);
};

// Enter in a search field chooses the first result instead of submitting the form
function enterPicksFirst(name, input) {
  if (!input || input.dataset.enterBound) return;
  input.dataset.enterBound = '1';
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (input.value.trim()) pickFirst(name, input.closest('form'));
  });
}

function pickFirst(name, form) {
  const st = combos[name];
  if (st && st.items.length) choose(name, form, st.items[0]);
  else if (name === 'tx') choose('tx', form, 'manual');
}

function choose(name, form, item) {
  if (!form) return;
  if (name === 'af') setAfLink(form, item);
  else setTxAsset(form, item);
}

ACTIONS['pf-pick'] = (el) => {
  const name = el.dataset.combo;
  const form = el.closest('form');
  const st = combos[name];
  if (!form) return;
  if (el.dataset.i === 'manual') {
    choose(name, form, 'manual');
    return;
  }
  const item = st && st.items[Number(el.dataset.i)];
  if (item) choose(name, form, item);
};

/* ======================================================================
   Transaction detail
   ====================================================================== */
SHEETS.tx = (args = {}) => {
  const t = D().txns.find((x) => x.id === args.id);
  if (!t) return { title: 'Operazione', body: '<div class="empty"><p>Questa operazione non esiste più.</p><button class="btn" type="button" data-act="back-sheet">Indietro</button></div>' };
  const a = t.aid ? asset(t.aid) : null;
  const ccy = a ? a.currency || 'EUR' : 'EUR';
  const rows = [stat('Data', fmtDate(t.date)), stat('Conto', esc(accName(t.acc)))];
  const fee = +t.fee || 0;
  const fxFee = +t.fxFee || 0;
  const tax = +t.tax || 0;
  if (t.type === 'buy' || t.type === 'sell') {
    const fx = txFx(t);
    rows.push(stat('Quantità', qtyFmt(t.qty)), stat(`Prezzo (${esc(ccy)})`, priceFmt(t.price, ccy)));
    if (ccy !== 'EUR') rows.push(stat(`Cambio EUR/${esc(ccy)}`, `${num(fx, 4)}${t.fx > 0 ? '' : ' <small class="muted">(stimato)</small>'}`));
    rows.push(stat('Controvalore', money((t.qty * t.price) / fx)));
    rows.push(stat('Commissione', money(fee)));
    if (fxFee) rows.push(stat('Costo cambio (AutoFX)', money(fxFee)));
    if (t.type === 'sell') rows.push(stat('Imposte trattenute', money(tax)));
    rows.push(stat(t.type === 'buy' ? 'Totale pagato' : 'Totale incassato', money(Math.abs(txAmount(t)))));
  } else if (t.type === 'div') {
    rows.push(stat('Netto ricevuto', money(+t.amount || 0), 'up'), stat('Ritenuta', money(tax)));
    if (t.gross > 0) rows.push(stat('Lordo', money(t.gross)));
    if (fxFee) rows.push(stat('Costo cambio (AutoFX)', money(fxFee)));
  } else {
    rows.push(stat('Importo', money(+t.amount || 0), t.type === 'fee' || t.type === 'tax' ? 'down' : t.type === 'interest' ? 'up' : ''));
    if (t.type === 'fee') rows.push(stat('Tipo di costo', esc(feeKindLabel(t.kind))));
    if (t.type === 'tax') rows.push(stat('Tipo di imposta', esc(taxKindLabel(t.kind))));
    if (t.type === 'interest' && tax) rows.push(stat('Ritenuta', money(tax)));
  }
  if (t.ref) rows.push(stat('Riferimento', esc(t.ref)));
  if (t.src) rows.push(stat('Origine', 'Importata da file'));
  if (t.demo) rows.push(stat('Origine', 'Dati di esempio'));
  const head = a
    ? `<button class="row asset-link" type="button" data-act="open-asset" data-aid="${esc(t.aid)}">${avatar(a)}<span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc([assetCode(a), a.exchange, ccy].filter(Boolean).join(' · '))}</span></span><span class="chev-wrap">${icon('chevRight')}</span></button>`
    : '';
  return {
    title: txLabel(t),
    body: `${head}
      <div class="stats tx-stats">${rows.join('')}</div>
      ${t.note ? `<p class="tx-note">${esc(t.note)}</p>` : ''}
      <div class="btn-row sheet-foot-actions">
        <button class="btn" type="button" data-act="edit-tx" data-id="${esc(t.id)}">${icon('edit')}Modifica</button>
        <button class="btn danger" type="button" data-act="delete-tx" data-id="${esc(t.id)}">${icon('trash')}Elimina</button>
      </div>`,
  };
};

/* ======================================================================
   Transaction form
   ====================================================================== */
const MAIN_TYPES = [['buy', 'Acquisto'], ['sell', 'Vendita'], ['div', 'Dividendo']];
const OTHER_TYPES = [['deposit', 'Deposito'], ['withdraw', 'Prelievo'], ['interest', 'Interessi sulla liquidità'], ['fee', 'Commissione o costo'], ['tax', 'Imposta']];
const NEEDS_ASSET = new Set(['buy', 'sell', 'div']);
const OPTIONAL_ASSET = new Set(['fee', 'tax']);

function parsePick(s) {
  try {
    const p = JSON.parse(s || 'null');
    return p && typeof p === 'object' && p.symbol ? p : null;
  } catch {
    return null;
  }
}

// Quantity of an asset held in one account on a date, ignoring one transaction (the one being edited)
export function heldQty(acc, aid, date, excludeId = null) {
  let q = 0;
  for (const t of sortTxns(D().txns.filter((x) => x.acc === acc && x.aid === aid && x.id !== excludeId))) {
    if (t.date > date) break;
    if (t.type === 'buy') q += +t.qty || 0;
    else if (t.type === 'sell') q = Math.max(0, q - (+t.qty || 0));
  }
  return q;
}

function defaultAccount(args, editing) {
  if (editing) return editing.acc;
  if (args.acc && account(args.acc)) return args.acc;
  const ids = scopeIds();
  if (ids) return ids[0];
  // the account where the asset is held, else the first
  if (args.aid) {
    const t = D().txns.find((x) => x.aid === args.aid && (x.type === 'buy' || x.type === 'sell'));
    if (t && account(t.acc)) return t.acc;
  }
  return D().accounts[0] ? D().accounts[0].id : '';
}

SHEETS.txForm = (args = {}) => {
  const editing = args.id ? D().txns.find((t) => t.id === args.id) || null : null;
  const t = editing || {};
  const dr = args.draft || null;
  const v = (name, fallback) => (dr && name in dr ? dr[name] : fallback);
  const today = todayISO();
  const accs = D().accounts;

  // Type: buy / sell / div, or "other" with a select
  let type0 = editing ? t.type : args.type && [...MAIN_TYPES, ...OTHER_TYPES].some((x) => x[0] === args.type) ? args.type : 'buy';
  const isMain = MAIN_TYPES.some((x) => x[0] === type0);
  let kind = v('type', isMain ? type0 : 'other');
  let other = v('otherType', isMain ? 'deposit' : type0);
  if (!['buy', 'sell', 'div', 'other'].includes(kind)) kind = 'buy';
  if (!OTHER_TYPES.some((x) => x[0] === other)) other = 'deposit';
  type0 = kind === 'other' ? other : kind;
  const acc = v('acc', defaultAccount(args, editing));

  // Asset: existing id, a market/catalog pick, or a new manual asset
  let mode = '';
  let aid = '';
  let pick = null;
  if (dr) {
    mode = dr.mode || '';
    aid = dr.aid || '';
    pick = parsePick(dr.pick);
  } else if (editing && t.aid) {
    mode = 'asset';
    aid = t.aid;
  } else if (args.aid && D().assets[args.aid]) {
    mode = 'asset';
    aid = args.aid;
  } else if (args.symbol) {
    const own = assetBySymbol(args.symbol);
    if (own) {
      mode = 'asset';
      aid = own.id;
    } else {
      mode = 'pick';
      pick = pickFromSymbol(args.symbol, args);
    }
  }
  if (mode === 'asset' && !D().assets[aid]) mode = '';
  if (mode === 'pick' && !pick) mode = '';

  const typeRadio = ([k, label]) => `<label><input type="radio" name="type" value="${k}"${kind === k ? ' checked' : ''}><span class="seg-lbl" data-k="${k}">${label}</span></label>`;
  const num0 = (x) => (x === undefined || x === null || x === '' ? '' : numInput(x));
  const field = (name, fallback) => esc(v(name, fallback));
  const touched = (name) => (editing || (dr && dr[name]) ? ' data-touched="1"' : '');
  const amountFallback = editing && t.type !== 'buy' && t.type !== 'sell' ? num0(t.amount) : '';

  return {
    title: editing ? 'Modifica operazione' : 'Nuova operazione',
    body: `<form class="form tx-form" data-form="pf-tx" data-input="pf-tx" data-id="${esc(editing ? editing.id : '')}" novalidate>
      ${accs.length > 1
    ? `<div class="field"><label for="tx-acc">Conto</label><select id="tx-acc" name="acc">${accs.map((a) => opt(a.id, a.name + (a.broker && a.broker !== 'Altro' && a.broker !== a.name ? ` · ${a.broker}` : ''), a.id === acc)).join('')}</select></div>`
    : `<input type="hidden" name="acc" value="${esc(acc)}">`}
      <div class="field"><span class="label">Tipo di operazione</span>
        <div class="seg full type-seg" role="radiogroup" aria-label="Tipo di operazione">${[...MAIN_TYPES, ['other', 'Altro']].map(typeRadio).join('')}</div>
      </div>
      <div class="field" id="tx-other-f"${kind === 'other' ? '' : ' hidden'}><label for="tx-other">Quale operazione?</label>
        <select id="tx-other" name="otherType">${OTHER_TYPES.map(([k, l]) => opt(k, l, k === other)).join('')}</select>
        <span class="hint" id="tx-other-hint"></span>
      </div>

      <div class="field combo" id="tx-asset-f">
        <label for="tx-q" id="tx-asset-l">Titolo</label>
        <input type="hidden" name="mode" value="${esc(mode)}">
        <input type="hidden" name="aid" value="${esc(aid)}">
        <input type="hidden" name="pick" value="${esc(pick ? JSON.stringify(pick) : '')}">
        <div class="picked" id="tx-picked"></div>
        <div id="tx-search">
          <div class="search-box sm">${icon('search')}<input id="tx-q" name="q" type="search" data-input="pf-tx-asset" value="${field('q', '')}" placeholder="Nome, ticker o ISIN (es. VWCE, Enel)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></div>
          <div class="combo-results" id="tx-results"></div>
        </div>
      </div>
      <div class="fieldset" id="tx-manual" role="group" aria-labelledby="tx-manual-title" hidden>
        <div class="fieldset-title" id="tx-manual-title">Nuovo titolo non quotato</div>
        <div class="field"><label for="nm-name">Nome</label><input id="nm-name" name="nm_name" value="${field('nm_name', '')}" autocomplete="off" placeholder="Es. BTP Valore 2028"></div>
        <div class="grid2">
          <div class="field"><label for="nm-ticker">Ticker o ISIN</label><input id="nm-ticker" name="nm_ticker" value="${field('nm_ticker', '')}" autocomplete="off" autocapitalize="characters" placeholder="Facoltativo"></div>
          <div class="field"><label for="nm-type">Tipo</label><select id="nm-type" name="nm_type">${TYPE_KEYS.filter((k) => k !== 'cash').map((k) => opt(k, TYPE_LABEL[k], k === v('nm_type', 'bond'))).join('')}</select></div>
        </div>
        <div class="field"><label for="nm-ccy">Valuta del prezzo</label><select id="nm-ccy" name="nm_currency">${CURRENCIES.map((c) => opt(c, c, c === v('nm_currency', 'EUR'))).join('')}</select></div>
        <p class="hint">Il prezzo di questo titolo lo aggiorni tu dalla sua scheda.</p>
      </div>

      <div class="field"><label for="tx-date">Data</label><input id="tx-date" type="date" name="date" value="${field('date', t.date || today)}" max="${addDays(today, 365)}"></div>

      <div id="tx-trade" class="stack">
        <div class="grid2">
          <div class="field"><label for="tx-qty">Quantità</label><input id="tx-qty" name="qty" inputmode="decimal" autocomplete="off" placeholder="0" value="${field('qty', num0(t.qty))}"><span class="hint" id="tx-held"></span></div>
          <div class="field"><label for="tx-price" id="tx-price-l">Prezzo per quota</label><input id="tx-price" name="price" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('price', num0(t.price))}"${touched('price')}><span class="hint" id="tx-price-hint"></span></div>
        </div>
        <div class="field" id="tx-fx-f" hidden><label for="tx-fx" id="tx-fx-l">Cambio</label><input id="tx-fx" name="fx" inputmode="decimal" autocomplete="off" placeholder="1,1000" value="${field('fx', num0(t.fx))}"${touched('fx')}><span class="hint" id="tx-fx-hint"></span></div>
        <div class="grid2">
          <div class="field"><label for="tx-fee">Commissione (€)</label><input id="tx-fee" name="fee" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('fee', num0(t.fee))}"></div>
          <div class="field" id="tx-fxfee-f"><label for="tx-fxfee">Costo cambio (€)</label><input id="tx-fxfee" name="fxFee" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('fxFee', num0(t.fxFee))}"><span class="hint">AutoFX di DEGIRO</span></div>
        </div>
        <div class="field" id="tx-tax-f"><label for="tx-tax">Imposte trattenute (€)</label><input id="tx-tax" name="tax" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('tax', editing && t.type === 'sell' ? num0(t.tax) : '')}"><span class="hint">Il 26% sulla plusvalenza, se il broker te lo trattiene (regime amministrato)</span></div>
      </div>

      <div id="tx-div" class="stack">
        <div class="grid2">
          <div class="field"><label for="tx-net" id="tx-net-l">Netto ricevuto (€)</label><input id="tx-net" name="net" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('net', editing && t.type === 'div' ? num0(t.amount) : '')}"></div>
          <div class="field"><label for="tx-wht">Ritenuta (€)</label><input id="tx-wht" name="wht" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('wht', editing && t.type === 'div' ? num0(t.tax) : '')}"></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="tx-gross">Lordo (€, facoltativo)</label><input id="tx-gross" name="gross" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('gross', editing && t.type === 'div' ? num0(t.gross) : '')}"></div>
          <div class="field" id="tx-divfx-f"><label for="tx-divfx">Costo cambio (€)</label><input id="tx-divfx" name="divFxFee" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('divFxFee', editing && t.type === 'div' ? num0(t.fxFee) : '')}"></div>
        </div>
        <p class="hint">Netto: quanto è arrivato sul conto. Ritenuta: le tasse trattenute (estere e italiane).</p>
      </div>

      <div id="tx-amount-f" class="stack">
        <div class="field"><label for="tx-amount" id="tx-amount-l">Importo (€)</label><input id="tx-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${field('amount', amountFallback)}"></div>
        <div class="field" id="tx-feekind-f"><label for="tx-feekind">Tipo di costo</label><select id="tx-feekind" name="feeKind">${Object.entries(FEE_KINDS).map(([k, l]) => opt(k, l, k === v('feeKind', t.type === 'fee' ? t.kind || 'other' : 'transaction'))).join('')}</select></div>
        <div class="field" id="tx-taxkind-f"><label for="tx-taxkind">Tipo di imposta</label><select id="tx-taxkind" name="taxKind">${Object.entries(TAX_KINDS).map(([k, l]) => opt(k, l, k === v('taxKind', t.type === 'tax' ? t.kind || 'other' : 'stamp'))).join('')}</select></div>
      </div>

      <details class="disclosure"${(v('note', t.note || '') || v('ref', t.ref || '')) ? ' open' : ''}><summary>Nota e riferimento</summary>
        <div class="stack">
          <div class="field"><label for="tx-note">Nota</label><input id="tx-note" name="note" autocomplete="off" placeholder="Facoltativa" value="${field('note', t.note || '')}"></div>
          <div class="field"><label for="tx-ref">Riferimento ordine</label><input id="tx-ref" name="ref" autocomplete="off" placeholder="Numero d'ordine del broker, facoltativo" value="${field('ref', t.ref || '')}"></div>
        </div>
      </details>

      <div class="total-line"><span id="tx-total-l">Totale</span><strong id="tx-total" class="num">—</strong></div>
      <p class="form-error" data-error role="alert" hidden></p>
      <button class="btn primary block" type="submit">${editing ? 'Salva le modifiche' : 'Salva operazione'}</button>
    </form>`,
    after: (body) => {
      const form = body.querySelector('form[data-form="pf-tx"]');
      if (!form) return;
      showPicked(form);
      syncTxForm(form);
      if (!editing) prefill(form);
      const q = form.elements.q;
      enterPicksFirst('tx', q);
      if (q && !form.elements.mode.value) runCombo('tx', q);
    },
  };
};
FORM_SHEETS.add('txForm');

// Current choices of the transaction form
function txState(form) {
  const el = form.elements;
  const kind = (form.querySelector('input[name="type"]:checked') || {}).value || 'buy';
  const type = kind === 'other' ? el.otherType.value : kind;
  const mode = el.mode.value;
  let a = null;
  let pick = null;
  let aType = '';
  let ccy = 'EUR';
  if (mode === 'asset') {
    a = D().assets[el.aid.value] || null;
    aType = a ? a.type : '';
    ccy = (a && a.currency) || 'EUR';
  } else if (mode === 'pick') {
    pick = parsePick(el.pick.value);
    aType = pick ? pick.type : '';
    ccy = (pick && pick.currency) || 'EUR';
  } else if (mode === 'manual') {
    aType = el.nm_type.value;
    ccy = el.nm_currency.value || 'EUR';
  }
  return { kind, type, mode, a, pick, aType, ccy, acc: el.acc.value, date: el.date.value };
}

const val = (el) => (el && el.value.trim() ? parseNum(el.value) : NaN);
const setHidden = (form, sel, hidden) => {
  const n = form.querySelector(sel);
  if (n) n.hidden = hidden;
};
const setText = (form, sel, text) => {
  const n = form.querySelector(sel);
  if (n) n.textContent = text;
};

// Show the selected asset (or the search box) in the transaction form
function showPicked(form) {
  const st = txState(form);
  const box = form.querySelector('#tx-picked');
  const search = form.querySelector('#tx-search');
  const manual = form.querySelector('#tx-manual');
  let html = '';
  if (st.mode === 'asset' && st.a) {
    html = `${avatar(st.a, 'sm')}<span class="row-main"><span class="row-title">${esc(st.a.name)}</span><span class="row-sub">${esc([assetCode(st.a), st.a.exchange, st.ccy].filter(Boolean).join(' · '))}</span></span>`;
  } else if (st.mode === 'pick' && st.pick) {
    const p = st.pick;
    html = `${avatar({ name: p.name, ticker: tickerOf(p.symbol), symbol: p.symbol, type: p.type }, 'sm')}<span class="row-main"><span class="row-title">${esc(p.name)}</span><span class="row-sub">${esc([p.symbol, p.exchange, p.currency].filter(Boolean).join(' · '))} · nuovo, prezzi da Yahoo</span></span>`;
  }
  if (html) html += '<button class="btn sm" type="button" data-act="pf-tx-unpick">Cambia</button>';
  box.innerHTML = html;
  box.hidden = !html;
  search.hidden = Boolean(html) || st.mode === 'manual';
  manual.hidden = st.mode !== 'manual';
  if (st.mode === 'manual') {
    box.innerHTML = '<span class="row-main"><span class="row-title">Titolo non quotato</span><span class="row-sub">Compila i dati qui sotto</span></span><button class="btn sm" type="button" data-act="pf-tx-unpick">Cerca invece</button>';
    box.hidden = false;
  }
}

function setTxAsset(form, item) {
  const el = form.elements;
  if (item === 'manual') {
    el.mode.value = 'manual';
    el.aid.value = '';
    el.pick.value = '';
    const q = el.q.value.trim();
    if (q && !el.nm_name.value.trim()) el.nm_name.value = q;
  } else if (item.kind === 'asset') {
    el.mode.value = 'asset';
    el.aid.value = item.aid;
    el.pick.value = '';
  } else {
    el.mode.value = 'pick';
    el.aid.value = '';
    el.pick.value = JSON.stringify(item);
  }
  el.q.value = '';
  const results = form.querySelector('#tx-results');
  if (results) results.innerHTML = '';
  const price = el.price;
  if (price && price.dataset.auto === '1') price.dataset.touched = '';
  showPicked(form);
  syncTxForm(form);
  prefill(form);
  if (item === 'manual') {
    const n = form.querySelector('#nm-name');
    if (n && isDesktop()) n.focus();
  }
  // A Yahoo result: download its history to confirm the currency and prefill the price
  if (item !== 'manual' && item.kind !== 'asset' && item.symbol && !market.isDemoSymbol(item.symbol)) {
    const sym = item.symbol;
    const hasReal = market.getHistory(sym);
    if (!hasReal && market.status !== 'offline') {
      setText(form, '#tx-price-hint', 'Carico il prezzo…');
      market.ensureHistory(sym).then((h) => {
        if (!form.isConnected) return;
        const cur = parsePick(el.pick.value);
        if (!cur || cur.symbol !== sym) return;
        if (h) {
          Object.assign(cur, { currency: h.currency || cur.currency, ccyOk: Boolean(h.currency) || cur.ccyOk, name: cur.name || h.name, exchange: cur.exchange || h.exchange || '' });
          el.pick.value = JSON.stringify(cur);
          showPicked(form);
        }
        syncTxForm(form);
        prefill(form);
      }).catch(() => {});
    }
  }
}

ACTIONS['pf-tx-unpick'] = (el) => {
  const form = el.closest('form');
  if (!form) return;
  form.elements.mode.value = '';
  form.elements.aid.value = '';
  form.elements.pick.value = '';
  showPicked(form);
  syncTxForm(form);
  const q = form.elements.q;
  runCombo('tx', q);
  if (isDesktop()) q.focus();
};

// Price and exchange rate of the chosen day, unless the user typed them
function prefill(form) {
  const st = txState(form);
  const el = form.elements;
  const date = st.date || todayISO();
  if (st.type !== 'buy' && st.type !== 'sell') return;
  let price = null;
  let note = '';
  if (st.mode === 'asset' && st.a) {
    price = priceOn(st.a.id, date);
    if (price) note = `Ultimo prezzo noto al ${fmtDate(date)}: correggilo con quello eseguito`;
  } else if (st.mode === 'pick' && st.pick) {
    // A new asset is priced by real market data only: never prefill a synthetic example price
    const h = market.getHistory(st.pick.symbol);
    price = h && !h.synthetic ? closeOn(h, date) : null;
    if (price) note = `Chiusura del ${fmtDate(date)}: correggila con il prezzo eseguito`;
  }
  if (el.price.dataset.touched !== '1') {
    if (price > 0) {
      el.price.value = numInput(roundPrice(price));
      el.price.dataset.auto = '1';
      setText(form, '#tx-price-hint', note);
    } else if (el.price.dataset.auto === '1') {
      el.price.value = '';
      setText(form, '#tx-price-hint', '');
    }
  }
  if (st.ccy !== 'EUR' && el.fx.dataset.touched !== '1') {
    el.fx.value = numInput(roundFx(fxOn(st.ccy, date)));
    el.fx.dataset.auto = '1';
  }
  syncTxForm(form);
}

// Visibility, labels, holdings hint and live total of the transaction form
function syncTxForm(form) {
  const st = txState(form);
  const el = form.elements;
  const { type, ccy } = st;
  const accObj = account(st.acc);
  const tracked = accObj && accObj.cashMode === 'track';

  setHidden(form, '#tx-other-f', st.kind !== 'other');
  // Deposits and withdrawals exist only for accounts that track cash
  for (const o of el.otherType.options) if (o.value === 'deposit' || o.value === 'withdraw') o.disabled = !tracked;
  if (!tracked && (type === 'deposit' || type === 'withdraw')) {
    el.otherType.value = 'fee';
    return syncTxForm(form);
  }
  setText(form, '#tx-other-hint', tracked ? '' : 'Deposito e prelievo servono solo ai conti con la liquidità tracciata (Altro → Conti): negli altri conti ogni acquisto conta già come soldi versati.');

  const showAsset = NEEDS_ASSET.has(type) || OPTIONAL_ASSET.has(type);
  setHidden(form, '#tx-asset-f', !showAsset);
  if (!showAsset) setHidden(form, '#tx-manual', true);
  else setHidden(form, '#tx-manual', st.mode !== 'manual');
  setText(form, '#tx-asset-l', OPTIONAL_ASSET.has(type) ? 'Titolo (facoltativo)' : 'Titolo');

  const trade = type === 'buy' || type === 'sell';
  setHidden(form, '#tx-trade', !trade);
  setHidden(form, '#tx-tax-f', type !== 'sell');
  setHidden(form, '#tx-div', type !== 'div');
  setHidden(form, '#tx-amount-f', !['deposit', 'withdraw', 'interest', 'fee', 'tax'].includes(type));
  setHidden(form, '#tx-feekind-f', type !== 'fee');
  setHidden(form, '#tx-taxkind-f', type !== 'tax');
  const nonEur = ccy !== 'EUR' && st.mode !== '';
  setHidden(form, '#tx-fx-f', !(trade && nonEur));
  setHidden(form, '#tx-fxfee-f', !(trade && nonEur) && !(val(el.fxFee) > 0));
  setHidden(form, '#tx-divfx-f', !(type === 'div' && nonEur) && !(val(el.divFxFee) > 0));

  // Labels that depend on the asset
  const incomeWord = st.aType === 'bond' ? 'Cedola' : 'Dividendo';
  const divLbl = form.querySelector('.seg-lbl[data-k="div"]');
  if (divLbl) divLbl.textContent = st.mode ? incomeWord : 'Dividendo';
  setText(form, '#tx-net-l', `${st.aType === 'bond' ? 'Cedola netta' : 'Netto ricevuto'} (€)`);
  setText(form, '#tx-price-l', `Prezzo per quota (${ccy})`);
  setText(form, '#tx-fx-l', `Cambio EUR/${ccy}`);
  setText(form, '#tx-amount-l', {
    deposit: 'Importo versato (€)', withdraw: 'Importo prelevato (€)', interest: 'Interessi netti ricevuti (€)', fee: 'Importo del costo (€)', tax: "Importo dell'imposta (€)",
  }[type] || 'Importo (€)');

  // Holdings hint for sells
  const qty = val(el.qty);
  const price = val(el.price);
  const fx = ccy === 'EUR' ? 1 : val(el.fx);
  let held = null;
  if (type === 'sell' && st.mode === 'asset' && st.a) {
    held = heldQty(st.acc, st.a.id, st.date || todayISO(), form.dataset.id || null);
    const unit = unitFor(st.a);
    setText(form, '#tx-held', `Ne hai ${num(held, 6)}${unit ? ' ' + unit : ''} in questo conto a quella data`);
  } else setText(form, '#tx-held', '');
  if (nonEur && fx > 0) setText(form, '#tx-fx-hint', `1 € = ${num(fx, 4)} ${ccy}${qty > 0 && price > 0 ? ` · controvalore ${moneyLocal((qty * price) / fx, 'EUR', { mask: false })}` : ''}`);
  else setText(form, '#tx-fx-hint', nonEur ? `Quanti ${ccy} vale 1 euro quel giorno` : '');

  // Live total in EUR
  const n0 = (x) => (Number.isFinite(x) ? x : 0);
  let total = NaN;
  let label = 'Totale';
  if (trade) {
    if (qty > 0 && price >= 0 && fx > 0) {
      const gross = (qty * price) / fx;
      const costs = n0(val(el.fee)) + n0(val(el.fxFee));
      total = type === 'buy' ? gross + costs : gross - costs - n0(val(el.tax));
    }
    label = type === 'buy' ? 'Totale pagato' : 'Totale incassato';
  } else if (type === 'div') {
    total = val(el.net);
    label = 'Arriva sul conto';
  } else {
    total = val(el.amount);
    label = { deposit: 'Versi sul conto', withdraw: 'Prelevi dal conto', interest: 'Arriva sul conto', fee: 'Paghi', tax: 'Paghi' }[type] || 'Totale';
  }
  setText(form, '#tx-total-l', label);
  setText(form, '#tx-total', Number.isFinite(total) ? moneyLocal(total, 'EUR', { mask: false }) : '—');
  return held;
}

INPUTS['pf-tx'] = (form, ev) => {
  const t = ev && ev.target;
  if (t && ev.type === 'input' && (t.name === 'price' || t.name === 'fx')) {
    t.dataset.touched = t.value.trim() ? '1' : '';
    t.dataset.auto = '';
    if (t.name === 'price') setText(form, '#tx-price-hint', '');
  }
  const err = form.querySelector('[data-error]');
  if (err && !err.hidden && ev.type === 'input') err.hidden = true;
  if (t && t.getAttribute('aria-invalid') === 'true') t.removeAttribute('aria-invalid');
  syncTxForm(form);
  if (t && (t.name === 'date' || t.name === 'type' || t.name === 'otherType' || t.name === 'nm_currency') && ev.type === 'change') prefill(form);
};

// Show a validation message under the form and focus the field
function formError(form) {
  return (msg, fieldEl = null) => {
    const e = form.querySelector('[data-error]');
    if (e) {
      e.textContent = msg;
      e.hidden = false;
    }
    if (fieldEl && fieldEl.setAttribute) {
      fieldEl.setAttribute('aria-invalid', 'true');
      try {
        fieldEl.focus({ preventScroll: false });
      } catch { /* ignore */ }
    } else if (e && e.scrollIntoView) e.scrollIntoView({ block: 'nearest' });
    return false;
  };
}

function assetFromPick(p) {
  return {
    id: newId('a'), name: p.name || p.symbol, ticker: tickerOf(p.symbol), symbol: p.symbol, isin: p.isin || '', type: TYPE_KEYS.includes(p.type) ? p.type : 'other',
    currency: p.currency || 'EUR', exchange: p.exchange || '', sector: p.sector || '', region: p.region || '', ter: p.ter > 0 ? p.ter : null, priceSource: 'auto',
  };
}

FORMS['pf-tx'] = async (form) => {
  const showErr = formError(form);
  const el = form.elements;
  const st = txState(form);
  const { type } = st;
  const today = todayISO();
  const editId = form.dataset.id || '';
  const editing = editId ? D().txns.find((t) => t.id === editId) : null;
  const acc = account(st.acc);
  if (!acc) return showErr('Scegli il conto.', el.acc);
  const date = st.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return showErr('Inserisci una data valida.', el.date);
  if (date > addDays(today, 365)) return showErr('La data è più di un anno nel futuro: controlla l\'anno.', el.date);
  if (date < '1970-01-01') return showErr('La data è troppo vecchia: controlla l\'anno.', el.date);
  if ((type === 'deposit' || type === 'withdraw') && acc.cashMode !== 'track') {
    return showErr(`Il conto ${acc.name} non tiene traccia della liquidità: deposito e prelievo non servono. Puoi attivarla in Altro → Conti.`, el.otherType);
  }

  // Asset
  let aid = null;
  let newAsset = null;
  const wantsAsset = NEEDS_ASSET.has(type) || (OPTIONAL_ASSET.has(type) && st.mode);
  if (wantsAsset) {
    if (st.mode === 'asset' && st.a) aid = st.a.id;
    else if (st.mode === 'pick' && st.pick) {
      const own = assetBySymbol(st.pick.symbol);
      if (own) aid = own.id;
      else {
        const p = { ...st.pick };
        if (!p.ccyOk && market.status !== 'offline') {
          const btn = form.querySelector('button[type="submit"]');
          if (btn) btn.disabled = true;
          try {
            const info = await market.lookup(p.symbol);
            if (info && info.currency) {
              p.currency = info.currency;
              if (!p.name || p.name === p.symbol) p.name = info.name || p.name;
              if (info.currency !== st.pick.currency && (type === 'buy' || type === 'sell') && el.price.value.trim()) {
                el.pick.value = JSON.stringify({ ...p, ccyOk: true });
                showPicked(form);
                syncTxForm(form);
                if (btn) btn.disabled = false;
                return showErr(`Attenzione: ${p.symbol} è quotato in ${info.currency}. Controlla prezzo e cambio, poi salva di nuovo.`, el.price);
              }
            }
          } catch { /* keep the guessed currency */ }
          if (btn) btn.disabled = false;
          if (!form.isConnected) return;
        }
        newAsset = assetFromPick(p);
        aid = newAsset.id;
      }
    } else if (st.mode === 'manual') {
      const name = el.nm_name.value.trim();
      if (!name) return showErr('Scrivi il nome del nuovo titolo.', el.nm_name);
      const code = el.nm_ticker.value.trim().toUpperCase();
      const same = Object.values(D().assets).find((a) => a.name.toLowerCase() === name.toLowerCase() || (code && (a.ticker === code || a.isin === code)));
      if (same) aid = same.id;
      else {
        const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(code) ? code : '';
        newAsset = {
          id: newId('a'), name, ticker: isin ? '' : code, symbol: '', isin, type: el.nm_type.value || 'other', currency: el.nm_currency.value || 'EUR',
          exchange: '', sector: '', region: '', ter: null, priceSource: 'manual',
        };
        aid = newAsset.id;
      }
    } else if (NEEDS_ASSET.has(type)) {
      return showErr('Scegli il titolo: cercalo per nome, ticker o ISIN, oppure inseriscilo a mano.', el.q);
    }
  }

  const tx = { id: editing ? editing.id : newId('t'), acc: acc.id, date, type };
  if (editing && editing.src) tx.src = editing.src;
  if (editing && editing.demo) tx.demo = true;
  if (aid) tx.aid = aid;
  const ccy = newAsset ? newAsset.currency : (aid ? asset(aid).currency : 'EUR') || 'EUR';
  const optional = (input, label) => {
    if (!input || !input.value.trim()) return 0;
    const x = parseNum(input.value);
    if (!Number.isFinite(x) || x < 0) {
      showErr(`${label}: scrivi un numero positivo o lascia vuoto.`, input);
      return null;
    }
    return x;
  };

  if (type === 'buy' || type === 'sell') {
    const qty = val(el.qty);
    if (!(qty > 0)) return showErr('Scrivi la quantità, maggiore di zero (es. 10 oppure 0,5).', el.qty);
    const price = val(el.price);
    if (!(price > 0)) return showErr(`Scrivi il prezzo per quota in ${ccy}, maggiore di zero.`, el.price);
    tx.qty = qty;
    tx.price = price;
    if (ccy !== 'EUR') {
      const fx = val(el.fx);
      if (!(fx > 0)) return showErr(`Scrivi il cambio EUR/${ccy} (quanti ${ccy} vale 1 euro), maggiore di zero.`, el.fx);
      tx.fx = fx;
    }
    const fee = optional(el.fee, 'Commissione');
    if (fee === null) return false;
    const fxFee = optional(el.fxFee, 'Costo cambio');
    if (fxFee === null) return false;
    if (fee) tx.fee = fee;
    if (fxFee) tx.fxFee = fxFee;
    if (type === 'sell') {
      const tax = optional(el.tax, 'Imposte');
      if (tax === null) return false;
      if (tax) tx.tax = tax;
      const held = newAsset ? 0 : heldQty(acc.id, aid, date, editing ? editing.id : null);
      if (qty > held + 1e-9) {
        const unit = unitFor(newAsset || asset(aid));
        return showErr(held > 0
          ? `Al ${fmtDate(date)} nel conto ${acc.name} hai ${num(held, 6)}${unit ? ' ' + unit : ''}: non puoi venderne di più.`
          : `Al ${fmtDate(date)} nel conto ${acc.name} non hai questo titolo: registra prima l'acquisto (o controlla conto e data).`, el.qty);
      }
    }
  } else if (type === 'div') {
    const net = val(el.net);
    if (!(net > 0)) return showErr('Scrivi l\'importo netto ricevuto in euro, maggiore di zero.', el.net);
    tx.amount = net;
    const wht = optional(el.wht, 'Ritenuta');
    if (wht === null) return false;
    if (wht) tx.tax = wht;
    const gross = optional(el.gross, 'Lordo');
    if (gross === null) return false;
    if (gross) {
      if (gross + 0.005 < net) return showErr('Il lordo non può essere minore del netto ricevuto.', el.gross);
      tx.gross = gross;
    }
    const fxFee = optional(el.divFxFee, 'Costo cambio');
    if (fxFee === null) return false;
    if (fxFee) tx.fxFee = fxFee;
  } else {
    const amount = val(el.amount);
    if (!(amount > 0)) return showErr('Scrivi l\'importo in euro, maggiore di zero.', el.amount);
    tx.amount = amount;
    if (type === 'fee') tx.kind = FEE_KINDS[el.feeKind.value] ? el.feeKind.value : 'other';
    if (type === 'tax') tx.kind = TAX_KINDS[el.taxKind.value] ? el.taxKind.value : 'other';
  }
  const note = el.note.value.trim();
  const ref = el.ref.value.trim();
  if (note) tx.note = note;
  if (ref) tx.ref = ref;

  if (newAsset) D().assets[newAsset.id] = newAsset;
  const i = editing ? D().txns.findIndex((x) => x.id === editing.id) : -1;
  if (i >= 0) D().txns[i] = tx;
  else D().txns.push(tx);
  commit(editing ? 'Operazione aggiornata' : 'Operazione salvata');
  app.popSheet();
  if (newAsset && newAsset.priceSource === 'auto') app.refreshPrices();
  return true;
};

/* ======================================================================
   Manual prices of all open positions without market data
   ====================================================================== */
SHEETS.prices = (args = {}) => {
  const today = todayISO();
  const dr = args.draft || null;
  const open = positions({}).filter((p) => p.qty > 0 && p.asset.type !== 'cash' && (p.asset.priceSource === 'manual' || !p.asset.symbol));
  open.sort((a, b) => b.value - a.value);
  const rows = open.map((p) => {
    const a = p.asset;
    const q = lastQuote(p.aid);
    const ccy = a.currency || 'EUR';
    const name = `p:${a.id}`;
    const old = q && q.date ? `${priceFmt(q.price, ccy)} · ${fmtDate(q.date)}` : 'nessun prezzo';
    const stale = !q || !q.date || q.date < addDays(today, -7);
    return `<div class="row price-row">${avatar(a, 'sm')}
      <span class="row-main"><label class="row-title" for="pr-${esc(a.id)}">${esc(a.name)}</label><span class="row-sub${stale ? ' warn-text' : ''}">${esc(old)}</span></span>
      <span class="price-input"><input id="pr-${esc(a.id)}" name="${esc(name)}" data-aid="${esc(a.id)}" inputmode="decimal" autocomplete="off" placeholder="${q ? esc(numInput(roundPrice(q.price))) : '0,00'}" value="${esc(dr && dr[name] ? dr[name] : '')}" aria-label="Nuovo prezzo di ${esc(a.name)} in ${esc(ccy)}"><small>${esc(ccy)}</small></span>
    </div>`;
  }).join('');
  return {
    title: 'Prezzi manuali',
    body: `<form class="form" data-form="prices" novalidate>
      <p class="hint">Qui aggiorni i titoli che non sono collegati a Yahoo Finance. Scrivi solo i prezzi cambiati; valgono per tutti i conti.</p>
      <div class="field"><label for="pr-date">Prezzi del giorno</label><input id="pr-date" type="date" name="date" value="${esc(dr && dr.date ? dr.date : today)}" max="${today}"></div>
      ${rows ? `<div class="list">${rows}</div>` : '<div class="empty"><p>Nessun titolo con prezzo manuale: i tuoi titoli si aggiornano da soli con Yahoo Finance.</p></div>'}
      <p class="form-error" data-error role="alert" hidden></p>
      ${rows ? '<button class="btn primary block" type="submit">Salva prezzi</button>' : ''}
    </form>`,
  };
};
FORM_SHEETS.add('prices');

FORMS.prices = (form) => {
  const showErr = formError(form);
  const today = todayISO();
  const date = form.elements.date.value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return showErr('Inserisci una data valida.', form.elements.date);
  if (date > today) return showErr('La data non può essere nel futuro.', form.elements.date);
  const updates = [];
  for (const input of form.querySelectorAll('input[data-aid]')) {
    if (!input.value.trim()) continue;
    const p = parseNum(input.value);
    if (!(p > 0)) return showErr(`Prezzo non valido per ${asset(input.dataset.aid).name}: scrivi un numero maggiore di zero.`, input);
    updates.push([input.dataset.aid, p]);
  }
  if (!updates.length) return showErr('Scrivi almeno un prezzo, oppure chiudi la finestra.');
  for (const [aid, p] of updates) setPrice(aid, date, p);
  commit(updates.length === 1 ? 'Prezzo aggiornato' : `${updates.length} prezzi aggiornati`);
  app.popSheet();
  return true;
};

FORMS['price-one'] = (form) => {
  const showErr = formError(form);
  const aid = form.dataset.aid;
  const a = D().assets[aid];
  if (!a) return showErr('Questo titolo non esiste più.');
  const p = parseNum(form.elements.price.value);
  if (!(p > 0)) return showErr(`Scrivi il prezzo in ${a.currency || 'EUR'}, maggiore di zero.`, form.elements.price);
  const today = todayISO();
  const date = form.elements.date.value || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showErr('Inserisci una data valida.', form.elements.date);
  if (date > today) return showErr('La data non può essere nel futuro.', form.elements.date);
  setPrice(aid, date, p);
  if (typeof document !== 'undefined' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
  commit(`Prezzo di ${a.name} aggiornato`);
  return true;
};

// Wrap the body of a portfolio sheet in <div class="pf-sheet pf-NAME"> so css/portfolio.css can
// space its blocks without touching the sheets of the other views
export function scopeSheet(name) {
  const fn = SHEETS[name];
  if (typeof fn !== 'function' || fn.scoped) return;
  const wrapped = (args) => {
    const out = fn(args);
    return out && typeof out.body === 'string' ? { ...out, body: `<div class="pf-sheet pf-${name}">${out.body}</div>` } : out;
  };
  wrapped.scoped = true;
  SHEETS[name] = wrapped;
}
for (const name of ['asset', 'assetForm', 'tx', 'txForm', 'prices']) scopeSheet(name);

/* ======================================================================
   Actions
   ====================================================================== */
Object.assign(ACTIONS, {
  'add-tx': (el) => {
    const d = (el && el.dataset) || {};
    const args = {};
    for (const k of ['aid', 'type', 'acc', 'symbol', 'name', 'exchange']) if (d[k]) args[k] = d[k];
    app.pushSheet('txForm', args);
  },
  'open-asset': (el) => {
    const aid = el.dataset.aid;
    if (!aid) return;
    // Already open lower in the stack (asset → operation → asset): go back to it
    const at = S.sheets.findIndex((s) => s.name === 'asset' && s.args && s.args.aid === aid);
    if (at >= 0 && S.sheets.slice(at + 1).every((s) => !FORM_SHEETS.has(s.name))) {
      if (at === S.sheets.length - 1) return;
      S.sheets.splice(at + 1);
      app.renderSheet();
      return;
    }
    app.pushSheet('asset', { aid });
  },
  'open-tx': (el) => {
    if (el.dataset.id) app.pushSheet('tx', { id: el.dataset.id });
  },
  'edit-tx': (el) => {
    const id = el.dataset.id;
    if (!D().txns.some((t) => t.id === id)) return;
    app.pushSheet('txForm', { id });
  },
  'delete-tx': (el) => {
    const id = el.dataset.id;
    const t = D().txns.find((x) => x.id === id);
    if (!t) return;
    const what = `${txLabel(t)}${t.aid ? ' di ' + asset(t.aid).name : ''} del ${fmtDate(t.date)}`;
    app.askConfirm({
      title: 'Eliminare l\'operazione?',
      text: `${what}. Valori e report verranno ricalcolati. Non si può annullare.`,
      ok: 'Elimina',
      onOk: () => {
        D().txns = D().txns.filter((x) => x.id !== id);
        S.sheets = S.sheets.filter((s) => !((s.name === 'tx' || s.name === 'txForm') && s.args && s.args.id === id));
        commit('Operazione eliminata');
      },
    });
  },
  'edit-asset': (el) => {
    if (D().assets[el.dataset.aid]) app.pushSheet('assetForm', { aid: el.dataset.aid });
  },
  'delete-asset': (el) => {
    const aid = el.dataset.aid;
    const a = D().assets[aid];
    if (!a) return;
    const n = D().txns.filter((t) => t.aid === aid).length;
    app.askConfirm({
      title: `Eliminare ${a.name}?`,
      text: n
        ? `Elimino il titolo, le sue ${n === 1 ? 'operazione' : `${n} operazioni`} e i prezzi inseriti a mano. Valori e report verranno ricalcolati. Non si può annullare.`
        : 'Elimino il titolo e i prezzi inseriti a mano. Non si può annullare.',
      ok: 'Elimina',
      onOk: () => {
        const d = D();
        const gone = new Set(d.txns.filter((t) => t.aid === aid).map((t) => t.id));
        d.txns = d.txns.filter((t) => t.aid !== aid);
        delete d.prices[aid];
        delete d.assets[aid];
        for (const w of d.watch) if (w.aid === aid) delete w.aid;
        S.sheets = S.sheets.filter((s) => {
          const x = s.args || {};
          if ((s.name === 'asset' || s.name === 'assetForm') && x.aid === aid) return false;
          if ((s.name === 'tx' || s.name === 'txForm') && gone.has(x.id)) return false;
          return true;
        });
        commit(`${a.name} eliminato`);
      },
    });
  },
  prices: () => app.pushSheet('prices'),
  'pf-asset-range': (el) => {
    const top = topSheet();
    if (!top || top.name !== 'asset') return;
    top.args.range = el.dataset.range;
    app.renderSheet();
  },
});

export const _test = { guessCurrency, tickerOf, closeOn, historyPoints, heldQty, comboItems, mapSector, fmt };
