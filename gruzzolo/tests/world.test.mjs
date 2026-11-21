import test from 'node:test';
import assert from 'node:assert/strict';
import { MAP_W, MAP_H, PATHS, BOXES, POINTS, NAMES, CONTINENT, VIEWS } from '../js/world.js';

const CONTINENTS = ['europe', 'americas', 'asia', 'africa', 'oceania'];
const EPS = 1e-6;
const oneDecimal = (v) => Number.isFinite(v) && Math.abs(v * 10 - Math.round(v * 10)) < EPS;
const inMap = ([x, y], tol = EPS) => x >= -tol && x <= MAP_W + tol && y >= -tol && y <= MAP_H + tol;

// Path data → rings of absolute points. Throws unless it is only "M x y l dx dy dx dy ... z" groups,
// numbers read with the SVG grammar ('-' and a second '.' start a new number: '1.5.5' is 1.5 and .5)
function parseRings(d) {
  const re = /(?:[ ,]?(-?(?:\d+(?:\.\d*)?|\.\d+)))|([Mlz])/y;
  const tokens = [];
  for (let at = 0; at < d.length; at = re.lastIndex) {
    re.lastIndex = at;
    const m = re.exec(d);
    if (!m) throw new Error(`unexpected "${d.slice(at, at + 10)}"`);
    tokens.push(m[2] ?? Number(m[1]));
  }
  const rings = [];
  let i = 0;
  const number = () => {
    if (typeof tokens[i] !== 'number') throw new Error(`number expected at token ${i}`);
    return tokens[i++];
  };
  while (i < tokens.length) {
    if (tokens[i++] !== 'M') throw new Error('each ring starts with M');
    let x = number();
    let y = number();
    const ring = [[x, y]];
    if (tokens[i++] !== 'l') throw new Error('M is followed by l');
    while (typeof tokens[i] === 'number') {
      x += number();
      y += number();
      ring.push([x, y]);
    }
    if (tokens[i++] !== 'z') throw new Error('each ring ends with z');
    rings.push(ring);
  }
  return rings;
}

test('map size: 1000 units wide, cropped to the land without Antarctica', () => {
  assert.equal(MAP_W, 1000);
  assert.ok(Number.isInteger(MAP_H), `MAP_H ${MAP_H}`);
  // the whole Equal Earth map would be 487 units high; without Antarctica about 140° of latitude are left
  assert.ok(MAP_H > 400 && MAP_H < 470, `MAP_H ${MAP_H}`);
});

test('shapes: the main countries and Kosovo, no Antarctica', () => {
  const codes = Object.keys(PATHS);
  assert.ok(codes.length >= 170, `${codes.length} countries`);
  for (const code of ['IT', 'US', 'CN', 'DE', 'FR', 'GB', 'JP', 'BR', 'IN', 'RU', 'AU', 'CA', 'ZA', 'XK']) {
    assert.ok(PATHS[code], `PATHS.${code}`);
  }
  assert.ok(!('AQ' in PATHS) && !('AQ' in POINTS), 'Antarctica removed');
  for (const code of codes) assert.match(code, /^[A-Z]{2}$/);
});

test('paths: only M, l, z and numbers, closed rings of 3+ points on the canvas', () => {
  const sample = parseRings('M1.5.5l-.5 2 3-1.5z');
  assert.deepEqual(sample, [[[1.5, 0.5], [1, 2.5], [4, 1]]], 'parser reads the compact number syntax');
  for (const [code, d] of Object.entries(PATHS)) {
    assert.match(d, /^(M[-\d. ]+l[-\d. ]+z)+$/, code);
    let rings;
    assert.doesNotThrow(() => (rings = parseRings(d)), code);
    for (const ring of rings) {
      assert.ok(new Set(ring.map(String)).size >= 3, `${code}: ring with fewer than 3 points`);
      for (let i = 0; i < ring.length; i++) {
        assert.ok(inMap(ring[i]), `${code}: point ${ring[i]} off the map`);
        assert.ok(oneDecimal(ring[i][0]) && oneDecimal(ring[i][1]), `${code}: ${ring[i]} has more than one decimal`);
        // An edge across the map is a polygon not cut at the antimeridian (Russia, Fiji)
        const next = ring[(i + 1) % ring.length];
        assert.ok(Math.abs(next[0] - ring[i][0]) < 100, `${code}: edge from ${ring[i]} to ${next} streaks across the map`);
      }
    }
  }
});

