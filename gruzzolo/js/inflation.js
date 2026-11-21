// Inflation and real returns. Pure functions over the monthly consumer price index (HICP, Eurostat,
// 2025 = 100) that /api/eco/inflation sends: { start: '1996-01', series: { IT: [..], EA: [..] } }.
//
// The price level at the start of a period is the index of the month BEFORE its first day (a year from
// 1 January to 31 December goes from December to December, like the official yearly inflation); at the
// end it is the index of the month of its last day, or the latest month published when that is not out yet.

// 'YYYY-MM' plus n months
export function addMonth(ym, n) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}
const monthIndex = (start, ym) => (Number(ym.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(ym.slice(5, 7)) - Number(start.slice(5, 7));

// Index value of a month (null when missing); `latest` caps it at the last month published
function valueAt(data, geo, ym, { latest = false } = {}) {
  const s = data && data.series ? data.series[geo] : null;
  if (!Array.isArray(s) || !data.start) return null;
  let i = monthIndex(data.start, ym);
  if (latest) {
    let last = s.length - 1;
    while (last >= 0 && !(s[last] > 0)) last--;
    if (i > last) i = last;
  }
  return i >= 0 && i < s.length && s[i] > 0 ? { v: s[i], ym: addMonth(data.start, i) } : null;
}

// Last month published for a geo
export function lastMonth(data, geo = 'IT') {
  const s = data && data.series ? data.series[geo] : null;
  if (!Array.isArray(s)) return null;
  for (let i = s.length - 1; i >= 0; i--) if (s[i] > 0) return addMonth(data.start, i);
  return null;
}

// Inflation between two dates ('YYYY-MM-DD'): { rate, fromMonth, toMonth, partial } or null.
// partial: the period ends after the last month published (the rate stops at that month).
export function inflationBetween(data, from, to, geo = 'IT') {
  if (!from || !to || to < from) return null;
  const a = valueAt(data, geo, addMonth(from.slice(0, 7), -1));
  const b = valueAt(data, geo, to.slice(0, 7), { latest: true });
  if (!a || !b || b.ym < a.ym) return null;
  return { rate: b.v / a.v - 1, fromMonth: a.ym, toMonth: b.ym, partial: b.ym < to.slice(0, 7) };
}

// Return net of inflation: (1 + nominal) / (1 + inflation) − 1
export const realReturn = (nominal, inflation) => (Number.isFinite(nominal) && Number.isFinite(inflation) && inflation > -1 ? (1 + nominal) / (1 + inflation) - 1 : null);

// A rate over `days` days as a yearly rate
export const annualize = (rate, days) => (Number.isFinite(rate) && days > 0 && rate > -1 ? (1 + rate) ** (365 / days) - 1 : null);

// Yearly inflation of the last 12 months published: { rate, month } or null
export function yearOnYear(data, geo = 'IT') {
  const last = lastMonth(data, geo);
  if (!last) return null;
  const a = valueAt(data, geo, addMonth(last, -12));
  const b = valueAt(data, geo, last);
  return a && b ? { rate: b.v / a.v - 1, month: last } : null;
}
