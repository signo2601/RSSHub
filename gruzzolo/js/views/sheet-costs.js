// Report sheet 5 "Costi d'intermediazione": broker fees by kind, value-weighted TER, cost breakdown,
// monthly summary, the list of cost operations, withheld taxes, Italian stamp duty and the capital
// loss carry-forward ("zaino fiscale") with the user-entered P&L realized outside the app.
import { S, D, asset, assetCode, commit } from '../state.js';
import { ACTIONS, FORMS, INPUTS } from '../registry.js';
import { app } from '../app.js';
import { costStats, fiscalBackpack } from '../costs.js';
import { lineChart } from '../charts.js';
import { esc, icon, money, moneySigned, pct, fmtDate, fmtMonth, numInput, parseNum, tone } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, kpiCard, chartCard, tableCard } from './report.js';

const EVENTS_SHOWN = 50;
const MONTHS_SHOWN = 12;
const NOTES_SHOWN = 2;
const KIND_SHORT = { transaction: 'Commissione', autofx: 'AutoFX', connectivity: 'Connectivity', other: 'Altro' };
const KIND_COLOR = { transaction: 'var(--c1)', autofx: 'var(--c2)', connectivity: 'var(--c3)', other: 'var(--c-other)' };
const FUND_TYPES = new Set(['etf', 'fund']);

const ui = { allEvents: false, allMonths: false };

/* ---------- Helpers ---------- */
const pct2 = (v) => pct(v, 2);
const terAxis = (v) => (Number.isFinite(v) ? (v * 100).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + '%' : '');

// Status of a backpack row → pill class and label
const STATUS = {
  'scaduta': ['zs-expired', 'Scaduta'],
  'compensata': ['zs-used', 'Compensata'],
  'anno positivo': ['zs-positive', 'Anno positivo'],
  'in corso': ['zs-current', 'In corso'],
  'nessun movimento': ['zs-none', 'Nessun movimento'],
};
export function statusPill(status) {
  const s = String(status || '');
  const [cls, label] = STATUS[s] || (s.startsWith('usabile entro') ? ['zs-usable', 'Usabile entro ' + s.slice(14)] : ['zs-none', s || '—']);
  return `<span class="zs-pill ${cls}">${esc(label)}</span>`;
}

// One extra line under the pill: what is left, what was used
function statusNote(r) {
  if (r.status.startsWith('usabile entro')) return `restano ${money(r.remaining)}`;
  if (r.status === 'scaduta' && r.remaining > 0.005) return `${money(r.remaining)} non più usabili`;
  if (r.status === 'compensata' && r.usedBy && r.usedBy.length) return `usata nel ${[...new Set(r.usedBy.map((u) => u.year))].join(', ')}`;
  if ((r.status === 'anno positivo' || r.status === 'in corso') && r.offset > 0.005) return `${money(r.offset)} compensati con perdite passate`;
  if (r.status === 'in corso' && r.net < -0.005) return 'perdita provvisoria';
  return '';
}

/* ---------- Broker costs ---------- */
function costKpis(cs) {
  return `<div class="kpi-grid cost-kpis">
    ${kpiCard({ label: 'Transaction fees', value: money(cs.transaction), sub: 'commissioni su acquisti e vendite', info: 'transactionFees' })}
    ${kpiCard({ label: 'AutoFX fees', value: money(cs.autofx), sub: 'costi di cambio valuta', info: 'autofxFees' })}
    ${kpiCard({ label: 'Connectivity fees', value: money(cs.connectivity), sub: 'canoni per le borse estere', info: 'connectivityFees' })}
    ${kpiCard({ label: 'Costi broker totali', value: money(cs.totalBroker), sub: cs.other > 0.005 ? `altri costi inclusi: ${money(cs.other)}` : `dal ${fmtDate(cs.from)} al ${fmtDate(cs.to)}`, info: 'costiBroker', cls: 'hero' })}
  </div>`;
}

