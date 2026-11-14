// Broker CSV import: parsing, preset detection, column mapping and conversion into transactions.
// Pure module: no DOM, no clock, no network. Transactions reference assets through t.assetKey
// (the ISIN, or the product name when there is no ISIN); the UI resolves the keys to asset ids
// (and to Yahoo symbols with market.search(isin)) before committing.
//
// Supported files:
//   'degiro-transactions'  DEGIRO → Attività → Transazioni → Esporta CSV (Transactions.csv)
//   'degiro-account'       DEGIRO → Attività → Estratto conto → Esporta CSV (Account.csv)
//   'scalable'             Scalable Capital broker export (English, German or Italian headers)
//   'generic'              any CSV with recognizable columns (Italian, English, German names)

/* ---------- Text helpers ---------- */
// Lower case, no accents, single spaces: 'Quantità' → 'quantita', 'Stück' → 'stuck'
export function normHeader(h) {
  return String(h ?? '')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .trim();
}

const round = (v, d = 2) => {
  const f = 10 ** d;
  const r = Math.round((v + Math.sign(v) * Number.EPSILON) * f) / f;
  return r === 0 ? 0 : r;
};
const CCY_RE = /^(?:[A-Z]{3}|GBp|GBX)$/;
const isCcy = (s) => CCY_RE.test(String(s ?? '').trim());

/* ---------- CSV parsing (RFC 4180) ---------- */
function countOutsideQuotes(line, ch) {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (!q && c === ch) n++;
  }
  return n;
}

const DELIMITERS = [',', ';', '\t', '|'];
function detectDelimiter(text) {
  const lines = [];
  for (const l of text.split(/\r\n|\n|\r/)) {
    if (l.trim()) lines.push(l);
    if (lines.length >= 12) break;
  }
  if (!lines.length) return ',';
  let best = ',';
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const head = countOutsideQuotes(lines[0], d);
    if (!head) continue;
    let score = 0;
    for (const l of lines) {
      const c = countOutsideQuotes(l, d);
      if (c === head) score += 1;
      else if (c > 0) score += 0.25;
    }
    score += head / 1000; // tie-break: more columns
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function parseRecords(text, delim) {
  const out = [];
  let row = [];
  let field = '';
  let q = false;
  let i = 0;
  const n = text.length;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    out.push(row);
    row = [];
  };
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        q = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === '') {
      field = '';
      q = true;
      i++;
    } else if (c === delim) {
      endField();
      i++;
    } else if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) endRow();
  return out;
}

// → { headers, rows, delimiter }; empty lines are skipped, an Excel "sep=;" first line is honored
export function parseCsv(text, { delimiter = null } = {}) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  let delim = delimiter;
  const sep = /^sep=(.)\s*(?:\r\n|\n|\r)/i.exec(s);
  if (sep) {
    delim ||= sep[1];
    s = s.slice(sep[0].length);
  }
  delim ||= detectDelimiter(s);
  const records = parseRecords(s, delim).filter((r) => r.some((c) => String(c).trim() !== ''));
  const headers = (records[0] || []).map((h) => String(h).trim());
  const rows = records.slice(1).map((r) => r.map((c) => String(c)));
  return { headers, rows, delimiter: delim };
}

