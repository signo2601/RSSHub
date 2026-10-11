// Report sheet 6 "Gestione del rischio": risk profile of the CURRENT allocation projected back on
// five years of market data (core, benchmark and active management, loss risk, performance quality)
// and the Markowitz efficient frontier of the open positions (computed after the first paint).
import { asset, assetCode, cached, hasDemo } from '../state.js';
import { ACTIONS, MOUNTS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { assetHistory, historyFor, positions } from '../engine.js';
import { backProjected, riskStats, regression } from '../metrics.js';
import { portfolioFrontier, frontierCsv } from '../markowitz.js';
import { scatterChart } from '../charts.js';
import { esc, icon, money, moneySigned, pct, pctSigned, num, fmtDate, tone, sum, saveFile } from '../util.js';
import { infoBtn } from '../info.js';
import { registerSheet, chartCard, tableCard, emptyCard, benchShort } from './report.js';
import { avatar } from './home.js';

const BACK_YEARS = 5;
const FRONTIER_YEARS = 10;
const MIN_REG_DAYS = 20;
const CSV_NAME = 'gruzzolo-frontiera.csv';
const FRONTIER_SUB = '(solo posizioni aperte correnti, storico comune fino a 10 anni, titolo privo di rischio, rendimenti settimanali, covarianza shrinkata, solo posizioni lunghe senza leva, peso minimo 0,1%, peso massimo 20% per strumento)';
const COLORS = {
  frontier: 'var(--accent-line)', cml: 'var(--muted)', asset: 'var(--c-other)',
  current: 'var(--c1)', maxSharpe: 'var(--c2)', minVar: 'var(--c3)',
};

/* ---------- Helpers ---------- */
// Axis label for a fraction: '12%', '2,5%', '−8%'
export function pctAxis(v) {
  if (!Number.isFinite(v)) return '';
  const s = (Math.abs(v) * 100).toLocaleString('it-IT', { maximumFractionDigits: Math.abs(v) < 0.1 && v !== 0 ? 1 : 0 });
  return (v < -1e-12 ? '−' : '') + s + '%';
}
const addYearsISO = (d, n) => `${+d.slice(0, 4) + n}${d.slice(4)}`;
const ratio = (v) => (Number.isFinite(v) ? num(v, 2) : '—');
const dash = '<span class="muted">—</span>';

// Small stable hash (FNV-1a) for DOM tokens
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Open positions held today (cash instruments excluded)
function openPositions(ctx) {
  return positions({ accIds: ctx.accIds, date: ctx.today })
    .filter((p) => p.qty > 0 && p.value > 0 && p.asset.type !== 'cash')
    .sort((a, b) => b.value - a.value);
}

// FX history of the benchmark currency (demo-aware, like report.js)
function benchFxHistory(history) {
  if (!history) return null;
  const ccy = history.currency || 'EUR';
  if (ccy === 'EUR') return null;
  const sym = market.fxSymbol(ccy);
  return (hasDemo() && market.getHistory('demo:' + sym)) || historyFor(sym);
}

// Why a position has no usable history, in plain Italian
function reasonText(reason, a, extra = {}) {
  if (reason === 'short') return extra.days ? `storico troppo breve (${num(extra.days, 0)} giorni)` : extra.weeks ? `storico troppo breve (${num(extra.weeks, 0)} settimane)` : 'storico troppo breve';
  if (reason === 'manual' || !a.symbol || a.priceSource === 'manual') return 'prezzo manuale, nessuno storico di mercato';
  if (market.status === 'offline') return 'storico non scaricato (sei offline)';
  if (market.status === 'online') return 'storico in arrivo';
  return 'storico non disponibile';
}

/* ---------- Back-projected risk ---------- */
export function riskData(ctx) {
  const key = `rep-risk:${ctx.scopeKey}:${ctx.today}:${ctx.rf}:${ctx.bench.symbol}:${ctx.bench.status}`;
  return cached(key, () => {
    const open = openPositions(ctx);
    const total = sum(open, (p) => p.value);
    const benchHistory = ctx.bench && ctx.bench.history ? ctx.bench.history : null;
    const bp = backProjected(open, { years: BACK_YEARS, today: ctx.today, benchHistory, benchFxHistory: benchFxHistory(benchHistory) });
    let rs = null;
    let benchFrom = null;
    if (bp.n >= 2) {
      rs = riskStats(bp.ret, { rf: ctx.rf, dates: bp.dates });
      if (bp.bench && bp.benchStart) {
        // The benchmark may start later than the window: regress only where it has data
        let k0 = 0;
        if (bp.benchStart > bp.start) while (k0 < bp.n && bp.dates[k0] <= bp.benchStart) k0++;
        if (bp.n - k0 >= MIN_REG_DAYS) {
          Object.assign(rs, regression(Array.from(bp.ret.subarray(k0)), Array.from(bp.bench.subarray(k0)), ctx.rf));
          benchFrom = k0 > 0 ? bp.dates[k0] : null;
        }
      }
    }
    const missingValue = sum(open.filter((p) => bp.missing.includes(p.aid)), (p) => p.value);
    return { open, total, bp, rs, benchFrom, missingShare: total > 0 ? missingValue / total : 0 };
  });
}

function groupBox(title, sub, rows) {
  const items = rows.map((r) => `<div class="rg-row">
      <dt><span>${esc(r.label)}</span>${r.info ? infoBtn(r.info) : ''}</dt>
      <dd><b class="num ${r.cls || ''}">${r.value}</b>${r.sub ? `<small>${r.sub}</small>` : ''}</dd>
    </div>`).join('');
  return `<section class="card rcard risk-group">
    <header class="rg-head"><h3 class="rcard-title">${esc(title)}</h3>${sub ? `<p class="rcard-sub">${sub}</p>` : ''}</header>
    <dl class="rg-list">${items}</dl>
  </section>`;
}

function benchUnavailable(ctx) {
  const b = ctx.bench;
  if (b.status === 'loading') return 'Carico il benchmark…';
  if (b.status === 'offline') return 'Benchmark non disponibile offline';
  if (b.status === 'none') return 'Nessun benchmark scelto';
  return 'Benchmark non disponibile';
}

function riskGroups(ctx, d) {
  const { rs, total } = d;
  const ddDates = rs.maxDDFrom && rs.maxDDTo ? `dal ${fmtDate(rs.maxDDFrom)} al ${fmtDate(rs.maxDDTo)}` : '';
  const hasReg = Number.isFinite(rs.beta);
  const bName = esc(benchShort(ctx.bench));
  const benchSub = hasReg
    ? `rispetto a ${bName}${d.benchFrom ? ` (dati dal ${fmtDate(d.benchFrom)})` : ''}`
    : esc(benchUnavailable(ctx));
  const eur = (x) => (Number.isFinite(x) && total > 0 ? `≈ ${moneySigned(-x * total)} al giorno su ${money(total)}` : '');
  return `<div class="risk-grid">
    ${groupBox('Core', 'rendimento e oscillazioni, su base annua', [
    { label: 'Rendimento annualizzato', value: Number.isFinite(rs.annReturn) ? pctSigned(rs.annReturn) : '—', cls: tone(rs.annReturn, 0.00005), info: 'cagr' },
    { label: 'Volatilità', value: Number.isFinite(rs.vol) ? pct(rs.vol) : '—', info: 'volatilita' },
    { label: 'Max drawdown', value: Number.isFinite(rs.maxDD) ? pctSigned(rs.maxDD) : '—', cls: rs.maxDD < -0.00005 ? 'down' : '', sub: ddDates, info: 'maxDrawdown' },
    { label: 'Sharpe', value: ratio(rs.sharpe), info: 'sharpe' },
    { label: 'Sortino', value: ratio(rs.sortino), info: 'sortino' },
  ])}
    ${groupBox('Benchmark & gestione attiva', benchSub, [
    { label: 'Beta', value: hasReg ? ratio(rs.beta) : dash, info: 'beta' },
    { label: 'Alpha annualizzato', value: Number.isFinite(rs.alpha) ? pctSigned(rs.alpha) : dash, cls: tone(rs.alpha, 0.00005), info: 'alpha' },
    { label: 'Correlazione con il benchmark', value: Number.isFinite(rs.corr) ? ratio(rs.corr) : dash, info: 'correlazione' },
    { label: 'Tracking error', value: Number.isFinite(rs.te) ? pct(rs.te) : dash, info: 'trackingError' },
  ])}
    ${groupBox('Rischio perdita', 'perdita in un giorno di borsa, livello di confidenza 95%', [
    { label: 'Value at Risk 95%', value: Number.isFinite(rs.var95) ? pctSigned(-rs.var95) : '—', cls: 'down', sub: eur(rs.var95), info: 'var95' },
    { label: 'Conditional VaR 95%', value: Number.isFinite(rs.cvar95) ? pctSigned(-rs.cvar95) : '—', cls: 'down', sub: eur(rs.cvar95), info: 'cvar95' },
  ])}
    ${groupBox('Qualità performance', 'come si distribuiscono i giorni buoni e cattivi', [
    { label: 'Gain/Loss ratio', value: ratio(rs.gainLoss), info: 'gainLoss' },
    { label: 'Periodi positivi', value: Number.isFinite(rs.positiveShare) ? pct(rs.positiveShare, 1) : '—', sub: 'dei giorni di borsa', info: 'periodiPositivi' },
  ])}
  </div>`;
}

function windowLine(ctx, d) {
  const { bp } = d;
  const parts = [];
  if (bp.start && bp.n) parts.push(`Storico comune dal ${fmtDate(bp.start)} · ${num(bp.n, 0)} giorni di borsa`);
  const fx = (bp.fxMissing || []).map((aid) => esc(assetCode(asset(aid)) || asset(aid).name));
  let excluded = '';
  if (bp.missingInfo && bp.missingInfo.length) {
    const list = bp.missingInfo.map((m) => {
      const a = asset(m.aid);
      return `<b>${esc(a.name || m.name)}</b> (${esc(reasonText(m.reason, a, m))})`;
    }).join(', ');
    excluded = `<p class="risk-excl">${icon('alert')}<span>Esclusi per storico mancante: ${list}${d.missingShare > 0.0005 ? ` · pesano il ${pct(d.missingShare, 1)} del portafoglio` : ''}. I pesi degli altri titoli sono stati riproporzionati.</span></p>`;
  }
  const short = bp.start && bp.start > addYearsISO(ctx.today, -BACK_YEARS)
    ? ' · finestra più corta di 5 anni: la limita il titolo con lo storico più breve'
    : '';
  return `${parts.length ? `<p class="risk-window">${icon('calendar')}<span>${parts.join(' · ')}${short}</span></p>` : ''}
    ${fx.length ? `<p class="risk-excl">${icon('alert')}<span>Cambio non disponibile per ${fx.join(', ')}: valutati senza l'effetto valuta.</span></p>` : ''}
    ${excluded}`;
}

function noHistoryCard(ctx, d) {
  const loading = market.status === 'online' && d.bp.missingInfo.some((m) => m.reason === 'nohistory' && asset(m.aid).symbol && asset(m.aid).priceSource !== 'manual');
  const list = d.bp.missingInfo.map((m) => {
    const a = asset(m.aid);
    return `<li>${avatar(a, 'sm')}<span><b>${esc(a.name || m.name)}</b><small>${esc(reasonText(m.reason, a, m))}</small></span></li>`;
  }).join('');
  const why = loading
    ? 'Sto scaricando lo storico dei prezzi: il profilo apparirà tra poco.'
    : market.status === 'offline'
      ? 'Sei offline e lo storico dei prezzi di questi titoli non è ancora stato scaricato. Riprova quando torni online.'
      : 'Il profilo di rischio usa lo storico dei prezzi di mercato: i titoli con prezzo inserito a mano non ce l\'hanno. Collega i titoli a Yahoo Finance (cerca il ticker in «Mercati») per includerli.';
  return `<div class="card rcard risk-empty">
    <div class="risk-empty-head">${loading ? '<span class="dot busy"></span>' : icon('shield')}<h3>${loading ? 'Carico lo storico dei prezzi…' : 'Storico dei prezzi non disponibile'}</h3></div>
    <p>${esc(why)}</p>
    ${list ? `<ul class="risk-miss-list">${list}</ul>` : ''}
  </div>`;
}

/* ---------- Efficient frontier (lazy) ---------- */
const FR = { key: null, result: null, job: null, timer: 0 };

// Inputs that change the frontier: scope, risk-free rate, day, weights (0,1%), price histories
export function frontierKey(ctx, open) {
  const total = sum(open, (p) => p.value);
  const parts = open.map((p) => {
    const h = assetHistory(p.asset);
    const fx = p.asset.currency && p.asset.currency !== 'EUR' ? historyFor(market.fxSymbol(p.asset.currency)) : null;
    const hk = h && h.dates && h.dates.length ? `${h.dates.length}@${h.dates[h.dates.length - 1]}` : '-';
    const fk = fx && fx.dates && fx.dates.length ? `${fx.dates.length}` : '-';
    return `${p.aid}:${total > 0 ? Math.round((p.value / total) * 1000) : 0}:${hk}:${fk}`;
  });
  return [ctx.scopeKey, ctx.rf, ctx.today, ...parts].join('|');
}

export function computeFrontier(open, { today, rf }) {
  try {
    return portfolioFrontier(open, { today, rf, years: FRONTIER_YEARS });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), missing: [], fxMissing: [] };
  }
}

function frontierPlaceholder(h) {
  return `<div class="fr-loading" style="min-height:${h}px" aria-live="polite">
    <div class="fr-loading-line"><span class="dot busy"></span><span>Calcolo la frontiera…</span></div>
    <div class="skeleton fr-skel"></div>
  </div>`;
}

function missingFrontierList(res) {
  const list = (res.missing || []).map((m) => {
    const a = m.aid ? asset(m.aid) : { name: m.name };
    return `${esc(a.name || m.name)} (${esc(reasonText(m.reason, a, m))})`;
  });
  return list.length ? `<p class="rcard-note">Esclusi: ${list.join(', ')}.</p>` : '';
}

function frontierInsufficient(res) {
  const reason = res.error || 'storico comune troppo corto';
  const tip = (res.names && res.names.length === 1)
    ? 'Con un solo titolo non c\'è nulla da combinare: la frontiera serve quando possiedi almeno due titoli con storico di mercato.'
    : 'Servono almeno due titoli con storico di mercato e almeno 26 settimane di prezzi in comune.';
  return `<div class="fr-empty">
    <p class="fr-empty-title">${icon('alert')}<b>Dati insufficienti per calcolare la frontiera efficiente</b></p>
    <p>${esc(reason)}. ${esc(tip)}</p>
    ${missingFrontierList(res)}
  </div>`;
}

function legendCard(cls, color, title, p, rf) {
  if (!p) return '';
  const sharpe = Number.isFinite(p.sharpe) ? num(p.sharpe, 2) : (p.vol > 0 ? num((p.ret - rf) / p.vol, 2) : '—');
  return `<div class="fr-key ${cls}">
    <span class="fr-dot" style="background:${color}" aria-hidden="true"></span>
    <div><b>${esc(title)}</b>
    <span>Rendimento atteso <b class="num">${pctSigned(p.ret, 1)}</b> · Volatilità <b class="num">${pct(p.vol, 1)}</b> · Sharpe <b class="num">${sharpe}</b></span></div>
  </div>`;
}

export function frontierChart(res, view) {
  const rf = Number.isFinite(res.rf) ? res.rf : view.rf;
  const points = res.assets.map((a) => ({ x: a.vol, y: a.ret, label: a.name, color: COLORS.asset, r: 4, group: 'Titoli' }));
  points.push({ x: 0, y: rf, label: 'Titolo privo di rischio', color: COLORS.cml, r: 4, group: 'Privo di rischio', sub: `tasso ${pct(rf, 2)}` });
  points.push({ x: res.minVar.vol, y: res.minVar.ret, label: 'Minima varianza', color: COLORS.minVar, r: 6, special: true, group: 'Minima varianza' });
  points.push({ x: res.maxSharpe.vol, y: res.maxSharpe.ret, label: 'Massimo Sharpe', color: COLORS.maxSharpe, r: 6, special: true, group: 'Massimo Sharpe', sub: Number.isFinite(res.maxSharpe.sharpe) ? `Sharpe ${num(res.maxSharpe.sharpe, 2)}` : '' });
  if (res.current) points.push({ x: res.current.vol, y: res.current.ret, label: 'Portafoglio attuale', color: COLORS.current, r: 7, special: true, group: 'Portafoglio attuale', sub: Number.isFinite(res.current.sharpe) ? `Sharpe ${num(res.current.sharpe, 2)}` : '' });
  const lines = [{
    name: 'Frontiera efficiente',
    color: COLORS.frontier,
    points: res.frontier.map((p) => ({ x: p.vol, y: p.ret, sub: Number.isFinite(p.sharpe) ? `Sharpe ${num(p.sharpe, 2)}` : '' })),
  }];
  const ms = res.maxSharpe;
  if (ms && ms.vol > 0 && ms.ret > rf) {
    const slope = (ms.ret - rf) / ms.vol;
    const maxVol = Math.max(ms.vol * 1.15, ...res.frontier.map((p) => p.vol), res.current ? res.current.vol : 0);
    lines.push({ name: 'Linea del mercato dei capitali', color: COLORS.cml, dash: true, points: [{ x: 0, y: rf }, { x: maxVol, y: rf + slope * maxVol }] });
  }
  return scatterChart('rep-frontier', {
    points,
    lines,
    w: view.w,
    h: view.h,
    xFormat: pctAxis,
    yFormat: pctAxis,
    tooltipX: (v) => pct(v, 1),
    tooltipY: (v) => pctSigned(v, 1),
    xLabel: 'Volatilità annua →',
    yLabel: '↑ Rendimento atteso annuo',
    legend: true,
    ariaLabel: 'Frontiera efficiente: rendimento atteso e volatilità dei portafogli possibili con i tuoi titoli',
  });
}

function weightsTable(res) {
  const n = res.names.length;
  const cur = res.current ? res.current.weights : null;
  const order = [...Array(n).keys()].sort((i, j) => (cur ? cur[j] - cur[i] : 0) || res.maxSharpe.weights[j] - res.maxSharpe.weights[i]);
  const cell = (w) => (Number.isFinite(w) ? pct(w, 1) : '—');
  const rows = order.map((i) => {
    const aid = res.aids ? res.aids[i] : null;
    const a = aid ? asset(aid) : { name: res.names[i] };
    const title = aid
      ? `<button class="pos-link" type="button" data-act="open-asset" data-aid="${esc(aid)}">${avatar(a, 'sm')}<span class="pl-main"><span class="pl-name">${esc(a.name)}</span><span class="pl-sub">${esc(assetCode(a) || '')}</span></span></button>`
      : esc(res.names[i]);
    const ms = res.maxSharpe.weights[i];
    const mv = res.minVar.weights[i];
    const c = cur ? cur[i] : null;
    const diff = (w) => (c === null || !Number.isFinite(w) ? '' : Math.abs(w - c) >= 0.05 ? (w > c ? ' class="fr-more"' : ' class="fr-less"') : '');
    return [title, cell(c), `<span${diff(ms)}>${cell(ms)}</span>`, `<span${diff(mv)}>${cell(mv)}</span>`];
  });
  return tableCard({
    title: 'Pesi a confronto',
    columns: [{ label: 'Titolo', align: 'left' }, { label: 'Attuale', align: 'right' }, { label: 'Massimo Sharpe', align: 'right' }, { label: 'Minima varianza', align: 'right' }],
    rows,
    foot: ['Totale', pct(1, 0), pct(1, 0), pct(1, 0)],
    note: 'In verde i pesi più alti di almeno 5 punti rispetto a oggi, in rosso quelli più bassi.',
    cls: 'fr-weights',
  });
}

export function frontierBody(res, view) {
  if (!res || !res.ok || !res.names || res.names.length < 2) return frontierInsufficient(res || { ok: false });
  const rf = Number.isFinite(res.rf) ? res.rf : view.rf;
  const weeks = res.weekly && res.weekly.weeks
    ? `${num(res.weekly.weeks, 0)} settimane dal ${fmtDate(res.weekly.start)} al ${fmtDate(res.weekly.end)}`
    : '';
  const notes = (res.notes || []).map((n) => `<li>${esc(n)}</li>`).join('');
  const fx = (res.fxMissing || []).map((aid) => esc(asset(aid).name));
  return `${frontierChart(res, view)}
    <div class="fr-legend">
      ${legendCard('cur', COLORS.current, 'Portafoglio attuale', res.current, rf)}
      ${legendCard('ms', COLORS.maxSharpe, 'Massimo Sharpe', res.maxSharpe, rf)}
      ${legendCard('mv', COLORS.minVar, 'Minima varianza', res.minVar, rf)}
    </div>
    <p class="fr-meta">${esc([weeks, `${res.names.length} titoli`, `tasso privo di rischio ${pct(rf, 2)}`, Number.isFinite(res.shrinkage) ? `shrinkage ${pct(res.shrinkage, 0)}` : ''].filter(Boolean).join(' · '))}</p>
    ${notes ? `<ul class="fr-notes">${notes}</ul>` : ''}
    ${fx.length ? `<p class="rcard-note">Cambio non disponibile per ${fx.join(', ')}: rendimenti in valuta locale.</p>` : ''}
    ${missingFrontierList(res)}
    ${weightsTable(res)}
    <div class="fr-actions">
      <button class="btn" type="button" data-act="risk-csv">${icon('download')}Scarica portafogli .csv</button>
      <p class="fr-disclaimer">${icon('info')}<span>Come leggerlo: ogni punto è un portafoglio fatto con i tuoi titoli; più a destra oscilla di più, più in alto ha reso di più. La curva dorata è il meglio ottenuto nel passato per ogni livello di rischio. È una stima storica, non una previsione né un consiglio d'investimento: i rendimenti attesi sono medie passate e per i titoli saliti molto possono sembrare irrealistici.</span></p>
    </div>`;
}

function frontierCard(ctx, open) {
  const view = { w: ctx.w, h: ctx.desktop ? 400 : 320, rf: ctx.rf };
  const key = frontierKey(ctx, open);
  const token = hashStr(key);
  let body;
  if (FR.key === key && FR.result) body = frontierBody(FR.result, view);
  else {
    FR.job = { key, token, open, today: ctx.today, rf: ctx.rf, view };
    body = frontierPlaceholder(view.h);
  }
  return chartCard({
    title: 'Frontiera efficiente di Markowitz',
    subtitle: esc(FRONTIER_SUB),
    info: 'frontiera',
    body: `<div id="risk-frontier" data-token="${token}">${body}</div>`,
    cls: 'full fr-card',
  });
}

// After the page is painted: compute the pending frontier and fill its card
function runFrontierJob() {
  const job = FR.job;
  FR.job = null;
  if (!job || typeof document === 'undefined') return;
  const res = computeFrontier(job.open, { today: job.today, rf: job.rf });
  FR.key = job.key;
  FR.result = res;
  const box = document.getElementById('risk-frontier');
  if (box && box.dataset.token === job.token) box.innerHTML = frontierBody(res, job.view);
}

MOUNTS.push(() => {
  if (typeof document === 'undefined') return;
  clearTimeout(FR.timer);
  if (!FR.job) return;
  if (!document.getElementById('risk-frontier')) {
    FR.job = null;
    return;
  }
  FR.timer = setTimeout(runFrontierJob, 60);
});

/* ---------- Sheet ---------- */
function renderRisk(ctx) {
  const d = riskData(ctx);
  const intro = `<p class="report-note risk-intro">${icon('shield')}<span>Rischio calcolato sui titoli che possiedi <b>oggi</b>, con i pesi di oggi, applicati agli ultimi ${BACK_YEARS} anni di prezzi in euro. Non dipende dal periodo scelto sopra.</span>${infoBtn('rischioRetro')}</p>`;
  if (!d.open.length) {
    return `<div class="risk-sheet stack-lg">${intro}${emptyCard('Nessuna posizione aperta oggi: il profilo di rischio e la frontiera si calcolano sui titoli che possiedi.')}</div>`;
  }
  const top = d.rs && d.bp.n >= 2 ? `${riskGroups(ctx, d)}${windowLine(ctx, d)}` : noHistoryCard(ctx, d);
  return `<div class="risk-sheet stack-lg">
    ${intro}
    ${top}
    ${frontierCard(ctx, d.open)}
  </div>`;
}

Object.assign(ACTIONS, {
  'risk-csv': () => {
    const res = FR.result;
    if (!res || !res.ok) {
      app.toast('La frontiera non è ancora pronta');
      return;
    }
    saveFile(CSV_NAME, frontierCsv(res), 'text/csv;charset=utf-8')
      .then((ok) => {
        if (ok) app.toast('File dei portafogli pronto');
      })
      .catch(() => app.toast('Non riesco a creare il file'));
  },
});

registerSheet({
  id: 'risk',
  order: 6,
  title: 'Gestione del rischio',
  subtitle: 'Profilo di rischio retroproiettato sull\'allocazione attuale e frontiera efficiente calcolata in EUR.',
  render: renderRisk,
});

export const _test = { FR, runFrontierJob, hashStr, reasonText, benchFxHistory };
