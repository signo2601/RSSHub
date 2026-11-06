// Mercati → Panoramica: indices, government bonds and AAA corporate bonds, commodities, currencies
// and the largest cryptocurrencies, with the change over the chosen period.
import { SHEETS } from '../registry.js';
import { eco } from '../eco.js';
import { NAMES } from '../world.js';
import { esc, fmtDate, num } from '../util.js';
import {
  prefs, PERIODS, periodField, periodLong, periodLabel, periodSeg, fmtNum, fmtPct, fmtPctSigned, fmtBp, fmtBig,
  chgPill, bpPill, flagSpan, stampLine, emptyState, finiteNum, dateOfSec,
} from './eco-common.js';

/* ---------- What the page shows ---------- */
// [TradingView ticker, name, country]
const INDICES = [
  ['Europa', [
    ['TVC:FTMIB', 'FTSE MIB', 'IT'],
    ['TVC:SX5E', 'Euro Stoxx 50', 'EU'],
    ['TVC:SXXP', 'Stoxx Europe 600', 'EU'],
    ['TVC:DEU40', 'DAX 40', 'DE'],
    ['TVC:CAC40', 'CAC 40', 'FR'],
    ['TVC:UKX', 'FTSE 100', 'GB'],
    ['TVC:IBEX35', 'IBEX 35', 'ES'],
    ['EURONEXT:AEX', 'AEX', 'NL'],
    ['SIX:SMI', 'SMI', 'CH'],
  ]],
  ['America', [
    ['SP:SPX', 'S&P 500', 'US'],
    ['NASDAQ:NDX', 'Nasdaq 100', 'US'],
    ['DJ:DJI', 'Dow Jones', 'US'],
    ['TVC:RUT', 'Russell 2000', 'US'],
    ['CBOE:VIX', 'VIX (volatilità S&P 500)', 'US'],
    ['TSX:TSX', 'S&P/TSX', 'CA'],
    ['BMFBOVESPA:IBOV', 'Bovespa', 'BR'],
  ]],
  ['Asia e Pacifico', [
    ['TVC:NI225', 'Nikkei 225', 'JP'],
    ['TVC:HSI', 'Hang Seng', 'HK'],
    ['SSE:000001', 'Shanghai Composite', 'CN'],
    ['SSE:000300', 'CSI 300', 'CN'],
    ['TVC:KOSPI', 'KOSPI', 'KR'],
    ['TWSE:IX0001', 'Taiex', 'TW'],
    ['BSE:SENSEX', 'Sensex', 'IN'],
    ['SP:XJO', 'S&P/ASX 200', 'AU'],
  ]],
];

// [ticker, name, unit]
const COMMODITIES = [
  ['Energia', [
    ['NYMEX:CL1!', 'Petrolio WTI', '$/barile'],
    ['ICEEUR:BRN1!', 'Petrolio Brent', '$/barile'],
    ['EEX:G3BM1!', 'Gas naturale TTF (Europa)', '€/MWh'],
    ['NYMEX:NG1!', 'Gas naturale (USA)', '$/MMBtu'],
    ['NYMEX:RB1!', 'Benzina RBOB', '$/gallone'],
    ['COMEX:UX1!', 'Uranio', '$/libbra'],
  ]],
  ['Metalli preziosi', [
    ['TVC:GOLD', 'Oro', '$/oncia'],
    ['TVC:SILVER', 'Argento', '$/oncia'],
    ['TVC:PLATINUM', 'Platino', '$/oncia'],
    ['TVC:PALLADIUM', 'Palladio', '$/oncia'],
  ]],
  ['Metalli industriali', [
    ['COMEX:HG1!', 'Rame', '$/libbra'],
    ['COMEX:ALI1!', 'Alluminio', '$/tonnellata'],
  ]],
  ['Agricoltura', [
    ['CBOT:ZW1!', 'Grano', '$/bushel'],
    ['CBOT:ZC1!', 'Mais', '$/bushel'],
    ['CBOT:ZS1!', 'Soia', '$/bushel'],
    ['ICEUS:KC1!', 'Caffè', '$/libbra'],
    ['ICEUS:CC1!', 'Cacao', '$/tonnellata'],
    ['ICEUS:SB1!', 'Zucchero', '$/libbra'],
    ['ICEUS:CT1!', 'Cotone', '$/libbra'],
  ]],
];

