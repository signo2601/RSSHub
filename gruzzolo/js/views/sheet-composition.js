// Report sheet 3 "Composizione": allocation donut by class / security / sector / region / currency,
// diversification KPIs, positions table, best and worst positions by unrealized return.
import { S, cached, TYPE_KEYS, TYPE_PLURAL, REGIONS, CURRENCIES, assetCode } from '../state.js';
import { ACTIONS } from '../registry.js';
import { app } from '../app.js';
import { positions, cashAt } from '../engine.js';
import { donutChart } from '../charts.js';
import { esc, money, moneySigned, pct, pctSigned, pctPlain, num, qtyFmt, priceFmt, fmtDate, tone, sum } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, kpiCard, tableCard, emptyCard } from './report.js';
import { avatar, pctPill, unitFor } from './home.js';

export const ALLOC_BY = [['class', 'Classe'], ['asset', 'Titoli'], ['sector', 'Settore'], ['region', 'Regione'], ['currency', 'Valuta']];
const BY_TEXT = { class: 'classe di investimento', asset: 'titolo', sector: 'settore', region: 'area geografica', currency: 'valuta' };
const FIXED = { class: TYPE_KEYS, region: REGIONS, currency: CURRENCIES };
const PALETTE = Array.from({ length: 8 }, (_, i) => `var(--c${i + 1})`);
const CASH_KEY = '__cash';
const OTHER_KEY = '__other';
const MAX_GROUPS = 8;

const validBy = (by) => (ALLOC_BY.some(([k]) => k === by) ? by : 'class');

// Groups of the allocation: [{ key, label, value, color, share }], top 7 + "Altro" when more than 8.
// cashBal (EUR on the broker accounts) joins as "Liquidità".
export function allocationGroups(open, by, cashBal = 0) {
  const map = new Map();
  const add = (key, label, value) => {
    const g = map.get(key) || { key, label, value: 0 };
    g.value += value;
    map.set(key, g);
  };
  for (const p of open) {
    if (!(p.value > 0)) continue;
    const a = p.asset;
    if (by === 'class') add(a.type || 'other', TYPE_PLURAL[a.type] || 'Altro', p.value);
    else if (by === 'asset') add(p.aid, a.name, p.value);
    else if (by === 'currency') add(a.currency || 'EUR', a.currency || 'EUR', p.value);
    else {
      const v = String(a[by] || '').trim();
      add(v || '—', v || 'Non specificato', p.value);
    }
  }
  if (cashBal > 0.005) {
    if (by === 'class') add('cash', TYPE_PLURAL.cash, cashBal);
    else if (by === 'currency') add('EUR', 'EUR', cashBal);
    else add(CASH_KEY, by === 'asset' ? 'Liquidità sul conto' : 'Liquidità', cashBal);
  }
  let groups = [...map.values()].sort((x, y) => y.value - x.value);
  if (groups.length > MAX_GROUPS) {
    const rest = groups.slice(MAX_GROUPS - 1);
    groups = groups.slice(0, MAX_GROUPS - 1).concat([{ key: OTHER_KEY, label: 'Altro', value: sum(rest, (g) => g.value), other: true, count: rest.length }]);
  }
  // Colors follow the entity where the list is fixed (classes, regions, currencies), the rank otherwise
  const fixed = FIXED[by];
  const used = new Set();
  for (const g of groups) {
    if (g.other) g.color = 'var(--c-other)';
    else if (fixed) {
      const i = fixed.indexOf(g.key);
      if (i >= 0) g.color = i < 8 ? PALETTE[i] : 'var(--c-other)';
    }
    if (g.color) used.add(g.color);
  }
  let next = 0;
  for (const g of groups) {
    if (g.color) continue;
    while (next < PALETTE.length && used.has(PALETTE[next])) next++;
    g.color = next < PALETTE.length ? PALETTE[next++] : 'var(--c-other)';
    used.add(g.color);
  }
  const total = sum(groups, (g) => g.value);
  for (const g of groups) g.share = total > 0 ? g.value / total : 0;
  return groups;
}