function terCard(cs, ctx) {
  const t = cs.ter;
  const w = ctx.wHalf;
  const funds = (t.byAsset || []).filter((r) => FUND_TYPES.has(r.type));
  const noTer = funds.filter((r) => r.ter === null);
  let chart;
  if (!t.date) chart = '<div class="chart-note">Nessun titolo in portafoglio nel periodo.</div>';
  else if (t.series.dates.length < 2) chart = '';
  else {
    chart = lineChart('rep-cost-ter', {
      dates: t.series.dates,
      series: [{ name: 'TER ponderato', color: 'var(--accent-line)', values: t.series.ter, width: 2, area: true }],
      w,
      h: 120,
      zero: true,
      yFormat: terAxis,
      tooltipValue: pct2,
      legend: false,
      ariaLabel: 'TER medio ponderato del portafoglio nel tempo',
    });
  }
  const missing = noTer.length
    ? `<p class="rcard-note ter-missing">${icon('alert')}<span>TER non indicato per ${noTer.map((r) => `<button class="link-btn" type="button" data-act="open-asset" data-aid="${esc(r.aid)}">${esc(assetCode(asset(r.aid)) || asset(r.aid).name)}</button>`).join(', ')}: aprilo e aggiungilo per un calcolo completo.</span></p>`
    : '';
  const body = `<div class="ter-top">
      <div class="ter-big"><span class="kpi-label">TER a fine periodo</span><b class="num">${t.date ? pct2(t.end) : '—'}</b><small>${t.date ? `al ${fmtDate(t.date)}` : ''}</small></div>
      <dl class="ter-stats">
        <div><dt>Media</dt><dd class="num">${t.date ? pct2(t.average) : '—'}</dd></div>
        <div><dt>Copertura</dt><dd class="num">${t.date ? pct(t.coverage, 0) : '—'}</dd></div>
        <div><dt>Costo annuo</dt><dd class="num">${money(t.annualCost)}</dd></div>
      </dl>
    </div>${chart}${missing}`;
  return chartCard({
    title: 'Weighted portfolio TER',
    subtitle: 'Costo annuo di ETF e fondi pesato sul valore: è già nel prezzo, non lo paghi a parte',
    info: 'ter',
    body,
  });
}

function breakdownTable(cs) {
  const rows = cs.breakdown.map((b) => [
    `<span class="cb-cat"><i style="background:${KIND_COLOR[b.key] || 'var(--c-other)'}" aria-hidden="true"></i>${esc(b.label)}</span>`,
    money(b.amount),
    `<span class="cb-share"><span class="cb-bar" aria-hidden="true"><i style="width:${(Math.max(0, Math.min(1, b.share)) * 100).toFixed(1)}%;background:${KIND_COLOR[b.key] || 'var(--c-other)'}"></i></span>${pct(b.share, 1)}</span>`,
  ]);
  return tableCard({
    title: 'Cost breakdown',
    info: 'costiBroker',
    columns: [{ label: 'Categoria', align: 'left' }, { label: 'Importo', align: 'right' }, { label: 'Peso sul totale', align: 'right' }],
    rows: cs.totalBroker > 0.005 ? rows : [],
    empty: 'Nessun costo del broker nel periodo',
    foot: ['Totale', money(cs.totalBroker), pct(1, 0)],
    cls: 'cost-bd',
  });
}

function monthlyTable(cs) {
  const all = cs.monthly;
  const list = ui.allMonths ? all : all.slice(0, MONTHS_SHOWN);
  const rows = list.map((m) => [
    esc(fmtMonth(m.month, true)),
    money(m.broker),
    money(m.incomeTaxes),
    `<b>${money(m.total)}</b>`,
  ]);
  const tb = all.reduce((s, m) => s + m.broker, 0);
  const ti = all.reduce((s, m) => s + m.incomeTaxes, 0);
  const toggle = all.length > MONTHS_SHOWN
    ? `<button class="link-btn" type="button" data-act="cost-months">${ui.allMonths ? 'Mostra solo gli ultimi 12 mesi' : `Mostra tutti i mesi (${all.length})`}</button>`
    : '';
  return tableCard({
    title: 'Monthly summary',
    columns: [{ label: 'Mese', align: 'left' }, { label: 'Costi broker', align: 'right' }, { label: 'Imposte su redditi', align: 'right' }, { label: 'Totale', align: 'right' }],
    rows,
    empty: 'Nessun costo o imposta nel periodo',
    foot: [all.length > list.length ? `Totale (${all.length} mesi)` : 'Totale', money(tb), money(ti), money(tb + ti)],
    note: `Solo i mesi con almeno un costo; «Imposte su redditi» sono le ritenute su dividendi e cedole.${toggle ? ' ' + toggle : ''}`,
    cls: 'full cost-monthly',
  });
}

