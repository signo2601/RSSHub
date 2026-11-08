// Report sheet 1 "Riepilogo": headline KPIs of the period (balances, TWR, P&L, flows, IRR, risk)
// and the per-account snapshot.
import { S, D, cached } from '../state.js';
import { MOUNTS } from '../registry.js';
import { eco } from '../eco.js';
import { inflationBetween, realReturn, annualize, addMonth } from '../inflation.js';
import { positions, realizedEvents, cashAt } from '../engine.js';
import { periodStats, businessDays, annualizedVolatility } from '../metrics.js';
import { esc, icon, money, moneySigned, pct, pctSigned, num, ratio, fmtDate, fmtMonth, addDays, tone, sum } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, kpiCard, tableCard, rowsCard, badgeFor, accColor, benchShort } from './report.js';


// Open positions and liquidity at the end of the period
function snapshot(accIds, to) {
  const all = positions({ accIds, date: to });
  const open = all.filter((p) => p.qty > 0);
  const cashAssets = sum(open.filter((p) => p.asset.type === 'cash'), (p) => p.value);
  const cashBal = cashAt(accIds, to);
  const invested = open.filter((p) => p.asset.type !== 'cash');
  return {
    open,
    liquidity: cashBal + cashAssets,
    cashBal,
    unreal: sum(invested, (p) => p.unreal),
    cost: sum(invested, (p) => p.cost),
    fxPL: sum(invested, (p) => (p.currency && p.currency !== 'EUR' ? p.fxPL : 0)),
    foreign: invested.filter((p) => p.currency && p.currency !== 'EUR').length,
  };
}

function realizedIn(accIds, from, to) {
  const list = realizedEvents(accIds).filter((e) => e.date >= from && e.date <= to);
  return { pl: sum(list, (e) => e.pl), count: list.length };
}

// Annualized volatility of the benchmark over the report period
function benchVol(ctx, st) {
  const b = ctx.bench.ret;
  if (!b || !st) return null;
  const cs = b.coverageStart;
  if (!cs || cs > ctx.to) return null;
  const dates = ctx.series.dates;
  let i0 = st.i0;
  while (i0 <= st.i1 && dates[i0] < cs) i0++;
  if (st.i1 - i0 < 10) return null;
  const bd = businessDays(dates.slice(i0, st.i1 + 1), Array.from(b.slice(i0, st.i1 + 1)));
  return annualizedVolatility(bd.ret);
}

// Italian inflation (HICP, Eurostat) for the real return; downloaded once a day, kept for offline use
const INFLATION = { key: 'inflation', path: '/eco/inflation', maxAge: 24 * 3600e3 };
MOUNTS.push(() => {
  if (S.ui.tab !== 'report') return;
  eco.init();
  eco.load(INFLATION.key, INFLATION.path, { maxAge: INFLATION.maxAge });
});

// TWR of the period net of Italian inflation: { real, infl, realYear?, toMonth, partial } or null
export function realOf(st, data) {
  const infl = data ? inflationBetween(data, st.from, st.to, 'IT') : null;
  if (!infl) return null;
  const real = realReturn(st.twr, infl.rate);
  if (real === null) return null;
  const out = { real, infl: infl.rate, toMonth: infl.toMonth, partial: infl.partial };
  if (st.days >= 365 && Number.isFinite(st.cagr)) out.realYear = realReturn(st.cagr, annualize(infl.rate, st.days));
  return out;
}

function summaryData(ctx) {
  const infl = eco.entry(INFLATION.key);
  const key = `rep-summary:${ctx.scopeKey}:${ctx.from}:${ctx.to}:${ctx.rf}:${ctx.bench.symbol}:${ctx.bench.status}:${infl ? infl.fetchedAt : 0}`;
  return cached(key, () => {
    const st = periodStats(ctx.series, ctx.from, ctx.to, { rf: ctx.rf, benchRet: ctx.bench.ret });
    const real = st ? realOf(st, eco.data(INFLATION.key)) : null;
    const snap = snapshot(ctx.accIds, ctx.to);
    const realized = realizedIn(ctx.accIds, ctx.from, ctx.to);
    const bvol = benchVol(ctx, st);
    const accounts = [];
    for (const a of D().accounts) {
      const s = ctx.accSeries[a.id];
      if (!s) {
        accounts.push({ a, st: null });
        continue;
      }
      const ast = periodStats(s, ctx.from, ctx.to, { rf: ctx.rf, benchRet: ctx.bench.ret });
      accounts.push({ a, st: ast, snap: snapshot([a.id], ctx.to), active: s.start <= ctx.to });
    }
    return { st, real, snap, realized, bvol, accounts };
  });
}