// Diversification of the open positions (cash balances excluded)
export function diversification(open) {
  const list = open.filter((p) => p.value > 0);
  const total = sum(list, (p) => p.value);
  const w = list.map((p) => (total > 0 ? p.value / total : 0)).sort((a, b) => b - a);
  const hhi = sum(w, (x) => x * x);
  const top = [...list].sort((a, b) => b.value - a.value)[0] || null;
  return {
    count: list.length,
    effective: hhi > 0 ? 1 / hhi : 0,
    top,
    topWeight: w[0] || 0,
    top5: sum(w.slice(0, 5)),
  };
}

function compData(ctx) {
  return cached(`rep-comp:${ctx.scopeKey}:${ctx.to}`, () => {
    const all = positions({ accIds: ctx.accIds, date: ctx.to });
    const open = all.filter((p) => p.qty > 0 && p.value > 0).sort((a, b) => b.value - a.value);
    const cashBal = Math.max(0, cashAt(ctx.accIds, ctx.to));
    return { open, cashBal, total: sum(open, (p) => p.value) + cashBal, div: diversification(open) };
  });
}

/* ---------- Allocation card ---------- */
function allocationCard(ctx, data) {
  const by = validBy(S.ui.allocBy);
  const groups = allocationGroups(data.open, by, data.cashBal);
  const sel = groups.some((g) => g.key === S.ui.allocSel) ? S.ui.allocSel : null;
  const selG = sel ? groups.find((g) => g.key === sel) : null;
  const size = ctx.desktop ? 230 : Math.min(230, Math.max(170, Math.round(ctx.w * 0.62)));
  const donut = groups.length
    ? donutChart('rep-comp-donut', {
      items: groups.map((g) => ({ key: g.key, label: g.label, value: g.value, color: g.color })),
      size,
      centerValue: selG ? pct(selG.share, 1) : money(data.total),
      centerLabel: selG ? selG.label : 'Totale',
      selected: sel,
      actKey: 'comp-sel',
      legend: false,
      ariaLabel: `Allocazione per ${BY_TEXT[by]}`,
    })
    : '';
  const items = groups.map((g) => `<button class="alloc-item" type="button" data-act="comp-sel" data-key="${esc(g.key)}" aria-pressed="${sel === g.key}">
      <i style="background:${g.color}" aria-hidden="true"></i>
      <span class="ai-label">${esc(g.label)}${g.other ? ` <span class="muted">(${g.count})</span>` : ''}</span>
      <span class="ai-value num">${money(g.value)}</span>
      <b class="ai-share num">${pctPlain(g.share)}</b>
    </button>`).join('');
  const seg = `<div class="seg full comp-seg" role="group" aria-label="Ripartisci per">${ALLOC_BY.map(([k, l]) => `<button type="button" data-act="comp-by" data-by="${k}" aria-pressed="${by === k}">${l}</button>`).join('')}</div>`;
  const when = ctx.to === ctx.today ? 'oggi' : `al ${fmtDate(ctx.to)}`;
  const sub = `Valore per ${BY_TEXT[by]}, ${when}${data.cashBal > 0.005 ? ', liquidità sul conto inclusa' : ''}. Tocca una voce per evidenziarla.`;
  return `<section class="card rcard comp-card full">
    <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">Allocazione</h3><p class="rcard-sub">${esc(sub)}</p></div>${infoBtn('allocazione')}</header>
    ${seg}
    ${groups.length ? `<div class="comp-wrap"><div class="comp-donut">${donut}</div><div class="alloc-list">${items}</div></div>` : '<p class="chart-note">Nessuna posizione aperta.</p>'}
  </section>`;
}