function eventsTable(cs) {
  const all = cs.events;
  const list = ui.allEvents ? all : all.slice(0, EVENTS_SHOWN);
  const rows = list.map((e) => [
    `<span class="nowrap">${fmtDate(e.date)}</span>`,
    esc(e.accName || ''),
    esc(KIND_SHORT[e.kind] || 'Altro'),
    e.txId
      ? `<button class="link-btn cost-desc" type="button" data-act="open-tx" data-id="${esc(e.txId)}">${esc(e.desc || e.label)}</button>`
      : esc(e.desc || e.label),
    e.ref ? `<span class="muted">${esc(e.ref)}</span>` : '<span class="muted">—</span>',
    money(e.amount),
  ]);
  const toggle = all.length > EVENTS_SHOWN
    ? `<button class="link-btn" type="button" data-act="cost-all">${ui.allEvents ? `Mostra solo le ultime ${EVENTS_SHOWN}` : `Mostra tutte (${all.length})`}</button>`
    : '';
  return tableCard({
    title: `Operazioni di costo${all.length ? ` (${all.length})` : ''}`,
    columns: [
      { label: 'Data', align: 'left' }, { label: 'Conto', align: 'left' }, { label: 'Tipo', align: 'left' },
      { label: 'Descrizione', align: 'left' }, { label: 'Ordine', align: 'left' }, { label: 'Importo', align: 'right' },
    ],
    rows,
    empty: 'Nessuna commissione nel periodo',
    note: `${all.length > list.length ? `Ultime ${list.length} di ${all.length}. ` : ''}Tocca la descrizione per aprire l'operazione.${toggle ? ' ' + toggle : ''}`,
    cls: 'full cost-events',
  });
}

/* ---------- Taxes ---------- */
function taxKpis(cs) {
  const sd = cs.stampDuty;
  const ref = sd.refDate ? `${sd.refDate.slice(8, 10)}/${sd.refDate.slice(5, 7)}/${sd.refDate.slice(0, 4)}` : '—';
  const stampValue = sd.recorded > 0.005 ? sd.recorded : sd.amount;
  const stampSub = `Riferimento ${ref} · Base titoli ${money(sd.base)}${sd.recorded > 0.005 ? ' · registrata' : ' · stima'}`;
  const prev = cs.prevYearTaxes || {};
  const prevParts = [];
  if (prev.capital > 0.005) prevParts.push(`plusvalenze ${money(prev.capital)}`);
  if (prev.income > 0.005) prevParts.push(`ritenute ${money(prev.income)}`);
  if (prev.stamp > 0.005) prevParts.push(`bollo ${money(prev.stamp)}`);
  else if (cs.estimatedStamp > 0.005) prevParts.push(`bollo stimato ${money(cs.estimatedStamp)}`);
  if (prev.other > 0.005) prevParts.push(`altre ${money(prev.other)}`);
  const rateLabel = pct(Number.isFinite(sd.rate) ? sd.rate : 0.002, 2);
  return `<div class="kpi-grid cost-tax-kpis">
    ${kpiCard({ label: 'Tasse su plusvalenze', value: money(cs.capitalTaxes), sub: cs.capitalTaxes > 0.005 ? 'trattenute sulle vendite del periodo' : 'nessuna registrata nel periodo', info: 'tassePlusvalenze' })}
    ${kpiCard({ label: 'Tasse su dividendi/cedole', value: money(cs.incomeTaxes), sub: 'ritenute del periodo', info: 'tasseDividendi' })}
    ${kpiCard({ label: `Imposta di bollo (${rateLabel})`, value: money(stampValue), sub: `${esc(stampSub)} · anno ${sd.year}`, info: 'bollo' })}
    ${kpiCard({ label: 'Totale imposte (anno prec.)', value: money(cs.totalTaxesPrevYear), sub: `${cs.prevYear}${prevParts.length ? ': ' + prevParts.join(' · ') : ': nessuna imposta'}`, info: 'totaleImposte' })}
  </div>`;
}

