// Savings plans (PAC): the detail of a plan ('plan') and its form ('planForm').
// The plans are listed in Altro and in the detail of their security; plans.js records their purchases.
import { S, D, asset, account, accName, commit } from '../state.js';
import { ACTIONS, FORMS, INPUTS, SHEETS, FORM_SHEETS } from '../registry.js';
import { app } from '../app.js';
import { market } from '../market.js';
import { lastQuote, fxOn, sortTxns } from '../engine.js';
import {
  EVERY, EVERY_LABEL, STEPS, MAX_DAY, planById, planTxns, planTotals, nextRun, pendingRuns, firstDate, scheduleBetween,
  yearAhead, runPlans, deletePlan, resetPlan, detachPurchases, blankPlan, planSummary, everyOf, dayOf,
} from '../plans.js';
import { esc, icon, money, moneySigned, pctSigned, num, numInput, parseNum, fmtDate, tone, todayISO, addDays, addMonths, parseISO } from '../util.js';
import { avatar, txRow } from './home.js';
import { COMBO_HOOKS, runCombo, enterPicksFirst, formError, assetFromPick, assetBySymbol, tickerOf, scopeSheet } from './sheets.js';

const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;
const stat = (label, value, cls = '') => `<div class="stat"><span>${label}</span><b class="${cls}">${value}</b></div>`;
const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const longDate = (d) => `${WEEKDAYS[parseISO(d).getDay()]} ${fmtDate(d)}`;
const stepLabel = (s) => (s > 0 ? `+${num(s * 100, s * 100 % 1 ? 1 : 0)}% ogni anno` : 'Nessuno');
const tracked = (accId) => (account(accId) || {}).cashMode === 'track';

/* ======================================================================
   Detail of a plan
   ====================================================================== */