/* ---------- Diversification ---------- */
function diversificationKpis(data) {
  const d = data.div;
  const topName = d.top ? esc(d.top.asset.name) : '—';
  return `<div class="kpi-grid comp-kpis">
    ${kpiCard({ label: 'Posizioni aperte', value: num(d.count, 0), sub: d.count === 1 ? 'un solo titolo' : 'titoli in portafoglio' })}
    ${kpiCard({ label: 'Posizioni effettive', value: num(d.effective, 1), sub: d.count ? `su ${d.count}: più è vicino, più è bilanciato` : '—', info: 'posizioniEffettive' })}
    ${kpiCard({ label: 'Peso della prima posizione', value: pct(d.topWeight, 1), valueClass: d.topWeight > 0.25 && d.top && !['etf', 'fund'].includes(d.top.asset.type) ? 'down' : '', sub: topName, info: 'concentrazione' })}
    ${kpiCard({ label: 'Peso delle prime 5', value: pct(d.top5, 1), sub: d.count <= 5 ? 'hai al massimo 5 posizioni' : `le altre ${d.count - 5} valgono ${pct(1 - d.top5, 1)}`, info: 'concentrazione' })}
  </div>`;
}

/* ---------- Positions ---------- */
const isCashAsset = (p) => p.asset.type === 'cash';

function titleCell(p) {
  const a = p.asset;
  const code = assetCode(a);
  return `<button class="pos-link" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">
    ${avatar(a, 'sm')}<span class="pl-main"><span class="pl-name">${esc(a.name)}</span><span class="pl-sub">${esc([code, a.currency && a.currency !== 'EUR' ? a.currency : ''].filter(Boolean).join(' · ') || TYPE_PLURAL[a.type] || '')}</span></span>
  </button>`;
}

function todayCell(p, ctx) {
  if (ctx.to !== ctx.today || isCashAsset(p) || !p.priceDate || Math.abs(p.dayChangePct) < 0.000005) return '<span class="muted">—</span>';
  return `<span class="${tone(p.dayChangePct, 0.00005)}">${pctSigned(p.dayChangePct)}</span>`;
}

// Quantity for the table: fewer decimals than qtyFmt, still masked in privacy mode
const qtyShort = (q) => (S.ui.hide ? '•••' : num(q, Math.abs(q) < 1 ? 6 : 3));
// The full table needs about this many pixels; narrower cards get the compact list
const TABLE_MIN_W = 910;

function positionsBlock(ctx, data) {
  const open = data.open;
  if (!open.length) return emptyCard('Nessuna posizione aperta alla data finale del periodo.');
  const totalPos = sum(open, (p) => p.value);
  const totalCost = sum(open.filter((p) => !isCashAsset(p)), (p) => p.cost);
  const totalUnreal = sum(open.filter((p) => !isCashAsset(p)), (p) => p.unreal);
  if (ctx.desktop && ctx.w >= TABLE_MIN_W) {
    const dash = '<span class="muted">—</span>';
    const rows = open.map((p) => {
      const cash = isCashAsset(p);
      return [
        titleCell(p),
        cash ? dash : qtyShort(p.qty),
        cash ? dash : priceFmt(p.avgLocal, p.currency),
        cash ? dash : priceFmt(p.priceLocal, p.currency),
        money(p.value),
        pctPlain(p.weight),
        cash ? dash : `<span class="${tone(p.unreal)}">${moneySigned(p.unreal)}</span>`,
        cash ? dash : `<b class="${tone(p.unrealPct, 0.00005)}">${pctSigned(p.unrealPct)}</b>`,
        todayCell(p, ctx),
      ];
    });
    return tableCard({
      title: `Posizioni (${open.length})`,
      columns: [
        { label: 'Titolo', align: 'left' }, { label: 'Quantità', align: 'right' }, { label: 'Prezzo medio', align: 'right' },
        { label: 'Prezzo', align: 'right' }, { label: 'Valore', align: 'right' }, { label: 'Peso', align: 'right' },
        { label: 'P&L', align: 'right' }, { label: 'P&L %', align: 'right' }, { label: 'Oggi', align: 'right' },
      ],
      rows,
      foot: ['Totale', '', '', '', money(totalPos), pct(1, 0), `<span class="${tone(totalUnreal)}">${moneySigned(totalUnreal)}</span>`, totalCost > 0 ? `<span class="${tone(totalUnreal / totalCost, 0.00005)}">${pctSigned(totalUnreal / totalCost)}</span>` : '', ''],
      note: `Prezzi nella valuta del titolo; valori e P&L in euro, commissioni di acquisto incluse nel costo.${ctx.to !== ctx.today ? ` Situazione al ${fmtDate(ctx.to)}.` : ''}`,
      cls: 'full pos-table',
    });
  }
  const rows = open.map((p) => {
    const a = p.asset;
    const unit = unitFor(a);
    const sub = isCashAsset(p) ? `${TYPE_PLURAL.cash} · ${pctPlain(p.weight)}` : `${qtyFmt(p.qty)}${unit ? ' ' + esc(unit) : ''} · peso ${pctPlain(p.weight)}`;
    const pl = isCashAsset(p) ? '' : `<span class="row-sub ${tone(p.unreal)}">${moneySigned(p.unreal)}</span>`;
    return `<button class="row" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">
      ${avatar(a, 'sm')}
      <span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${sub}</span>${pl}</span>
      <span class="row-end"><span class="row-value">${money(p.value)}</span>${isCashAsset(p) ? '' : pctPill(p.unrealPct)}</span>
    </button>`;
  }).join('');
  return `<section class="card rcard pos-card">
    <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">Posizioni (${open.length})</h3><p class="rcard-sub">Valore, peso e guadagno non realizzato di ogni titolo</p></div></header>
    <div class="list flush">${rows}</div>
  </section>`;
}

