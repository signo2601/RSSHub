// Mercati → Agenda: the economic calendar of the main economies (inflation, central bank decisions,
// GDP, jobs, business surveys…): the latest results with their expectations, then the coming days.
// Titles arrive in English from TradingView: the common ones are translated, and the most important
// indicators carry a one-line explanation for a non-expert.
import { SHEETS, ACTIONS } from '../registry.js';
import { app } from '../app.js';
import { eco } from '../eco.js';
import { NAMES } from '../world.js';
import { esc, iso, todayISO, addDays, MONTHS } from '../util.js';
import { prefs, fmtNum, flagSpan, stampLine, emptyState, finiteNum } from './eco-common.js';

const COL = { id: 0, date: 1, country: 2, title: 3, period: 4, actual: 5, forecast: 6, previous: 7, unit: 8, scale: 9, high: 10 };

// Country chips: [key, label, countries]
export const CAL_REGIONS = [
  ['all', 'Tutti', null],
  ['it', 'Italia', ['IT']],
  ['europe', 'Europa', ['EU', 'IT', 'DE', 'FR', 'ES', 'GB', 'CH']],
  ['us', 'Stati Uniti', ['US']],
  ['asia', 'Asia', ['JP', 'CN']],
];

export function wants() {
  return [{ key: 'calendar', path: '/eco/calendar', maxAge: 10 * 60e3 }];
}

