// Look-through: what the portfolio really owns through its ETFs and funds.
// The composition of every ETF (from /api/eco/etf, read from justETF: its 10 largest holdings, its
// countries and sectors) is weighted by the value of the position. Shares owned directly add
// themselves, with the country of their ISIN and their sector; bonds add their country and sector.
// Everything else (cash, crypto, gold, an ETF whose composition is unknown) stays "not classified".
// Percentages are shares of the whole value given, so every list adds up to 100%.
import { NAMES } from './world.js';

export const ETF_MAX_AGE = 7 * 24 * 3600e3; // compositions change slowly: one download a week
export const etfKey = (isin) => `etf:${isin}`;
export const etfPath = (isin) => `/eco/etf?isin=${encodeURIComponent(isin)}`;
export const validIsin = (s) => typeof s === 'string' && /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s);
export const isFund = (a) => Boolean(a) && (a.type === 'etf' || a.type === 'fund');

// justETF sectors → the sectors of the app (state.js SECTORS)
const SECTOR_MAP = {
  informatica: 'Tecnologia',
  'tecnologia dell informazione': 'Tecnologia',
  finanza: 'Finanza',
  industria: 'Industria',
  'servizi alle imprese': 'Industria',
  'assistenza sanitaria': 'Sanità',
  sanita: 'Sanità',
  'beni di consumo non ciclici': 'Beni di consumo',
  'beni di prima necessita': 'Beni di consumo',
  'beni di consumo ciclici': 'Beni voluttuari',
  'beni voluttuari': 'Beni voluttuari',
  'servizi ai consumatori': 'Beni voluttuari',
  energia: 'Energia',
  'materiali non energetici': 'Materiali',
  materiali: 'Materiali',
  telecomunicazioni: 'Telecomunicazioni',
  'servizi di comunicazione': 'Telecomunicazioni',
  'servizi di pubblica utilita': 'Utility',
  utility: 'Utility',
  immobiliare: 'Immobiliare',
  'emittenti sovrani stati': 'Governativo',
  'emittenti non societari': 'Governativo',
  altri: 'Altro',
  altro: 'Altro',
};
// Country names justETF writes differently from world.js (English ones included)
const COUNTRY_ALIASES = {
  'repubblica sudafricana': 'ZA', 'sud africa': 'ZA', 'cayman islands': 'KY', israel: 'IL', 'saudi arabia': 'SA',
  'united arab emirates': 'AE', 'united states': 'US', usa: 'US', 'united kingdom': 'GB', 'gran bretagna': 'GB',
  netherlands: 'NL', olanda: 'NL', switzerland: 'CH', germany: 'DE', japan: 'JP', 'south korea': 'KR', korea: 'KR',
  'repubblica di corea': 'KR', china: 'CN', brazil: 'BR', mexico: 'MX', india: 'IN', france: 'FR', spain: 'ES',
  italy: 'IT', canada: 'CA', australia: 'AU', sweden: 'SE', denmark: 'DK', ireland: 'IE', belgium: 'BE',
  'hong kong sar': 'HK', 'isole vergini britanniche': 'VG', 'british virgin islands': 'VG', bermuda: 'BM', jersey: 'JE',
};
// Regions of the app → a country, for a share with no ISIN
const REGION_COUNTRY = { Italia: 'IT', USA: 'US' };
const OTHERS = new Set(['altri', 'altro', 'others', 'other']);

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

let countryIndex = null;
// Country name (as justETF writes it) → ISO code, or null
export function countryCode(name) {
  if (!countryIndex) {
    countryIndex = new Map();
    for (const [code, n] of Object.entries(NAMES)) countryIndex.set(norm(n), code);
    for (const [n, code] of Object.entries(COUNTRY_ALIASES)) countryIndex.set(norm(n), code);
  }
  return countryIndex.get(norm(name)) || null;
}
// Country of a share or a bond from its ISIN ('US0378331005' → 'US'); XS, EU and the like are no country
export const countryOfIsin = (isin) => (validIsin(isin) && NAMES[isin.slice(0, 2)] ? isin.slice(0, 2) : null);
export const countryName = (code) => NAMES[code] || code;
export function sectorOf(name) {
  const k = norm(name);
  return SECTOR_MAP[k] || (k ? String(name).trim() : 'Altro');
}

// State of the composition of one ETF: 'ok' (data), 'none' (justETF has none), 'loading', 'failed',
// 'noisin' (the security has no ISIN to look it up)
export function fundState(a, entryOf) {
  if (!validIsin(a.isin)) return { state: 'noisin' };
  const e = entryOf(a.isin);
  if (!e) return { state: 'loading' };
  if (e.failed && !e.data) return { state: 'failed', message: e.failed };
  if (!e.data) return { state: 'loading' };
  if (e.data.none) return { state: 'none' };
  return { state: 'ok', data: e.data };
}