/* ---------- Dates and numbers ---------- */
const daysIn = (y, m) => new Date(y, m, 0).getDate();
// dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy, yyyy-mm-dd (a time after the date is ignored) → 'YYYY-MM-DD' or null
export function parseDate(s) {
  const t = String(s ?? '').trim();
  let y;
  let mo;
  let d;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?![\d])/.exec(t);
  if (m) {
    y = +m[1];
    mo = +m[2];
    d = +m[3];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?![\d])/.exec(t))) {
    d = +m[1];
    mo = +m[2];
    y = +m[3];
    if (m[3].length === 2) y += y > 69 ? 1900 : 2000;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // month/day order (US files)
  } else return null;
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= daysIn(y, mo)) || y < 1900 || y > 2200) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// '1.234,56' '1,234.56' '-12,5' '(12,50)' '12,50-' '€ 1 234,56' '+3' → number (NaN if not a number).
// decimal (',' or '.') resolves ambiguous values like '1.234' or '1,234'.
export function parseAmount(s, decimal = null) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  let t = String(s ?? '').trim();
  if (!t) return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/[−‒–—]/g, '-').replace(/[\s  '’]/g, '');
  t = t.replace(/^[A-Za-z]{3}(?=[-+\d.,(])/, '').replace(/([\d.,])[A-Za-z]{3}$/, '$1').replace(/[€$£¥%]/g, '');
  if (/^\(.*\)$/.test(t)) {
    neg = !neg;
    t = t.slice(1, -1);
  }
  if (t.endsWith('-')) {
    neg = !neg;
    t = t.slice(0, -1);
  }
  if (t.startsWith('-')) {
    neg = !neg;
    t = t.slice(1);
  } else if (t.startsWith('+')) t = t.slice(1);
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return NaN;
  const lastC = t.lastIndexOf(',');
  const lastD = t.lastIndexOf('.');
  const commas = t.split(',').length - 1;
  const dots = t.split('.').length - 1;
  let sep; // decimal separator in this value
  if (lastC >= 0 && lastD >= 0) sep = lastC > lastD ? ',' : '.';
  else if (lastC >= 0) {
    if (commas > 1) sep = '.';
    else if (decimal === '.' && t.length - lastC - 1 === 3) sep = '.';
    else sep = ',';
  } else if (lastD >= 0) {
    if (dots > 1) sep = ',';
    else if (decimal === ',' && t.length - lastD - 1 === 3) sep = ',';
    else sep = '.';
  } else sep = '.';
  t = sep === ',' ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return neg && n !== 0 ? -n : n;
}

// Decimal separator used by a set of cells (',' or '.'), null when nothing tells
export function detectDecimal(values) {
  let comma = 0;
  let dot = 0;
  for (const raw of values) {
    const v = String(raw ?? '').trim().replace(/[\s ]/g, '');
    if (!v || !/\d/.test(v)) continue;
    if (/\d\.\d{3},\d+$/.test(v) || /^[-+(]?\d+,(\d{1,2}|\d{4,})\)?$/.test(v)) comma++;
    else if (/\d,\d{3}\.\d+$/.test(v) || /^[-+(]?\d+\.(\d{1,2}|\d{4,})\)?$/.test(v)) dot++;
  }
  if (comma > dot) return ',';
  if (dot > comma) return '.';
  return null;
}

/* ---------- Presets ---------- */
// Header aliases (normalized with normHeader). Exact matches win; then a header starting with
// an alias (or, for long aliases, containing it) is accepted.
const A = {
  date: ['data', 'date', 'datum', 'fecha', 'data operazione', 'data esecuzione', 'trade date', 'booking date', 'buchungstag', 'data contabile', 'data movimento'],
  time: ['ora', 'time', 'tijd', 'uhrzeit', 'zeit', 'hora', 'heure', 'orario'],
  valueDate: ['data valore', 'value date', 'valutadatum', 'fecha valor', 'valuta'],
  name: ['prodotto', 'product', 'produkt', 'producto', 'produit', 'nome', 'name', 'titolo', 'strumento', 'security', 'asset', 'descrizione titolo', 'nome titolo'],
  isin: ['isin', 'codice isin', 'isin code'],
  symbol: ['ticker', 'symbol', 'simbolo', 'codice titolo'],
  exchange: ['borsa di riferimento', 'reference exchange', 'referenzborse', 'beurs', 'bolsa de referencia', 'borsa', 'exchange', 'mercato'],
  venue: ['sede di esecuzione', 'venue', 'ausfuhrungsort', 'uitvoeringsplaats', 'centro de ejecucion'],
  qty: ['quantita', 'quantity', 'qty', 'anzahl', 'aantal', 'cantidad', 'quantite', 'shares', 'stuck', 'numero', 'pezzi', 'quote', 'units'],
  price: ['prezzo', 'price', 'kurs', 'koers', 'precio', 'prix', 'prezzo unitario', 'unit price'],
  localValue: ['valore locale', 'local value', 'wert in lokalwahrung', 'lokale waarde', 'valor local', 'valeur locale'],
  value: ['valore eur', 'valore', 'value eur', 'value', 'wert eur', 'wert', 'waarde eur', 'waarde', 'valor', 'valeur', 'controvalore'],
  fx: ['tasso di cambio', 'exchange rate', 'wechselkurs', 'wisselkoers', 'tipo de cambio', 'taux de change', 'fx', 'cambio', 'fx rate'],
  fxFee: ['costi autofx', 'costo autofx', 'commissione autofx', 'autofx fee', 'autofx-gebuhr', 'autofx gebuhr', 'autofx kosten', 'autofx'],
  fee: [
    'costi di transazione e/o costi di terze parti', 'costi di transazione', 'transaction and/or third party fees', 'transaction costs',
    'transaktionskosten und/oder kosten dritter', 'transaktionskosten', 'transactiekosten en/of kosten van derden', 'transactiekosten',
    'costes de transaccion', 'commissioni', 'commissione', 'fee', 'fees', 'gebuhr', 'gebuhren', 'spese', 'costi', 'commission',
  ],
  tax: ['tax', 'taxes', 'tasse', 'imposte', 'steuer', 'steuern', 'ritenuta', 'withholding'],
  total: ['totale eur', 'totale', 'total eur', 'total', 'gesamt eur', 'gesamt', 'totaal eur', 'totaal', 'controvalore totale'],
  amount: ['importo', 'amount', 'betrag', 'importo netto', 'netto'],
  change: ['variazione', 'change', 'anderung', 'mutatie', 'variacion', 'mouvement'],
  balance: ['saldo', 'balance', 'solde'],
  description: ['descrizione', 'description', 'beschreibung', 'omschrijving', 'descripcion', 'causale', 'note', 'memo', 'dettagli'],
  ref: ['id ordine', 'order id', 'order-id', 'orderid', 'id orden', 'reference', 'referenz', 'riferimento', 'numero ordine', 'id'],
  type: ['tipo', 'type', 'typ', 'operazione', 'tipo operazione', 'transaction type', 'segno', 'action', 'azione'],
  currency: ['valuta', 'currency', 'wahrung', 'divisa', 'devise', 'moneda'],
  status: ['status', 'stato', 'estado'],
  assetType: ['assettype', 'assettyp', 'asset type', 'tipo di asset', 'tipo asset'],
};

const pick = (keys, extra = {}) => Object.fromEntries(keys.map((k) => [k, extra[k] || A[k]]));

export const PRESETS = {
  'degiro-transactions': {
    label: 'DEGIRO · Transazioni',
    broker: 'DEGIRO',
    hint: 'DEGIRO → Attività → Transazioni → scegli le date → Esporta → CSV',
    fields: pick(['date', 'time', 'name', 'isin', 'exchange', 'venue', 'qty', 'price', 'localValue', 'value', 'fx', 'fxFee', 'fee', 'total', 'ref'], {
      fee: A.fee.slice(0, 9),
      ref: ['id ordine', 'order id', 'order-id', 'orderid', 'id orden'],
      fx: A.fx.slice(0, 7),
      value: A.value.slice(0, 10),
    }),
  },
  'degiro-account': {
    label: 'DEGIRO · Estratto conto',
    broker: 'DEGIRO',
    hint: 'DEGIRO → Attività → Estratto conto → scegli le date → Esporta → CSV',
    fields: pick(['date', 'time', 'valueDate', 'name', 'isin', 'description', 'fx', 'change', 'balance', 'ref'], {
      ref: ['id ordine', 'order id', 'order-id', 'orderid', 'id orden'],
      fx: A.fx.slice(0, 7),
      description: A.description.slice(0, 5),
    }),
  },
  scalable: {
    label: 'Scalable Capital',
    broker: 'Scalable Capital',
    hint: 'Scalable Capital → Transazioni → Esporta (file CSV)',
    fields: pick(['date', 'time', 'status', 'ref', 'description', 'assetType', 'type', 'isin', 'qty', 'price', 'amount', 'fee', 'tax', 'currency'], {
      ref: ['reference', 'referenz', 'riferimento'],
      qty: ['shares', 'stuck', 'quantita', 'anzahl', 'quantity'],
      price: ['price', 'kurs', 'prezzo'],
      fee: ['fee', 'fees', 'gebuhr', 'gebuhren', 'commissione', 'commissioni'],
      tax: ['tax', 'taxes', 'steuer', 'steuern', 'imposte', 'tasse'],
      currency: ['currency', 'wahrung', 'valuta'],
      type: ['type', 'typ', 'tipo'],
      date: ['date', 'datum', 'data'],
    }),
  },
  generic: {
    label: 'Altro file CSV',
    broker: 'Altro',
    hint: 'Serve almeno una colonna con la data e una con il tipo di operazione o la quantità.',
    fields: pick(['date', 'time', 'type', 'isin', 'symbol', 'name', 'qty', 'price', 'currency', 'fx', 'fee', 'tax', 'amount', 'total', 'ref', 'description'], {
      amount: [...A.amount, 'valore', 'value', 'controvalore'],
    }),
  },
};

export const MAPPING_KEYS = ['date', 'time', 'type', 'isin', 'symbol', 'name', 'qty', 'price', 'currency', 'fx', 'fee', 'amount', 'total', 'ref', 'description'];

// → 'degiro-transactions' | 'degiro-account' | 'scalable' | 'generic'
export function detectPreset(headers) {
  const H = new Set((headers || []).map(normHeader));
  const has = (...alts) => alts.some((a) => H.has(a));
  if (has('isin') && has('id ordine', 'order id', 'order-id', 'orderid', 'id orden') && has(...A.qty.slice(0, 7)) && has(...A.price.slice(0, 6))) return 'degiro-transactions';
  if (has(...A.description.slice(0, 5)) && has('saldo', 'balance', 'solde') && has(...A.change)) return 'degiro-account';
  if (has('assettype', 'assettyp', 'asset type') || (has('reference', 'referenz') && has('shares', 'stuck') && has('status'))) return 'scalable';
  return 'generic';
}

// → { date, time, type, isin, symbol, name, qty, price, currency, fx, fee, amount, total, ref, description, ... }
// with column indexes (-1 when absent). Extra keys used by the presets: valueDate, exchange, fxFee, tax,
// status, assetType, localValue, balance.
export function guessMapping(headers, preset = null) {
  const p = PRESETS[preset] ? preset : detectPreset(headers);
  const H = (headers || []).map(normHeader);
  const fields = PRESETS[p].fields;
  const map = {};
  for (const k of MAPPING_KEYS) map[k] = -1;
  const used = new Set();
  const claim = (key, i) => {
    map[key] = i;
    used.add(i);
  };
  // Pass 1: exact header names
  for (const [key, aliases] of Object.entries(fields)) {
    for (const a of aliases) {
      const i = H.findIndex((h, j) => !used.has(j) && h === a);
      if (i >= 0) {
        claim(key, i);
        break;
      }
    }
  }
  // Pass 2: headers that start with (or contain) an alias, e.g. 'Totale EUR', 'Costi di transazione ... EUR'
  for (const [key, aliases] of Object.entries(fields)) {
    if (map[key] >= 0) continue;
    for (const a of aliases) {
      if (a.length < 4) continue;
      const i = H.findIndex((h, j) => !used.has(j) && h && (h.startsWith(a + ' ') || h.startsWith(a + '(') || ((a.length >= 8 || a === 'autofx') && h.includes(a))));
      if (i >= 0) {
        claim(key, i);
        break;
      }
    }
  }
  for (const k of Object.keys(fields)) if (!(k in map)) map[k] = -1;
  // DEGIRO files: the currency of an amount sits in the unnamed column next to it
  if (p === 'degiro-transactions') {
    if (map.price >= 0 && H[map.price + 1] === '') map.currency = map.price + 1;
    map.amount = map.value;
    delete map.value;
  }
  if (p === 'degiro-account') {
    map.amount = map.change;
    delete map.change;
  }
  return map;
}

/* ---------- Classification ---------- */
const matches = (re, s) => re.test(s);

// Generic type keywords (Italian, English, German) → txn type, null if unknown
export function typeFromText(text) {
  const s = normHeader(text);
  if (!s) return null;
  if (matches(/ritenuta|withholding|quellensteuer|\btax(es)?\b|\btass[ae]\b|\bimpost|steuer|\bbollo\b|capital gain/, s)) return 'tax';
  if (matches(/cedola|coupon|kupon/, s)) return 'div';
  if (matches(/dividend|distribution|ausschuttung|provento|distribuzione/, s)) return 'div';
  if (matches(/interess|interest|zinsen/, s)) return 'interest';
  if (matches(/commission|\bfees?\b|gebuhr|\bspese\b|\bcosti?\b/, s)) return 'fee';
  if (matches(/vendita|\bsell|verkauf|\bvend\b|\bsale\b|^s$/, s)) return 'sell';
  if (matches(/acquist|\bbuy|\bkauf|savings plan|sparplan|piano di accumulo|\bpac\b|purchase|\bacq\b|^b$/, s)) return 'buy';
  if (matches(/prelievo|withdraw|auszahlung|bonifico in uscita|ritiro/, s)) return 'withdraw';
  if (matches(/deposit|versamento|einzahlung|bonifico in entrata|ricarica/, s)) return 'deposit';
  return null;
}

// DEGIRO account statement description → category
export function degiroAccountKind(description) {
  const s = normHeader(description);
  if (!s) return 'unknown';
  if (matches(/ritenuta|dividend tax|withholding|quellensteuer|dividendbelasting|dividendensteuer|retencion/, s)) return 'wht';
  if (matches(/dividend|ausschuttung|cedola|coupon|kupon/, s)) return 'div';
  if (matches(/connession|connection|connectivity|verbindung|aansluit|conexion/, s)) return 'connectivity';
  if (matches(/autofx|costi di cambio|commissione (di )?cambio|fx (debit |credit )?(fee|commission)|conversion fee|wahrungsumrechnungsgebuhr|valutakosten/, s)) return 'autofx';
  if (matches(/cambio valuta|fx credit|fx debit|fx-gutschrift|fx-lastschrift|valuta creditering|valuta debitering|wahrungswechsel|cambio de divisa/, s)) return 'fx';
  if (matches(/costi di transazione|transaction (and\/or third party )?(fee|cost)|transaktionskosten|transactiekosten|costes de transaccion/, s)) return 'txfee';
  if (matches(/money market|mercato monetario|geldmarkt|fund price change|prezzo del fondo|liquidity fund|cash fund|conversione fond|fondi del mercato|fondo monetario/, s)) return 'mmf';
  if (matches(/cash sweep|sweep transfer|transfer (from|to) your cash account|trasferimento .*(conto|cash)|overboeking|ubertrag/, s)) return 'internal';
  if (matches(/\bbollo\b|stamp duty|stamp tax|stempel/, s)) return 'stamp';
  if (matches(/plusvalenz|capital gain|kapitalertrag|vermogenswinst/, s)) return 'capital';
  if (matches(/transazioni finanziarie|tobin|financial transaction tax|\bftt\b|\bttf\b/, s)) return 'ftt';
  if (matches(/interess|interest|zinsen|\brente\b/, s)) return 'interest';
  if (matches(/prelievo|withdrawal|auszahlung|opname|bonifico in uscita|ritiro/, s)) return 'withdraw';
  if (matches(/deposit|versamento|bonifico in entrata|einzahlung|storting|ideal|sofort|ricarica/, s)) return 'deposit';
  if (matches(/^(acquisto|vendita|buy|sell|kauf|verkauf|koop|verkoop|compra|venta)\b/, s)) return 'trade';
  if (matches(/rimborso|redemption|tilgung|aflossing|amortizacion/, s)) return 'redemption';
  return 'unknown';
}

const SCALABLE_TYPES = [
  [/^(buy|kauf|acquisto|savings plan|sparplan|piano di accumulo)/, 'buy'],
  [/^(sell|verkauf|vendita)/, 'sell'],
  [/^(distribution|dividend|ausschuttung|dividende|distribuzione|dividendo|coupon|cedola)/, 'div'],
  [/^(interest|zinsen|interessi)/, 'interest'],
  [/^(deposit|einzahlung|deposito|versamento)/, 'deposit'],
  [/^(withdrawal|auszahlung|prelievo)/, 'withdraw'],
  [/^(fee|gebuhr|commissione|costo)/, 'fee'],
  [/^(tax|steuer|impost|tass)/, 'tax'],
  [/^(corporate action|kapitalmassnahme|operazione societaria|security transfer|wertpapierubertrag|trasferimento)/, 'skip'],
];
function scalableType(text) {
  const s = normHeader(text);
  for (const [re, t] of SCALABLE_TYPES) if (re.test(s)) return t;
  return null;
}

function feeKindFrom(text) {
  const s = normHeader(text);
  if (/connession|connection|connectivity|verbindung/.test(s)) return 'connectivity';
  if (/autofx|\bfx\b|cambio|currency|wahrung/.test(s)) return 'autofx';
  if (/transazion|transaction|ordine|order/.test(s)) return 'transaction';
  return 'other';
}
function taxKindFrom(text) {
  const s = normHeader(text);
  if (/bollo|stamp/.test(s)) return 'stamp';
  if (/plusval|capital|kapital|gain/.test(s)) return 'capital';
  if (/ritenuta|withholding|dividend|cedol|coupon|quellen/.test(s)) return 'income';
  return 'other';
}

// Rough asset class from the product name (the UI can override it)
function typeHint(name, isin, assetType = '') {
  const s = normHeader(name);
  const at = normHeader(assetType);
  if (/crypto|krypto/.test(at) || /\b(bitcoin|ethereum|btc|eth|solana|crypto)\b/.test(s)) return 'crypto';
  if (/\b(etc|etn)\b|physical (gold|silver)|\bgold\b|\boro\b/.test(s)) return 'commodity';
  if (/\bbtp\b|\bbot\b|\bcct\b|\bctz\b|bond|obbligaz|treasury|\bbund\b|\boat\b|\bbtf\b/.test(s)) return 'bond';
  if (/\b(etf|ucits)\b|ishares|vanguard|xtrackers|amundi|lyxor|spdr|invesco|wisdomtree/.test(s)) return 'etf';
  if (/\bfund\b|\bfondo\b|\bsicav\b/.test(s)) return 'fund';
  return 'stock';
}

/* ---------- Building transactions ---------- */
const DEFAULT_SRC = (rows) => {
  let h = 0;
  for (const r of rows.slice(0, 50)) for (const c of r.join('|')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 'imp' + h.toString(36);
};

// Signature used to recognize a transaction already in the data
function signature(t, key) {
  const n = (v, d) => (Number.isFinite(+v) ? round(+v, d) : '');
  if (t.type === 'buy' || t.type === 'sell') return [t.date, key, t.type, n(t.qty, 6), n(t.price, 4)].join('|');
  return [t.date, key, t.type, n(t.amount, 2), t.kind || ''].join('|');
}

function keysOfExisting(t, assets) {
  const a = (assets && t.aid && assets[t.aid]) || null;
  const keys = new Set([t.assetKey, t.aid, a && a.isin, a && a.name, a && a.symbol, a && a.ticker].filter(Boolean).map((k) => String(k).toUpperCase()));
  if (!keys.size) keys.add('');
  return keys;
}

/**
 * rows + mapping → { txns, assets: [{ key, isin, name, currency, exchange?, symbol?, type }], warnings, skipped, duplicates, ... }
 * options: { preset, acc, existing: Txn[], assets: data.assets (to read ISINs of existing txns),
 *            src: import batch id, fxOn(ccy, date) → units per EUR (optional, for non-EUR amounts), decimal }
 */
export function buildTxns(rows, mapping, options = {}) {
  const preset = PRESETS[options.preset] ? options.preset : 'generic';
  const acc = options.acc || null;
  const src = options.src || DEFAULT_SRC(rows || []);
  const list = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
  const m = { ...mapping };
  const ctx = {
    preset,
    m,
    fxOn: typeof options.fxOn === 'function' ? options.fxOn : null,
    decimal: options.decimal || detectDecimal(numericCells(list, m)),
    records: [],
    assets: new Map(),
    warnings: [],
    skippedReasons: {},
    skipped: 0,
  };
  if (preset === 'degiro-transactions') degiroTransactions(list, ctx);
  else if (preset === 'degiro-account') degiroAccount(list, ctx);
  else if (preset === 'scalable') scalable(list, ctx);
  else generic(list, ctx);

  // Duplicates of transactions already in the data (same account)
  const existing = (Array.isArray(options.existing) ? options.existing : []).filter((t) => t && (!acc || !t.acc || t.acc === acc));
  const refs = new Set(existing.filter((t) => t.ref).map((t) => String(t.ref)));
  const sigs = new Set();
  for (const t of existing) for (const k of keysOfExisting(t, options.assets)) sigs.add(signature(t, k));
  let duplicates = 0;
  const kept = [];
  for (const r of ctx.records) {
    const key = String(r.assetKey || '').toUpperCase();
    if ((r.ref && refs.has(String(r.ref))) || sigs.has(signature(r, key))) {
      duplicates++;
      continue;
    }
    kept.push(r);
  }
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a._time || '') < (b._time || '') ? -1 : (a._time || '') > (b._time || '') ? 1 : a._line - b._line));
  const txns = kept.map((r, i) => {
    const t = { id: `${src}-${i + 1}` };
    if (acc) t.acc = acc;
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('_') || v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
      t[k] = v;
    }
    t.src = src;
    return t;
  });
  const usedKeys = new Set(txns.map((t) => t.assetKey).filter(Boolean));
  const assets = [...ctx.assets.values()].filter((a) => usedKeys.has(a.key));
  return {
    txns,
    assets,
    warnings: ctx.warnings,
    skipped: ctx.skipped,
    skippedReasons: ctx.skippedReasons,
    duplicates,
    rows: list.length,
    src,
    preset,
  };
}

