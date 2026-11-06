// Generate js/world.js, the world map of the "Macro" page in the Mercati tab.
//
//   node dev/build-world.mjs   → rewrites js/world.js
//
// Downloads two pinned public datasets, here only (the app never fetches them):
//   world-atlas 2.0.2       Natural Earth 1:110m country shapes as TopoJSON (public domain)
//   world-countries 5.1.0   ISO 3166-1 codes, Italian names, regions, label points (ODbL 1.0)
// projects the shapes with Equal Earth (1000 units wide, y down, Antarctica removed, canvas cropped
// to the land actually drawn) and writes one compact SVG path per country plus lookup tables.
// The output depends only on the two pinned files: running the script again rewrites the same bytes.
// Behind an HTTPS proxy Node's fetch only uses it with NODE_USE_ENV_PROXY=1: when HTTPS_PROXY is
// set the script restarts itself with it, like dev/server.mjs.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = path.join(ROOT, 'js', 'world.js');
const ATLAS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
const COUNTRIES_URL = 'https://cdn.jsdelivr.net/npm/world-countries@5.1.0/countries.json';

const MAP_W = 1000;
const MARGIN = 1; // map units left free above the northernmost and below the southernmost land
const STEP = 10; // coordinates are rounded to 1/STEP of a map unit: one decimal
const MAIN_SHARE = 0.15; // BOXES: polygons with at least this share of the country's largest one
const VIEW_PAD = 0.02; // region views: margin on each side, share of the width / height
const VIEW_RATIO = [0.85, 2.2]; // region views: allowed width / height (the Americas and Africa are taller than wide)
const VIEW_RANGES = {
  europe: [[-25, 45], [34, 71]],
  americas: [[-170, -30], [-56, 72]],
  asia: [[25, 150], [-11, 56]],
  africa: [[-20, 55], [-36, 38]],
  oceania: [[110, 180], [-48, 0]],
};
// Antarctica: no economy to show, and a wide empty band at the bottom of the map. Left out of every table.
const DROPPED = new Set(['AQ']);
// world-atlas features without an ISO numeric id: Kosovo has its own (user-assigned) code, the
// other two are drawn as part of the internationally recognised country
const CODE_BY_NAME = { Kosovo: 'XK', 'N. Cyprus': 'CY', Somaliland: 'SO' };
// Polygons drawn with another country than in Natural Earth's de facto view, found by a lon/lat
// point inside them: Crimea goes with Ukraine, as recognised by Italy and the UN General Assembly
// (the same rule as N. Cyprus and Somaliland above)
const MOVED_POLYGONS = [{ name: 'Crimea', from: 'RU', to: 'UA', at: [34.2, 45.3] }];
// Italian names: the dataset's translations.ita.common, except these short familiar forms
// (and a few fixes: wrong name for BL, lowercase OM, former name for SZ)
const NAME_FIXES = {
  AX: 'Isole Åland',
  AZ: 'Azerbaigian',
  BL: 'Saint-Barthélemy',
  CD: 'RD del Congo',
  CZ: 'Repubblica Ceca',
  FK: 'Isole Falkland',
  FO: 'Isole Fær Øer',
  GP: 'Guadalupa',
  GS: 'Georgia del Sud',
  IO: "Territorio britannico dell'Oceano Indiano",
  JE: 'Jersey',
  MM: 'Myanmar',
  OM: 'Oman',
  SH: "Sant'Elena",
  SS: 'Sudan del Sud',
  SZ: 'Eswatini',
  TH: 'Thailandia',
  UM: 'Isole minori degli Stati Uniti',
  US: 'Stati Uniti',
  ZA: 'Sudafrica',
};
const EXTRA_NAMES = { EU: 'Area euro' };
const CONTINENT_BY_REGION = { Europe: 'europe', Americas: 'americas', Asia: 'asia', Africa: 'africa', Oceania: 'oceania' };
// Continents: the dataset `region`, except the transcontinental countries (fixed here so that a new
// dataset version cannot move them), the US Pacific islands, and the dataset's "Antarctic" region
// (territories other than Antarctica, placed as in the UN M49 scheme)
const CONTINENT_FIXES = {
  RU: 'europe',
  TR: 'europe',
  CY: 'europe',
  GE: 'asia',
  AM: 'asia',
  AZ: 'asia',
  GL: 'americas',
  UM: 'oceania',
  BV: 'americas',
  GS: 'americas',
  HM: 'oceania',
  TF: 'africa',
};
const EXTRA_CONTINENTS = { EU: 'europe' };

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function getJSON(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  } catch (err) {
    fail(`Download non riuscito: ${url} (${err.cause?.message || err.message})`);
  }
  if (!res.ok) fail(`Download non riuscito: ${url} (HTTP ${res.status})`);
  return res.json();
}