// [ticker, pair, name, flags, decimals]
const CURRENCIES = [
  ["L'euro contro", [
    ['FX_IDC:EURUSD', 'EUR/USD', 'Dollaro USA', 'EU US', 4],
    ['FX_IDC:EURGBP', 'EUR/GBP', 'Sterlina britannica', 'EU GB', 4],
    ['FX_IDC:EURCHF', 'EUR/CHF', 'Franco svizzero', 'EU CH', 4],
    ['FX_IDC:EURJPY', 'EUR/JPY', 'Yen giapponese', 'EU JP', 2],
    ['FX_IDC:EURCNY', 'EUR/CNY', 'Yuan cinese', 'EU CN', 4],
    ['FX_IDC:EURSEK', 'EUR/SEK', 'Corona svedese', 'EU SE', 4],
    ['FX_IDC:EURNOK', 'EUR/NOK', 'Corona norvegese', 'EU NO', 4],
  ]],
  ['Il dollaro', [
    ['TVC:DXY', 'DXY', 'Indice del dollaro', 'US', 2],
    ['FX_IDC:GBPUSD', 'GBP/USD', 'Sterlina contro dollaro', 'GB US', 4],
    ['FX_IDC:USDJPY', 'USD/JPY', 'Dollaro contro yen', 'US JP', 2],
    ['FX_IDC:USDCHF', 'USD/CHF', 'Dollaro contro franco', 'US CH', 4],
    ['FX_IDC:USDCNY', 'USD/CNY', 'Dollaro contro yuan', 'US CN', 4],
    ['FX_IDC:AUDUSD', 'AUD/USD', 'Dollaro australiano', 'AU US', 4],
    ['FX_IDC:USDCAD', 'USD/CAD', 'Dollaro canadese', 'US CA', 4],
  ]],
];

// AAA corporate bonds: only Microsoft and Johnson & Johnson have the top rating.
// [ticker, issuer, short name, logo, coupon %, currency]
const AAA_BONDS = [
  ['BONDSCOM:US594918BY93', 'Microsoft', 'Microsoft', 'microsoft', 3.3, 'USD'],
  ['BONDSCOM:XS1001749289', 'Microsoft', 'Microsoft', 'microsoft', 3.125, 'EUR'],
  ['BONDSCOM:XS0922885362', 'Microsoft', 'Microsoft', 'microsoft', 2.625, 'EUR'],
  ['BONDSCOM:US594918BS26', 'Microsoft', 'Microsoft', 'microsoft', 3.45, 'USD'],
  ['BONDSCOM:US594918CE21', 'Microsoft', 'Microsoft', 'microsoft', 2.921, 'USD'],
  ['BONDSCOM:XS3005214104', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 2.7, 'EUR'],
  ['BONDSCOM:US478160DJ00', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 4.7, 'USD'],
  ['BONDSCOM:XS3005214799', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 3.35, 'EUR'],
  ['BONDSCOM:US478160DL55', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 5, 'USD'],
  ['BONDSCOM:XS3005215093', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 3.6, 'EUR'],
  ['BONDSCOM:US478160CX03', 'Johnson & Johnson', 'J&J', 'johnson-and-johnson', 5.25, 'USD'],
];

// Government bonds of developed countries (data of the yield curves)
const GOV_COUNTRIES = ['IT', 'DE', 'FR', 'ES', 'PT', 'GR', 'NL', 'BE', 'AT', 'IE', 'FI', 'GB', 'CH', 'SE', 'NO', 'DK', 'US', 'CA', 'JP', 'AU', 'NZ'];
export const EURO_AREA = new Set(['IT', 'DE', 'FR', 'ES', 'PT', 'GR', 'NL', 'BE', 'AT', 'IE', 'FI']);