/* ---------- KPI cards ---------- */
function benchSub(ctx, st) {
  const b = ctx.bench;
  if (b.status === 'loading') return 'Carico il benchmark…';
  if (b.status === 'offline') return 'Benchmark non disponibile offline';
  if (b.status === 'failed' || b.status === 'none') return 'Benchmark non disponibile';
  if (st.benchTwr === null) return `Nessun dato di ${esc(benchShort(b))} nel periodo`;
  return `${esc(benchShort(b))} ${pctSigned(st.benchTwr)}${st.benchPartial ? ' (dati parziali)' : ''}`;
}

function realCard(data) {
  const { st, real } = data;
  if (!real) {
    const fail = eco.failure(INFLATION.key);
    return kpiCard({
      label: 'Rendimento reale',
      value: '—',
      valueClass: 'muted',
      sub: fail ? 'Dati sull\'inflazione non disponibili: servono internet e qualche secondo' : eco.isLoading(INFLATION.key) ? 'Scarico i dati sull\'inflazione…' : 'Al netto dell\'inflazione italiana',
      info: 'rendimentoReale',
    });
  }
  // Prices are published with about a month of delay: say up to when only when the gap is larger
  const stale = real.partial && addMonth(real.toMonth, 2) < st.to.slice(0, 7);
  const upTo = stale ? ` · prezzi fino a ${fmtMonth(real.toMonth, true)}` : '';
  const year = real.realYear !== undefined && real.realYear !== null ? ` · ${pctSigned(real.realYear)} reale l'anno` : '';
  return kpiCard({
    label: 'Rendimento reale',
    value: pctSigned(real.real),
    valueClass: tone(real.real, 0.00005),
    badge: badgeFor(real.real),
    sub: `Inflazione Italia ${pctSigned(real.infl)}${year}${upTo}`,
    info: 'rendimentoReale',
  });
}

