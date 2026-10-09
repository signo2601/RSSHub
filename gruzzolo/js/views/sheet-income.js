// Report sheet 4 "Dividendi & Fixed Income": income received in the period, 12-month yield,
// currency mix of dividends and bonds, 12-month payment calendar (with forecasts), cumulative
// income, yields and return decomposition, next-12-months forecast per security and market
// dividends not yet recorded (one tap to record them).
import { S, D, asset, assetCode, account, commit, CURRENCIES } from '../state.js';
import { ACTIONS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { assetHistory, positions, qtyAt } from '../engine.js';
import { incomeStats, KIND_LABEL } from '../income.js';
import { lineChart, donutChart } from '../charts.js';
import { esc, icon, money, moneyLocal, pct, pctSigned, num, compact, fmtDate, MONTHS, addDays, newId, tone, sum } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, kpiCard, chartCard, tableCard } from './report.js';
import { avatar } from './home.js';

const MAX_POINTS = 360;
const CAL_ITEMS = 4; // payments listed per month card before "+N altri"
const MISSING_SHOWN = 6;
const DIV_COLOR = 'var(--c1)';
const COUPON_COLOR = 'var(--c2)';
const RECORD_NOTE = 'Registrato da dati di mercato (stima)';

const ui = { missingAll: false };
// Parameters of the last rendered sheet: the "Registra" action recomputes the same suggestions
let lastParams = null;

/* ---------- Helpers ---------- */
const round2 = (v) => Math.round((v + Math.sign(v) * Number.EPSILON) * 100) / 100;
const ccyColor = (code) => {
  const i = CURRENCIES.indexOf(code);
  return i >= 0 && i < 8 ? `var(--c${i + 1})` : 'var(--c-other)';
};
// Short code of a paying security ('ENEL'); cash interest has no asset
export function payerCode(aid) {
  if (!aid) return 'Interessi';
  const a = asset(aid);
  return assetCode(a) || a.name || '—';
}
const moneyAxis = () => (S.ui.hide ? () => '' : (v) => compact(v));

// Evenly spaced indices (first and last kept)
export function sampleEven(n, max = MAX_POINTS) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const out = [];
  const step = (n - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(Math.round(k * step));
  return [...new Set(out)];
}

function incomeFor(ctx) {
  lastParams = { accIds: ctx.accIds, from: ctx.from, to: ctx.to, today: ctx.today, settings: ctx.settings };
  return incomeStats(lastParams);
}

// Year shown by the calendar: the chosen one when it has data, else the current year
export function calendarYear(inc, today, chosen = S.ui.incomeYear) {
  const years = inc.years && inc.years.length ? inc.years : [+today.slice(0, 4)];
  const y = Number(chosen);
  if (Number.isInteger(y) && years.includes(y)) return y;
  const cur = +today.slice(0, 4);
  return years.includes(cur) ? cur : years[years.length - 1];
}

/* ---------- Layout ---------- */
// Desktop split (KPIs and donuts on the left, calendar and chart on the right) when there is room
export function layout(ctx) {
  const cw = ctx.w + 32;
  const split = Boolean(ctx.desktop) && cw >= 860;
  const side = split ? Math.max(280, Math.min(340, Math.round(cw * 0.3))) : cw;
  const mainW = split ? cw - side - 16 : cw;
  return { split, side, chartW: Math.max(200, Math.floor(mainW - 32)) };
}

/* ---------- Cards ---------- */
function topKpis(inc) {
  return `${kpiCard({
    label: 'Dividendi totali ricevuti',
    value: money(inc.dividends),
    sub: `netti, nel periodo${inc.taxes > 0.005 ? ` · ritenute ${money(inc.taxes)}` : ''}`,
    info: 'dividendiTotali',
  })}${kpiCard({
    label: 'Dividend yield (12M)',
    value: pct(inc.yield12m),
    sub: inc.income12m > 0.005 ? `${money(inc.income12m)} negli ultimi 12 mesi` : 'nessun incasso negli ultimi 12 mesi',
    info: 'dividendYield12m',
  })}`;
}

