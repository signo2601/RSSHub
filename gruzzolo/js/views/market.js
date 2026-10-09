// Tab "Mercati": search (Yahoo Finance through our server, plus the offline catalog), watchlist,
// held securities, popular lists. Sheets: 'quote' (any symbol) and 'watchForm' (target and note).
import { S, D, assetCode, commit, TYPE_LABEL } from '../state.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, FORM_SHEETS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { historyFor, positions, lastQuote } from '../engine.js';
import { CATALOG, GROUPS, searchCatalog, findInCatalog } from '../catalog.js';
import { sparkline } from '../charts.js';
import { esc, icon, money, priceFmt, pct, pctSigned, num, numInput, parseNum, fmtDate, fmtTime, tone, todayISO, addMonths, addDays, newId, debounce, iso, qtyFmt } from '../util.js';
import { avatar, pctPill, demoBanner, unitFor } from './home.js';
import { sheetInnerWidth, priceChartBlock, historyPoints, tickerOf, guessCurrency } from './sheets.js';

/* ---------- Quotes from the market cache ---------- */
const exactCatalog = (symbol) => {
  const c = findInCatalog(symbol);
  return c && c.symbol === symbol ? c : null;
};
const isDemoHistory = (h) => Boolean(h && (h.synthetic || market.isDemoSymbol(h.symbol)));

// Last price, change versus the previous close and the history of a symbol (real or demo data)
export function quoteOf(symbol) {
  const h = symbol ? historyFor(symbol) : null;
  if (!h) return null;
  const pts = historyPoints(h);
  if (!pts.length) return null;
  const [date, price] = pts[pts.length - 1];
  let prev = pts.length > 1 ? pts[pts.length - 2][1] : price;
  if (h.prev > 0 && h.time && iso(new Date(h.time)) === date) prev = h.prev;
  return {
    h, pts, price, prev, date,
    change: price - prev,
    changePct: prev > 0 ? price / prev - 1 : 0,
    currency: h.currency || (exactCatalog(symbol) || {}).currency || guessCurrency(symbol),
    demo: isDemoHistory(h),
  };
}

const typeText = (r) => r.typeDisp || TYPE_LABEL[r.type] || '';

/* ---------- Search state ---------- */
const live = { q: '', results: [], pending: false, gen: 0 };
let popGroup = GROUPS[0];

const runLive = debounce((q, gen) => {
  market.search(q).then((res) => {
    if (gen !== live.gen) return;
    live.q = q;
    live.results = Array.isArray(res) ? res : [];
    live.pending = false;
    updateResults();
  }).catch(() => {
    if (gen !== live.gen) return;
    live.q = q;
    live.results = [];
    live.pending = false;
    updateResults();
  });
}, 300);

function startLive(q) {
  const k = q.trim();
  live.gen++;
  if (k.length < 2 || market.status === 'offline') {
    live.pending = false;
    return;
  }
  if (live.q === k && !live.pending) return;
  live.pending = true;
  runLive(k, live.gen);
}

function resultRow(r) {
  const q = quoteOf(r.symbol);
  const own = Object.values(D().assets).some((a) => a.symbol === r.symbol);
  const sub = [r.symbol, r.exchange, typeText(r)].filter(Boolean).join(' · ');
  const end = q
    ? `<span class="row-value num">${priceFmt(q.price, q.currency)}</span>${pctPill(q.changePct)}`
    : `<span class="tag">${r.src === 'catalog' ? esc(r.currency || 'Catalogo') : 'Yahoo'}</span>`;
  return `<button class="row result-row" type="button" data-act="open-quote" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name || '')}" data-exchange="${esc(r.exchange || '')}" data-type="${esc(r.type || '')}">
    ${avatar({ name: r.name, ticker: tickerOf(r.symbol), symbol: r.symbol, type: r.type }, 'sm')}
    <span class="row-main"><span class="row-title">${esc(r.name || r.symbol)}${own ? ' <span class="own-dot" title="Nel tuo portafoglio">●</span>' : ''}</span><span class="row-sub">${esc(sub)}</span></span>
    <span class="row-end">${end}</span>
  </button>`;
}