// The figures of the period: one hero (the balance), four tiles (return, real return, money in and
// out, cash) and two cards of rows for the rest, so the screen has one focal point
function kpis(ctx, data) {
  const { st, snap, realized, bvol } = data;
  const all = ctx.period === 'ALL';
  const dayBefore = addDays(st.from, -1);
  const tiles = [];
  tiles.push(kpiCard({
    label: 'Saldo finale',
    value: money(st.endValue),
    badge: badgeFor(st.gain, 0.005),
    sub: `Risultato del periodo <b class="${tone(st.gain)}">${moneySigned(st.gain)}</b> · al ${fmtDate(st.to)}`,
    info: 'saldoFinale',
    cls: 'hero',
  }));
  tiles.push(kpiCard({
    label: 'Rendimento (TWR)',
    value: pctSigned(st.twr),
    valueClass: tone(st.twr, 0.00005),
    badge: badgeFor(st.twr),
    sub: all ? `dall'inizio · ${num(st.days, 0)} giorni` : `${num(st.days, 0)} giorni · dal ${fmtDate(st.from)}`,
    info: 'twr',
  }));
  tiles.push(realCard(data));
  tiles.push(kpiCard({
    label: 'Flussi netti',
    value: moneySigned(st.netFlows),
    sub: `Versati ${money(st.inflows)} · ritirati ${money(st.outflows)}`,
    info: 'flussiNetti',
  }));
  tiles.push(kpiCard({
    label: 'Liquidità',
    value: money(snap.liquidity),
    sub: st.endValue > 0 && snap.liquidity > 0 ? `${pct(snap.liquidity / st.endValue, 1)} del saldo` : 'nessuna liquidità registrata',
    info: 'liquidita',
  }));

  const pl = rowsCard('Guadagni e perdite', 'Nel periodo, prima delle tasse', [
    {
      label: 'P&L non realizzato',
      value: moneySigned(snap.unreal),
      cls: tone(snap.unreal),
      sub: snap.cost > 0 ? `${pctSigned(snap.unreal / snap.cost)} sul costo` : 'nessuna posizione aperta',
      info: 'plNonRealizzato',
    },
    {
      label: 'P&L realizzato',
      value: moneySigned(realized.pl),
      cls: realized.count ? tone(realized.pl) : '',
      sub: realized.count ? `${realized.count} ${realized.count === 1 ? 'vendita' : 'vendite'} nel periodo` : 'nessuna vendita nel periodo',
      info: 'plRealizzato',
    },
    {
      label: 'P&L cambio (n.r.)',
      value: moneySigned(snap.fxPL),
      cls: snap.foreign ? tone(snap.fxPL) : '',
      sub: snap.foreign ? `${snap.foreign} ${snap.foreign === 1 ? 'titolo' : 'titoli'} in valuta` : 'nessun titolo in valuta',
      info: 'plCambio',
    },
    {
      label: 'Saldo iniziale',
      value: money(st.startValue),
      sub: st.startValue > 0 ? `alla chiusura del ${fmtDate(dayBefore)}` : 'prima della prima operazione',
      info: 'saldoIniziale',
    },
  ]);
  const dd = Number.isFinite(st.maxDD) ? st.maxDD : 0;
  const risk = rowsCard('Rendimento e rischio', st.shortPeriod ? 'Su base annua: con meno di un anno di dati sono solo indicativi' : 'Su base annua', [
    {
      label: 'Attivo vs benchmark',
      value: st.activeVsBench === null ? '—' : pctSigned(st.activeVsBench),
      cls: st.activeVsBench === null ? 'muted' : tone(st.activeVsBench, 0.00005),
      sub: benchSub(ctx, st),
      info: 'attivoVsBenchmark',
    },
    {
      label: 'IRR investitore (ann.)',
      value: st.irr === null ? '—' : pctSigned(st.irr),
      cls: st.irr === null ? 'muted' : tone(st.irr, 0.00005),
      sub: st.irr === null ? 'non calcolabile con questi flussi' : 'versamenti inclusi',
      info: 'irr',
    },
    {
      label: 'CAGR',
      value: st.cagr === null ? '—' : pctSigned(st.cagr),
      cls: st.cagr === null ? 'muted' : tone(st.cagr, 0.00005),
      sub: 'crescita media all\'anno',
      info: 'cagr',
    },
    {
      label: 'Volatilità (ann.)',
      value: st.vol === null ? '—' : pct(st.vol),
      sub: bvol !== null && bvol !== undefined ? `${esc(benchShort(ctx.bench))} ${pct(bvol)}` : st.vol === null ? 'servono più giorni di dati' : '',
      info: 'volatilita',
    },
    {
      label: 'Sharpe (ann.)',
      value: st.sharpe === null ? '—' : ratio(st.sharpe),
      cls: st.sharpe === null ? 'muted' : '',
      sub: st.sharpe === null ? 'servono più giorni di dati' : `tasso senza rischio ${pct(ctx.rf)}`,
      info: 'sharpe',
    },
    {
      label: 'Drawdown massimo',
      value: dd < -0.00005 ? pctSigned(dd) : pct(0),
      cls: dd < -0.00005 ? 'down' : '',
      sub: st.maxDDFrom && st.maxDDTo && dd < -0.00005 ? `${fmtDate(st.maxDDFrom, st.maxDDFrom.slice(0, 4) !== st.maxDDTo.slice(0, 4))} → ${fmtDate(st.maxDDTo)}` : 'nessun calo nel periodo',
      info: 'maxDrawdown',
    },
  ]);
  return `<div class="kpi-grid summary-kpis">${tiles.join('')}</div>
    <div class="chart-grid summary-rows">${pl}${risk}</div>`;
}