SHEETS.plan = (args = {}) => {
  const p = planById(args.id);
  if (!p) return { title: 'PAC', body: '<div class="empty"><p>Questo piano di accumulo non esiste più.</p><button class="btn" type="button" data-act="back-sheet">Indietro</button></div>' };
  const today = todayISO();
  const a = asset(p.aid);
  const next = nextRun(p, today);
  // days already over whose purchase waits for its closing price (today's is the next purchase)
  const pending = pendingRuns(p, today).filter((r) => r.date < today);
  const over = !p.paused && !next && !pending.length;
  const status = p.paused ? ['In pausa', 'flat'] : over ? ['Concluso', 'flat'] : ['Attivo', 'up'];
  const tot = planTotals(p.id);
  const q = lastQuote(p.aid);
  const value = q && tot.qty > 0 ? (tot.qty * q.price) / fxOn(a.currency || 'EUR', today) : null;
  const gain = value !== null ? value - tot.paid : null;

  const rows = [
    stat('Prossimo acquisto', p.paused ? 'In pausa' : next ? `${next.date === today ? 'oggi, si registra a mercato chiuso' : esc(longDate(next.date))}${p.step ? ` · ${money(next.amount)}` : ''}` : 'Nessuno'),
    stat('Frequenza', `${esc(EVERY_LABEL[everyOf(p)])}, il ${dayOf(p)}${dayOf(p) === 1 ? '°' : ''}`),
    stat('Conto', esc(accName(p.acc))),
    stat('Pagamento', p.sepa === false && tracked(p.acc) ? 'Liquidità del conto' : 'Addebito SEPA'),
    stat('Adeguamento all\'inflazione', esc(stepLabel(+p.step || 0))),
    stat('Commissione', money(+p.fee || 0)),
    stat('Primo acquisto', esc(fmtDate(tot.first && tot.first < firstDate(p) ? tot.first : firstDate(p)))),
    stat('Ultimo acquisto', p.end ? `entro il ${esc(fmtDate(p.end))}` : 'Senza scadenza'),
  ];
  const totals = tot.count
    ? `<div class="stats plan-totals">
        ${stat('Acquisti', num(tot.count, 0))}
        ${stat('Investito', money(tot.paid))}
        ${value !== null ? stat('Valore oggi', money(value)) : ''}
        ${gain !== null ? stat('Risultato', `${moneySigned(gain)}${tot.paid > 0 ? ` (${pctSigned(gain / tot.paid)})` : ''}`, tone(gain)) : ''}
      </div>
      <p class="hint">Valore delle quote comprate con il PAC al prezzo di oggi, anche se nel frattempo ne hai vendute.</p>`
    : '';
  const notes = [];
  if (pending.length) {
    notes.push(`${pending.length === 1 ? `L'acquisto del ${fmtDate(pending[0].date, false)}` : `${pending.length} acquisti, dal ${fmtDate(pending[0].date, false)},`} ${pending.length === 1 ? 'si registra' : 'si registrano'} appena ${market.status === 'offline' ? 'torni online e ' : ''}arriva il prezzo di chiusura.`);
  }
  if (+p.skipped > 0) notes.push(`${p.skipped === 1 ? '1 acquisto è stato saltato' : `${p.skipped} acquisti sono stati saltati`}: per quei giorni non ci sono prezzi del titolo.`);
  const ahead = yearAhead(p, today);
  const list = sortTxns(planTxns(p.id)).reverse();
  const txList = list.length
    ? `<div class="list">${list.slice(0, 12).map((t) => txRow(t, { showAsset: false, showAcc: false })).join('')}</div>${list.length > 12 ? `<p class="hint">Gli ultimi 12 di ${num(list.length, 0)} acquisti: li trovi tutti nella scheda del titolo.</p>` : ''}`
    : `<p class="muted">Ancora nessun acquisto${next ? `: il primo è ${esc(longDate(next.date))}` : ''}.</p>`;

  return {
    title: 'Piano di accumulo',
    body: `<button class="row asset-link" type="button" data-act="open-asset" data-aid="${esc(p.aid)}">${avatar(a)}<span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc([tickerOf(a.symbol) || a.ticker, a.isin, a.currency].filter(Boolean).join(' · '))}</span></span><span class="chev-wrap">${icon('chevRight')}</span></button>
      <div class="plan-hero">
        <div><div class="plan-amount num">${esc(planSummary(p, today))}</div>
        <p class="plan-hero-sub">${ahead > 0 ? `${money(ahead)} nei prossimi 12 mesi` : p.paused ? 'Nessun acquisto finché è in pausa' : 'Nessun altro acquisto in programma'}</p></div>
        <span class="pill ${status[1]}">${status[0]}</span>
      </div>
      ${notes.map((n) => `<p class="report-note plan-note">${icon('info')}<span>${esc(n)}</span></p>`).join('')}
      <div class="stats plan-stats">${rows.join('')}</div>
      ${totals}
      <div class="group-label">Acquisti del PAC</div>
      ${txList}
      <div class="btn-row sheet-foot-actions plan-actions">
        <button class="btn" type="button" data-act="plan-edit" data-id="${esc(p.id)}">${icon('edit')}Modifica</button>
        ${over ? '' : `<button class="btn" type="button" data-act="plan-pause" data-id="${esc(p.id)}">${icon(p.paused ? 'play' : 'pause')}${p.paused ? 'Riprendi' : 'Sospendi'}</button>`}
        <button class="btn danger" type="button" data-act="plan-delete" data-id="${esc(p.id)}">${icon('trash')}Elimina</button>
      </div>`,
  };
};

/* ======================================================================
   Form of a plan
   ====================================================================== */
function pickedHtml(form) {
  const el = form.elements;
  const aid = el.aid.value;
  let pick = null;
  try {
    pick = el.pick.value ? JSON.parse(el.pick.value) : null;
  } catch { /* ignore */ }
  if (aid && D().assets[aid]) {
    const a = D().assets[aid];
    return `${avatar(a, 'sm')}<span class="row-main"><span class="row-title">${esc(a.name)}</span><span class="row-sub">${esc([tickerOf(a.symbol) || a.ticker, a.exchange, a.currency].filter(Boolean).join(' · '))}</span></span>`;
  }
  if (pick && pick.symbol) {
    return `${avatar({ name: pick.name, ticker: tickerOf(pick.symbol), symbol: pick.symbol, type: pick.type }, 'sm')}<span class="row-main"><span class="row-title">${esc(pick.name)}</span><span class="row-sub">${esc([pick.symbol, pick.exchange, pick.currency].filter(Boolean).join(' · '))} · nuovo, prezzi da Yahoo</span></span>`;
  }
  return '';
}

function showPicked(form) {
  const box = form.querySelector('#pl-picked');
  const search = form.querySelector('#pl-search');
  const html = pickedHtml(form);
  box.innerHTML = html ? `${html}<button class="btn sm" type="button" data-act="plan-unpick">Cambia</button>` : '';
  box.hidden = !html;
  search.hidden = Boolean(html);
}

// ETFs and funds first: the usual securities of a savings plan
const PLAN_TYPE_RANK = { etf: 0, fund: 1, stock: 2, crypto: 3, commodity: 4 };
COMBO_HOOKS.plan = {
  results: '#pl-results',
  own: true,
  order: (list) => list.map((a, i) => [a, i]).sort((x, y) => (PLAN_TYPE_RANK[x[0].type] ?? 9) - (PLAN_TYPE_RANK[y[0].type] ?? 9) || x[1] - y[1]).map((x) => x[0]),
  choose(form, item) {
    if (!item || item === 'manual') return;
    const el = form.elements;
    if (item.kind === 'asset') {
      el.aid.value = item.aid;
      el.pick.value = '';
    } else {
      el.aid.value = '';
      el.pick.value = JSON.stringify(item);
    }
    el.q.value = '';
    const results = form.querySelector('#pl-results');
    if (results) results.innerHTML = '';
    showPicked(form);
    syncPlanForm(form);
  },
};

// The plan the form describes (null fields when not valid yet)
function formPlan(form) {
  const el = form.elements;
  const sepa = form.querySelector('input[name="sepa"]:checked');
  return {
    acc: el.acc.value,
    amount: parseNum(el.amount.value),
    every: Number(el.every.value) || 1,
    day: Number(el.day.value) || 1,
    start: el.start.value,
    end: el.end.value || '',
    step: Number(el.step.value) || 0,
    fee: el.fee.value.trim() ? parseNum(el.fee.value) : 0,
    sepa: !sepa || sepa.value !== '0',
  };
}

// Live texts of the form: when the first purchase happens, past purchases it will record, money per year
function syncPlanForm(form) {
  const f = formPlan(form);
  const today = todayISO();
  const when = form.querySelector('#pl-when');
  const year = form.querySelector('#pl-year');
  const pay = form.querySelector('#pl-pay-f');
  const payHint = form.querySelector('#pl-pay-hint');
  const isTracked = tracked(f.acc);
  if (pay) pay.hidden = !isTracked;
  if (payHint) {
    payHint.textContent = f.sepa
      ? 'I soldi arrivano da un altro conto (la tua banca): non serve registrare depositi e la liquidità del broker non cambia.'
      : 'Gli acquisti usano la liquidità registrata nel conto.';
  }
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(f.start) && f.amount > 0;
  const editing = form.dataset.id ? planById(form.dataset.id) : null;
  const redo = form.querySelector('input[name="redo"]:checked');
  if (when) {
    let text = '';
    if (valid) {
      const p = { ...f, start: f.start };
      const first = firstDate(p);
      const past = scheduleBetween(p, first, addDays(today, -1));
      const fresh = !editing || (redo && redo.value === '1');
      if (past.length && fresh) {
        text = `Registro anche ${past.length === 1 ? 'l\'acquisto già passato' : `i ${past.length} acquisti già passati`}, dal ${fmtDate(first)}, ai prezzi di chiusura di quei giorni.`;
      } else if (first >= today) text = `Primo acquisto: ${longDate(first)}.`;
      else if (editing) text = 'Le modifiche valgono dai prossimi acquisti.';
    }
    when.textContent = text;
    when.hidden = !text;
  }
  if (year) year.textContent = valid ? money(yearAhead({ ...f }, today)) : '—';
}

// Account of a new plan: where the security is bought, else where the other plans are, else a broker
// known for savings plans, else the first one
function defaultAccount(aid) {
  const accs = D().accounts;
  const t = aid ? D().txns.find((x) => x.aid === aid && x.type === 'buy' && account(x.acc)) : null;
  if (t) return t.acc;
  const p = (D().plans || []).find((x) => account(x.acc));
  if (p) return p.acc;
  const known = accs.find((a) => /scalable|trade republic|fineco|directa|moneyfarm/i.test(`${a.broker} ${a.name}`));
  return known ? known.id : accs[0] ? accs[0].id : '';
}

SHEETS.planForm = (args = {}) => {
  const editing = args.id ? planById(args.id) : null;
  const base = editing || blankPlan({ acc: args.acc || '', aid: args.aid || '' });
  const dr = args.draft || null;
  const v = (name, fallback) => (dr && name in dr ? dr[name] : fallback);
  const accs = D().accounts;
  let acc = v('acc', base.acc);
  if (!account(acc)) acc = defaultAccount(base.aid);
  const aid = v('aid', base.aid && D().assets[base.aid] ? base.aid : '');
  const pick = v('pick', args.pick || '');
  const step = Number(v('step', base.step || 0));
  const every = Number(v('every', base.every));
  const day = Number(v('day', base.day));
  const sepa = v('sepa', base.sepa === false ? '0' : '1');
  const count = editing ? planTxns(editing.id).filter((t) => t.gen).length : 0;
  const stepOpts = STEPS.includes(step) ? STEPS : [...STEPS, step].sort((x, y) => x - y);

  return {
    title: editing ? 'Modifica il PAC' : 'Nuovo piano di accumulo',
    body: `<form class="form plan-form" data-form="plan" data-input="plan-form" data-id="${esc(editing ? editing.id : '')}" novalidate>
      <p class="hint plan-lead">Come i piani di accumulo di Scalable Capital: Gruzzolo registra da solo ogni acquisto, al prezzo di chiusura del giorno. I soldi arrivano con addebito SEPA, senza inserire liquidità.</p>
      ${accs.length > 1
    ? `<div class="field"><label for="pl-acc">Conto</label><select id="pl-acc" name="acc">${accs.map((a) => opt(a.id, a.name + (a.broker && a.broker !== 'Altro' && a.broker !== a.name ? ` · ${a.broker}` : ''), a.id === acc)).join('')}</select></div>`
    : `<input type="hidden" name="acc" value="${esc(acc)}">`}
      <div class="field combo" id="pl-asset-f">
        <label for="pl-q">Titolo</label>
        <input type="hidden" name="aid" value="${esc(aid)}">
        <input type="hidden" name="pick" value="${esc(pick)}">
        <div class="picked" id="pl-picked" hidden></div>
        <div id="pl-search">
          <div class="search-box sm">${icon('search')}<input id="pl-q" name="q" type="search" data-input="plan-asset" value="${esc(v('q', ''))}" placeholder="Nome, ticker o ISIN (es. VWCE)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"></div>
          <div class="combo-results" id="pl-results"></div>
        </div>
      </div>
      <div class="grid2">
        <div class="field"><label for="pl-amount">Importo (€)</label><input id="pl-amount" name="amount" inputmode="decimal" autocomplete="off" placeholder="100,00" value="${esc(v('amount', numInput(base.amount)))}"><span class="hint">Per ogni acquisto</span></div>
        <div class="field"><label for="pl-every">Frequenza</label><select id="pl-every" name="every">${EVERY.map((k) => opt(k, EVERY_LABEL[k], k === every)).join('')}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label for="pl-day">Giorno di acquisto</label><select id="pl-day" name="day">${Array.from({ length: MAX_DAY }, (_, i) => opt(i + 1, `Il ${i + 1}${i ? '' : '°'} del mese`, i + 1 === day)).join('')}</select></div>
        <div class="field"><label for="pl-start">${editing ? 'Iniziato dal' : 'A partire dal'}</label><input id="pl-start" type="date" name="start" value="${esc(v('start', base.start))}" min="${esc(addMonths(todayISO(), -120))}" max="${esc(addDays(todayISO(), 365))}"></div>
      </div>
      <p class="hint plan-when" id="pl-when" aria-live="polite" hidden></p>
      <div class="field"><label for="pl-step">Adeguamento all'inflazione</label>
        <select id="pl-step" name="step">${stepOpts.map((s) => opt(s, s > 0 ? `+${num(s * 100, s * 100 % 1 ? 1 : 0)}% ogni anno` : 'Nessuno', s === step)).join('')}</select>
        <span class="hint">A ogni anniversario del primo acquisto l'importo cresce di questa percentuale.</span>
      </div>
      <div class="field" id="pl-pay-f"><span class="label" id="pl-pay-l">Pagamento</span>
        <div class="seg full" role="radiogroup" aria-labelledby="pl-pay-l">
          <label><input type="radio" name="sepa" value="1"${sepa !== '0' ? ' checked' : ''}><span class="seg-lbl">Addebito SEPA</span></label>
          <label><input type="radio" name="sepa" value="0"${sepa === '0' ? ' checked' : ''}><span class="seg-lbl">Liquidità del conto</span></label>
        </div>
        <span class="hint" id="pl-pay-hint"></span>
      </div>
      <details class="disclosure"${v('fee', base.fee ? numInput(base.fee) : '') || v('end', base.end || '') ? ' open' : ''}><summary>Commissione e scadenza</summary>
        <div class="grid2">
          <div class="field"><label for="pl-fee">Commissione (€)</label><input id="pl-fee" name="fee" inputmode="decimal" autocomplete="off" placeholder="0,00" value="${esc(v('fee', base.fee ? numInput(base.fee) : ''))}"><span class="hint">Per acquisto, compresa nell'importo</span></div>
          <div class="field"><label for="pl-end">Fino al</label><input id="pl-end" type="date" name="end" value="${esc(v('end', base.end || ''))}"><span class="hint">Facoltativo</span></div>
        </div>
      </details>
      ${count ? `<div class="field"><span class="label" id="pl-redo-l">Le modifiche valgono per</span>
        <div class="seg full" role="radiogroup" aria-labelledby="pl-redo-l">
          <label><input type="radio" name="redo" value="0"${v('redo', '0') !== '1' ? ' checked' : ''}><span class="seg-lbl">I prossimi acquisti</span></label>
          <label><input type="radio" name="redo" value="1"${v('redo', '0') === '1' ? ' checked' : ''}><span class="seg-lbl">Anche i ${num(count, 0)} passati</span></label>
        </div>
        <span class="hint">«Anche i passati» ricalcola gli acquisti registrati dal PAC con i nuovi dati (le modifiche fatte a mano su quegli acquisti si perdono).</span>
      </div>` : ''}
      <div class="total-line"><span>Nei prossimi 12 mesi</span><strong id="pl-year" class="num">—</strong></div>
      <p class="form-error" data-error role="alert" hidden></p>
      <button class="btn primary block" type="submit">${editing ? 'Salva le modifiche' : 'Crea il PAC'}</button>
    </form>`,
    after: (body) => {
      const form = body.querySelector('form[data-form="plan"]');
      if (!form) return;
      showPicked(form);
      syncPlanForm(form);
      const q = form.elements.q;
      enterPicksFirst('plan', q);
      if (q && !form.elements.aid.value && !form.elements.pick.value) runCombo('plan', q);
    },
  };
};
FORM_SHEETS.add('planForm');
// spaced like the other portfolio sheets (css/portfolio.css)
scopeSheet('plan');
scopeSheet('planForm');

INPUTS['plan-asset'] = (input, ev) => {
  if (ev && ev.type === 'change') return;
  runCombo('plan', input);
};
INPUTS['plan-form'] = (form, ev) => {
  const t = ev && ev.target;
  if (t && t.name === 'q') return;
  const err = form.querySelector('[data-error]');
  if (err && !err.hidden && ev.type === 'input') err.hidden = true;
  if (t && t.getAttribute && t.getAttribute('aria-invalid') === 'true') t.removeAttribute('aria-invalid');
  syncPlanForm(form);
};

FORMS.plan = async (form) => {
  const showErr = formError(form);
  const el = form.elements;
  const f = formPlan(form);
  const today = todayISO();
  const editing = form.dataset.id ? planById(form.dataset.id) : null;
  if (!account(f.acc)) return showErr('Scegli il conto.', el.acc);
  // Security: one already in the data, or a search result to add
  let aid = el.aid.value && D().assets[el.aid.value] ? el.aid.value : '';
  let newAsset = null;
  if (!aid) {
    let pick = null;
    try {
      pick = el.pick.value ? JSON.parse(el.pick.value) : null;
    } catch { /* ignore */ }
    if (!pick || !pick.symbol) return showErr('Scegli il titolo del PAC: cercalo per nome, ticker o ISIN.', el.q);
    const own = assetBySymbol(pick.symbol);
    if (own) aid = own.id;
    else {
      const p = { ...pick };
      if (!p.ccyOk && market.status !== 'offline') {
        const btn = form.querySelector('button[type="submit"]');
        if (btn) btn.disabled = true;
        try {
          const info = await market.lookup(p.symbol);
          if (info && info.currency) {
            p.currency = info.currency;
            if (!p.name || p.name === p.symbol) p.name = info.name || p.name;
          }
        } catch { /* keep the guessed currency */ }
        if (btn) btn.disabled = false;
        if (!form.isConnected) return false;
      }
      newAsset = assetFromPick(p);
      aid = newAsset.id;
    }
  }
  if (!(f.amount > 0)) return showErr('Scrivi l\'importo di ogni acquisto in euro, maggiore di zero.', el.amount);
  if (f.amount > 1e6) return showErr('L\'importo è troppo alto: controlla le cifre.', el.amount);
  if (!Number.isFinite(f.fee) || f.fee < 0) return showErr('Commissione: scrivi un numero positivo o lascia vuoto.', el.fee);
  if (f.fee >= f.amount) return showErr('La commissione deve essere più piccola dell\'importo.', el.fee);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.start)) return showErr('Inserisci la data di inizio.', el.start);
  if (f.start > addDays(today, 365)) return showErr('L\'inizio è più di un anno nel futuro: controlla l\'anno.', el.start);
  if (f.start < addMonths(today, -120)) return showErr('L\'inizio può essere al massimo 10 anni fa: i prezzi più vecchi non sono disponibili.', el.start);
  if (f.end && f.end < f.start) return showErr('La fine deve venire dopo l\'inizio.', el.end);

  const d = D();
  if (!Array.isArray(d.plans)) d.plans = [];
  if (newAsset) d.assets[newAsset.id] = newAsset;
  const plan = editing || blankPlan({});
  const fields = { acc: f.acc, aid, amount: Math.round(f.amount * 100) / 100, every: f.every, day: f.day, start: f.start, step: f.step, fee: Math.round(f.fee * 100) / 100, sepa: f.sepa };
  if (editing) {
    const redo = form.querySelector('input[name="redo"]:checked');
    if (redo && redo.value === '1') resetPlan(d, editing);
    else {
      // only the purchases still to come change: the ones already made stay as they are
      if (editing.acc !== fields.acc || editing.aid !== fields.aid) detachPurchases(d, editing.id);
      if (editing.done && fields.start === editing.start && (fields.every !== everyOf(editing) || fields.day !== dayOf(editing))) fields.start = today;
    }
  }
  Object.assign(plan, fields);
  if (f.end) plan.end = f.end;
  else delete plan.end;
  if (!plan.step) delete plan.step;
  if (!plan.fee) delete plan.fee;
  if (!editing) d.plans.push(plan);
  const { added } = runPlans({ only: plan.id });
  const msg = editing ? 'PAC aggiornato' : 'PAC creato';
  commit(added.length ? `${msg} · ${added.length === 1 ? 'registrato 1 acquisto' : `registrati ${added.length} acquisti`}` : msg);
  app.popSheet();
  if (!editing) app.pushSheet('plan', { id: plan.id });
  if (newAsset && newAsset.priceSource === 'auto') app.refreshPrices();
  return true;
};