/* ---------- Equal Earth projection (Šavrič, Patterson, Jenny 2018) ---------- */
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const RAD = Math.PI / 180;

// lon/lat in degrees → [x, y] on the unit sphere, y up
function equalEarth(lon, lat) {
  const theta = Math.asin(M * Math.sin(lat * RAD));
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return [
    (lon * RAD * Math.cos(theta)) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2))),
    theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)),
  ];
}
// lon −180..180 at the equator spans exactly MAP_W
const SCALE = MAP_W / (2 * equalEarth(180, 0)[0]);

/* ---------- TopoJSON ---------- */
// Arcs as absolute quantized coordinates (the file stores them delta-encoded)
function decodeArcs(topology) {
  return topology.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => [(x += dx), (y += dy)]);
  });
}

// A negative index ~i means arc i walked backwards
const arcPoints = (arcs, i) => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
const arcId = (i) => (i < 0 ? ~i : i);
const pointKey = ([x, y]) => `${x},${y}`;

// Ring of arc indexes → closed ring of points (consecutive arcs share their end point)
function ringPoints(arcs, ring) {
  const points = [];
  for (const i of ring) points.push(...arcPoints(arcs, i).slice(points.length ? 1 : 0));
  return points;
}

// Even-odd rule: is [x, y] inside the closed ring?
function insideRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Outline of the union of polygons of several features: an arc used twice is a border between
// two of them (Cyprus / N. Cyprus, Somalia / Somaliland) and goes away, the others are chained end
// to start into rings. Polygons and result are rings of arc indexes.
function dissolve(arcs, polygons) {
  const all = polygons.flat(2);
  const uses = new Map();
  for (const i of all) uses.set(arcId(i), (uses.get(arcId(i)) || 0) + 1);
  const open = all.filter((i) => uses.get(arcId(i)) === 1);
  const start = (i) => pointKey(arcPoints(arcs, i)[0]);
  const end = (i) => pointKey(arcPoints(arcs, i).at(-1));
  const rings = [];
  while (open.length) {
    const ring = [open.shift()];
    while (end(ring.at(-1)) !== start(ring[0])) {
      const next = open.findIndex((i) => start(i) === end(ring.at(-1)));
      if (next < 0) throw new Error('dissolve: an outline does not close');
      ring.push(...open.splice(next, 1));
    }
    rings.push(ring);
  }
  return rings;
}

/* ---------- Antimeridian ---------- */
// world-atlas joins the polygons that cross the antimeridian (Fiji, Chukotka) for spherical
// renderers. A flat map must cut them again at ±180°, or their edges streak across the whole map.
// Closed ring of [lon, lat] → closed rings, each within −180..180.
function cutAntimeridian(ring) {
  const jumps = (p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180;
  if (!ring.some(jumps)) return [ring];
  // Continuous longitudes: the ring runs past ±180° instead of jumping across the map
  let shift = 0;
  const unwrapped = ring.map((p, i) => {
    if (i > 0) {
      const d = p[0] - ring[i - 1][0];
      if (d > 180) shift -= 360;
      else if (d < -180) shift += 360;
    }
    return [p[0] + shift, p[1]];
  });
  if (shift !== 0) throw new Error('A ring goes around a pole: not supported');
  return [
    clipLon(clipLon(unwrapped, -180, 1), 180, -1),
    clipLon(unwrapped, 180, 1).map(([lon, lat]) => [lon - 360, lat]),
    clipLon(unwrapped, -180, -1).map(([lon, lat]) => [lon + 360, lat]),
  ].filter((r) => r.length >= 4);
}

// Sutherland–Hodgman: the part of a closed ring east (side 1) or west (side −1) of a meridian.
// Enough here: each ring crosses the antimeridian exactly twice, so each side is one piece.
function clipLon(ring, lon, side) {
  const inside = (p) => (p[0] - lon) * side >= 0;
  const out = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) out.push([lon, a[1] + ((lon - a[0]) / (b[0] - a[0])) * (b[1] - a[1])]);
  }
  if (out.length) out.push(out[0]);
  return out;
}