function donutBlock(id, items, { emptyText, aria, centerLabel }) {
  const list = items.filter((it) => it.value > 0.005);
  if (!list.length) return `<div class="chart-note inc-note-sm">${esc(emptyText)}</div>`;
  const total = sum(list, (it) => it.value);
  const colored = list.map((it) => ({ key: it.key, label: it.label, value: it.value, color: ccyColor(it.key) }));
  const donut = donutChart(id, {
    items: colored,
    size: 124,
    centerValue: list.length === 1 ? list[0].key : String(list.length),
    centerLabel: list.length === 1 ? '100%' : centerLabel,
    legend: false,
    ariaLabel: aria,
  });
  const rows = colored.map((it) => `<li class="idn-item">
      <i style="background:${it.color}" aria-hidden="true"></i>
      <span class="idn-label" title="${esc(it.label)}">${esc(it.key)}</span>
      <span class="idn-share num">${pct(it.value / total, 1)}</span>
      <span class="idn-value num">${money(it.value)}</span>
    </li>`).join('');
  return `<div class="inc-donut"><div class="idn-chart">${donut}</div><ul class="idn-list">${rows}</ul></div>`;
}

function currencyCards(inc) {
  return `${chartCard({
    title: 'Valuta dividendi',
    subtitle: 'Incassi del periodo per valuta del titolo',
    info: 'valutaDividendi',
    body: donutBlock('rep-inc-ccy', inc.byCurrency, { emptyText: 'Nessun incasso nel periodo', aria: 'Dividendi per valuta', centerLabel: 'valute' }),
  })}${chartCard({
    title: 'Valuta bond',
    subtitle: 'Valore attuale delle obbligazioni per valuta',
    info: 'valutaBond',
    body: donutBlock('rep-inc-bond', inc.bondByCurrency, { emptyText: 'Nessuna obbligazione', aria: 'Obbligazioni per valuta', centerLabel: 'valute' }),
  })}`;
}

function calendarCard(inc, ctx) {
  const years = inc.years && inc.years.length ? inc.years : [+ctx.today.slice(0, 4)];
  const year = calendarYear(inc, ctx.today);
  const months = inc.calendar(year);
  const thisYear = +ctx.today.slice(0, 4);
  const curMonth = +ctx.today.slice(5, 7) - 1;
  let received = 0;
  let forecast = 0;
  const cards = months.map((m) => {
    const isCur = year === thisYear && m.month === curMonth;
    const real = m.items.filter((it) => !it.forecast);
    const fc = m.items.filter((it) => it.forecast);
    const rTot = sum(real, (it) => it.amount);
    const fTot = sum(fc, (it) => it.amount);
    received += rTot;
    forecast += fTot;
    const shown = m.items.slice(0, CAL_ITEMS);
    const more = m.items.length - shown.length;
    const items = shown.map((it) => {
      const code = payerCode(it.aid);
      const title = `${it.aid ? asset(it.aid).name : 'Interessi sulla liquidità'} · ${KIND_LABEL[it.kind] || 'Incasso'} · ${it.forecast ? 'data prevista' : 'data pagamento'} ${fmtDate(it.date)}`;
      return `<li class="ical-item${it.forecast ? ' fc' : ''}" title="${esc(title)}">
        <span class="ical-code">${esc(code)}${it.forecast ? ' <small>previsto</small>' : ''}</span>
        <span class="ical-amt num">${it.forecast ? '≈ ' : ''}${money(it.amount)}</span>
      </li>`;
    }).join('');
    const totalHtml = m.items.length
      ? `<b class="ical-total num${real.length ? '' : ' fc'}">${real.length ? '' : '≈ '}${money(rTot + fTot)}</b>`
      : '<b class="ical-total muted">—</b>';
    return `<div class="ical-month${isCur ? ' current' : ''}${m.items.length ? '' : ' empty'}">
      <div class="ical-head"><span>${esc(MONTHS[m.month])}</span>${totalHtml}</div>
      ${m.items.length ? `<ul class="ical-items">${items}${more > 0 ? `<li class="ical-more">+${more} ${more === 1 ? 'altro' : 'altri'}</li>` : ''}</ul>` : ''}
    </div>`;
  }).join('');
  const i = years.indexOf(year);
  const prev = i > 0 ? years[i - 1] : null;
  const next = i >= 0 && i < years.length - 1 ? years[i + 1] : null;
  const yearNav = `<div class="ical-year" role="group" aria-label="Anno del calendario">
    <button class="icon-btn" type="button" data-act="inc-year" data-year="${prev ?? ''}" aria-label="Anno precedente"${prev === null ? ' disabled' : ''}>${icon('chevLeft')}</button>
    <b class="num" aria-live="polite">${year}</b>
    <button class="icon-btn" type="button" data-act="inc-year" data-year="${next ?? ''}" aria-label="Anno successivo"${next === null ? ' disabled' : ''}>${icon('chevRight')}</button>
  </div>`;
  const summary = `Incassati nel ${year}: <b>${money(received)}</b>${forecast > 0.005 ? ` · previsti entro dicembre: <b class="fc">≈ ${money(forecast)}</b>` : ''}`;
  return `<section class="chart-card rcard ical-card">
    <header class="rcard-head">
      <div class="rcard-titles"><h3 class="rcard-title">Calendario cedole e dividendi</h3><p class="rcard-sub">Mese per mese: incassati e previsti (in corsivo, stimati)</p></div>
      <div class="ical-tools">${yearNav}${infoBtn('calendarioIncome')}</div>
    </header>
    <div class="ical-grid">${cards}</div>
    <p class="ical-sum">${summary}</p>
  </section>`;
}