function resultsHtml(query) {
  const q = query.trim();
  if (!q) return '';
  const cat = searchCatalog(q, 10).map((c) => ({ ...c, src: 'catalog' }));
  const seen = new Set(cat.map((c) => c.symbol));
  const fromLive = live.q === q ? live.results.filter((r) => r && r.symbol && !seen.has(r.symbol)).map((r) => ({ ...r, src: 'yahoo' })) : [];
  const items = [...cat, ...fromLive].slice(0, 30);
  let status = '';
  if (market.status === 'offline') status = `<p class="mkt-note">${icon('cloud')}<span>Ricerca online non disponibile: mostro il catalogo.</span></p>`;
  else if (live.pending && q.length >= 2) status = '<p class="mkt-note"><span class="dot busy"></span><span>Cerco su Yahoo Finance…</span></p>';
  const list = items.length
    ? `<div class="list">${items.map(resultRow).join('')}</div>`
    : (live.pending ? '' : `<div class="empty"><p>Nessun risultato per “${esc(q)}”. Prova con il ticker (es. VWCE) o con il codice ISIN (es. IE00BK5BQT80).</p></div>`);
  return `<section class="section" aria-label="Risultati della ricerca">
    <div class="sec-head"><h2>Risultati</h2><span class="hint">${items.length ? `${items.length} titoli` : ''}</span></div>
    ${status}${list}
  </section>`;
}

// Update only the results area while typing (a full render would close the iPhone keyboard)
function updateResults() {
  if (typeof document === 'undefined' || S.ui.tab !== 'market') return;
  const box = document.getElementById('mkt-results');
  const home = document.getElementById('mkt-home');
  const clear = document.getElementById('mkt-clear');
  const q = String(S.ui.marketQuery || '');
  if (box) {
    box.innerHTML = resultsHtml(q);
    box.hidden = !q.trim();
  }
  if (home) home.hidden = Boolean(q.trim());
  if (clear) clear.hidden = !q;
}

/* ---------- Sections ---------- */
function targetText(w, price, ccy) {
  if (!(w.target > 0)) return '';
  if (!(price > 0)) return `Obiettivo ${priceFmt(w.target, ccy)}`;
  const d = w.target / price - 1;
  if (Math.abs(d) < 0.005) return `Obiettivo ${priceFmt(w.target, ccy)} · raggiunto`;
  return `Obiettivo ${priceFmt(w.target, ccy)} · ${pctSigned(d, 1)}`;
}

function watchRow(w, today) {
  const q = w.symbol ? quoteOf(w.symbol) : null;
  const ccy = (q && q.currency) || w.currency || 'EUR';
  const price = q ? q.price : w.price > 0 ? w.price : null;
  let spark = '';
  if (q) {
    const from = addMonths(today, -3);
    const vals = q.pts.filter((p) => p[0] >= from).map((p) => p[1]);
    const r = vals.length > 1 ? vals[vals.length - 1] / vals[0] - 1 : 0;
    spark = `<span class="spark-wrap" aria-hidden="true">${sparkline(vals, { w: 64, h: 28, color: r >= 0 ? 'var(--up)' : 'var(--down)' })}</span>`;
  }
  const sub = [targetText(w, price, ccy) || w.ticker || w.symbol, w.note].filter(Boolean).join(' · ');
  let end;
  if (q) end = `<span class="row-value num">${priceFmt(q.price, ccy)}</span>${pctPill(q.changePct)}`;
  else if (w.symbol && market.status !== 'offline' && !w.price) end = '<span class="row-sub">Carico…</span>';
  else end = `<span class="row-value num">${price ? priceFmt(price, ccy) : '—'}</span><span class="row-sub">${w.symbol ? 'prezzo salvato' : 'prezzo manuale'}</span>`;
  return `<button class="row watch-row" type="button" data-act="watch-open" data-id="${esc(w.id)}">
    ${avatar({ name: w.name, ticker: w.ticker || tickerOf(w.symbol), symbol: w.symbol, type: 'stock' })}
    <span class="row-main"><span class="row-title">${esc(w.name || w.symbol || w.ticker)}</span><span class="row-sub">${esc(sub)}</span></span>
    ${spark}
    <span class="row-end">${end}</span>
  </button>`;
}