function numericCells(rows, m) {
  const cols = ['qty', 'price', 'amount', 'total', 'fee', 'fx', 'tax', 'localValue', 'fxFee', 'balance'].map((k) => m[k]).filter((i) => Number.isInteger(i) && i >= 0);
  const out = [];
  for (const r of rows.slice(0, 200)) {
    for (const i of cols) {
      out.push(r[i]);
      if (r[i + 1] !== undefined) out.push(r[i + 1]);
    }
  }
  return out;
}

/* ---------- Shared row helpers ---------- */
const cell = (row, i) => (Number.isInteger(i) && i >= 0 && i < row.length ? String(row[i] ?? '').trim() : '');
const num = (ctx, row, i) => parseAmount(cell(row, i), ctx.decimal);

// DEGIRO amount columns are followed (or preceded) by an unnamed currency column: read both
function pair(ctx, row, i) {
  if (!(Number.isInteger(i) && i >= 0)) return { value: NaN, ccy: '' };
  const a = cell(row, i);
  const b = cell(row, i + 1);
  if (isCcy(a) && !isCcy(b)) return { value: parseAmount(b, ctx.decimal), ccy: a };
  return { value: parseAmount(a, ctx.decimal), ccy: isCcy(b) ? b : '' };
}

function warn(ctx, msg) {
  if (!ctx.warnings.includes(msg)) ctx.warnings.push(msg);
}
function skip(ctx, reason) {
  ctx.skipped++;
  ctx.skippedReasons[reason] = (ctx.skippedReasons[reason] || 0) + 1;
}