function cumulativeCard(inc, ctx, w) {
  const c = inc.cumulative;
  const n = c.dates.length;
  const last = n ? (c.dividends[n - 1] || 0) + (c.coupons[n - 1] || 0) : 0;
  let body;
  if (n < 2 || last < 0.005) body = '<div class="chart-note">Nessun dividendo o cedola incassato nel periodo.</div>';
  else {
    const idx = sampleEven(n);
    const pick = (arr) => idx.map((i) => arr[i]);
    body = lineChart('rep-inc-cum', {
      dates: pick(c.dates),
      series: [
        { name: 'Dividendi', color: DIV_COLOR, values: pick(c.dividends), width: 2.2 },
        { name: 'Cedole', color: COUPON_COLOR, values: pick(c.coupons), width: 2 },
      ],
      w,
      h: ctx.desktop ? 230 : 200,
      zero: true,
      yFormat: moneyAxis(),
      tooltipValue: (v) => money(v),
      legend: true,
      ariaLabel: 'Cedole e dividendi cumulati nel periodo',
    });
  }
  return chartCard({
    title: 'Cedole e dividendi cumulati',
    subtitle: `Somma progressiva degli incassi netti dal ${fmtDate(inc.from)} al ${fmtDate(inc.to)} (interessi inclusi nei dividendi)`,
    info: 'incomeCumulato',
    body,
  });
}