/* ---------- Titles in Italian ---------- */
// Whole titles first (most common releases), then pieces; anything unknown stays in English.
const TITLES = [
  [/^Inflation Rate YoY/, 'Inflazione annua'],
  [/^Inflation Rate MoM/, 'Inflazione mensile'],
  [/^Core Inflation Rate YoY/, 'Inflazione di fondo annua'],
  [/^Core Inflation Rate MoM/, 'Inflazione di fondo mensile'],
  [/^Harmonised Inflation Rate YoY/, 'Inflazione armonizzata annua'],
  [/^Harmonised Inflation Rate MoM/, 'Inflazione armonizzata mensile'],
  [/^Consumer Price Index/, 'Indice dei prezzi al consumo'],
  [/^(Fed |ECB |BoE |BoJ |SNB |PBoC )?Interest Rate( Decision)?$/, 'Decisione sui tassi'],
  [/^Deposit Facility Rate/, 'Tasso sui depositi'],
  [/^Main Refinancing Rate/, 'Tasso di rifinanziamento principale'],
  [/^Loan Prime Rate 1Y/, 'Tasso di riferimento sui prestiti a 1 anno'],
  [/^Loan Prime Rate (\d+)Y/, 'Tasso di riferimento sui prestiti a $1 anni'],
  [/^GDP Growth Rate QoQ/, 'PIL trimestrale'],
  [/^GDP Growth Rate YoY/, 'PIL annuo'],
  [/^GDP Growth Annualized/, 'PIL annualizzato'],
  [/^GDP MoM/, 'PIL mensile'],
  [/^GDP YoY/, 'PIL annuo'],
  [/^Unemployment Rate/, 'Tasso di disoccupazione'],
  [/^Non Farm Payrolls/, 'Nuovi occupati (non agricoli)'],
  [/^ADP Employment Change/, 'Nuovi occupati ADP'],
  [/^Initial Jobless Claims/, 'Nuove richieste di sussidio'],
  [/^Continuing Jobless Claims/, 'Richieste di sussidio continuative'],
  [/^Average Hourly Earnings MoM/, 'Salari orari mensili'],
  [/^Average Hourly Earnings YoY/, 'Salari orari annui'],
  [/^Participation Rate/, 'Tasso di partecipazione al lavoro'],
  [/^Retail Sales MoM/, 'Vendite al dettaglio mensili'],
  [/^Retail Sales YoY/, 'Vendite al dettaglio annue'],
  [/^Retail Sales Ex Autos MoM/, 'Vendite al dettaglio senza auto'],
  [/^Industrial Production MoM/, 'Produzione industriale mensile'],
  [/^Industrial Production YoY/, 'Produzione industriale annua'],
  [/^Manufacturing Production/, 'Produzione manifatturiera'],
  [/^(HCOB |S&P Global |ISM |Caixin |RatingDog |NBS |au Jibun Bank |Jibun Bank )?Manufacturing PMI/, 'PMI manifatturiero'],
  [/^(HCOB |S&P Global |ISM |Caixin |RatingDog |NBS |au Jibun Bank |Jibun Bank )?(Services|Non Manufacturing) PMI/, 'PMI servizi'],
  [/^(HCOB |S&P Global |Caixin |RatingDog |au Jibun Bank |Jibun Bank )?Composite PMI/, 'PMI composito'],
  [/^(HCOB |S&P Global )?Construction PMI/, 'PMI costruzioni'],
  [/^S&P Global All-Sector PMI/, 'PMI di tutti i settori'],
  [/^Balance of Trade/, 'Bilancia commerciale'],
  [/^Exports YoY/, 'Esportazioni annue'],
  [/^Imports YoY/, 'Importazioni annue'],
  [/^Exports MoM/, 'Esportazioni mensili'],
  [/^Imports MoM/, 'Importazioni mensili'],
  [/^Current Account/, 'Partite correnti'],
  [/^Consumer Confidence/, 'Fiducia dei consumatori'],
  [/^Business Confidence/, 'Fiducia delle imprese'],
  [/^Michigan Consumer Sentiment/, 'Fiducia dei consumatori (Michigan)'],
  [/^Michigan Inflation Expectations/, 'Inflazione attesa dai consumatori (Michigan)'],
  [/^ZEW Economic Sentiment/, 'Fiducia ZEW (analisti)'],
  [/^ZEW Current Conditions/, 'Situazione attuale ZEW'],
  [/^Ifo Business Climate/, 'Clima d\'impresa Ifo'],
  [/^Sentix Investor Confidence/, 'Fiducia degli investitori Sentix'],
  [/^PPI YoY/, 'Prezzi alla produzione annui'],
  [/^PPI MoM/, 'Prezzi alla produzione mensili'],
  [/^Producer Prices/, 'Prezzi alla produzione'],
  [/^Existing Home Sales/, 'Vendite di case esistenti'],
  [/^New Home Sales/, 'Vendite di case nuove'],
  [/^Housing Starts/, 'Nuovi cantieri'],
  [/^Building Permits/, 'Permessi di costruzione'],
  [/^Durable Goods Orders/, 'Ordini di beni durevoli'],
  [/^Factory Orders/, 'Ordini all\'industria'],
  [/^Personal Income/, 'Reddito delle famiglie'],
  [/^Personal Spending/, 'Spesa delle famiglie'],
  [/^Household Spending/, 'Spesa delle famiglie'],
  [/^PCE Price Index/, 'Inflazione PCE'],
  [/^Core PCE Price Index/, 'Inflazione PCE di fondo'],
  [/^Government Budget/, 'Saldo del bilancio pubblico'],
  [/^Leading Economic Index/, 'Indice anticipatore'],
  [/^Car Registrations/, 'Immatricolazioni di auto'],
  [/^Tourist Arrivals/, 'Arrivi di turisti'],
  [/NY Fed Inflation Expectation 1yr/, 'Inflazione attesa a 1 anno (Fed di New York)'],
  [/NY Fed Inflation Expectation (\d+)yr/, 'Inflazione attesa a $1 anni (Fed di New York)'],
  [/(Crude Oil|Gasoline) Stocks Change/, 'Scorte di $1'],
];
const SUFFIXES = [[/ Prel$/, ' · stima preliminare'], [/ Flash$/, ' · stima flash'], [/ Final$/, ' · dato finale'], [/ Adv$/, ' · prima stima'], [/ 2nd Est$/, ' · seconda stima'], [/ 3rd Est$/, ' · terza stima'], [/ s\.a$/, ' (destag.)']];

export function titleIt(title) {
  const t = String(title || '');
  for (const [re, it] of TITLES) {
    const m = t.match(re);
    if (m) {
      let out = it.replace(/\$(\d)/g, (_, i) => (m[+i] === 'Crude Oil' ? 'petrolio' : m[+i] === 'Gasoline' ? 'benzina' : m[+i] || ''));
      for (const [s, rep] of SUFFIXES) if (s.test(t)) out += rep;
      return out;
    }
  }
  return t;
}