// Highlights at the top: [kind, ticker or key, label]
const HIGHLIGHTS = [
  ['quote', 'TVC:FTMIB', 'FTSE MIB'],
  ['quote', 'SP:SPX', 'S&P 500'],
  ['quote', 'TVC:SX5E', 'Euro Stoxx 50'],
  ['spread', 'IT', 'Spread BTP-Bund'],
  ['yield', 'IT', 'BTP 10 anni'],
  ['fx', 'FX_IDC:EURUSD', 'EUR/USD'],
  ['quote', 'TVC:GOLD', 'Oro'],
  ['quote', 'ICEEUR:BRN1!', 'Brent'],
  ['crypto', 'CRYPTO:BTCUSD', 'Bitcoin'],
];

export const OVERVIEW_PERIODS = ['1D', '1W', '1M', 'YTD', '1Y'];
export const OVERVIEW_TICKERS = [
  ...INDICES.flatMap(([, list]) => list.map((x) => x[0])),
  ...COMMODITIES.flatMap(([, list]) => list.map((x) => x[0])),
  ...CURRENCIES.flatMap(([, list]) => list.map((x) => x[0])),
  ...AAA_BONDS.map((x) => x[0]),
];

// Data the page needs: { key, path, maxAge }
export function wants() {
  return [
    { key: 'overview', path: `/eco/quotes?t=${OVERVIEW_TICKERS.map(encodeURIComponent).join(',')}`, maxAge: 90e3 },
    { key: 'yields', path: '/eco/yields', maxAge: 180e3 },
    { key: 'crypto', path: '/eco/crypto', maxAge: 180e3 },
  ];
}

/* ---------- Reading the answers ---------- */
const QCOL = { price: 0, chg: 1, chgAbs: 2, w: 3, m1: 4, m3: 5, m6: 6, ytd: 7, y: 8, time: 9, ccy: 10, name: 11, ytm: 12, maturity: 13 };
export function quote(ticker) {
  const d = eco.data('overview');
  const r = d && d.rows ? d.rows[ticker] : null;
  return Array.isArray(r) ? r : null;
}
const qv = (r, field) => (r ? r[QCOL[field]] ?? null : null);

// Yield curves: { IT: [[months, yield, chgAbs, w, m1, ytd, y, time], ...] }
const YCOL = { months: 0, yield: 1, chgAbs: 2, w: 3, m1: 4, ytd: 5, y: 6, time: 7 };
export function curve(cc) {
  const d = eco.data('yields');
  const c = d && d.curves ? d.curves[cc] : null;
  return Array.isArray(c) ? c : null;
}
// Yield at a tenor (months) and its change over the period in percentage points
export function yieldAt(cc, months, period = '1D') {
  const c = curve(cc);
  const p = c ? c.find((x) => x[0] === months) : null;
  if (!p || !finiteNum(p[1])) return null;
  return { value: p[1], change: yieldChange(p, period), time: p[YCOL.time] };
}
// Change of a yield over the period, in percentage points. TradingView gives the 1-day change in
// points and the other periods as % change of the yield itself: undo that to get the old level.
export function yieldChange(p, period) {
  if (!p || !finiteNum(p[1])) return null;
  if (period === '1D') return finiteNum(p[2]) ? p[2] : null;
  const f = { '1W': YCOL.w, '1M': YCOL.m1, YTD: YCOL.ytd, '1Y': YCOL.y }[period];
  const perf = f !== undefined ? p[f] : null;
  if (!finiteNum(perf) || perf <= -100) return null;
  const old = p[1] / (1 + perf / 100);
  return Number.isFinite(old) && Math.abs(old) < 100 ? p[1] - old : null;
}
// Old level of a yield over the period (for the comparison curves)
export function yieldBefore(p, period) {
  const ch = yieldChange(p, period);
  return ch === null ? null : p[1] - ch;
}