function heldRows() {
  const open = positions({}).filter((p) => p.qty > 0 && p.asset.type !== 'cash').sort((a, b) => b.value - a.value);
  return open.map((p) => {
    const a = p.asset;
    const q = lastQuote(p.aid);
    const ccy = a.currency || 'EUR';
    const fresh = q && q.source === 'market';
    const sub = [assetCode(a), a.exchange, fresh ? '' : q && q.source === 'manual' ? `manuale del ${fmtDate(q.date)}` : 'nessun prezzo di mercato'].filter(Boolean).join(' · ');
    return `<button class="row" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">
      ${avatar(a, 'sm')}
      <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc(sub)}</span></span>
      <span class="row-end"><span class="row-value num">${q ? priceFmt(q.price, ccy) : '—'}</span>${fresh ? pctPill(q.changePct) : ''}</span>
    </button>`;
  }).join('');
}

function popularRows(group) {
  return CATALOG.filter((c) => c.group === group).map((c) => resultRow({ ...c, src: 'catalog' })).join('');
}

export function renderMarket() {
  const today = todayISO();
  const query = String(S.ui.marketQuery || '');
  const watch = D().watch;
  const held = heldRows();
  const group = GROUPS.includes(popGroup) ? popGroup : GROUPS[0];
  const offline = market.status === 'offline';
  return `<div class="page mkt-page">
    <div class="page-head"><div><p class="eyebrow">Prezzi da Yahoo Finance</p><h1 class="page-title">Mercati</h1></div></div>
    <div class="search-box mkt-search" role="search">
      ${icon('search')}
      <input id="mkt-q" type="search" data-input="mkt-search" value="${esc(query)}" placeholder="Cerca azioni, ETF, crypto: nome, ticker o ISIN" aria-label="Cerca un titolo" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <button class="icon-btn clear-btn" id="mkt-clear" type="button" data-act="mkt-clear" aria-label="Cancella la ricerca"${query ? '' : ' hidden'}>${icon('close')}</button>
    </div>
    ${offline ? `<p class="mkt-note">${icon('cloud')}<span>Server prezzi non raggiungibile: mostro il catalogo e gli ultimi prezzi salvati.</span></p>` : ''}
    <div id="mkt-results"${query.trim() ? '' : ' hidden'}>${resultsHtml(query)}</div>
    <div id="mkt-home" class="stack mkt-home"${query.trim() ? ' hidden' : ''}>
      ${demoBanner()}
      <section class="section" aria-label="Watchlist">
        <div class="sec-head"><h2>Watchlist <span class="muted">${watch.length || ''}</span></h2><button class="link-btn" type="button" data-act="watch-add">${icon('plus')}Aggiungi</button></div>
        ${watch.length
    ? `<div class="list">${watch.map((w) => watchRow(w, today)).join('')}</div><p class="hint">Il prezzo obiettivo ti ricorda a che prezzo vorresti comprare o vendere; la percentuale è quanto manca per arrivarci.</p>`
    : `<div class="empty compact"><p>Nessun titolo osservato. Cerca un titolo e tocca «Aggiungi alla watchlist» per seguirne il prezzo.</p></div>`}
      </section>
      ${held ? `<section class="section" aria-label="I tuoi titoli"><div class="sec-head"><h2>I tuoi titoli</h2></div><div class="list">${held}</div></section>` : ''}
      <section class="section" aria-label="Titoli popolari">
        <div class="sec-head"><h2>Popolari</h2><span class="hint">Tocca un titolo per vederne il grafico</span></div>
        <div class="chips group-chips" role="group" aria-label="Categoria">${GROUPS.map((g) => `<button class="chip" type="button" data-act="mkt-group" data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g)}</button>`).join('')}</div>
        <div class="list">${popularRows(group)}</div>
      </section>
    </div>
  </div>`;
}