/* ---------- Zaino fiscale ---------- */
function extInput(r) {
  const y = String(r.year);
  if (S.ui.hide) {
    return `<div class="zx-ext"><input class="zx-input" type="text" value="" placeholder="•••••" disabled aria-label="P&L esterno ${y} (nascosto)"></div>`;
  }
  const v = Math.abs(r.external) > 0.004 ? numInput(Math.round(r.external * 100) / 100) : '';
  return `<form class="zx-ext" data-form="cost-ext" data-year="${y}" autocomplete="off">
    <button class="zx-sign" type="button" data-act="cost-ext-sign" data-year="${y}" aria-label="Cambia segno: perdita o guadagno ${y}" title="Cambia segno (+/−)">±</button>
    <input class="zx-input num" type="text" name="v" inputmode="decimal" enterkeyhint="done" autocomplete="off" spellcheck="false"
      data-input="cost-ext" data-year="${y}" value="${esc(v)}" placeholder="0" aria-label="P&L esterno ${y} in euro (perdita con il segno meno)">
  </form>`;
}

function backpackCard(fb, ctx) {
  const rows = fb.rows.map((r) => {
    const note = statusNote(r);
    return `<tr class="${r.status === 'scaduta' ? 'zx-row-expired' : ''}${r.status === 'in corso' ? ' zx-row-current' : ''}">
      <th scope="row" class="zx-year">${r.year}</th>
      <td class="num"><span class="${tone(r.portfolio)}">${moneySigned(r.portfolio)}</span>${r.ignored > 0.005 ? `<small class="zx-sub">guadagni ETF esclusi ${money(r.ignored)}</small>` : ''}</td>
      <td class="num">${extInput(r)}</td>
      <td class="num"><b class="${tone(r.net)}">${moneySigned(r.net)}</b></td>
      <td>${statusPill(r.status)}${note ? `<small class="zx-sub">${note}</small>` : ''}</td>
    </tr>`;
  }).join('');
  const rate = Number.isFinite(ctx.settings.taxRate) ? ctx.settings.taxRate : 0.26;
  const notes = fb.notes || [];
  const first = notes.slice(0, NOTES_SHOWN).map((n) => `<li>${esc(n)}</li>`).join('');
  const rest = notes.slice(NOTES_SHOWN).map((n) => `<li>${esc(n)}</li>`).join('');
  return `<section class="card rcard zaino-card">
    <header class="rcard-head">
      <div class="rcard-titles"><h3 class="rcard-title">Zaino fiscale – minusvalenze compensabili</h3>
      <p class="rcard-sub">Le perdite realizzate vendendo (minusvalenze) riducono le tasse sui guadagni futuri per 4 anni. Scrivi in «P&amp;L esterno» i guadagni (+) o le perdite (−) fatti fuori dall'app, per esempio su un altro conto.</p></div>
      ${infoBtn('zainoFiscale')}
    </header>
    <div class="table-wrap"><table class="table zx-table">
      <thead><tr><th scope="col">Anno</th><th scope="col" class="num">P&amp;L portafoglio</th><th scope="col" class="num">P&amp;L esterno</th><th scope="col" class="num">Netto anno</th><th scope="col">Stato</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="zx-sum">
      <div class="zx-box main"><span class="kpi-label">Zaino fiscale disponibile</span><b class="num">${money(fb.available)}</b><small>minusvalenze ancora usabili</small></div>
      <div class="zx-box"><span class="kpi-label">Risparmio d'imposta potenziale (${pct(rate, 0)})</span><b class="num up">${money(fb.potentialSaving)}</b><small>tasse risparmiate su futuri guadagni</small></div>
      <div class="zx-box"><span class="kpi-label">Minusvalenze scadute (non compensabili)</span><b class="num${fb.expired > 0.005 ? ' down' : ''}">${money(fb.expired)}</b><small>perse perché troppo vecchie</small></div>
      ${fb.crypto && fb.crypto.active ? `<div class="zx-box"><span class="kpi-label">Zaino cripto (separato)</span><b class="num">${money(fb.crypto.available)}</b><small>minusvalenze su cripto: compensano solo plusvalenze su cripto</small></div>` : ''}
    </div>
    <ul class="zx-notes">${first}</ul>
    ${rest ? `<details class="zx-more"><summary>Altre note (${notes.length - NOTES_SHOWN})</summary><ul class="zx-notes">${rest}</ul></details>` : ''}
  </section>`;
}