// Crypto rows: [symbol, code, name, logo, priceUSD, chg, w, m1, ytd, y, mcapM, time]
const CCOL = { chg: 5, w: 6, m1: 7, ytd: 8, y: 9 };
function eurPerUsd() {
  const r = quote('FX_IDC:EURUSD');
  const p = qv(r, 'price');
  return p > 0 ? 1 / p : null;
}

/* ---------- Rendering ---------- */
const countryName = (cc) => (cc === 'EU' ? 'Europa' : NAMES[cc] || cc);
const perfOf = (r, period) => qv(r, periodField(period));

function priceText(r, dp) {
  const v = qv(r, 'price');
  return fmtNum(v, dp);
}

function quoteRow(ticker, title, sub, { dp, flags = '', logo = '', unit = '' } = {}, period) {
  const r = quote(ticker);
  const lead = logo || (flags ? `<span class="eco-flags">${flags.split(' ').map((c) => flagSpan(c)).join('')}</span>` : '');
  return `<button class="row eco-row" type="button" data-act="eco-quote" data-t="${esc(ticker)}" data-label="${esc(title)}">
    ${lead}
    <span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${esc(sub)}</span></span>
    <span class="row-end"><span class="row-value num">${r ? priceText(r, dp) : '—'}${unit && r ? ` <small>${esc(unit)}</small>` : ''}</span>${r ? chgPill(perfOf(r, period)) : '<span class="row-sub">n.d.</span>'}</span>
  </button>`;
}

function groupBlock(label, rows) {
  return `${label ? `<p class="eco-group-label">${esc(label)}</p>` : ''}<div class="list eco-list">${rows.join('')}</div>`;
}

function indicesSection(period) {
  return `<section class="section eco-sec" aria-label="Indici azionari">
    <div class="sec-head"><h2>Indici azionari</h2></div>
    ${INDICES.map(([g, list]) => groupBlock(g, list.map(([t, name, cc]) => quoteRow(t, name, countryName(cc), { flags: cc }, period)))).join('')}
  </section>`;
}

// Developed countries' government bond yields: 10 years large, 2 and 30 years and the spread on Bund below
function govSection(period) {
  if (!eco.data('yields')) return `<section class="section eco-sec" aria-label="Titoli di Stato"><div class="sec-head"><h2>Titoli di Stato</h2></div>${emptyState('yields', { what: 'i rendimenti' })}</section>`;
  const bund = yieldAt('DE', 120, period);
  const rows = GOV_COUNTRIES.map((cc) => {
    const ten = yieldAt(cc, 120, period);
    if (!ten) return '';
    const two = yieldAt(cc, 24, period);
    const thirty = yieldAt(cc, 360, period);
    // Euro area: the spread on the Bund first (the number people follow), then the 2 years
    const spread = EURO_AREA.has(cc) && cc !== 'DE' && bund ? `spread ${fmtNum((ten.value - bund.value) * 100, 0)} pb` : '';
    const bits = spread ? [spread, two ? `2A ${fmtPct(two.value)}` : ''] : [two ? `2A ${fmtPct(two.value)}` : '', thirty ? `30A ${fmtPct(thirty.value)}` : ''];
    return `<button class="row eco-row" type="button" data-act="eco-curve" data-cc="${esc(cc)}">
      ${flagSpan(cc)}
      <span class="row-main"><span class="row-title">${esc(countryName(cc))}</span><span class="row-sub">${esc(bits.filter(Boolean).join(' · '))}</span></span>
      <span class="row-end"><span class="row-value num">${fmtPct(ten.value)}</span>${bpPill(ten.change)}</span>
    </button>`;
  }).filter(Boolean);
  return `<section class="section eco-sec" aria-label="Titoli di Stato">
    <div class="sec-head"><h2>Titoli di Stato</h2><span class="hint">Rendimento a 10 anni</span></div>
    ${groupBlock('', rows)}
    <p class="hint">Lo spread è la differenza con il Bund tedesco a 10 anni, in punti base (100 pb = 1%). Tocca un Paese per la sua curva.</p>
  </section>`;
}