/* ---------- Grid rings and path encoding ---------- */
// Shoelace formula, twice the signed area
function ringArea2(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}

// Ring in map units → open ring on the STEP grid (integers), without repeated points; null when it
// collapses to fewer than 3 distinct points or to no area
function gridRing(points) {
  const out = [];
  for (const [x, y] of points) {
    const p = [Math.round(x * STEP), Math.round(y * STEP)];
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && pointKey(out[0]) === pointKey(out.at(-1))) out.pop();
  if (new Set(out.map(pointKey)).size < 3 || ringArea2(out) === 0) return null;
  return out;
}

// Grid value → shortest SVG number: 125 → '12.5', 5 → '.5', -5 → '-.5', 30 → '3'
function svgNumber(v) {
  const a = Math.abs(v);
  const int = Math.floor(a / STEP);
  const frac = a % STEP;
  return (v < 0 ? '-' : '') + (frac ? `${int || ''}.${frac}` : `${int}`);
}

// Numbers with the fewest separators the SVG path grammar allows: a '-' always starts a new
// number, and so does a '.' after a number that already has one ('1.5.5' reads as 1.5 and .5)
function joinNumbers(values) {
  let out = '';
  let prev = '';
  for (const v of values) {
    const s = svgNumber(v);
    if (prev && s[0] !== '-' && !(s[0] === '.' && prev.includes('.'))) out += ' ';
    out += s;
    prev = s;
  }
  return out;
}

// Absolute M to the first point, relative l to the next ones (implicit after the first pair), z
function ringPath(ring) {
  const deltas = [];
  for (let i = 1; i < ring.length; i++) deltas.push(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
  return `M${joinNumbers(ring[0])}l${joinNumbers(deltas)}z`;
}

function ringBox(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Distance between two boxes, 0 when they overlap
function boxGap(a, b) {
  return Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
}

// [x0, y0, x1, y1] of the country's main landmass(es): the polygons with at least MAIN_SHARE of the
// area of the largest one and no farther from it than its size. The area keeps out small islands
// (Hawaii, Corsica), the distance far away parts as big as French Guiana (15.7% of France here).
// Holes (Lesotho in South Africa) lie inside their polygon, so they never widen the box.
function mainBox(rings) {
  const parts = rings.map((ring) => ({ area: Math.abs(ringArea2(ring)), box: ringBox(ring) }));
  const largest = parts.reduce((a, b) => (b.area > a.area ? b : a));
  const size = Math.max(largest.box[2] - largest.box[0], largest.box[3] - largest.box[1]);
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    if (part.area < MAIN_SHARE * largest.area || boxGap(part.box, largest.box) > size) continue;
    box[0] = Math.min(box[0], part.box[0]);
    box[1] = Math.min(box[1], part.box[1]);
    box[2] = Math.max(box[2], part.box[2]);
    box[3] = Math.max(box[3], part.box[3]);
  }
  return box.map((v) => v / STEP);
}

const round1 = (v) => Math.round(v * 10) / 10;

/* ---------- Region views ---------- */
// viewBox [x, y, w, h] of a lon/lat range: bounding box of its projected outline, padded, widened or
// heightened into VIEW_RATIO, moved inside the map when the padding runs past an edge
function regionView([lon0, lon1], [lat0, lat1], toMap, mapH) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = ([x, y]) => {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  };
  // Meridians are curved: walk the whole outline, the equator included where it widens the range
  for (let i = 0; i <= 200; i++) {
    const lon = lon0 + ((lon1 - lon0) * i) / 200;
    const lat = lat0 + ((lat1 - lat0) * i) / 200;
    for (const p of [[lon0, lat], [lon1, lat], [lon, lat0], [lon, lat1]]) add(toMap(...p));
  }
  if (lat0 < 0 && lat1 > 0) for (const lon of [lon0, lon1]) add(toMap(lon, 0));
  // Never larger than the map; tenths rounded up, so that the ratio cannot slip out of range
  let w = Math.ceil(Math.min((box[2] - box[0]) * (1 + 2 * VIEW_PAD), MAP_W) * 10) / 10;
  let h = Math.ceil(Math.min((box[3] - box[1]) * (1 + 2 * VIEW_PAD), mapH) * 10) / 10;
  if (w / h < VIEW_RATIO[0]) w = Math.ceil(h * VIEW_RATIO[0] * 10) / 10;
  else if (w / h > VIEW_RATIO[1]) h = Math.ceil((w / VIEW_RATIO[1]) * 10) / 10;
  if (w > MAP_W || h > mapH) throw new Error(`View ${lon0}..${lon1}, ${lat0}..${lat1}: the ratio does not fit the map`);
  const x = Math.min(Math.max(round1((box[0] + box[2] - w) / 2), 0), round1(MAP_W - w));
  const y = Math.min(Math.max(round1((box[1] + box[3] - h) / 2), 0), round1(mapH - h));
  return [x, y, w, h];
}

