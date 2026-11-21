import test from 'node:test';
import assert from 'node:assert/strict';
import { lookThrough, countryCode, countryOfIsin, sectorOf, fundState, flagOf, validIsin, etfPath } from '../js/lookthrough.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('countries and sectors of justETF match the names of the app', () => {
  assert.equal(countryCode('Stati Uniti'), 'US');
  assert.equal(countryCode('Paesi bassi'), 'NL');
  assert.equal(countryCode('Repubblica Sudafricana'), 'ZA');
  assert.equal(countryCode('Saudi Arabia'), 'SA');
  assert.equal(countryCode('United Arab Emirates'), 'AE');
  assert.equal(countryCode('Cayman Islands'), 'KY');
  assert.equal(countryCode('Corea del Sud'), 'KR');
  assert.equal(countryCode('Atlantide'), null);
  assert.equal(countryOfIsin('US0378331005'), 'US');
  assert.equal(countryOfIsin('IT0003128367'), 'IT');
  assert.equal(countryOfIsin('XS1234567890'), null, 'international bonds have no country');
  assert.equal(countryOfIsin('bad'), null);
  assert.equal(sectorOf('Informatica'), 'Tecnologia');
  assert.equal(sectorOf('Assistenza sanitaria'), 'Sanità');
  assert.equal(sectorOf('Servizi di pubblica utilità'), 'Utility');
  assert.equal(sectorOf('Emittenti Sovrani (Stati)'), 'Governativo');
  assert.equal(sectorOf('Altri'), 'Altro');
  assert.equal(sectorOf('Spazio'), 'Spazio', 'unknown names stay as they are');
  assert.equal(flagOf('IT'), '🇮🇹');
  assert.equal(flagOf(null), '');
  assert.equal(validIsin('IE00BK5BQT80'), true);
  assert.equal(validIsin('IE00BK5BQT8X'), false);
  assert.equal(etfPath('IE00BK5BQT80'), '/eco/etf?isin=IE00BK5BQT80');
});

test('fundState: loading, failed, none, no ISIN, data', () => {
  const a = { type: 'etf', isin: 'IE00BK5BQT80' };
  assert.equal(fundState(a, () => null).state, 'loading');
  assert.deepEqual(fundState(a, () => ({ data: null, failed: 'Offline' })), { state: 'failed', message: 'Offline' });
  assert.equal(fundState(a, () => ({ data: { none: true } })).state, 'none');
  assert.equal(fundState({ type: 'etf', isin: '' }, () => null).state, 'noisin');
  assert.equal(fundState(a, () => ({ data: { top: [] }, failed: 'old copy, refresh failed' })).state, 'ok', 'an old copy still counts');
});

test('lookThrough: ETFs weighted by value, direct shares and bonds added, the rest not classified', () => {
  const VWCE = {
    top: [['NVIDIA Corp.', 5, 'US67066G1040'], ['Apple', 4, 'US0378331005']],
    countries: [['Stati Uniti', 60], ['Giappone', 6], ['Altri', 34]],
    sectors: [['Informatica', 38], ['Finanza', 18], ['Altri', 44]],
    date: '2026-09-30',
    count: 3797,
  };
  const assets = {
    vwce: { id: 'vwce', name: 'Vanguard FTSE All-World', type: 'etf', isin: 'IE00BK5BQT80' },
    aapl: { id: 'aapl', name: 'Apple', type: 'stock', isin: 'US0378331005', sector: 'Tecnologia' },
    btp: { id: 'btp', name: 'BTP 2030', type: 'bond', isin: 'IT0005383309' },
    btc: { id: 'btc', name: 'Bitcoin', type: 'crypto' },
    gold: { id: 'gold', name: 'Xetra-Gold', type: 'etf', isin: 'DE000A0S9GB0' },
    cash: { id: 'cash', name: 'Liquidità', type: 'cash' },
  };
  const pos = [['vwce', 10000], ['aapl', 2000], ['btp', 3000], ['btc', 1000], ['gold', 1000], ['cash', 500]].map(([aid, value]) => ({ aid, value, asset: assets[aid] }));
  const data = { IE00BK5BQT80: { data: VWCE }, DE000A0S9GB0: { data: { none: true } } };
  const lt = lookThrough(pos, (isin) => data[isin] || null);
  close(lt.total, 17500);
  const apple = lt.holdings[0];
  assert.equal(apple.name, 'Apple');
  close(apple.value, 2400);
  assert.equal(apple.direct, true);
  assert.deepEqual(apple.via, ['vwce', 'aapl']);
  close(apple.share, 2400 / 17500);
  assert.deepEqual(lt.holdings.map((h) => h.key), ['US0378331005', 'US67066G1040']);
  const c = Object.fromEntries(lt.countries.map((r) => [r.key, r.value]));
  close(c.US, 8000);
  close(c.IT, 3000);
  close(c.JP, 600);
  close(c.others, 3400);
  close(c.none, 2500, 1e-6);
  assert.equal(lt.countries[0].name, 'Stati Uniti');
  close(lt.countries.reduce((s, r) => s + r.share, 0), 1);
  const s = Object.fromEntries(lt.sectors.map((r) => [r.key, r.value]));
  close(s.Tecnologia, 5800);
  close(s.Finanza, 1800);
  close(s.Governativo, 3000);
  close(s.others, 4400);
  close(s.none, 2500);
  assert.deepEqual(lt.funds.map((f) => [f.aid, f.state]), [['vwce', 'ok'], ['gold', 'none']]);
  assert.equal(lt.funds[0].date, '2026-09-30');
  close(lt.funds[0].topShare, 0.09);
  close(lt.known.country, 15000 / 17500);
});

test('lookThrough: lists that do not reach 100% put the rest in "others"; nothing known, nothing classified', () => {
  const pos = [{ aid: 'e', value: 1000, asset: { type: 'etf', isin: 'IE00B4L5Y983' } }];
  const lt = lookThrough(pos, () => ({ data: { top: [], countries: [['Stati Uniti', 70]], sectors: [] } }));
  const c = Object.fromEntries(lt.countries.map((r) => [r.key, r.value]));
  close(c.US, 700);
  close(c.others, 300);
  assert.equal(c.none, undefined);
  close(Object.fromEntries(lt.sectors.map((r) => [r.key, r.value])).others, 1000);
  const empty = lookThrough(pos, () => null);
  assert.deepEqual(empty.countries.map((r) => r.key), ['none']);
  assert.equal(empty.funds[0].state, 'loading');
  assert.deepEqual(lookThrough([], () => null).countries, []);
});