function bondsSection(period) {
  const rows = AAA_BONDS.map(([t, issuer, short, logo, coupon, ccy]) => {
    const r = quote(t);
    const mat = qv(r, 'maturity');
    const ytm = qv(r, 'ytm');
    const title = `${short} ${num(coupon, 3)}% ${mat ? mat.slice(0, 4) : ''}`.trim();
    const sub = [ccy === 'EUR' ? 'in euro' : 'in dollari', r ? `prezzo ${fmtNum(qv(r, 'price'))}` : ''].filter(Boolean).join(' · ');
    return `<button class="row eco-row" type="button" data-act="eco-quote" data-t="${esc(t)}" data-label="${esc(`${issuer} ${num(coupon, 3)}% ${mat ? mat.slice(0, 4) : ''}`.trim())}">
      ${logoImg(logo, issuer)}
      <span class="row-main"><span class="row-title">${esc(title)}</span><span class="row-sub">${esc(sub)}</span></span>
      <span class="row-end"><span class="row-value num">${finiteNum(ytm) ? fmtPct(ytm) : '—'}</span>${r ? chgPill(perfOf(r, period)) : '<span class="row-sub">n.d.</span>'}</span>
    </button>`;
  });
  return `<section class="section eco-sec" aria-label="Obbligazioni societarie AAA">
    <div class="sec-head"><h2>Corporate bond AAA</h2><span class="hint">Rendimento a scadenza</span></div>
    ${groupBlock('', rows)}
    <p class="hint">Obbligazioni delle sole due aziende al mondo con il rating AAA, il più alto: Microsoft e Johnson &amp; Johnson (J&amp;J). L'anno nel nome è la scadenza; la percentuale colorata è la variazione del prezzo.</p>
  </section>`;
}

function commoditiesSection(period) {
  return `<section class="section eco-sec" aria-label="Materie prime">
    <div class="sec-head"><h2>Materie prime</h2><span class="hint">Contratti futures</span></div>
    ${COMMODITIES.map(([g, list]) => groupBlock(g, list.map(([t, name, unit]) => quoteRow(t, name, unit, { flags: '' }, period)))).join('')}
  </section>`;
}

function currenciesSection(period) {
  return `<section class="section eco-sec" aria-label="Valute">
    <div class="sec-head"><h2>Valute</h2></div>
    ${CURRENCIES.map(([g, list]) => groupBlock(g, list.map(([t, pair, name, flags, dp]) => quoteRow(t, pair, name, { flags, dp }, period)))).join('')}
  </section>`;
}

export function logoImg(id, alt = '', cls = '') {
  if (!id) return `<span class="eco-logo ${cls} empty" aria-hidden="true">${esc(String(alt || '?').slice(0, 1))}</span>`;
  // A logo that fails to load is removed by the shell (market.js): the initial behind it shows
  return `<span class="eco-logo ${cls}" aria-hidden="true"><b>${esc(String(alt || '?').slice(0, 1))}</b><img src="${esc(eco.logoUrl(id))}" alt="" loading="lazy" decoding="async"></span>`;
}

function cryptoSection(period) {
  const d = eco.data('crypto');
  if (!d || !Array.isArray(d.rows)) return `<section class="section eco-sec" aria-label="Criptovalute"><div class="sec-head"><h2>Criptovalute</h2></div>${emptyState('crypto', { what: 'le criptovalute' })}</section>`;
  const fx = eurPerUsd();
  const field = CCOL[periodField(period)] ?? CCOL.chg;
  const rows = d.rows.map((r) => {
    const [symbol, code, name, logo, usd, , , , , , mcap] = r;
    const price = fx ? usd * fx : usd;
    const ccySign = fx ? '€' : '$';
    const sub = [code, finiteNum(mcap) ? `cap. ${fmtBig(mcap * 1e6 * (fx || 1), ccySign)}` : ''].filter(Boolean).join(' · ');
    return `<button class="row eco-row" type="button" data-act="eco-crypto" data-t="${esc(symbol)}">
      ${logoImg(logo, code, 'round')}
      <span class="row-main"><span class="row-title">${esc(name)}</span><span class="row-sub">${esc(sub)}</span></span>
      <span class="row-end"><span class="row-value num">${fmtNum(price, price >= 1 ? 2 : 4)} ${ccySign}</span>${chgPill(r[field])}</span>
    </button>`;
  });
  return `<section class="section eco-sec" aria-label="Criptovalute">
    <div class="sec-head"><h2>Criptovalute</h2><span class="hint">Le più grandi, senza stablecoin</span></div>
    ${groupBlock('', rows)}
    ${fx ? '' : '<p class="hint">Prezzi in dollari: il cambio euro/dollaro non è ancora disponibile.</p>'}
  </section>`;
}

