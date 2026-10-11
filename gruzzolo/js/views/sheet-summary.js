// Report sheet 1 "Riepilogo": headline KPIs of the period (balances, TWR, P&L, flows, IRR, risk)
// and the per-account snapshot.
import { D, cached } from '../state.js';
import { positions, realizedEvents, cashAt } from '../engine.js';
import { periodStats, businessDays, annualizedVolatility } from '../metrics.js';
import { esc, icon, money, moneySigned, pct, pctSigned, num, fmtDate, addDays, tone, sum } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, kpiCard, tableCard, badgeFor, accColor, benchShort } from './report.js';

const SHORT_NOTE = 'periodo breve: valore annualizzato indicativo';

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

function summaryData(ctx) {
  const key = `rep-summary:${ctx.scopeKey}:${ctx.from}:${ctx.to}:${ctx.rf}:${ctx.bench.symbol}:${ctx.bench.status}`;
  return cached(key, () => {
    const st = periodStats(ctx.series, ctx.from, ctx.to, { rf: ctx.rf, benchRet: ctx.bench.ret });
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
    return { st, snap, realized, bvol, accounts };
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

function kpis(ctx, data) {
  const { st, snap, realized, bvol } = data;
  const all = ctx.period === 'ALL';
  const dayBefore = addDays(st.from, -1);
  const cards = [];

  cards.push(kpiCard({
    label: 'Saldo finale',
    value: money(st.endValue),
    badge: badgeFor(st.gain, 0.005),
    sub: `Risultato del periodo <b class="${tone(st.gain)}">${moneySigned(st.gain)}</b> · al ${fmtDate(st.to)}`,
    info: 'saldoFinale',
    cls: 'hero',
  }));
  cards.push(kpiCard({
    label: all ? 'Dall\'inizio performance (TWR)' : 'TWR del periodo',
    value: pctSigned(st.twr),
    valueClass: tone(st.twr, 0.00005),
    badge: badgeFor(st.twr),
    sub: `${fmtDate(st.from)} → ${fmtDate(st.to)} · ${num(st.days, 0)} giorni`,
    info: 'twr',
    cls: 'hero',
  }));
  cards.push(kpiCard({
    label: 'Saldo iniziale',
    value: money(st.startValue),
    sub: st.startValue > 0 ? `alla chiusura del ${fmtDate(dayBefore)}` : 'prima della prima operazione',
    info: 'saldoIniziale',
  }));
  cards.push(kpiCard({
    label: 'Liquidità',
    value: money(snap.liquidity),
    sub: st.endValue > 0 && snap.liquidity > 0 ? `${pct(snap.liquidity / st.endValue, 1)} del saldo` : 'nessuna liquidità registrata',
    info: 'liquidita',
  }));
  cards.push(kpiCard({
    label: 'P&L realizzato',
    value: moneySigned(realized.pl),
    valueClass: tone(realized.pl),
    badge: realized.count ? badgeFor(realized.pl, 0.005) : null,
    sub: realized.count ? `${realized.count} ${realized.count === 1 ? 'vendita' : 'vendite'} nel periodo, prima delle tasse` : 'nessuna vendita nel periodo',
    info: 'plRealizzato',
  }));
  cards.push(kpiCard({
    label: 'P&L non realizzato',
    value: moneySigned(snap.unreal),
    valueClass: tone(snap.unreal),
    badge: snap.cost > 0 ? badgeFor(snap.unreal, 0.005) : null,
    sub: snap.cost > 0 ? `${pctSigned(snap.unreal / snap.cost)} sul costo, al ${fmtDate(st.to)}` : 'nessuna posizione aperta',
    info: 'plNonRealizzato',
  }));
  cards.push(kpiCard({
    label: 'P&L cambio (n.r.)',
    value: moneySigned(snap.fxPL),
    valueClass: snap.foreign ? tone(snap.fxPL) : '',
    badge: snap.foreign ? badgeFor(snap.fxPL, 0.005) : null,
    sub: snap.foreign ? `effetto del cambio su ${snap.foreign} ${snap.foreign === 1 ? 'titolo' : 'titoli'} in valuta` : 'nessun titolo in valuta estera',
    info: 'plCambio',
  }));
  cards.push(kpiCard({
    label: 'Attivo vs benchmark',
    value: st.activeVsBench === null ? '—' : pctSigned(st.activeVsBench),
    valueClass: st.activeVsBench === null ? 'muted' : tone(st.activeVsBench, 0.00005),
    badge: badgeFor(st.activeVsBench),
    sub: benchSub(ctx, st),
    info: 'attivoVsBenchmark',
  }));
  cards.push(kpiCard({
    label: 'Flussi netti',
    value: moneySigned(st.netFlows),
    sub: `Versati ${money(st.inflows)} · ritirati ${money(st.outflows)}`,
    info: 'flussiNetti',
  }));
  cards.push(kpiCard({
    label: 'IRR investitore (ann.)',
    value: st.irr === null ? '—' : pctSigned(st.irr),
    valueClass: st.irr === null ? 'muted' : tone(st.irr, 0.00005),
    badge: badgeFor(st.irr),
    sub: st.irr === null ? 'non calcolabile con questi flussi' : st.shortPeriod ? SHORT_NOTE : 'rendimento dei tuoi soldi, versamenti inclusi',
    info: 'irr',
  }));
  cards.push(kpiCard({
    label: 'Volatilità (ann.)',
    value: st.vol === null ? '—' : pct(st.vol),
    sub: bvol !== null && bvol !== undefined ? `${esc(benchShort(ctx.bench))} ${pct(bvol)}` : st.vol === null ? 'servono più giorni di dati' : 'oscillazione tipica in un anno',
    info: 'volatilita',
  }));
  cards.push(kpiCard({
    label: 'Sharpe (ann.)',
    value: st.sharpe === null ? '—' : num(st.sharpe, 2),
    valueClass: st.sharpe === null ? 'muted' : tone(st.sharpe, 0.005),
    badge: badgeFor(st.sharpe, 0.005),
    sub: st.sharpe === null ? 'servono più giorni di dati' : `${st.shortPeriod ? SHORT_NOTE + ' · ' : ''}tasso senza rischio ${pct(ctx.rf)}`,
    info: 'sharpe',
  }));
  cards.push(kpiCard({
    label: 'CAGR',
    value: st.cagr === null ? '—' : pctSigned(st.cagr),
    valueClass: st.cagr === null ? 'muted' : tone(st.cagr, 0.00005),
    badge: badgeFor(st.cagr),
    sub: st.shortPeriod ? SHORT_NOTE : 'crescita media composta all\'anno',
    info: 'cagr',
  }));
  const dd = Number.isFinite(st.maxDD) ? st.maxDD : 0;
  cards.push(kpiCard({
    label: 'Drawdown massimo',
    value: dd < -0.00005 ? pctSigned(dd) : pct(0),
    valueClass: dd < -0.00005 ? 'down' : '',
    badge: dd < -0.00005 ? 'down' : 'flat',
    sub: st.maxDDFrom && st.maxDDTo && dd < -0.00005 ? `dal ${fmtDate(st.maxDDFrom)} al ${fmtDate(st.maxDDTo)}` : 'nessun calo nel periodo',
    info: 'maxDrawdown',
    cls: 'danger',
    bar: Math.abs(dd),
  }));
  return cards.join('');
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
  const notes = [];
  if (data.st.shortPeriod) notes.push('Periodo più breve di un anno: IRR, CAGR e Sharpe sono riportati su base annua e quindi solo indicativi.');
  return `<div class="kpi-grid summary-kpis">${kpis(ctx, data)}</div>
    ${notes.length ? `<p class="report-note">${icon('info')}${notes.map(esc).join(' ')}</p>` : ''}
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