function bestWorst(ctx, data) {
  const ranked = data.open.filter((p) => !isCashAsset(p) && p.cost > 0).sort((a, b) => b.unrealPct - a.unrealPct);
  if (ranked.length < 2) return '';
  const n = Math.min(3, Math.floor(ranked.length / 2) || 1);
  const best = ranked.slice(0, n);
  const worst = ranked.slice(-n).reverse();
  const row = (p) => `<button class="row" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">
      ${avatar(p.asset, 'sm')}
      <span class="row-main"><span class="row-title">${esc(p.asset.name)}</span><span class="row-sub">${moneySigned(p.unreal)} su ${money(p.cost)}</span></span>
      <span class="row-end">${pctPill(p.unrealPct)}</span>
    </button>`;
  const card = (title, sub, list) => `<section class="card rcard bw-card">
    <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">${esc(title)}</h3><p class="rcard-sub">${esc(sub)}</p></div></header>
    <div class="list flush">${list.map(row).join('')}</div>
  </section>`;
  return `<div class="chart-grid">
    ${card(`Le migliori ${n}`, 'Per guadagno non realizzato in %', best)}
    ${card(`Le peggiori ${n}`, 'Per guadagno non realizzato in %', worst)}
  </div>`;
}

function renderComposition(ctx) {
  const data = compData(ctx);
  if (!data.open.length && data.cashBal <= 0.005) {
    return emptyCard('Nessuna posizione aperta alla data finale del periodo: scegli un periodo che finisce più avanti.');
  }
  return `<div class="comp-sheet stack-lg">
    ${allocationCard(ctx, data)}
    <div class="sec-head comp-sec"><h3>Diversificazione</h3></div>
    ${diversificationKpis(data)}
    ${positionsBlock(ctx, data)}
    ${bestWorst(ctx, data)}
  </div>`;
}

Object.assign(ACTIONS, {
  'comp-by': (el) => {
    const by = validBy(el.dataset.by);
    if (S.ui.allocBy === by) return;
    S.ui.allocBy = by;
    S.ui.allocSel = null;
    app.render();
  },
  'comp-sel': (el) => {
    const key = el.dataset.key || null;
    S.ui.allocSel = S.ui.allocSel === key ? null : key;
    app.render();
  },
});

registerSheet({
  id: 'composition',
  order: 3,
  title: 'Composizione',
  subtitle: 'Come è distribuito oggi il patrimonio e quanto è diversificato.',
  render: renderComposition,
});

export const _test = { allocationGroups, diversification, compData };