/* ---------- Highlights strip ---------- */
function highlight([kind, key, label], period) {
  let value = '—';
  let pill = '<span class="pill flat">—</span>';
  let act = '';
  if (kind === 'quote' || kind === 'fx') {
    const r = quote(key);
    if (r) {
      value = fmtNum(qv(r, 'price'), kind === 'fx' ? 4 : 2);
      pill = chgPill(perfOf(r, period));
    }
    act = `data-act="eco-quote" data-t="${esc(key)}" data-label="${esc(label)}"`;
  } else if (kind === 'yield') {
    const y = yieldAt(key, 120, period);
    if (y) {
      value = fmtPct(y.value);
      pill = bpPill(y.change);
    }
    act = `data-act="eco-curve" data-cc="${esc(key)}"`;
  } else if (kind === 'spread') {
    const a = yieldAt(key, 120, period);
    const b = yieldAt('DE', 120, period);
    if (a && b) {
      value = `${fmtNum((a.value - b.value) * 100, 0)} pb`;
      pill = a.change !== null && b.change !== null ? bpPill(a.change - b.change) : pill;
    }
    act = `data-act="eco-curve" data-cc="${esc(key)}"`;
  } else if (kind === 'crypto') {
    const d = eco.data('crypto');
    const r = d && Array.isArray(d.rows) ? d.rows.find((x) => x[0] === key) : null;
    const fx = eurPerUsd();
    if (r) {
      value = `${fmtNum(fx ? r[4] * fx : r[4], 0)} ${fx ? '€' : '$'}`;
      pill = chgPill(r[CCOL[periodField(period)] ?? CCOL.chg]);
    }
    act = `data-act="eco-crypto" data-t="${esc(key)}"`;
  }
  return `<button class="eco-hl" type="button" ${act}><span class="eco-hl-label">${esc(label)}</span><span class="eco-hl-value num">${esc(value)}</span>${pill}</button>`;
}

export function renderOverview() {
  const p = prefs();
  const period = OVERVIEW_PERIODS.includes(p.period) ? p.period : '1D';
  const have = eco.data('overview');
  const top = `<div class="eco-toolbar">${periodSeg(OVERVIEW_PERIODS, period, 'eco-period', 'Variazione su')}</div>
    <div class="eco-hl-strip" role="list" aria-label="In evidenza">${HIGHLIGHTS.map((h) => highlight(h, period)).join('')}</div>`;
  if (!have) {
    return `${top}${emptyState('overview', { what: 'i mercati' })}${govSection(period)}${cryptoSection(period)}`;
  }
  return `${top}
    ${stampLine('overview', { note: `Variazioni ${esc(periodLong(period))}` })}
    ${indicesSection(period)}
    ${govSection(period)}
    ${bondsSection(period)}
    ${commoditiesSection(period)}
    ${currenciesSection(period)}
    ${cryptoSection(period)}
    <p class="hint eco-foot">Dati di TradingView, in ritardo fino a 15 minuti. Solo informativi: non sono consigli di investimento.</p>`;
}

/* ---------- Detail sheet: performance over every period ---------- */
function perfGrid(values) {
  return `<div class="eco-perf-grid">${values.map(([label, v, fmt]) => `<div class="eco-perf"><span>${esc(label)}</span>${fmt ? fmt(v) : chgPill(v)}</div>`).join('')}</div>`;
}