/* ---------- Quote sheet ---------- */
function yearStats(q, today) {
  const yearAgo = addDays(today, -365);
  const pts = q.pts.filter((p) => p[0] >= yearAgo);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, v] of pts) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const h = q.h;
  // One-year return with dividends reinvested (adjusted closes) when available
  let ret = null;
  const i0 = h.dates.findIndex((d) => d >= yearAgo);
  const first = q.pts[0] ? q.pts[0][0] : null;
  if (i0 > 0 || (i0 === 0 && first && first <= addDays(yearAgo, 7))) {
    const a0 = (h.adj && h.adj[i0]) || h.close[i0];
    const n = h.dates.length - 1;
    const a1 = (h.adj && h.adj[n]) || h.close[n];
    const c1 = h.close[n];
    const scale = c1 > 0 ? q.price / c1 : 1;
    if (a0 > 0 && a1 > 0) ret = (a1 * scale) / a0 - 1;
  }
  const divs = (h.divs || []).filter((d) => d[0] > yearAgo && d[0] <= today);
  const div12 = divs.reduce((s, d) => s + (+d[1] || 0), 0);
  return { lo: pts.length ? lo : null, hi: pts.length ? hi : null, ret, div12, divCount: divs.length, yld: q.price > 0 ? div12 / q.price : null };
}