function normCcy(c) {
  const s = String(c || '').trim();
  if (s === 'GBp' || s.toUpperCase() === 'GBX') return 'GBX';
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : '';
}

function addAsset(ctx, { isin, name, symbol, currency, exchange, assetType }) {
  const key = isin || name || symbol;
  if (!key) return '';
  const cur = ctx.assets.get(key);
  if (cur) {
    if (!cur.currency && currency) cur.currency = currency;
    if (!cur.exchange && exchange) cur.exchange = exchange;
    return key;
  }
  const a = { key, isin: isin || '', name: name || symbol || isin, currency: currency || 'EUR', type: typeHint(name || symbol, isin, assetType) };
  if (exchange) a.exchange = exchange;
  if (symbol) a.symbol = symbol;
  ctx.assets.set(key, a);
  return key;
}

// Units per EUR for a non-EUR amount; explicit rate first, then the injected lookup
function rateFor(ctx, ccy, date, explicit) {
  if (!ccy || ccy === 'EUR') return 1;
  if (explicit > 0) return explicit;
  if (ctx.fxOn) {
    const r = Number(ctx.fxOn(ccy, date));
    if (r > 0) return r;
  }
  return 0;
}

/* ---------- DEGIRO: Transazioni ---------- */
function degiroTransactions(rows, ctx) {
  const { m } = ctx;
  rows.forEach((row, line) => {
    const date = parseDate(cell(row, m.date));
    if (!date) return skip(ctx, 'data non valida');
    const isin = cell(row, m.isin).toUpperCase();
    const name = cell(row, m.name);
    const qtyRaw = num(ctx, row, m.qty);
    if (!Number.isFinite(qtyRaw) || qtyRaw === 0) return skip(ctx, 'quantità mancante');
    const p = pair(ctx, row, m.price);
    let price = p.value;
    if (!(price > 0)) {
      warn(ctx, 'Righe senza prezzo (operazioni societarie, frazionamenti) non importate: registrale a mano se servono.');
      return skip(ctx, 'prezzo mancante');
    }
    let ccy = normCcy(m.currency >= 0 ? cell(row, m.currency) : p.ccy) || normCcy(p.ccy) || 'EUR';
    const pence = ccy === 'GBX';
    let qty = Math.abs(qtyRaw);
    const local = pair(ctx, row, m.localValue);
    const eur = pair(ctx, row, m.amount);
    const localAbs = Math.abs(local.value);
    // Bonds are quoted in % of nominal: 1000 nominal at 98,50 → 10 units of 100 at 98,50
    if (localAbs > 0) {
      const ratio = (qty * price) / localAbs;
      if (ratio > 95 && ratio < 105) {
        qty /= 100;
        warn(ctx, 'Obbligazioni: la quantità è espressa in lotti da 100 € di valore nominale (prezzo in % come in borsa).');
      } else if (Math.abs(ratio - 1) > 0.05) {
        warn(ctx, `Controlla ${name || isin} del ${date}: quantità × prezzo non corrisponde al valore indicato dal broker.`);
      }
    }
    let fxRaw = num(ctx, row, m.fx);
    if (pence) {
      price /= 100;
      ccy = 'GBP';
      if (fxRaw > 20) fxRaw /= 100;
    }
    let fx;
    if (ccy !== 'EUR') {
      if (fxRaw > 0) fx = fxRaw;
      else if (localAbs > 0 && Math.abs(eur.value) > 0) fx = (pence ? localAbs / 100 : localAbs) / Math.abs(eur.value);
      else fx = rateFor(ctx, ccy, date, 0) || undefined;
      if (!fx) warn(ctx, `Manca il tasso di cambio per alcune operazioni in ${ccy}: verrà usato quello di mercato del giorno.`);
    }
    const feePair = pair(ctx, row, m.fee);
    const fee = Number.isFinite(feePair.value) ? Math.abs(feePair.value) : 0;
    const fxFeeRaw = num(ctx, row, m.fxFee);
    const fxFee = Number.isFinite(fxFeeRaw) ? Math.abs(fxFeeRaw) : 0;
    const assetKey = addAsset(ctx, { isin, name, currency: ccy, exchange: cell(row, m.exchange) });
    if (!assetKey) return skip(ctx, 'titolo mancante');
    ctx.records.push({
      date,
      type: qtyRaw < 0 ? 'sell' : 'buy',
      assetKey,
      qty: round(qty, 8),
      price: round(price, 6),
      fx: fx ? round(fx, 6) : undefined,
      fee: fee ? round(fee, 2) : undefined,
      fxFee: fxFee ? round(fxFee, 2) : undefined,
      ref: cell(row, m.ref) || undefined,
      _time: cell(row, m.time),
      _line: line,
    });
  });
}