test('boxes: one per shape, on the map, main landmass only', () => {
  assert.deepEqual(Object.keys(BOXES).sort(), Object.keys(PATHS).sort());
  for (const [code, [x0, y0, x1, y1]] of Object.entries(BOXES)) {
    assert.ok(inMap([x0, y0], 1) && inMap([x1, y1], 1), `${code}: ${BOXES[code]} off the map`);
    assert.ok(x0 < x1 && y0 < y1, `${code}: empty box ${BOXES[code]}`);
  }
  // France without French Guiana: its box stays in Europe
  const [x0, , x1] = BOXES.FR;
  assert.ok(x1 - x0 < 80, `FR box ${BOXES.FR}`);
  // Russia without the piece of Chukotka beyond 180°: the box does not start at the left edge
  assert.ok(BOXES.RU[0] > MAP_W / 2, `RU box ${BOXES.RU}`);
});

test('every shape has a name, a continent, a box and a point', () => {
  for (const code of Object.keys(PATHS)) {
    assert.ok(typeof NAMES[code] === 'string' && NAMES[code].length > 1, `NAMES.${code}`);
    assert.ok(CONTINENTS.includes(CONTINENT[code]), `CONTINENT.${code} = ${CONTINENT[code]}`);
    assert.ok(BOXES[code], `BOXES.${code}`);
    assert.ok(POINTS[code], `POINTS.${code}`);
  }
});

test('names: Italian common names for every country, plus the euro area', () => {
  assert.equal(NAMES.IT, 'Italia');
  assert.equal(NAMES.US, 'Stati Uniti');
  assert.equal(NAMES.GB, 'Regno Unito');
  assert.equal(NAMES.KR, 'Corea del Sud');
  assert.equal(NAMES.CN, 'Cina');
  assert.equal(NAMES.XK, 'Kosovo');
  assert.equal(NAMES.EU, 'Area euro');
  assert.deepEqual(Object.keys(NAMES).sort(), [...Object.keys(POINTS), 'EU'].sort(), 'a name for every country');
  for (const [code, name] of Object.entries(NAMES)) assert.match(name, /^\p{Lu}/u, `NAMES.${code} = ${name}`);
});

test('continents: five keys, fixed choices for transcontinental countries', () => {
  assert.equal(CONTINENT.IT, 'europe');
  assert.equal(CONTINENT.BR, 'americas');
  assert.equal(CONTINENT.JP, 'asia');
  assert.equal(CONTINENT.EU, 'europe');
  for (const code of ['RU', 'TR', 'CY']) assert.equal(CONTINENT[code], 'europe', code);
  for (const code of ['GE', 'AM', 'AZ']) assert.equal(CONTINENT[code], 'asia', code);
  assert.equal(CONTINENT.GL, 'americas');
  assert.deepEqual(Object.keys(CONTINENT).sort(), Object.keys(NAMES).sort());
  for (const [code, c] of Object.entries(CONTINENT)) assert.ok(CONTINENTS.includes(c), `CONTINENT.${code} = ${c}`);
});

test('points: every country, the ones too small for a shape too, on the map', () => {
  for (const code of ['SG', 'HK', 'MT', 'BH', 'IT']) assert.ok(POINTS[code], `POINTS.${code}`);
  for (const [code, p] of Object.entries(POINTS)) {
    assert.equal(p.length, 2, code);
    assert.ok(p.every(oneDecimal), `${code}: ${p}`);
    assert.ok(inMap(p), `${code}: ${p} off the map`);
  }
});

test('views: whole map plus five regions inside it, ratio 0.85–2.2', () => {
  assert.deepEqual(Object.keys(VIEWS).sort(), ['africa', 'americas', 'asia', 'europe', 'oceania', 'world']);
  assert.deepEqual(VIEWS.world, [0, 0, MAP_W, MAP_H]);
  const has = (view, code) => {
    const [x, y, w, h] = VIEWS[view];
    const [x0, y0, x1, y1] = BOXES[code];
    return x0 >= x && y0 >= y && x1 <= x + w && y1 <= y + h;
  };
  for (const [key, [x, y, w, h]] of Object.entries(VIEWS)) {
    if (key === 'world') continue;
    assert.ok(x >= 0 && y >= 0 && x + w <= MAP_W + EPS && y + h <= MAP_H + EPS, `${key}: ${VIEWS[key]} off the map`);
    assert.ok(w / h >= 0.85 && w / h <= 2.2, `${key}: ratio ${w / h}`);
  }
  for (const [view, codes] of Object.entries({ europe: ['IT', 'DE', 'FR', 'ES', 'GB'], americas: ['US', 'BR', 'AR'], asia: ['CN', 'IN', 'JP'], africa: ['ZA', 'EG', 'NG'], oceania: ['AU', 'NZ'] })) {
    for (const code of codes) assert.ok(has(view, code), `${view} view shows ${code}`);
  }
});