// One-line explanations of the releases that move the markets
const EXPLAIN = [
  [/Inflation|Consumer Price|PCE/, 'Di quanto salgono i prezzi. Se è più alta delle attese, la banca centrale può alzare i tassi (o tagliarli più tardi): di solito i titoli di Stato perdono valore.'],
  [/Interest Rate|Deposit Facility|Refinancing|Loan Prime/, 'Il tasso deciso dalla banca centrale: muove i rendimenti dei titoli di Stato, i mutui, le valute e le Borse.'],
  [/^GDP/, 'Il prodotto interno lordo: quanto è cresciuta l\'economia. Un dato debole fa temere un rallentamento.'],
  [/Unemployment|Non Farm|Jobless|Employment/, 'Il mercato del lavoro: tanta occupazione sostiene i consumi, ma può spingere salari e inflazione.'],
  [/PMI/, 'Sondaggio tra i responsabili acquisti delle aziende: sopra 50 l\'attività cresce, sotto 50 si contrae. Anticipa l\'andamento dell\'economia.'],
  [/Retail Sales|Spending/, 'Quanto spendono i consumatori: è il motore principale dell\'economia.'],
  [/Industrial Production|Manufacturing Production|Factory Orders|Durable Goods/, 'Quanto producono fabbriche e industrie.'],
  [/Confidence|Sentiment|ZEW|Ifo|Sentix/, 'Fiducia di famiglie, imprese o investitori: anticipa le decisioni di spesa e di investimento.'],
  [/Balance of Trade|Exports|Imports|Current Account/, 'Scambi con l\'estero: esportazioni e importazioni di merci e servizi.'],
  [/PPI|Producer Prices/, 'I prezzi praticati dalle aziende: spesso anticipano l\'inflazione al consumo.'],
];
export const explain = (title) => (EXPLAIN.find(([re]) => re.test(title)) || [null, ''])[1];

// The releases worth a beginner's attention: every high-importance one, plus these medium ones
const KEY_MEDIUM = /Inflation|Consumer Price|Interest Rate|Deposit Facility|Refinancing|GDP|Unemployment Rate|Non Farm|Retail Sales (MoM|YoY)|Industrial Production|Manufacturing PMI|Services PMI|Composite PMI|Consumer Confidence|Business Confidence|ZEW Economic|Ifo Business|Michigan Consumer|PCE|Balance of Trade$/;
export const isKey = (row) => row[COL.high] === 1 || (KEY_MEDIUM.test(row[COL.title]) && !/ s\.a$/.test(row[COL.title]));

/* ---------- Values ---------- */
const MONTH_EN = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// 'Oct. 2026' → 'ott 2026', 'Q3 2026' → '3° trim. 2026'
export function periodIt(p) {
  const s = String(p || '').trim();
  const m = s.match(/^([A-Z][a-z]{2})\.?\s+(\d{4})$/);
  if (m && m[1] in MONTH_EN) return `${MONTHS[MONTH_EN[m[1]]]} ${m[2]}`;
  const q = s.match(/^Q([1-4])\s+(\d{4})$/);
  if (q) return `${q[1]}° trim. ${q[2]}`;
  return s;
}

const SCALE_WORD = { K: 'mila', M: 'mln', B: 'mld', T: 'mila mld' };
// As many decimals as the number has, at most 2 (4 → 4, 4.1 → 4,1, 3.75 → 3,75)
const decimalsOf = (v) => (Number.isInteger(v) ? 0 : Number.isInteger(Math.round(v * 1e6) / 1e5) ? 1 : 2);
// A value with its unit and scale: 4,1% · 165 mila · 19,6 mld € · 51
export function valueText(v, unit, scale) {
  if (!finiteNum(v)) return '—';
  const n = fmtNum(v, decimalsOf(v));
  if (unit === '%') return `${n}%`;
  return [n, scale && SCALE_WORD[scale] ? SCALE_WORD[scale] : '', unit || ''].filter(Boolean).join(' ');
}