/* ---------- DEGIRO: Estratto conto ---------- */
function degiroAccount(rows, ctx) {
  const { m } = ctx;
  const items = [];
  rows.forEach((row, line) => {
    const date = parseDate(cell(row, m.date));
    if (!date) return skip(ctx, 'data non valida');
    const desc = cell(row, m.description);
    const amt = pair(ctx, row, m.amount);
    items.push({
      line,
      date,
      time: cell(row, m.time),
      name: cell(row, m.name),
      isin: cell(row, m.isin).toUpperCase(),
      desc,
      kind: degiroAccountKind(desc),
      fx: num(ctx, row, m.fx),
      ccy: normCcy(amt.ccy) || 'EUR',
      amount: amt.value,
      ref: cell(row, m.ref),
    });
  });

  // Exchange rates booked by the broker ("Cambio valuta" rows), by date and currency
  const rates = [];
  const byGroup = new Map();
  for (const it of items) {
    if (it.kind !== 'fx' && it.kind !== 'autofx') continue;
    if (it.kind === 'fx' && Number.isFinite(it.amount)) {
      const g = `${it.date}|${it.ref || it.time}`;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(it);
    }
    if (it.fx > 0) rates.push({ date: it.date, ccy: it.ccy !== 'EUR' ? it.ccy : null, rate: it.fx, weight: 1 });
  }
  for (const group of byGroup.values()) {
    const eurRow = group.find((x) => x.ccy === 'EUR');
    const other = group.find((x) => x.ccy !== 'EUR');
    if (eurRow && other && Math.abs(eurRow.amount) > 0) rates.push({ date: other.date, ccy: other.ccy, rate: Math.abs(other.amount) / Math.abs(eurRow.amount), weight: 2 });
  }
  const bookedRate = (ccy, date) => {
    let best = null;
    let bestScore = Infinity;
    for (const r of rates) {
      if (r.ccy && r.ccy !== ccy) continue;
      const days = Math.abs((Date.parse(r.date) - Date.parse(date)) / 864e5);
      if (days > 5) continue;
      const score = days * 10 + (r.ccy ? 0 : 3) - r.weight;
      if (score < bestScore) {
        bestScore = score;
        best = r.rate;
      }
    }
    return best;
  };
  const unconverted = new Set();
  const toEur = (it, value) => {
    if (it.ccy === 'EUR') return value;
    const r = it.fx > 0 ? it.fx : bookedRate(it.ccy, it.date) || rateFor(ctx, it.ccy, it.date, 0);
    if (r > 0) return value / r;
    unconverted.add(it.ccy);
    return value;
  };

  // Dividends and their withholding: gross and tax of the same security and day are merged
  const divs = new Map();
  const whts = [];
  for (const it of items) {
    if (!Number.isFinite(it.amount) || it.amount === 0) {
      if (['div', 'wht', 'connectivity', 'autofx', 'interest', 'deposit', 'withdraw', 'stamp', 'capital', 'ftt'].includes(it.kind)) skip(ctx, 'importo zero');
      else skip(ctx, skipReason(it.kind));
      continue;
    }
    const assetKey = it.isin || it.name ? addAsset(ctx, { isin: it.isin, name: it.name, currency: it.ccy }) : '';
    const base = { date: it.date, _time: it.time, _line: it.line };
    switch (it.kind) {
      case 'div': {
        const k = `${assetKey}|${it.date}|${it.ccy}`;
        const d = divs.get(k) || { ...base, assetKey, ccy: it.ccy, gross: 0, tax: 0, fx: 0, items: [] };
        d.gross += it.amount;
        if (it.fx > 0) d.fx = it.fx;
        d.items.push(it);
        divs.set(k, d);
        break;
      }
      case 'wht':
        whts.push({ ...it, assetKey });
        break;
      case 'connectivity':
      case 'autofx':
        if (it.amount > 0) {
          warn(ctx, 'Rimborsi di commissioni non importati: registrali a mano se servono.');
          skip(ctx, 'rimborso');
          break;
        }
        ctx.records.push({ ...base, type: 'fee', kind: it.kind, amount: round(toEur(it, -it.amount), 2), note: it.desc, ref: it.ref || undefined });
        break;
      case 'interest':
        if (it.amount > 0) ctx.records.push({ ...base, type: 'interest', amount: round(toEur(it, it.amount), 2), note: it.desc });
        else ctx.records.push({ ...base, type: 'fee', kind: 'other', amount: round(toEur(it, -it.amount), 2), note: it.desc || 'Interessi passivi' });
        break;
      case 'deposit':
      case 'withdraw': {
        const type = it.amount > 0 ? 'deposit' : 'withdraw';
        ctx.records.push({ ...base, type, amount: round(toEur(it, Math.abs(it.amount)), 2), note: it.desc });
        break;
      }
      case 'stamp':
      case 'capital':
      case 'ftt':
        if (it.amount > 0) {
          warn(ctx, 'Rimborsi di imposte non importati: registrali a mano se servono.');
          skip(ctx, 'rimborso');
          break;
        }
        ctx.records.push({ ...base, type: 'tax', kind: it.kind === 'ftt' ? 'other' : it.kind, assetKey: it.kind === 'stamp' ? undefined : assetKey || undefined, amount: round(toEur(it, -it.amount), 2), note: it.desc });
        break;
      case 'redemption':
        warn(ctx, 'Rimborso di obbligazioni a scadenza: registralo come vendita al prezzo di rimborso.');
        skip(ctx, skipReason(it.kind));
        break;
      case 'unknown':
        warn(ctx, `Movimento non riconosciuto e non importato: "${it.desc || 'senza descrizione'}".`);
        skip(ctx, skipReason(it.kind));
        break;
      default:
        skip(ctx, skipReason(it.kind));
    }
  }

  // Withholding rows: same security, same day first, then the closest dividend within 5 days
  const divList = [...divs.values()];
  for (const w of whts) {
    const sameDay = divList.find((d) => d.assetKey === w.assetKey && d.date === w.date && d.ccy === w.ccy);
    let target = sameDay;
    if (!target) {
      let best = Infinity;
      for (const d of divList) {
        if (d.assetKey !== w.assetKey || d.ccy !== w.ccy) continue;
        const days = Math.abs((Date.parse(d.date) - Date.parse(w.date)) / 864e5);
        if (days <= 5 && days < best) {
          best = days;
          target = d;
        }
      }
    }
    if (target) {
      target.tax += -w.amount;
      if (w.fx > 0 && !target.fx) target.fx = w.fx;
      continue;
    }
    if (w.amount < 0) {
      ctx.records.push({ date: w.date, _time: w.time, _line: w.line, type: 'tax', kind: 'income', assetKey: w.assetKey || undefined, amount: round(toEur(w, -w.amount), 2), note: w.desc });
    } else {
      warn(ctx, 'Rimborsi di ritenute sui dividendi non importati: registrali a mano se servono.');
      skip(ctx, 'rimborso');
    }
  }
  for (const d of divList) {
    if (!(d.gross > 0.000001)) {
      skip(ctx, 'dividendo stornato');
      continue;
    }
    const conv = { ccy: d.ccy, date: d.date, fx: d.fx };
    const gross = toEur(conv, d.gross);
    const tax = toEur(conv, Math.max(0, d.tax));
    ctx.records.push({
      date: d.date,
      _time: d._time,
      _line: d._line,
      type: 'div',
      assetKey: d.assetKey || undefined,
      amount: round(gross - tax, 2),
      gross: round(gross, 2),
      tax: tax > 0 ? round(tax, 2) : undefined,
    });
  }
  for (const c of unconverted) warn(ctx, `Alcuni importi in ${c} non sono stati convertiti in euro (manca il cambio): controllali prima di importare.`);
}