SHEETS.ecoQuote = (args = {}) => {
  const r = quote(args.t);
  const title = args.label || (r && qv(r, 'name')) || args.t;
  if (!r) return { title, body: '<div class="empty compact"><p>Dati non disponibili per questo strumento.</p></div>' };
  const isBond = finiteNum(qv(r, 'ytm'));
  const ccy = qv(r, 'ccy');
  const head = isBond
    ? `<div class="quote-price"><div class="price-big num">${fmtPct(qv(r, 'ytm'))}</div><p class="src-line">Rendimento a scadenza · prezzo ${fmtNum(qv(r, 'price'))}${qv(r, 'maturity') ? ` · scade il ${fmtDate(qv(r, 'maturity'))}` : ''}</p></div>`
    : `<div class="quote-price"><div class="price-big num">${fmtNum(qv(r, 'price'))}${ccy ? ` <small>${esc(ccy)}</small>` : ''}</div>
       <div class="price-change">${chgPill(qv(r, 'chg'))} <span class="muted num">${finiteNum(qv(r, 'chgAbs')) ? (qv(r, 'chgAbs') >= 0 ? '+' : '−') + fmtNum(Math.abs(qv(r, 'chgAbs'))) : ''}</span></div></div>`;
  const when = dateOfSec(qv(r, 'time'));
  return {
    title,
    body: `<div class="eco-sheet">
      ${isBond ? `<p class="eco-sheet-sub">${esc(qv(r, 'name') || args.t)}</p>` : ''}
      ${head}
      <h3 class="eco-sheet-h">${isBond ? 'Andamento del prezzo' : 'Andamento'}</h3>
      ${perfGrid([['Oggi', qv(r, 'chg')], ['1 settimana', qv(r, 'w')], ['1 mese', qv(r, 'm1')], ['3 mesi', qv(r, 'm3')], ['6 mesi', qv(r, 'm6')], ['Da inizio anno', qv(r, 'ytd')], ['1 anno', qv(r, 'y')]])}
      <p class="hint">${when ? `Ultimo dato del ${esc(fmtDate(when))}. ` : ''}Fonte TradingView (${esc(args.t)}), con un ritardo fino a 15 minuti.</p>
    </div>`,
  };
};

SHEETS.ecoCrypto = (args = {}) => {
  const d = eco.data('crypto');
  const r = d && Array.isArray(d.rows) ? d.rows.find((x) => x[0] === args.t) : null;
  if (!r) return { title: 'Criptovaluta', body: '<div class="empty compact"><p>Dati non disponibili.</p></div>' };
  const [, code, name, logo, usd, chg, w, m1, ytd, y, mcap] = r;
  const fx = eurPerUsd();
  return {
    title: name,
    body: `<div class="eco-sheet">
      <div class="detail-head">${logoImg(logo, code, 'round lg')}<div class="detail-title"><h3>${esc(name)}</h3><div class="tags"><span class="tag">${esc(code)}</span></div></div></div>
      <div class="quote-price"><div class="price-big num">${fx ? `${fmtNum(usd * fx, usd * fx >= 1 ? 2 : 4)} €` : `${fmtNum(usd)} $`}</div>
        <p class="src-line">${fx ? `${fmtNum(usd, usd >= 1 ? 2 : 4)} $ · ` : ''}capitalizzazione ${fmtBig(mcap * 1e6, '$')}</p></div>
      <h3 class="eco-sheet-h">Andamento</h3>
      ${perfGrid([['24 ore', chg], ['1 settimana', w], ['1 mese', m1], ['Da inizio anno', ytd], ['1 anno', y]])}
      <p class="hint">Fonte TradingView (${esc(args.t)}). Le criptovalute possono perdere gran parte del valore in poco tempo.</p>
    </div>`,
  };
};

export const _test = { yieldChange, yieldBefore, OVERVIEW_TICKERS, GOV_COUNTRIES, PERIODS, periodLabel, fmtBp, fmtPctSigned };