/**
 * positions: [{ aid, value, asset }] (value in euros); entryOf(isin) → { data, failed } or null.
 * → { total, holdings, countries, sectors, funds, known: { country, sector } }
 *   holdings: [{ key, name, isin, value, share, via: [aid], direct }] by value (top 10 of every ETF only)
 *   countries: [{ key, code, name, value, share }], sectors: [{ key, name, value, share }]: each list ends
 *   with 'others' (the "Altri" of the ETFs) and 'none' (nothing to classify: cash, crypto, unknown ETFs)
 *   funds: [{ aid, isin, value, state, date, count, topShare }]
 */
export function lookThrough(positions, entryOf) {
  const list = (positions || []).filter((p) => p && p.asset && p.value > 0);
  const total = list.reduce((s, p) => s + p.value, 0);
  const holdings = new Map();
  const countries = new Map();
  const sectors = new Map();
  const funds = [];
  let otherCountries = 0;
  let otherSectors = 0;
  const addHolding = (key, name, isin, value, aid, direct = false) => {
    const h = holdings.get(key) || { key, name, isin: isin || '', value: 0, via: [], direct: false };
    h.value += value;
    if (!h.via.includes(aid)) h.via.push(aid);
    if (direct) h.direct = true;
    if (!h.isin && isin) h.isin = isin;
    holdings.set(key, h);
  };
  const addCountry = (code, label, value) => {
    const key = code || `n:${norm(label)}`;
    const c = countries.get(key) || { key, code: code || null, name: code ? countryName(code) : label, value: 0 };
    c.value += value;
    countries.set(key, c);
  };
  const addSector = (name, value) => {
    if (name === 'Altro') {
      otherSectors += value;
      return;
    }
    const s = sectors.get(name) || { key: name, name, value: 0 };
    s.value += value;
    sectors.set(name, s);
  };
  for (const p of list) {
    const a = p.asset;
    const v = p.value;
    if (isFund(a)) {
      const st = fundState(a, entryOf);
      const f = { aid: p.aid, isin: validIsin(a.isin) ? a.isin : '', value: v, state: st.state };
      funds.push(f);
      if (st.state !== 'ok') continue;
      const d = st.data;
      f.date = d.date || null;
      f.count = d.count || null;
      let topShare = 0;
      for (const [name, pct, isin] of Array.isArray(d.top) ? d.top : []) {
        if (!(pct > 0)) continue;
        topShare += pct;
        addHolding(validIsin(isin) ? isin : `n:${norm(name)}`, name, validIsin(isin) ? isin : '', (v * pct) / 100, p.aid);
      }
      f.topShare = topShare / 100;
      // countries and sectors: what the lists do not reach (rounding) counts as "others"
      let cSum = 0;
      for (const [name, pct] of Array.isArray(d.countries) ? d.countries : []) {
        if (!(pct > 0)) continue;
        cSum += pct;
        if (OTHERS.has(norm(name))) otherCountries += (v * pct) / 100;
        else addCountry(countryCode(name), name, (v * pct) / 100);
      }
      otherCountries += (v * Math.max(0, 100 - cSum)) / 100;
      let sSum = 0;
      for (const [name, pct] of Array.isArray(d.sectors) ? d.sectors : []) {
        if (!(pct > 0)) continue;
        sSum += pct;
        addSector(sectorOf(name), (v * pct) / 100);
      }
      otherSectors += (v * Math.max(0, 100 - sSum)) / 100;
    } else if (a.type === 'stock') {
      addHolding(validIsin(a.isin) ? a.isin : `a:${p.aid}`, a.name, validIsin(a.isin) ? a.isin : '', v, p.aid, true);
      const code = countryOfIsin(a.isin) || REGION_COUNTRY[a.region] || null;
      if (code) addCountry(code, '', v);
      else otherCountries += v;
      addSector(a.sector && a.sector !== 'Diversificato' ? a.sector : 'Altro', v);
    } else if (a.type === 'bond') {
      const code = countryOfIsin(a.isin) || REGION_COUNTRY[a.region] || null;
      if (code) addCountry(code, '', v);
      else otherCountries += v;
      addSector(a.sector && a.sector !== 'Diversificato' ? a.sector : 'Governativo', v);
    }
  }
  const share = (x) => (total > 0 ? x / total : 0);
  const finish = (map, others, othersLabel) => {
    const rows = [...map.values()].sort((x, y) => y.value - x.value).map((r) => ({ ...r, share: share(r.value) }));
    const known = rows.reduce((s, r) => s + r.value, 0) + others;
    if (others > 0.005) rows.push({ key: 'others', name: othersLabel, value: others, share: share(others), others: true });
    const none = total - known;
    if (none > 0.005) rows.push({ key: 'none', name: 'Non classificato', value: none, share: share(none), none: true });
    return { rows, known: share(known) };
  };
  const c = finish(countries, otherCountries, 'Altri paesi');
  const s = finish(sectors, otherSectors, 'Altri settori');
  return {
    total,
    holdings: [...holdings.values()].sort((x, y) => y.value - x.value).map((h) => ({ ...h, share: share(h.value) })),
    countries: c.rows,
    sectors: s.rows,
    funds: funds.sort((x, y) => y.value - x.value),
    known: { country: c.known, sector: s.known },
  };
}

// Flag emoji of an ISO country code ('' for anything else)
export function flagOf(code) {
  return /^[A-Z]{2}$/.test(code || '') ? String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
}