function skipReason(kind) {
  return {
    trade: 'compravendita (nel file Transazioni)',
    txfee: 'commissione già nel file Transazioni',
    fx: 'cambio valuta',
    mmf: 'fondo monetario',
    internal: 'trasferimento interno',
    redemption: 'rimborso obbligazione',
    unknown: 'movimento non riconosciuto',
  }[kind] || 'non importato';
}

/* ---------- Scalable Capital ---------- */
function scalable(rows, ctx) {
  const { m } = ctx;
  rows.forEach((row, line) => {
    const status = normHeader(cell(row, m.status));
    if (m.status >= 0 && status && !/execut|ausgefuhrt|eseguit|ejecutad|settled|abgerechnet/.test(status)) return skip(ctx, 'non eseguita');
    const date = parseDate(cell(row, m.date));
    if (!date) return skip(ctx, 'data non valida');
    const typeText = cell(row, m.type);
    const desc = cell(row, m.description);
    const type = scalableType(typeText) || typeFromText(typeText) || typeFromText(desc);
    if (type === 'skip') {
      warn(ctx, 'Operazioni societarie e trasferimenti di titoli non importati: registrali a mano se servono.');
      return skip(ctx, 'operazione societaria o trasferimento');
    }
    if (!type) {
      warn(ctx, `Tipo di operazione non riconosciuto: "${typeText || desc}".`);
      return skip(ctx, 'tipo non riconosciuto');
    }
    const isin = cell(row, m.isin).toUpperCase();
    const ccy = normCcy(cell(row, m.currency)) || 'EUR';
    const qtyRaw = num(ctx, row, m.qty);
    const priceRaw = num(ctx, row, m.price);
    const amount = num(ctx, row, m.amount);
    const feeRaw = num(ctx, row, m.fee);
    const taxRaw = num(ctx, row, m.tax);
    const fee = Number.isFinite(feeRaw) ? Math.abs(feeRaw) : 0;
    const tax = Number.isFinite(taxRaw) ? Math.abs(taxRaw) : 0;
    const base = { date, ref: cell(row, m.ref) || undefined, _time: cell(row, m.time), _line: line };
    const fx = ccy === 'EUR' ? 1 : rateFor(ctx, ccy, date, 0);
    if (ccy !== 'EUR' && !fx) warn(ctx, `Alcuni importi in ${ccy} non sono stati convertiti in euro (manca il cambio): controllali.`);
    const eur = (v) => (fx > 0 ? v / fx : v);
    if (type === 'buy' || type === 'sell') {
      const qty = Math.abs(qtyRaw);
      if (!(qty > 0)) return skip(ctx, 'quantità mancante');
      let price = priceRaw > 0 ? priceRaw : Math.abs(amount) > 0 ? Math.abs(amount) / qty : NaN;
      if (!(price > 0)) return skip(ctx, 'prezzo mancante');
      price = Math.abs(price);
      const assetKey = addAsset(ctx, { isin, name: desc, currency: ccy, assetType: cell(row, m.assetType) });
      if (!assetKey) return skip(ctx, 'titolo mancante');
      ctx.records.push({
        ...base,
        type,
        assetKey,
        qty: round(qty, 8),
        price: round(price, 6),
        fx: ccy !== 'EUR' && fx ? round(fx, 6) : undefined,
        fee: fee ? round(eur(fee), 2) : undefined,
        tax: type === 'sell' && tax ? round(eur(tax), 2) : undefined,
        note: /savings plan|sparplan|piano di accumulo/.test(normHeader(typeText)) ? 'Piano di accumulo' : undefined,
      });
      return;
    }
    if (!Number.isFinite(amount) || amount === 0) return skip(ctx, 'importo zero');
    const abs = Math.abs(amount);
    if (type === 'div') {
      const assetKey = addAsset(ctx, { isin, name: desc, currency: ccy, assetType: cell(row, m.assetType) });
      const net = eur(abs);
      const t = eur(tax);
      ctx.records.push({ ...base, type: 'div', assetKey: assetKey || undefined, amount: round(net, 2), gross: round(net + t, 2), tax: t ? round(t, 2) : undefined });
    } else if (type === 'interest') {
      if (amount > 0) ctx.records.push({ ...base, type: 'interest', amount: round(eur(abs), 2), note: desc || undefined });
      else ctx.records.push({ ...base, type: 'fee', kind: 'other', amount: round(eur(abs), 2), note: desc || 'Interessi passivi' });
    } else if (type === 'deposit' || type === 'withdraw') {
      ctx.records.push({ ...base, type: type === 'withdraw' || amount < 0 ? 'withdraw' : 'deposit', amount: round(eur(abs), 2), note: desc || undefined });
    } else if (type === 'fee') {
      if (amount > 0) {
        warn(ctx, 'Rimborsi di commissioni non importati: registrali a mano se servono.');
        return skip(ctx, 'rimborso');
      }
      ctx.records.push({ ...base, type: 'fee', kind: feeKindFrom(desc), amount: round(eur(abs), 2), note: desc || undefined });
    } else if (type === 'tax') {
      if (amount > 0) {
        warn(ctx, 'Rimborsi di imposte non importati: registrali a mano se servono.');
        return skip(ctx, 'rimborso');
      }
      const assetKey = isin ? addAsset(ctx, { isin, name: desc, currency: ccy }) : '';
      ctx.records.push({ ...base, type: 'tax', kind: taxKindFrom(`${typeText} ${desc}`), assetKey: assetKey || undefined, amount: round(eur(abs), 2), note: desc || undefined });
    }
  });
}