/* ======================================================================
   Actions
   ====================================================================== */
Object.assign(ACTIONS, {
  'plan-open': (el) => app.pushSheet('plan', { id: el.dataset.id }),
  'plan-new': (el) => {
    const args = { aid: el.dataset.aid || '', acc: el.dataset.acc || '' };
    const tx = el.closest('form[data-form="pf-tx"]');
    if (tx) {
      // from the purchase form: the security and the account chosen there carry over, and it closes
      const mode = tx.elements.mode ? tx.elements.mode.value : '';
      if (mode === 'asset') args.aid = tx.elements.aid.value;
      if (mode === 'pick') args.pick = tx.elements.pick.value;
      if (tx.elements.acc) args.acc = tx.elements.acc.value;
      S.sheets.pop();
    }
    app.pushSheet('planForm', args);
  },
  'plan-edit': (el) => app.pushSheet('planForm', { id: el.dataset.id }),
  'plan-unpick': (el) => {
    const form = el.closest('form');
    if (!form) return;
    form.elements.aid.value = '';
    form.elements.pick.value = '';
    showPicked(form);
    syncPlanForm(form);
    const q = form.elements.q;
    if (q) {
      q.focus();
      runCombo('plan', q);
    }
  },
  'plan-pause': (el) => {
    const p = planById(el.dataset.id);
    if (!p) return;
    if (p.paused) {
      delete p.paused;
      // purchases while it was paused are not made up for
      const today = todayISO();
      if (!p.done || p.done < addDays(today, -1)) p.done = addDays(today, -1);
      commit('PAC ripreso');
    } else {
      // the purchases due until today go through first
      runPlans({ only: p.id });
      p.paused = true;
      commit('PAC sospeso: nessun acquisto finché non lo riprendi');
    }
  },
  'plan-delete': (el) => {
    const p = planById(el.dataset.id);
    if (!p) return;
    const own = planTxns(p.id).filter((t) => t.gen).length;
    const close = () => {
      S.sheets = S.sheets.filter((s) => !((s.name === 'plan' || s.name === 'planForm') && (s.args || {}).id === p.id));
    };
    if (!own) {
      app.askConfirm({
        title: 'Eliminare il PAC?',
        text: 'Non registrerà più acquisti. Le operazioni già presenti restano.',
        ok: 'Elimina',
        onOk: () => {
          deletePlan(D(), p.id);
          close();
          commit('PAC eliminato');
        },
      });
      return;
    }
    app.askConfirm({
      title: 'Eliminare il PAC?',
      text: `Ha registrato ${own === 1 ? '1 acquisto' : `${own} acquisti`}. Puoi tenerli nel portafoglio (il PAC smette solo di comprare) oppure eliminarli insieme al piano.`,
      ok: 'Elimina anche gli acquisti',
      alt: 'Tieni gli acquisti',
      onOk: () => {
        const n = deletePlan(D(), p.id, { purchases: true });
        close();
        commit(`PAC eliminato con ${n === 1 ? '1 acquisto' : `${n} acquisti`}`);
      },
      onAlt: () => {
        deletePlan(D(), p.id);
        close();
        commit('PAC eliminato: gli acquisti restano');
      },
    });
  },
});