/* ---------- Output ---------- */
const quote = (s) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const list = (values) => `[${values.join(', ')}]`;
function objectSource(obj, format) {
  const lines = Object.keys(obj)
    .sort()
    .map((k) => `  ${k}: ${format(obj[k])},`);
  return `{\n${lines.join('\n')}\n}`;
}

async function main() {
  const [topology, countries] = await Promise.all([getJSON(ATLAS_URL), getJSON(COUNTRIES_URL)]);
  const byNumeric = new Map(countries.filter((c) => c.ccn3).map((c) => [c.ccn3, c.cca2]));
  const known = new Set(countries.map((c) => c.cca2));
  const arcs = decodeArcs(topology);
  const [sx, sy] = topology.transform.scale;
  const [tx, ty] = topology.transform.translate;

  // Polygons (rings of arc indexes) of every feature, grouped by alpha-2 code
  const groups = new Map();
  const skipped = [];
  for (const g of topology.objects.countries.geometries) {
    const name = g.properties?.name || '?';
    const code = g.id ? byNumeric.get(g.id) : CODE_BY_NAME[name];
    if (!code || !known.has(code)) {
      skipped.push(`${name} (${g.id ? `id ${g.id} non nel dataset` : 'senza codice'})`);
      continue;
    }
    if (DROPPED.has(code)) continue;
    const polygons = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : [];
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push(polygons);
  }
  if (skipped.length) console.warn(`⚠ Forme senza paese, scartate: ${skipped.join(', ')}`);
  const toLonLat = ([x, y]) => [x * sx + tx, y * sy + ty];
  for (const { name, from, to, at } of MOVED_POLYGONS) {
    const found = [];
    for (const feature of groups.get(from) || []) {
      feature.forEach((polygon, i) => {
        if (insideRing(at, ringPoints(arcs, polygon[0]).map(toLonLat))) found.push([feature, i]);
      });
    }
    if (found.length !== 1) fail(`${name}: attesa una sola forma di ${from} in ${at}, trovate ${found.length}`);
    const [feature, i] = found[0];
    if (!groups.has(to)) groups.set(to, []);
    groups.get(to).push(feature.splice(i, 1));
  }

  // Projected rings (y up, unscaled) of every country
  const projected = new Map();
  let yTop = -Infinity;
  let yBottom = Infinity;
  for (const [code, features] of groups) {
    const rings = features.length > 1 ? dissolve(arcs, features.flat()) : features.flat(2);
    const out = [];
    for (const ring of rings) {
      for (const piece of cutAntimeridian(ringPoints(arcs, ring).map(toLonLat))) {
        const pts = piece.map(([lon, lat]) => equalEarth(lon, lat));
        for (const [, y] of pts) {
          yTop = Math.max(yTop, y);
          yBottom = Math.min(yBottom, y);
        }
        out.push(pts);
      }
    }
    projected.set(code, out);
  }

  // Map units: x from the left edge, y down from the top, canvas cropped to the land drawn
  const span = (yTop - yBottom) * SCALE;
  const mapH = Math.ceil(span + 2 * MARGIN);
  const top = (mapH - span) / 2;
  const toCanvas = ([x, y]) => [MAP_W / 2 + x * SCALE, top + (yTop - y) * SCALE];
  const toMap = (lon, lat) => toCanvas(equalEarth(lon, lat));

  const paths = {};
  const boxes = {};
  for (const [code, rings] of projected) {
    const grid = rings.map((r) => gridRing(r.map(toCanvas))).filter(Boolean);
    if (!grid.length) {
      console.warn(`⚠ ${code}: forma troppo piccola, resta solo il punto`);
      continue;
    }
    paths[code] = grid.map(ringPath).join('');
    boxes[code] = mainBox(grid);
  }

  const points = {};
  const names = { ...EXTRA_NAMES };
  const continents = { ...EXTRA_CONTINENTS };
  for (const c of countries) {
    const code = c.cca2;
    if (DROPPED.has(code)) continue;
    const [lat, lon] = c.latlng;
    points[code] = toMap(lon, lat).map(round1);
    names[code] = NAME_FIXES[code] || c.translations?.ita?.common || c.name.common;
    continents[code] = CONTINENT_FIXES[code] || CONTINENT_BY_REGION[c.region];
    if (!continents[code]) fail(`${code}: regione "${c.region}" senza continente: aggiungilo a CONTINENT_FIXES`);
  }

  const views = { world: [0, 0, MAP_W, mapH] };
  for (const [key, [lons, lats]] of Object.entries(VIEW_RANGES)) views[key] = regionView(lons, lats, toMap, mapH);

  // Sanity checks: every shape has its tables, everything lies on the canvas
  for (const code of Object.keys(paths)) {
    if (!names[code] || !continents[code] || !points[code]) fail(`${code}: manca nome, continente o punto`);
  }
  for (const [code, [x, y]] of Object.entries(points)) {
    if (x < 0 || x > MAP_W || y < 0 || y > mapH) console.warn(`⚠ ${code}: punto fuori dalla mappa (${x}, ${y})`);
  }

  const source = `// World map for the "Macro" page of the Mercati tab. GENERATED by dev/build-world.mjs from
// world-atlas 2.0.2 (Natural Earth 1:110m, public domain) and world-countries 5.1.0 (mledoze/countries,
// ODbL 1.0, source of NAMES, POINTS and CONTINENT): do not edit by hand. Equal Earth projection,
// ${MAP_W} units wide, Antarctica removed, canvas cropped to the land drawn.
export const MAP_W = ${MAP_W};
export const MAP_H = ${mapH};
// ISO 3166-1 alpha-2 → SVG path data (projected, y down): absolute M, relative l, z per ring,
// one decimal at most. Kosovo is XK; N. Cyprus is part of CY, Somaliland of SO, Crimea of UA.
export const PATHS = ${objectSource(paths, quote)};
// ISO alpha-2 → [x0, y0, x1, y1] bounding box of the country's main landmass(es): union of its polygons
// with at least ${MAIN_SHARE * 100}% of the area of its largest one and no farther from it than its size.
// US: contiguous states and Alaska, no Hawaii; FR: mainland only, no French Guiana or Corsica;
// NO: mainland only, no Svalbard; RU: no Kaliningrad and no Chukotka east of 180°
export const BOXES = ${objectSource(boxes, list)};
// ISO alpha-2 → [x, y] label / marker point (the dataset's latlng, projected) for every country,
// also those too small to have a shape (SG, HK, MT, BH...): the view draws a dot there
export const POINTS = ${objectSource(points, list)};
// ISO alpha-2 → Italian common name for every country, plus EU for the euro area
export const NAMES = ${objectSource(names, quote)};
// ISO alpha-2 → continent key: 'europe' | 'americas' | 'asia' | 'africa' | 'oceania'
// (RU, TR and CY in Europe; GE, AM and AZ in Asia; Greenland in the Americas)
export const CONTINENT = ${objectSource(continents, quote)};
// Map views for the region chips: viewBox [x, y, w, h] in map units (lon/lat range projected,
// padded ${VIEW_PAD * 100}% and widened or heightened to a width / height between ${VIEW_RATIO[0]} and ${VIEW_RATIO[1]})
export const VIEWS = {
${Object.entries(views)
  .map(([k, v]) => `  ${k}: ${k === 'world' ? '[0, 0, MAP_W, MAP_H]' : list(v)},`)
  .join('\n')}
};
`;
  await writeFile(OUT_FILE, source);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const pathBytes = Object.values(paths).reduce((s, p) => s + p.length, 0);
  console.log(`✓ ${path.relative(ROOT, OUT_FILE)}: ${kb(Buffer.byteLength(source))} (percorsi ${kb(pathBytes)})`);
  console.log(`  ${Object.keys(paths).length} paesi con forma, ${Object.keys(points).length} punti, MAP_H = ${mapH}`);
  for (const code of ['US', 'FR', 'NL', 'NO', 'RU']) console.log(`  BOXES.${code} = ${list(boxes[code])}`);
}

// Behind an HTTPS proxy (corporate network, sandbox) Node's fetch only uses it when
// NODE_USE_ENV_PROXY=1 is set at startup: restart once as a child process with it.
const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxied && !process.env.NODE_USE_ENV_PROXY) {
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
} else {
  main().catch((err) => fail(err.stack || err.message));
}