/* ---------- Generic CSV ---------- */
function generic(rows, ctx) {
  const { m } = ctx;
  if (m.date < 0) warn(ctx, 'Nessuna colonna con la data: indica quale colonna contiene la data.');
  rows.forEach((row, line) => {
    const date = parseDate(cell(row, m.date));
    if (!date) return skip(ctx, 'data non valida');
    const typeText = cell(row, m.type);
    const desc = cell(row, m.description);
    const qtyRaw = num(ctx, row, m.qty);
    let type = typeFromText(typeText) || (m.type < 0 ? typeFromText(desc) : null);
    if (!type && Number.isFinite(qtyRaw) && qtyRaw !== 0) type = qtyRaw < 0 ? 'sell' : 'buy';
    if (!type) {
      if (typeText) warn(ctx, `Tipo di operazione non riconosciuto: "${typeText}".`);
      return skip(ctx, 'tipo non riconosciuto');
    }
    const isin = cell(row, m.isin).toUpperCase();
    const symbol = cell(row, m.symbol).toUpperCase();
    const name = cell(row, m.name);
    const ccy = normCcy(cell(row, m.currency)) || 'EUR';
    const fxCol = num(ctx, row, m.fx);
    const amountRaw = num(ctx, row, m.amount);
    const totalRaw = num(ctx, row, m.total);
    const feeRaw = num(ctx, row, m.fee);
    const taxRaw = num(ctx, row, m.tax);
    const fee = Number.isFinite(feeRaw) ? Math.abs(feeRaw) : 0;
    const tax = Number.isFinite(taxRaw) ? Math.abs(taxRaw) : 0;
    const base = { date, ref: cell(row, m.ref) || undefined, _time: cell(row, m.time), _line: line };
    const fx = ccy === 'EUR' ? 1 : rateFor(ctx, ccy, date, fxCol);
    if (ccy !== 'EUR' && !fx) warn(ctx, `Manca il tasso di cambio per alcune righe in ${ccy}: verrà usato quello di mercato del giorno.`);
    if (type === 'buy' || type === 'sell') {
      const qty = Math.abs(qtyRaw);
      if (!(qty > 0)) return skip(ctx, 'quantità mancante');
      const priceRaw = num(ctx, row, m.price);
      const gross = Number.isFinite(amountRaw) && amountRaw !== 0 ? Math.abs(amountRaw) : Number.isFinite(totalRaw) && totalRaw !== 0 ? Math.abs(totalRaw) : NaN;
      const price = priceRaw > 0 ? priceRaw : gross / qty;
      if (!(price > 0)) return skip(ctx, 'prezzo mancante');
      const assetKey = addAsset(ctx, { isin, name, symbol, currency: ccy });
      if (!assetKey) return skip(ctx, 'titolo mancante');
      ctx.records.push({
        ...base,
        type,
        assetKey,
        qty: round(qty, 8),
        price: round(Math.abs(price), 6),
        fx: ccy !== 'EUR' && fx ? round(fx, 6) : undefined,
        fee: fee ? round(fee, 2) : undefined,
        tax: type === 'sell' && tax ? round(tax, 2) : undefined,
        note: desc && desc !== typeText ? desc : undefined,
      });
      return;
    }
    const value = Number.isFinite(amountRaw) && amountRaw !== 0 ? amountRaw : totalRaw;
    if (!Number.isFinite(value) || value === 0) return skip(ctx, 'importo zero');
    const eur = (v) => (fx > 0 ? v / fx : v);
    const abs = eur(Math.abs(value));
    const note = desc || (typeText && typeFromText(typeText) ? undefined : typeText) || undefined;
    if (type === 'div') {
      const assetKey = addAsset(ctx, { isin, name, symbol, currency: ccy });
      const t = eur(tax);
      ctx.records.push({ ...base, type: 'div', assetKey: assetKey || undefined, amount: round(abs, 2), gross: round(abs + t, 2), tax: t ? round(t, 2) : undefined, note: desc || undefined });
    } else if (type === 'fee') {
      const assetKey = isin || symbol || name ? addAsset(ctx, { isin, name, symbol, currency: ccy }) : '';
      ctx.records.push({ ...base, type: 'fee', kind: feeKindFrom(`${typeText} ${desc}`), assetKey: assetKey || undefined, amount: round(abs, 2), note });
    } else if (type === 'tax') {
      const assetKey = isin || symbol || name ? addAsset(ctx, { isin, name, symbol, currency: ccy }) : '';
      ctx.records.push({ ...base, type: 'tax', kind: taxKindFrom(`${typeText} ${desc}`), assetKey: assetKey || undefined, amount: round(abs, 2), note });
    } else if (type === 'interest') {
      if (value > 0) ctx.records.push({ ...base, type: 'interest', amount: round(abs, 2), note });
      else ctx.records.push({ ...base, type: 'fee', kind: 'other', amount: round(abs, 2), note: note || 'Interessi passivi' });
    } else {
      ctx.records.push({ ...base, type, amount: round(abs, 2), note });
    }
  });
}

/* ---------- Convenience ---------- */
// One call for the UI: text → { preset, mapping, headers, ...buildTxns result }
export function importCsv(text, options = {}) {
  const { headers, rows, delimiter } = parseCsv(text);
  const preset = options.preset && PRESETS[options.preset] ? options.preset : detectPreset(headers);
  const mapping = options.mapping || guessMapping(headers, preset);
  const res = buildTxns(rows, mapping, { ...options, preset });
  return { ...res, headers, mapping, delimiter, preset };
}

export const _test = { detectDelimiter, signature, typeHint };