function bottomKpis(inc) {
  const parts = [];
  if (inc.dividends > 0.005) parts.push(`dividendi ${money(inc.dividends)}`);
  if (inc.coupons > 0.005) parts.push(`cedole ${money(inc.coupons)}`);
  if (inc.interest > 0.005) parts.push(`interessi ${money(inc.interest)}`);
  const freq = inc.frequency || { label: 'Nessuna', byAsset: [] };
  const counts = new Map();
  for (const f of freq.byAsset) counts.set(f.label, (counts.get(f.label) || 0) + 1);
  const freqSub = counts.size
    ? [...counts.entries()].map(([l, c]) => `${c} ${l.toLowerCase()}`).join(' · ')
    : 'nessun pagamento negli ultimi 12 mesi';
  const prv = `<span class="ipr"><span class="ipr-row"><small>Prezzo</small><b class="${tone(inc.priceReturn, 0.00005)}">${pctSigned(inc.priceReturn)}</b></span>`
    + `<span class="ipr-row"><small>Income</small><b class="${tone(inc.incomeReturn, 0.00005)}">${pctSigned(inc.incomeReturn)}</b></span></span>`;
  return `<div class="kpi-grid inc-bottom">
    ${kpiCard({ label: 'Yield distribuzione', value: pct(inc.yieldPeriod), sub: 'incassi sul valore medio, su base annua', info: 'yieldDistribuzione' })}
    ${kpiCard({ label: 'Income totale (€)', value: money(inc.total), sub: parts.length ? parts.join(' · ') : 'nessun incasso nel periodo', info: 'incomeTotale' })}
    ${kpiCard({ label: 'Rendimento prezzo vs income', value: prv, valueClass: 'ipr-value', sub: `rendimento totale (TWR) ${pctSigned(inc.twr)}`, info: 'prezzoVsIncome' })}
    ${kpiCard({ label: 'Income annuo stimato', value: money(inc.forecast12m), sub: inc.forecast12m > 0.005 ? `prossimi 12 mesi, netto · ≈ ${money(inc.forecast12m / 12)} al mese` : 'nessun pagamento atteso', info: 'incomeStimato' })}
    ${kpiCard({ label: 'Frequenza distribuzione', value: esc(freq.label === 'Nessuna' ? '—' : freq.label), sub: esc(freqSub), info: 'frequenzaDistribuzione' })}
  </div>`;
}

function titleCell(aid) {
  const a = asset(aid);
  return `<button class="pos-link" type="button" data-act="open-asset" data-aid="${esc(aid)}">
    ${avatar(a, 'sm')}<span class="pl-main"><span class="pl-name">${esc(a.name)}</span><span class="pl-sub">${esc(assetCode(a) || '')}</span></span>
  </button>`;
}

function forecastTable(inc, ctx) {
  const rows = inc.forecastByAsset.map((f) => {
    const next = (f.nextDates || []).find((d) => d > ctx.today) || null;
    const perShare = f.source === 'market'
      ? `${moneyLocal(f.perShare, f.currency, { mask: false })} <span class="muted">lordo</span>`
      : `${moneyLocal(f.perShare, 'EUR', { mask: false })} <span class="muted">netto</span>`;
    return [
      titleCell(f.aid),
      esc(KIND_LABEL[f.kind] || 'Dividendo'),
      esc(f.frequency),
      next ? fmtDate(next) : '<span class="muted">—</span>',
      perShare,
      S.ui.hide ? '•••' : num(f.qty, f.qty < 1 ? 6 : 3),
      `<b>${money(f.amount)}</b>`,
    ];
  });
  return tableCard({
    title: 'Prossimi 12 mesi per titolo',
    info: 'incomeStimato',
    columns: [
      { label: 'Titolo', align: 'left' }, { label: 'Tipo', align: 'left' }, { label: 'Frequenza', align: 'left' },
      { label: 'Prossimo', align: 'right' }, { label: 'Per quota (12 mesi)', align: 'right' }, { label: 'Quantità', align: 'right' },
      { label: 'Stima netta', align: 'right' },
    ],
    rows,
    empty: 'Nessun titolo in portafoglio ha pagato dividendi o cedole negli ultimi 12 mesi.',
    foot: ['Totale', '', '', '', '', '', money(inc.forecast12m)],
    note: 'Stima: ripete i pagamenti degli ultimi 12 mesi sulle quantità di oggi. «Lordo» = dividendo di mercato per quota prima delle tasse; «netto» = dai pagamenti che hai registrato. La stima netta toglie la ritenuta italiana.',
    cls: 'full inc-fc-table',
  });
}

