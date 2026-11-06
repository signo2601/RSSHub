// Squarified treemap (Bruls, Huizing, van Wijk 2000): rectangles whose areas are proportional to
// the values and as close to squares as possible. Pure functions, used by the Mercati heatmap.

// Worst aspect ratio of a row of areas (sum, min, max) laid along a side of length `side`
function worst(sum, min, max, side) {
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

// Lay out items with value > 0 in the rectangle { x, y, w, h }. Largest first, each row along the
// shorter side of the space left. Returns [{ item, x, y, w, h }] from the largest to the smallest.
export function squarify(items, rect, valueOf = (d) => d.value) {
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, v: Number(valueOf(item)) }))
    .filter((d) => Number.isFinite(d.v) && d.v > 0)
    .sort((a, b) => b.v - a.v);
  const out = [];
  let { x, y, w, h } = rect || {};
  if (!list.length || !(w > 0) || !(h > 0)) return out;
  const total = list.reduce((s, d) => s + d.v, 0);
  const scale = (w * h) / total;
  for (const d of list) d.a = d.v * scale;

  let i = 0;
  while (i < list.length) {
    const side = Math.min(w, h);
    let sum = list[i].a;
    let min = sum;
    let max = sum;
    let j = i + 1;
    // Add items to the row while the worst aspect ratio does not get worse
    while (j < list.length) {
      const a = list[j].a;
      const nSum = sum + a;
      if (worst(nSum, Math.min(min, a), Math.max(max, a), side) > worst(sum, min, max, side)) break;
      sum = nSum;
      min = Math.min(min, a);
      max = Math.max(max, a);
      j++;
    }
    const last = j >= list.length;
    if (w >= h) {
      // Column on the left, as tall as the space left
      const cw = last ? w : Math.min(w, sum / h);
      let cy = y;
      for (let k = i; k < j; k++) {
        const ch = k === j - 1 ? y + h - cy : list[k].a / cw;
        out.push({ item: list[k].item, x, y: cy, w: cw, h: ch });
        cy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      // Row on top, as wide as the space left
      const rh = last ? h : Math.min(h, sum / w);
      let cx = x;
      for (let k = i; k < j; k++) {
        const cw = k === j - 1 ? x + w - cx : list[k].a / rh;
        out.push({ item: list[k].item, x: cx, y, w: cw, h: rh });
        cx += cw;
      }
      y += rh;
      h -= rh;
    }
    i = j;
  }
  return out;
}

// Two-level layout: groups (e.g. sectors) first, then their children inside each group rectangle.
// groups: [{ key, items: [...] }], value(item) → number; a group rectangle at least minHeaderW × minHeaderH (px) keeps a
// header band of `header` px for its name. Returns [{ key, x, y, w, h, header, tiles: [{ item, x, y, w, h }] }].
export function nestedTreemap(groups, rect, { value = (d) => d.value, header = 18, minHeaderW = 64, minHeaderH = 52, gap = 2 } = {}) {
  const sized = (Array.isArray(groups) ? groups : [])
    .map((g) => ({ ...g, total: (g.items || []).reduce((s, d) => s + Math.max(0, Number(value(d)) || 0), 0) }))
    .filter((g) => g.total > 0);
  return squarify(sized, rect, (g) => g.total).map(({ item: g, x, y, w, h }) => {
    // Groups are separated by `gap` px: shrink the right and bottom edges unless they touch the border
    const gw = x + w < rect.x + rect.w - 0.5 ? Math.max(0, w - gap) : w;
    const gh = y + h < rect.y + rect.h - 0.5 ? Math.max(0, h - gap) : h;
    const hasHeader = gw >= minHeaderW && gh >= minHeaderH;
    const top = hasHeader ? header : 0;
    const tiles = squarify(g.items, { x, y: y + top, w: gw, h: Math.max(0, gh - top) }, value);
    return { key: g.key, x, y, w: gw, h: gh, header: top, tiles };
  });
}