/* ---------- Sheet ---------- */
function renderCosts(ctx) {
  const settings = ctx.settings || D().settings;
  const cs = costStats({ accIds: ctx.accIds, from: ctx.from, to: ctx.to, today: ctx.today, settings });
  const fb = fiscalBackpack({ accIds: ctx.accIds, today: ctx.today, settings });
  const scopeNote = ctx.accIds ? '<p class="report-note">' + icon('info') + '<span>Stai guardando un solo conto: costi, imposte e zaino fiscale riguardano solo le sue operazioni.</span></p>' : '';
  return `<div class="cost-sheet stack-lg">
    ${scopeNote}
    ${costKpis(cs)}
    <div class="chart-grid">
      ${terCard(cs, ctx)}
      ${breakdownTable(cs)}
      ${monthlyTable(cs)}
      ${eventsTable(cs)}
    </div>
    <div class="sec-head cost-sec"><h3>Imposte</h3></div>
    ${taxKpis(cs)}
    ${backpackCard(fb, ctx)}
  </div>`;
}

/* ---------- Actions and inputs ---------- */
// The value is stored at once; the re-render waits a moment, so a tap on another control
// (which blurs the field and fires "change") is not lost under a re-rendered page
let commitTimer = null;
function saveExternal(year, value) {
  const st = D().settings;
  const ext = st.externalPL && typeof st.externalPL === 'object' ? { ...st.externalPL } : {};
  const before = Number(ext[year]) || 0;
  if (!Number.isFinite(value) || Math.abs(value) < 0.005) delete ext[year];
  else ext[year] = Math.round(value * 100) / 100;
  if (Math.abs((Number(ext[year]) || 0) - before) < 0.005) return false;
  st.externalPL = ext;
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    commitTimer = null;
    commit('P&L esterno salvato');
  }, 250);
  return true;
}

// '' → 0 (cleared); invalid text → NaN
export function parseExternal(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return 0;
  return parseNum(t);
}

INPUTS['cost-ext'] = (el, ev) => {
  if (ev && ev.type !== 'change') return;
  const year = el.dataset.year;
  const v = parseExternal(el.value);
  if (!year) return;
  if (!Number.isFinite(v)) {
    app.toast('Scrivi un importo in euro, per esempio −75 o 120,50');
    return;
  }
  saveExternal(year, v);
};

FORMS['cost-ext'] = (form) => {
  const input = form.querySelector('input');
  if (input) input.blur(); // fires "change", which saves
};

Object.assign(ACTIONS, {
  'cost-all': () => {
    ui.allEvents = !ui.allEvents;
    app.render();
  },
  'cost-months': () => {
    ui.allMonths = !ui.allMonths;
    app.render();
  },
  'cost-ext-sign': (el) => {
    const year = el.dataset.year;
    const box = el.closest('.zx-ext');
    const input = box ? box.querySelector('input') : null;
    if (!year || !input) return;
    const v = parseExternal(input.value);
    if (!Number.isFinite(v) || Math.abs(v) < 0.005) {
      input.focus();
      app.toast('Scrivi prima l\'importo, poi tocca ± per farlo diventare una perdita');
      return;
    }
    input.value = numInput(-v);
    saveExternal(year, -v);
  },
});

registerSheet({
  id: 'costs',
  order: 5,
  title: 'Costi d\'intermediazione',
  subtitle: 'Commissioni broker, imposte su redditi e patrimonio, minusvalenze compensabili.',
  render: renderCosts,
});

export const _test = { statusPill, statusNote, parseExternal, saveExternal, ui };