// Why some suggestions cannot be computed yet (market dividends unavailable): '' when all is there
function missingStatus(ctx) {
  const linked = positions({ accIds: ctx.accIds, date: ctx.today })
    .filter((p) => p.qty > 0 && p.asset.symbol && p.asset.priceSource !== 'manual' && p.asset.type !== 'cash');
  const n = linked.filter((p) => !assetHistory(p.asset)).length;
  if (!n) return '';
  const what = n === 1 ? '1 titolo' : `${n} titoli`;
  if (market.status === 'offline') return `Sei offline: mancano i dati di mercato di ${what}, quindi non posso cercare i dividendi non registrati. Riprova quando torni online.`;
  return `Carico i dati di mercato di ${what} per cercare i dividendi non registrati…`;
}

function missingCard(inc, ctx) {
  const list = inc.missing || [];
  const status = missingStatus(ctx);
  if (!list.length) {
    if (!status) return '';
    return `<section class="card rcard inc-missing-card">
      <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">Dividendi da registrare</h3></div>${infoBtn('dividendiMancanti')}</header>
      <p class="rcard-note">${esc(status)}</p>
    </section>`;
  }
  const shown = ui.missingAll ? list : list.slice(0, MISSING_SHOWN);
  const rows = shown.map((m) => {
    const a = asset(m.aid);
    const kind = KIND_LABEL[m.kind] || 'Dividendo';
    const qty = S.ui.hide ? '•••' : num(m.qty, m.qty < 1 ? 6 : 3);
    return `<div class="row inc-miss-row">
      ${avatar(a, 'sm')}
      <span class="row-main">
        <span class="row-title">${esc(a.name)}</span>
        <span class="row-sub">${esc(kind)} · stacco ${fmtDate(m.date)} · ${qty} × ${moneyLocal(m.perShare, m.currency, { mask: false })}</span>
        <span class="row-sub">≈ <b>${money(m.net)}</b> netti (lordo ${money(m.gross)})</span>
      </span>
      <button class="btn sm" type="button" data-act="inc-record" data-aid="${esc(m.aid)}" data-date="${esc(m.date)}" aria-label="Registra ${esc(kind.toLowerCase())} di ${esc(a.name)} del ${fmtDate(m.date)}">Registra</button>
    </div>`;
  }).join('');
  const more = list.length > MISSING_SHOWN
    ? `<button class="link-btn inc-more" type="button" data-act="inc-missing-all">${ui.missingAll ? 'Mostra meno' : `Mostra tutti (${list.length})`}</button>`
    : '';
  return `<section class="card rcard inc-missing-card">
    <header class="rcard-head">
      <div class="rcard-titles"><h3 class="rcard-title">Dividendi da registrare (${list.length})</h3>
      <p class="rcard-sub">Secondo i dati di mercato dovresti averli ricevuti, ma non risultano tra le operazioni.</p></div>
      ${infoBtn('dividendiMancanti')}
    </header>
    <div class="list flush">${rows}</div>
    ${more}
    ${status ? `<p class="rcard-note">${esc(status)}</p>` : ''}
    <p class="rcard-note inc-est">${icon('info')}<span>Gli importi sono stime: dividendo per quota × quote possedute il giorno prima dello stacco, al cambio del giorno, meno la ritenuta italiana (${pct(ctx.settings.taxRate ?? 0.26, 0)}; ${pct(ctx.settings.govTaxRate ?? 0.125, 1)} sui titoli di Stato). Controlla l'estratto conto del broker e correggi l'operazione se l'importo è diverso.</span></p>
  </section>`;
}

function emptyIncome(inc) {
  const hasOpen = inc.value > 0.005;
  return `<div class="card rcard inc-empty">
    <div class="inc-empty-ico">${icon('coins')}</div>
    <h3>Ancora nessun dividendo o cedola</h3>
    <p>Quando incassi un dividendo, una cedola o gli interessi sulla liquidità, registrali con il tasto + oppure importa l'estratto conto del broker: qui vedrai calendario, rendimento e stime per i prossimi 12 mesi.</p>
    <div class="btns">
      <button class="btn primary" type="button" data-act="add-tx" data-type="div">${icon('plus')}Registra un dividendo</button>
      ${hasOpen ? '' : '<button class="btn" type="button" data-act="tab" data-tab="more">Importa operazioni</button>'}
    </div>
  </div>`;
}