// Released value compared with the expectation
function surprise(row) {
  const a = row[COL.actual];
  const f = row[COL.forecast];
  if (!finiteNum(a) || !finiteNum(f)) return '';
  const d = a - f;
  const tol = Math.max(Math.abs(f) * 0.002, 1e-9);
  if (Math.abs(d) <= tol) return '<span class="cal-vs flat">in linea con le attese</span>';
  return `<span class="cal-vs ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲ sopra' : '▼ sotto'} le attese</span>`;
}

/* ---------- Page ---------- */
const localDay = (isoDate) => iso(new Date(isoDate));
const timeText = (isoDate) => {
  const d = new Date(isoDate);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const WD_SHORT = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
// Left column of a released value: the time today, the day before
function whenShort(isoDate, today) {
  const day = localDay(isoDate);
  if (day === today) return timeText(isoDate);
  if (day === addDays(today, -1)) return 'ieri';
  const d = new Date(day + 'T12:00:00');
  return `${WD_SHORT[d.getDay()]} ${d.getDate()}`;
}
function dayLabel(day, today) {
  if (day === today) return 'Oggi';
  if (day === addDays(today, 1)) return 'Domani';
  if (day === addDays(today, -1)) return 'Ieri';
  const d = new Date(day + 'T12:00:00');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const countryName = (cc) => (cc === 'EU' ? 'Area euro' : NAMES[cc] || cc);

function rowHtml(row, { past = false } = {}) {
  const [id, date, cc, title, period, actual, forecast, previous, unit, scale, high] = row;
  const sub = [periodIt(period), finiteNum(previous) ? `prec. ${valueText(previous, unit, scale)}` : ''].filter(Boolean).join(' · ');
  const end = finiteNum(actual)
    ? `<span class="row-value num">${esc(valueText(actual, unit, scale))}</span>${surprise(row)}`
    : finiteNum(forecast)
      ? `<span class="cal-exp">attese</span><span class="row-value num cal-fc">${esc(valueText(forecast, unit, scale))}</span>`
      : '<span class="cal-exp">in uscita</span>';
  return `<button class="row eco-row cal-row${high ? ' high' : ''}" type="button" data-act="cal-open" data-id="${esc(id)}" data-date="${esc(date)}">
    <span class="cal-time num">${esc(past ? whenShort(date, todayISO()) : timeText(date))}</span>
    ${flagSpan(cc)}
    <span class="row-main"><span class="row-title">${esc(titleIt(title))}${high ? '\u00a0<span class="cal-hi" title="Dato molto importante">●</span>' : ''}</span><span class="row-sub">${esc(sub)}</span></span>
    <span class="row-end">${end}</span>
  </button>`;
}

export function renderCalendar() {
  const p = prefs();
  const region = CAL_REGIONS.find((r) => r[0] === p.calRegion) || CAL_REGIONS[0];
  p.calRegion = region[0];
  const onlyKey = p.calAll !== true;
  const controls = `<div class="chips cal-reg-chips" role="group" aria-label="Paesi" data-keep-x="cal-reg">${CAL_REGIONS.map(([k, label]) => `<button class="chip" type="button" data-act="cal-region" data-v="${k}" aria-pressed="${k === region[0]}">${esc(label)}</button>`).join('')}</div>
    <div class="seg cal-seg" role="group" aria-label="Quali dati">
      <button type="button" data-act="cal-all" data-v="0" aria-pressed="${onlyKey}">I più importanti</button>
      <button type="button" data-act="cal-all" data-v="1" aria-pressed="${!onlyKey}">Tutti</button>
    </div>`;
  const d = eco.data('calendar');
  if (!d || !Array.isArray(d.rows)) return `${controls}${emptyState('calendar', { what: 'il calendario economico' })}`;
  const today = todayISO();
  const nowIso = new Date().toISOString();
  const rows = d.rows.filter((r) => (!region[2] || region[2].includes(r[COL.country])) && (!onlyKey || isKey(r)));
  // Latest results: released in the last 3 days, newest first
  const released = rows.filter((r) => finiteNum(r[COL.actual]) && r[COL.date] <= nowIso).sort((a, b) => (a[COL.date] < b[COL.date] ? 1 : -1)).slice(0, 8);
  // Coming: from now on (today's released ones stay in "Ultimi risultati"), grouped by local day
  const upcoming = rows.filter((r) => localDay(r[COL.date]) >= today && !(finiteNum(r[COL.actual]) && r[COL.date] <= nowIso));
  const days = new Map();
  for (const r of upcoming) {
    const k = localDay(r[COL.date]);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(r);
  }
  const groups = [...days].map(([day, list]) => `<p class="eco-group-label cal-day">${esc(dayLabel(day, today))}</p><div class="list eco-list">${list.map((r) => rowHtml(r)).join('')}</div>`).join('');
  return `${controls}
    ${stampLine('calendar', { note: 'orari italiani' })}
    <div class="eco-cols">
    <section class="section eco-sec" aria-label="Ultimi risultati">
      <div class="sec-head"><h2>Ultimi risultati</h2><span class="hint">dato e attese</span></div>
      ${released.length ? `<div class="list eco-list">${released.map((r) => rowHtml(r, { past: true })).join('')}</div>` : '<div class="empty compact"><p>Nessun dato uscito negli ultimi giorni per questi Paesi.</p></div>'}
    </section>
    <section class="section eco-sec" aria-label="In arrivo">
      <div class="sec-head"><h2>In arrivo</h2><span class="hint">prossime 2 settimane</span></div>
      ${groups || '<div class="empty compact"><p>Nessun dato in calendario per questi Paesi.</p></div>'}
    </section>
    </div>
    <p class="hint eco-foot">«Attese» è la previsione media degli analisti. Un dato molto diverso dalle attese di solito muove Borse, rendimenti e valute. Fonte: calendario economico di TradingView.</p>`;
}

/* ---------- Detail sheet ---------- */
SHEETS.calEvent = (args = {}) => {
  const d = eco.data('calendar');
  const row = d && Array.isArray(d.rows) ? d.rows.find((r) => r[COL.id] === args.id && r[COL.date] === args.date) : null;
  if (!row) return { title: 'Dato economico', body: '<div class="empty compact"><p>Dato non più disponibile.</p></div>' };
  const [, date, cc, title, period, actual, forecast, previous, unit, scale, high] = row;
  const it = titleIt(title);
  const when = new Date(date);
  const stat = (label, v, cls = '') => `<div class="stat"><span>${esc(label)}</span><b class="num ${cls}">${esc(valueText(v, unit, scale))}</b></div>`;
  const ex = explain(title);
  return {
    title: it,
    body: `<div class="eco-sheet">
      <div class="detail-head">${flagSpan(cc, 'lg')}<div class="detail-title"><h3>${esc(it)}</h3><div class="tags"><span class="tag">${esc(countryName(cc))}</span>${period ? `<span class="tag">${esc(periodIt(period))}</span>` : ''}${high ? '<span class="tag cal-tag-hi">Molto importante</span>' : ''}</div></div></div>
      <p class="src-line">${esc(dayLabel(localDay(date), todayISO()))} alle ${esc(timeText(date))} · ${esc(when.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }))}</p>
      <div class="stats eco-stats">
        ${stat('Dato uscito', actual)}
        ${stat('Attese', forecast)}
        ${stat('Precedente', previous)}
        <div class="stat"><span>Rispetto alle attese</span><b>${surprise(row) || '—'}</b></div>
      </div>
      ${ex ? `<p class="cal-explain">${esc(ex)}</p>` : ''}
      ${it !== title ? `<p class="hint">Nome originale: ${esc(title)}</p>` : ''}
    </div>`,
  };
};

Object.assign(ACTIONS, {
  'cal-region': (el) => {
    if (CAL_REGIONS.some((r) => r[0] === el.dataset.v)) prefs().calRegion = el.dataset.v;
    app.render();
  },
  'cal-all': (el) => {
    prefs().calAll = el.dataset.v === '1';
    app.render();
  },
  'cal-open': (el) => {
    if (el.dataset.id) app.pushSheet('calEvent', { id: el.dataset.id, date: el.dataset.date });
  },
});

export const _test = { titleIt, periodIt, valueText, isKey, explain, dayLabel };