SHEETS.quote = (args = {}) => {
  const symbol = String(args.symbol || '').trim();
  const today = todayISO();
  const cat = exactCatalog(symbol);
  const q = quoteOf(symbol);
  const h = q ? q.h : null;
  const name = args.name || (h && h.name) || (cat && cat.name) || symbol;
  const exchange = (h && h.exchange) || (cat && cat.exchange) || args.exchange || '';
  const ccy = (q && q.currency) || (cat && cat.currency) || '';
  const typeKey = (cat && cat.type) || (h && h.type) || args.type || '';
  const own = Object.values(D().assets).find((a) => a.symbol === symbol) || null;
  const pos = own ? positions({}).find((p) => p.aid === own.id && p.qty > 0) : null;
  const watched = D().watch.find((w) => w.symbol === symbol) || null;
  const isBench = (D().settings.benchmark || {}).symbol === symbol;
  const tags = [symbol, exchange, ccy, TYPE_LABEL[typeKey] || '', cat && cat.ter > 0 ? `TER ${pct(cat.ter, 2)}` : '', cat && cat.isin].filter(Boolean)
    .map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  const offline = market.status === 'offline';

  let priceBlock;
  let chart = '';
  let stats = '';
  if (q) {
    const src = q.demo
      ? `Prezzo simulato del ${fmtDate(q.date)} · dati di esempio`
      : q.date === today && h.time ? `Prezzo da Yahoo Finance · ${fmtTime(h.time)}` : `Prezzo da Yahoo Finance · chiusura del ${fmtDate(q.date)}`;
    priceBlock = `<div class="quote-price"><div class="price-big num">${priceFmt(q.price, q.currency)}</div>
      <div class="price-change">${pctPill(q.changePct)} <span class="muted num">${q.change >= 0 ? '+' : '−'}${priceFmt(Math.abs(q.change), q.currency)}</span></div></div>
      <p class="src-line">${esc(src)}</p>`;
    chart = priceChartBlock({ id: 'quote-chart', points: q.pts, range: args.range || '1A', ccy: q.currency, act: 'mkt-quote-range', w: sheetInnerWidth(), today });
    const y = yearStats(q, today);
    const st = (label, value, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${value}</b></div>`;
    stats = `<div class="stats quote-stats">
      ${st('Minimo 52 settimane', y.lo !== null ? priceFmt(y.lo, q.currency) : '—')}
      ${st('Massimo 52 settimane', y.hi !== null ? priceFmt(y.hi, q.currency) : '—')}
      ${st('Rendimento 1 anno', y.ret !== null ? pctSigned(y.ret) : '—', y.ret !== null ? tone(y.ret, 0.00005) : '')}
      ${st('Dividendi 12 mesi', y.div12 > 0 ? `${priceFmt(y.div12, q.currency)} · ${pct(y.yld, 2)}` : 'nessuno')}
      ${st('Valuta', esc(q.currency || '—'))}
      ${st('Borsa', esc(exchange || '—'))}
    </div>
    <p class="hint">Rendimento 1 anno con i dividendi reinvestiti. Dividendi lordi per azione (o quota) degli ultimi 12 mesi e rendimento rispetto al prezzo di oggi.</p>`;
  } else if (offline || args.failed) {
    priceBlock = `<div class="banner info">${icon('cloud')}<p>${offline ? 'Server prezzi non raggiungibile: il grafico apparirà quando torni online.' : 'Yahoo Finance non ha dati per questo simbolo, o è occupato: riprova tra poco.'}</p></div>`;
  } else {
    priceBlock = `<p class="src-line" aria-live="polite">Carico i prezzi…</p>
      <div class="skeleton skel-price"></div><div class="skeleton chart-skel"></div>`;
  }

  const ownBlock = pos
    ? `<button class="row own-row" type="button" data-act="open-asset" data-aid="${esc(own.id)}">${avatar(own, 'sm')}
        <span class="row-main"><span class="row-title">Nel tuo portafoglio</span><span class="row-sub">${qtyFmt(pos.qty)} ${esc(unitFor(own))} · ${money(pos.value)}</span></span>
        <span class="row-end">${pctPill(pos.unrealPct)}</span></button>`
    : '';

  const actions = `<div class="btn-row quote-actions">
    <button class="btn primary" type="button" data-act="add-tx" data-symbol="${esc(symbol)}" data-type="buy" data-name="${esc(name)}" data-exchange="${esc(exchange)}">${icon('plus')}Registra acquisto</button>
    ${watched
    ? `<button class="btn" type="button" data-act="watch-remove" data-symbol="${esc(symbol)}">${icon('star')}Rimuovi dalla watchlist</button>`
    : `<button class="btn" type="button" data-act="watch-add" data-symbol="${esc(symbol)}" data-name="${esc(name)}">${icon('star')}Aggiungi alla watchlist</button>`}
  </div>
  <button class="btn block ghost bench-btn" type="button"${isBench ? ' disabled' : ` data-act="mkt-bench" data-symbol="${esc(symbol)}" data-name="${esc(name)}"`}>${icon('report')}${isBench ? 'È il benchmark dei tuoi report' : 'Usa come benchmark nei report'}</button>`;

  return {
    title: 'Scheda titolo',
    body: `<div class="detail-head">${avatar({ name, ticker: tickerOf(symbol), symbol, type: typeKey })}<div class="detail-title"><h3>${esc(name)}</h3><div class="tags">${tags}</div></div></div>
      ${priceBlock}
      ${chart}
      ${ownBlock}
      ${stats}
      ${actions}`,
    after: () => {
      if (args.tried || !symbol || market.isDemoSymbol(symbol)) return;
      const hReal = market.getHistory(symbol);
      if (hReal && !hReal.synthetic && hReal.dates.length) return;
      if (market.status === 'offline') return;
      args.tried = true;
      market.ensureHistory(symbol).then((res) => {
        const top = S.sheets[S.sheets.length - 1];
        if (!res) args.failed = true;
        if (top && top.name === 'quote' && top.args === args) app.renderSheet();
      }).catch(() => {
        args.failed = true;
      });
    },
  };
};

/* ---------- Watchlist editor ---------- */
SHEETS.watchForm = (args = {}) => {
  const w = D().watch.find((x) => x.id === args.id);
  if (!w) return { title: 'Watchlist', body: '<div class="empty"><p>Questo titolo non è più nella watchlist.</p><button class="btn" type="button" data-act="back-sheet">Indietro</button></div>' };
  const dr = args.draft || null;
  const v = (name, fallback) => (dr && name in dr ? dr[name] : fallback);
  const q = w.symbol ? quoteOf(w.symbol) : null;
  const ccy = (q && q.currency) || w.currency || 'EUR';
  const price = q ? q.price : w.price;
  return {
    title: w.name || w.symbol || 'Watchlist',
    body: `<div class="detail-head">${avatar({ name: w.name, ticker: w.ticker || tickerOf(w.symbol), symbol: w.symbol })}
        <div class="detail-title"><h3>${esc(w.name || w.symbol)}</h3><div class="tags">${[w.symbol || w.ticker, ccy].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div></div>
      ${q ? `<div class="quote-price"><div class="price-big num">${priceFmt(q.price, ccy)}</div><div class="price-change">${pctPill(q.changePct)}</div></div>` : ''}
      <form class="form" data-form="mkt-watch" data-id="${esc(w.id)}" novalidate>
        ${w.symbol ? '' : `<div class="field"><label for="w-price">Prezzo attuale (${esc(ccy)})</label><input id="w-price" name="price" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(v('price', numInput(w.price || '')))}"><span class="hint">Questo titolo non è collegato a Yahoo Finance: aggiorni tu il prezzo.</span></div>`}
        <div class="field"><label for="w-target">Prezzo obiettivo (${esc(ccy)})</label><input id="w-target" name="target" inputmode="decimal" autocomplete="off" placeholder="${price > 0 ? esc(numInput(+price.toFixed(2))) : '0,00'}" value="${esc(v('target', w.target > 0 ? numInput(w.target) : ''))}"><span class="hint">A che prezzo vorresti comprare (o vendere). Lascia vuoto se non ti serve.</span></div>
        <div class="field"><label for="w-note">Nota</label><input id="w-note" name="note" autocomplete="off" placeholder="Perché lo segui" value="${esc(v('note', w.note || ''))}"></div>
        <p class="form-error" data-error role="alert" hidden></p>
        <button class="btn primary block" type="submit">Salva</button>
      </form>
      <div class="btn-row sheet-foot-actions">
        ${w.symbol ? `<button class="btn" type="button" data-act="open-quote" data-symbol="${esc(w.symbol)}" data-name="${esc(w.name || '')}">${icon('chart')}Grafico</button>` : ''}
        ${w.symbol ? `<button class="btn" type="button" data-act="add-tx" data-symbol="${esc(w.symbol)}" data-type="buy" data-name="${esc(w.name || '')}">${icon('plus')}Compra</button>` : ''}
        <button class="btn danger" type="button" data-act="watch-remove" data-id="${esc(w.id)}">${icon('trash')}Rimuovi</button>
      </div>`,
  };
};
FORM_SHEETS.add('watchForm');

FORMS['mkt-watch'] = (form) => {
  const w = D().watch.find((x) => x.id === form.dataset.id);
  const err = form.querySelector('[data-error]');
  const fail = (msg, el) => {
    if (err) {
      err.textContent = msg;
      err.hidden = false;
    }
    if (el) {
      el.setAttribute('aria-invalid', 'true');
      el.focus();
    }
  };
  if (!w) return fail('Questo titolo non è più nella watchlist.');
  const el = form.elements;
  let target = 0;
  if (el.target.value.trim()) {
    target = parseNum(el.target.value);
    if (!(target > 0)) return fail('Il prezzo obiettivo deve essere un numero maggiore di zero, oppure lascialo vuoto.', el.target);
  }
  if (el.price) {
    const p = el.price.value.trim() ? parseNum(el.price.value) : 0;
    if (el.price.value.trim() && !(p > 0)) return fail('Il prezzo deve essere un numero maggiore di zero.', el.price);
    w.price = p;
  }
  w.target = target;
  w.note = el.note.value.trim();
  commit('Watchlist aggiornata');
  app.popSheet();
};

/* ---------- Actions ---------- */
function removeWatch(pred) {
  const d = D();
  const gone = d.watch.filter(pred);
  if (!gone.length) return;
  d.watch = d.watch.filter((w) => !pred(w));
  const ids = new Set(gone.map((w) => w.id));
  S.sheets = S.sheets.filter((s) => !(s.name === 'watchForm' && s.args && ids.has(s.args.id)));
  commit(gone.length === 1 ? `${gone[0].name || gone[0].symbol} rimosso dalla watchlist` : 'Rimossi dalla watchlist');
  app.renderSheet();
}

Object.assign(ACTIONS, {
  'open-quote': (el) => {
    const symbol = el.dataset.symbol;
    if (!symbol) return;
    const top = S.sheets[S.sheets.length - 1];
    if (top && top.name === 'quote' && top.args && top.args.symbol === symbol) return;
    const args = { symbol };
    for (const k of ['name', 'exchange', 'type']) if (el.dataset[k]) args[k] = el.dataset[k];
    app.pushSheet('quote', args);
  },
  'watch-add': (el) => {
    const symbol = el.dataset.symbol;
    if (!symbol) {
      // From the watchlist header: search first, then add from the quote sheet
      if (S.ui.tab !== 'market') {
        S.ui.tab = 'market';
        app.render();
      }
      const input = typeof document !== 'undefined' ? document.getElementById('mkt-q') : null;
      if (input) {
        input.focus();
        input.scrollIntoView({ block: 'center' });
      }
      app.toast('Cerca il titolo, aprilo e tocca «Aggiungi alla watchlist»');
      return;
    }
    if (D().watch.some((w) => w.symbol === symbol)) {
      app.toast('È già nella watchlist');
      return;
    }
    const q = quoteOf(symbol);
    const cat = exactCatalog(symbol);
    const name = el.dataset.name || (q && q.h.name) || (cat && cat.name) || symbol;
    const own = Object.values(D().assets).find((a) => a.symbol === symbol);
    const item = {
      id: newId('w'), symbol, ticker: tickerOf(symbol), name,
      currency: (q && q.currency) || (cat && cat.currency) || guessCurrency(symbol),
      price: q && !q.demo ? q.price : 0, target: 0, note: '',
    };
    if (own) item.aid = own.id;
    D().watch.push(item);
    commit(`${name} aggiunto alla watchlist`);
  },
  'watch-open': (el) => {
    if (D().watch.some((w) => w.id === el.dataset.id)) app.pushSheet('watchForm', { id: el.dataset.id });
  },
  'watch-remove': (el) => {
    const { id, symbol } = el.dataset;
    if (id) removeWatch((w) => w.id === id);
    else if (symbol) removeWatch((w) => w.symbol === symbol);
  },
  'mkt-clear': () => {
    S.ui.marketQuery = '';
    live.gen++;
    live.pending = false;
    const input = typeof document !== 'undefined' ? document.getElementById('mkt-q') : null;
    if (input) {
      input.value = '';
      input.focus();
    }
    updateResults();
  },
  'mkt-group': (el) => {
    if (GROUPS.includes(el.dataset.group)) popGroup = el.dataset.group;
    app.render();
  },
  'mkt-quote-range': (el) => {
    const top = S.sheets[S.sheets.length - 1];
    if (!top || top.name !== 'quote') return;
    top.args.range = el.dataset.range;
    app.renderSheet();
  },
  'mkt-bench': (el) => {
    const symbol = el.dataset.symbol;
    if (!symbol) return;
    const name = el.dataset.name || symbol;
    D().settings.benchmark = { symbol, name };
    commit(`Benchmark dei report: ${name}`);
    if (!market.getHistory(symbol) && market.status !== 'offline') market.ensureHistory(symbol).catch(() => {});
  },
});

INPUTS['mkt-search'] = (el, ev) => {
  if (ev && ev.type === 'change') return;
  S.ui.marketQuery = el.value;
  startLive(el.value);
  updateResults();
};

// A query kept from an earlier visit: fetch its live results again
MOUNTS.push(() => {
  if (S.ui.tab !== 'market') return;
  const q = String(S.ui.marketQuery || '').trim();
  if (q.length >= 2 && live.q !== q && !live.pending && market.status !== 'offline') {
    startLive(q);
    updateResults();
  }
});

export const _test = { quoteOf, yearStats, resultsHtml, num };