/* ---------- Sheet ---------- */
function renderIncome(ctx) {
  const inc = incomeFor(ctx);
  const everPaid = inc.years.some((y) => inc.calendar(y).some((m) => m.items.length));
  if (!everPaid && !inc.forecastByAsset.length && !(inc.missing || []).length && inc.total < 0.005) {
    return `<div class="inc-sheet stack-lg">${emptyIncome(inc)}${missingCard(inc, ctx)}</div>`;
  }
  const lay = layout(ctx);
  const side = `<div class="inc-side">
      <div class="kpi-grid inc-kpis">${topKpis(inc)}</div>
      <div class="inc-donuts">${currencyCards(inc)}</div>
    </div>`;
  const main = `<div class="inc-main">${calendarCard(inc, ctx)}${cumulativeCard(inc, ctx, lay.chartW)}</div>`;
  return `<div class="inc-sheet stack-lg">
    <div class="inc-top${lay.split ? ' split' : ''}" style="--inc-side:${lay.side}px">${side}${main}</div>
    ${bottomKpis(inc)}
    ${forecastTable(inc, ctx)}
    ${missingCard(inc, ctx)}
  </div>`;
}

/* ---------- Actions ---------- */
// Accounts of the scope that held the asset on the day before the ex-date (fallback: on the day),
// with their quantities: the suggestion is split among them
export function holdersAt(accIds, aid, date) {
  const ids = accIds && accIds.length ? accIds : D().accounts.map((a) => a.id);
  for (const day of [addDays(date, -1), date]) {
    const out = ids.map((acc) => ({ acc, qty: qtyAt([acc], aid, day) })).filter((h) => h.qty > 1e-9);
    if (out.length) return out;
  }
  return [];
}

// Dividend transactions for a market suggestion: net amount, tax = gross − net, split by holder
export function recordTxns(m, holders) {
  const total = sum(holders, (h) => h.qty);
  if (!(total > 0)) return [];
  const demo = Boolean(asset(m.aid).demo);
  return holders.map((h) => {
    const share = h.qty / total;
    const net = round2(m.net * share);
    const tax = round2(m.gross * share - net);
    const t = { id: newId('t'), acc: h.acc, date: m.date, type: 'div', aid: m.aid, amount: net, note: RECORD_NOTE };
    if (tax > 0) t.tax = tax;
    if (demo) t.demo = true;
    return t;
  }).filter((t) => t.amount > 0);
}

Object.assign(ACTIONS, {
  'inc-year': (el) => {
    const y = Number(el.dataset.year);
    if (!Number.isInteger(y)) return;
    S.ui.incomeYear = y;
    app.render();
  },
  'inc-missing-all': () => {
    ui.missingAll = !ui.missingAll;
    app.render();
  },
  'inc-record': (el) => {
    const { aid, date } = el.dataset;
    if (!aid || !date || !lastParams) return;
    const inc = incomeStats(lastParams);
    const m = (inc.missing || []).find((x) => x.aid === aid && x.date === date);
    if (!m) {
      app.toast('Questo dividendo risulta già registrato');
      app.render();
      return;
    }
    const txns = recordTxns(m, holdersAt(lastParams.accIds, aid, date));
    if (!txns.length) {
      app.toast('Non trovo il conto che possedeva il titolo in quella data');
      return;
    }
    D().txns.push(...txns);
    const net = sum(txns, (t) => t.amount);
    const where = txns.length === 1 ? ` su ${(account(txns[0].acc) || {}).name || 'conto'}` : '';
    commit(`${KIND_LABEL[m.kind] || 'Dividendo'} ${payerCode(aid)} registrato${where}: ${money(net)}`);
  },
});

registerSheet({
  id: 'income',
  order: 4,
  title: 'Dividendi & Fixed Income',
  subtitle: 'Flussi da dividendi e cedole: calendario, cumulati e rendimento.',
  render: renderIncome,
});

export const _test = { sampleEven, calendarYear, layout, holdersAt, recordTxns, payerCode, missingStatus };