/* ---------- Per-account snapshot ---------- */
function accountsBlock(ctx, data) {
  const list = data.accounts;
  if (ctx.scopeKey !== 'all' || D().accounts.length < 2) return '';
  const total = sum(list, (x) => (x.st ? x.st.endValue : 0));
  const idx = new Map(D().accounts.map((a, i) => [a.id, i]));
  const name = (a) => `<span class="acc-cell"><i class="acc-dot" style="background:${accColor(idx.get(a.id))}" aria-hidden="true"></i>${esc(a.name)}</span>`;
  const broker = (a) => esc(a.broker && a.broker !== 'Altro' ? a.broker : '—');
  const rows = list.map(({ a, st, snap }) => {
    if (!st) return [name(a), broker(a), '—', '—', '<span class="muted">nessuna operazione</span>', '—', '—'];
    const w = total > 0 ? st.endValue / total : 0;
    return [
      name(a),
      broker(a),
      money(st.endValue),
      pct(w, 1),
      `<span class="${tone(st.twr, 0.00005)}">${pctSigned(st.twr)}</span>`,
      moneySigned(st.netFlows),
      `<span class="${tone(snap.unreal)}">${moneySigned(snap.unreal)}</span>`,
    ];
  });
  const tot = data.st;
  const foot = ['Totale', '', money(tot.endValue), pct(total > 0 ? 1 : 0, 0), `<span class="${tone(tot.twr, 0.00005)}">${pctSigned(tot.twr)}</span>`, moneySigned(tot.netFlows), `<span class="${tone(data.snap.unreal)}">${moneySigned(data.snap.unreal)}</span>`];

  if (ctx.desktop && ctx.w >= 760) {
    return tableCard({
      title: 'Fotografia per conto',
      info: 'fotografiaConti',
      columns: [
        { label: 'Conto', align: 'left' }, { label: 'Broker', align: 'left' }, { label: 'Valore', align: 'right' },
        { label: 'Peso', align: 'right' }, { label: 'TWR periodo', align: 'right' }, { label: 'Flussi netti', align: 'right' },
        { label: 'P&L non realizzato', align: 'right' },
      ],
      rows,
      foot,
      cls: 'acc-table',
    });
  }
  // Phone: one compact block per account
  const items = list.map(({ a, st, snap }) => {
    const i = idx.get(a.id);
    if (!st) {
      return `<div class="acc-snap"><div class="as-top"><span class="acc-cell"><i class="acc-dot" style="background:${accColor(i)}" aria-hidden="true"></i><b>${esc(a.name)}</b></span><span class="muted">nessuna operazione</span></div></div>`;
    }
    const w = total > 0 ? st.endValue / total : 0;
    return `<div class="acc-snap">
      <div class="as-top"><span class="acc-cell"><i class="acc-dot" style="background:${accColor(i)}" aria-hidden="true"></i><b>${esc(a.name)}</b></span><b class="num">${money(st.endValue)}</b></div>
      <div class="as-bar" aria-hidden="true"><i style="width:${(w * 100).toFixed(1)}%;background:${accColor(i)}"></i></div>
      <dl class="as-grid">
        <div><dt>Peso</dt><dd>${pct(w, 1)}</dd></div>
        <div><dt>TWR periodo</dt><dd class="${tone(st.twr, 0.00005)}">${pctSigned(st.twr)}</dd></div>
        <div><dt>Flussi netti</dt><dd>${moneySigned(st.netFlows)}</dd></div>
        <div><dt>P&amp;L non realizzato</dt><dd class="${tone(snap.unreal)}">${moneySigned(snap.unreal)}</dd></div>
      </dl>
    </div>`;
  }).join('');
  return `<section class="card rcard acc-snaps">
    <header class="rcard-head"><div class="rcard-titles"><h3 class="rcard-title">Fotografia per conto</h3><p class="rcard-sub">Valore, peso e rendimento di ogni conto nel periodo</p></div>
    ${infoBtn('fotografiaConti')}</header>
    ${items}
  </section>`;
}

function renderSummary(ctx) {
  const data = summaryData(ctx);
  if (!data.st) return '<div class="empty"><p>Nessun dato nel periodo scelto.</p></div>';
  return `${kpis(ctx, data)}
    ${accountsBlock(ctx, data)}`;
}

registerSheet({
  id: 'summary',
  order: 1,
  title: 'Riepilogo',
  subtitle: 'Panoramica sintetica della performance, dei flussi e della fotografia per conto sul periodo selezionato.',
  render: renderSummary,
});

export const _test = { snapshot, realizedIn, summaryData };
