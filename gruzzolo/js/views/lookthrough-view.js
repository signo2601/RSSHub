// Pieces shared by the look-through card of the Report (sheet-composition.js) and the composition
// block of an ETF's sheet (sheets.js): downloads through eco.js and the rows with bars.
import { eco } from '../eco.js';
import { etfKey, etfPath, validIsin, ETF_MAX_AGE, flagOf } from '../lookthrough.js';
import { esc, money, pct, fmtDate } from '../util.js';

// { data, failed } of an ETF's composition, or null while nothing is known
export function entryOf(isin) {
  const k = etfKey(isin);
  const e = eco.entry(k);
  const f = eco.failure(k);
  if (e) return { data: e.data, failed: f ? f.message : '' };
  if (f && !eco.isLoading(k)) return { data: null, failed: f.message };
  return null;
}

// Download the compositions not downloaded this week (never twice at the same time)
export function ensureEtfs(isins) {
  for (const isin of new Set(isins)) {
    if (validIsin(isin)) eco.load(etfKey(isin), etfPath(isin), { maxAge: ETF_MAX_AGE });
  }
}

// Rows with a bar: [{ label, share, value?, sub?, code?, muted? }] (plain text); bars are relative to the largest row
export function barRows(rows, { showValue = true } = {}) {
  const max = Math.max(...rows.filter((r) => !r.muted).map((r) => r.share), 0.0001);
  return `<div class="lt-list">${rows.map((r) => {
    const flag = r.code ? flagOf(r.code) : '';
    const w = Math.max(1, Math.min(100, (r.share / max) * 100));
    const value = showValue && r.value !== undefined ? money(r.value) : '';
    // without a second line the euros sit next to the percentage
    return `<div class="lt-row${r.muted ? ' muted-row' : ''}">
      <div class="lt-top">${flag ? `<span class="lt-flag" aria-hidden="true">${flag}</span>` : ''}<span class="lt-name">${esc(r.label)}</span>${value && !r.sub ? `<span class="lt-val num">${value}</span>` : ''}<b class="lt-share num">${pct(r.share, r.share < 0.1 ? 1 : 0)}</b></div>
      <div class="lt-bar" aria-hidden="true"><i style="width:${w.toFixed(1)}%"></i></div>
      ${r.sub ? `<div class="lt-meta"><span>${esc(r.sub)}</span>${value ? `<span class="num">${value}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// "Dati justETF al 30 set 2026"
export const sourceLine = (date) => `Dati justETF${date ? ` al ${fmtDate(date)}` : ''}`;
