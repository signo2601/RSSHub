// Squarified treemap: areas proportional to values, rectangles inside the container without
// overlaps, reasonable aspect ratios, nested groups with header bands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { squarify, nestedTreemap } from '../js/treemap.js';

const area = (r) => r.w * r.h;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 1e-6 && h > 1e-6;
}

test('squarify: areas proportional to values and the container exactly filled', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((value, i) => ({ id: i, value }));
  const rect = { x: 10, y: 20, w: 600, h: 400 };
  const out = squarify(items, rect);
  assert.equal(out.length, 7);
  const total = 24;
  for (const r of out) {
    assert.ok(near(area(r), (r.item.value / total) * 600 * 400, 1e-9), `area of ${r.item.id}`);
    assert.ok(r.x >= rect.x - 1e-9 && r.y >= rect.y - 1e-9, 'inside (top-left)');
    assert.ok(r.x + r.w <= rect.x + rect.w + 1e-9 && r.y + r.h <= rect.y + rect.h + 1e-9, 'inside (bottom-right)');
  }
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(!overlap(out[i], out[j]), `${i} overlaps ${j}`);
  assert.ok(near(out.reduce((s, r) => s + area(r), 0), 600 * 400));
  // Largest first
  assert.deepEqual(out.map((r) => r.item.value), [6, 6, 4, 3, 2, 2, 1]);
});

test('squarify: near-square tiles for equal values, no zero or negative values, empty input', () => {
  const eq = squarify(Array.from({ length: 16 }, (_, i) => ({ value: 1, i })), { x: 0, y: 0, w: 400, h: 400 });
  for (const r of eq) assert.ok(Math.max(r.w / r.h, r.h / r.w) < 1.6, `aspect ${r.w}×${r.h}`);
  const mixed = squarify([{ value: 0 }, { value: -3 }, { value: NaN }, { value: 5 }], { x: 0, y: 0, w: 100, h: 50 });
  assert.equal(mixed.length, 1);
  assert.deepEqual([mixed[0].x, mixed[0].y, mixed[0].w, mixed[0].h], [0, 0, 100, 50]);
  assert.deepEqual(squarify([], { x: 0, y: 0, w: 100, h: 100 }), []);
  assert.deepEqual(squarify([{ value: 1 }], { x: 0, y: 0, w: 0, h: 100 }), []);
});

test('squarify: a market-cap-like distribution (500 values) stays inside, without overlaps', () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ value: 4000 / (i + 1) ** 1.1, i }));
  const rect = { x: 0, y: 0, w: 358, h: 470 };
  const out = squarify(items, rect);
  assert.equal(out.length, 500);
  let sum = 0;
  for (const r of out) {
    assert.ok(r.w > 0 && r.h > 0);
    assert.ok(r.x + r.w <= rect.w + 1e-6 && r.y + r.h <= rect.h + 1e-6);
    sum += area(r);
  }
  assert.ok(near(sum, 358 * 470, 1e-6));
  // The 30 largest never overlap each other or the rest
  for (let i = 0; i < 30; i++) for (let j = i + 1; j < out.length; j++) assert.ok(!overlap(out[i], out[j]), `${i}/${j}`);
});

test('nestedTreemap: groups sized by their totals, children inside, header band only when there is room', () => {
  const groups = [
    { key: 'Tech', items: [{ value: 50 }, { value: 30 }, { value: 20 }] },
    { key: 'Finance', items: [{ value: 40 }, { value: 10 }] },
    { key: 'Tiny', items: [{ value: 0.5 }] },
    { key: 'Empty', items: [{ value: 0 }] },
  ];
  const rect = { x: 0, y: 0, w: 360, h: 480 };
  const out = nestedTreemap(groups, rect, { header: 18, gap: 2 });
  assert.deepEqual(out.map((g) => g.key), ['Tech', 'Finance', 'Tiny']);
  const tech = out[0];
  assert.equal(tech.header, 18);
  assert.equal(tech.tiles.length, 3);
  for (const t of tech.tiles) {
    assert.ok(t.y >= tech.y + 18 - 1e-9, 'below the header');
    assert.ok(t.x >= tech.x - 1e-9 && t.x + t.w <= tech.x + tech.w + 1e-9);
    assert.ok(t.y + t.h <= tech.y + tech.h + 1e-9);
  }
  assert.equal(out[2].header, 0, 'a tiny group has no room for its name');
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(!overlap(out[i], out[j]));
});
