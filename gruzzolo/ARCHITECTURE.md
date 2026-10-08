# Gruzzolo v2 — architecture and module contracts

Personal investment tracker. Italian UI, EUR base currency. Runs as a static PWA
(iPhone first, desktop too) plus a tiny server function that proxies Yahoo Finance
(search, prices, dividends, FX) and stores an encrypted sync blob.

This file is the contract between modules. Signatures and shapes here are binding:
if you own a module, implement exactly these exports; if you consume one, use only these.

## Hosting model

- Static files in `gruzzolo/` (no build step). ES modules loaded by `index.html` (`<script type="module" src="js/main.js">`).
- Server: Cloudflare Pages Function `gruzzolo/functions/api/[[path]].js` (same origin → `/api/...`).
  Setting `settings.apiBase` (default `''`) lets the app use another origin (`https://x.workers.dev`), so the function must send CORS headers.
- Without a reachable API (offline, GitHub Pages without proxy, Claude artifact) the app still works: manual prices, demo data, curated catalog.
- Claude artifact build: `dev/build-artifact.mjs` bundles `js/main.js` with esbuild into one inline script + inline CSS. Code must therefore not rely on module-relative `fetch` of JSON files (import data as JS modules instead).

## Files and owners

| File | Purpose |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js`, `css/app.css` | Shell, PWA, base design system (UI shell) |
| `js/util.js` | Dates, formatting, parsing, DOM helpers, icons (FOUNDATION, exists) |
| `js/registry.js` | Global ACTIONS / FORMS / SHEETS registries (FOUNDATION, exists) |
| `js/app.js` | `app` hook object filled by main.js: render, toast, sheets (FOUNDATION, exists) |
| `js/state.js` | State `S`, data model, defaults, migrate, commit, memo (FOUNDATION, exists) |
| `js/engine.js` | Ledger, positions, daily valuation series, events (FOUNDATION, exists) |
| `js/market.js` | Market data cache + API client + refresh (core API exists; network layer to add) |
| `js/catalog.js` | Curated popular securities |
| `functions/api/[[path]].js` | Server: Yahoo proxy + sync KV |
| `dev/server.mjs` | Local dev server: static + `/api` via the same function + in-memory KV |
| `js/metrics.js` | Performance and risk metrics |
| `js/markowitz.js` | Efficient frontier |
| `js/income.js` | Dividends / fixed income analytics |
| `js/costs.js` | Fees, taxes, stamp duty, Italian loss carry-forward ("zaino fiscale"), TER |
| `js/charts.js` | SVG charts with touch/mouse tooltips |
| `js/store.js` | Persistence (localStorage or Claude artifact db) |
| `js/sync.js` | End-to-end encrypted sync via `/api/sync` |
| `js/importer.js` | Broker CSV parsing and mapping (DEGIRO, Scalable Capital, generic) |
| `js/demo.js` | Example portfolio with synthetic market data |
| `js/main.js` | Boot, router, chrome (header, mobile tab bar, desktop sidebar), event delegation, sheets |
| `js/views/home.js` | Tab "Portafoglio" |
| `js/views/market.js` | Tab "Mercati": search, watchlist, popular, asset preview |
| `js/views/sheets.js` | Modal sheets: asset detail, transaction form/detail, confirm |
| `js/views/report.js`, `css/report.css`, `js/info.js` | Tab "Report": controls, navigator, sheet registry, metric explanations |
| `js/views/sheet-summary.js` | Report 1 "Riepilogo" |
| `js/views/sheet-visual.js` | Report 2 "Analisi visiva" |
| `js/views/sheet-composition.js` | Report 3 "Composizione" |
| `js/views/sheet-income.js` | Report 4 "Dividendi & Fixed Income" |
| `js/views/sheet-costs.js` | Report 5 "Costi d'intermediazione" |
| `js/views/sheet-risk.js` | Report 6 "Gestione del rischio" |
| `js/views/more.js`, `css/extra.css` | Tab "Altro": accounts, import, settings, fiscal, sync, server, backup |
| `tests/*.test.mjs` | `node --test gruzzolo/tests` |

Code style: plain modern JS (ES2022), no frameworks, 2-space indent, single quotes, semicolons,
camelCase, English comments, Italian UI copy. Views return HTML strings; every user string goes through `esc()`.

## Conventions

- Dates are `'YYYY-MM-DD'` strings (local calendar). Months are `'YYYY-MM'`.
- Money is EUR `number`. Prices of an asset are in the asset's currency ("local").
- FX rate `fx` = units of currency per 1 EUR (same as Yahoo `EURUSD=X` close). `eur = local / fx`. EUR → 1.
- Yahoo FX symbol for currency `C`: `EUR${C}=X`. Currency `GBp`/`GBX` is normalized by market.js to `GBP` (prices / 100).
- Asset types (`TYPE_KEYS`): `stock, etf, fund, bond, crypto, cash, commodity, realestate, other`.
  Income on a `bond` is a coupon ("Cedola"); on `cash` it is interest.
- Categorical chart colors: `var(--c1)`…`var(--c8)` in fixed order; total portfolio `var(--accent-line)`; benchmark `var(--muted)`.
- Demo data: assets with `priceSource: 'demo'` read the synthetic history stored under `'demo:' + symbol` (also for FX and benchmark),
  so example data never collides with real market data.
- Never use `alert/confirm/prompt` (use `app.askConfirm`). Never `Date.now()` inside pure analytics (pass `today`).

## Data model (`S.data`, version 2)

```js
{
  v: 2,
  updatedAt: 0,                          // ms epoch of last local change (sync)
  settings: {
    started: false,                      // user left demo / created data
    riskFree: 0.02,                      // annual
    benchmark: { symbol: 'VWCE.DE', name: 'Vanguard FTSE All-World UCITS ETF' },
    taxRate: 0.26, govTaxRate: 0.125, stampDuty: 0.002,
    externalPL: {},                      // { '2023': -75 } fiscal P&L realized outside the app
    apiBase: '',                         // '' → same origin
    theme: 'auto',                       // 'auto' | 'light' | 'dark'
  },
  accounts: [{ id, name, broker, cashMode: 'auto' | 'track', demo? }],
  assets: { [id]: { id, name, ticker, symbol, isin, type, currency, exchange, sector, region, ter, priceSource: 'auto' | 'manual' | 'demo', demo? } },
  // ticker: short display code ('VWCE'); symbol: Yahoo symbol ('VWCE.DE'), '' for manual assets; ter: annual fraction (0.0022) or null
  txns: [Txn],
  prices: { [aid]: [[date, price], ...] },   // MANUAL price points only (local currency), sorted
  watch: [{ id, aid?, symbol, ticker, name, currency, price /* manual fallback */, target, note, demo? }],
}
```

`Txn`:

```js
{
  id, acc, date, type,                 // type: buy | sell | div | deposit | withdraw | interest | fee | tax
  aid?,                                // buy, sell, div (required); interest/fee/tax optional
  qty?, price?,                        // buy/sell: price per unit in asset currency
  fx?,                                 // buy/sell: currency units per EUR at trade (omit or 1 for EUR)
  fee?,                                // EUR transaction commission (buy/sell)
  fxFee?,                              // EUR currency-conversion fee (AutoFX) (buy/sell/div)
  tax?,                                // EUR tax withheld (sell: capital gains; div: withholding)
  amount?,                             // EUR, positive: div NET received; deposit; withdraw; interest; fee; tax
  gross?,                              // EUR gross dividend (optional)
  kind?,                               // fee: 'transaction'|'autofx'|'connectivity'|'other'; tax: 'capital'|'income'|'stamp'|'other'
  note?, ref?, src?, demo?             // ref: broker order id; src: import batch id
}
```

Cash ledger of an account (EUR): deposit `+amount`, withdraw `−amount`, buy `−(qty·price/fx + fee + fxFee)`,
sell `+(qty·price/fx − fee − fxFee − tax)`, div `+amount`, interest `+amount`, fee `−amount`, tax `−amount`.

External flows (for TWR, IRR, "Flussi netti"):
- `cashMode: 'track'`: only deposit (inflow) and withdraw (outflow). Cash balance is part of the value.
- `cashMode: 'auto'` (default): cash is always 0; every event's cash delta is an external flow
  (negative delta → inflow of the same size, positive delta → outflow). deposit/withdraw are ignored.

Realized P&L of a sell (average cost, before taxes): `qty·price/fx − fee − fxFee − avgCostEUR·qty`
where avg cost includes buy fees. Taxes are reported separately.

## Foundation API (exists — read the source)

`js/util.js`: `iso, parseISO, todayISO, addDays, addMonths, dayDiff, isWeekend, monthKey, fmtDate, fmtMonth, MONTHS, MONTHS_LONG,
fmt.hide (bool), money, moneySigned, moneyLocal, priceFmt, pct, pctSigned, pctPlain, num, compact, qtyFmt, tone, parseNum, numInput,
esc, newId, clone, sum, mean, stdev, quantile, hashHue, icon(name, attrs), ICONS, contentWidth(), isDesktop(), debounce, epochToISO, fmtTime, saveFile(filename, text, mime)`.

`js/registry.js`: `ACTIONS` (name → `(el, event) => void`), `FORMS` (name → `(form, event) => void`),
`SHEETS` (name → `(args) => ({ title, body, after?, size?: 'wide' })`), `FORM_SHEETS` (Set of sheet names never re-rendered while open),
`INPUTS` (name → `(el, event) => void`, for `data-input` live inputs), `MOUNTS` (array of `() => void` run after every render).

`js/app.js`: `app.render()`, `app.toast(msg)`, `app.pushSheet(name, args)`, `app.popSheet()`, `app.closeSheets()`,
`app.renderSheet()`, `app.askConfirm({ title, text, ok, danger = true, onOk })`, `app.refreshPrices()` — all set by main.js.

`js/state.js`: constants `TYPE_KEYS, TYPE_LABEL, TYPE_PLURAL, SECTORS, REGIONS, CURRENCIES, BROKERS, TX_TYPES, TX_LABEL`;
`S` = `{ data, ver, loaded, sheets: [], ui: {...} }`; `D()`; `blankData()`; `migrate(raw)`; `asset(aid)`; `account(id)`;
`accName(id)`; `accountIds()`; `assetCode(asset)` (display code); `FEE_KINDS`, `TAX_KINDS` (labels); `scopeIds()` (accounts in the current filter); `scopeKey()`; `cached(key, fn)`; `bump()`;
`commit(message?)`; `hasDemo()`; `persistence` hooks; `saveUi()`/`restoreUi()`; `setPrice(aid, date, price)`; `incomeLabel(aid)`.

`S.ui` keys: `tab` ('home'|'report'|'market'|'more'), `scope` ('all' | account id), `range` (home chart: '1S','1M','3M','YTD','1A','3A','MAX'),
`chartMode` ('value'|'perf'), `sort`, `showClosed`, `hide`, `sheet` (report sheet index 0..5), `period` ('1M','3M','6M','1Y','YTD','ALL','CUSTOM'),
`from`, `to` (custom dates or null), `base100` (bool), `logScale` (bool), `allocBy`, `allocSel`, `incomeYear`, `txFilter`, `marketQuery`.

`js/engine.js` (all memoized by data + market version):

```js
historyFor(symbol) → History|null           // real market history, else the demo one ('demo:' + symbol)
assetHistory(asset) → History|null          // history used to price an asset (null for manual assets)
trackedSymbols() → string[]                 // linked assets, watchlist, benchmark, FX pairs to keep fresh
sortTxns(list), fxSeries(ccy) → [[date, rate]]
priceSeries(aid) → [[date, price]]          // merged: market closes, manual points (win), trade prices before market data
priceOn(aid, date) → number|null            // carry forward; null before first point
fxOn(currency, date) → number               // units per EUR; 1 for EUR; carry forward; fallback to trade fx
lastQuote(aid) → { price, date, prev, change, changePct, currency, source } | null   // change vs previous close (local ccy)
txnsFor(accIds|null) → Txn[]                 // sorted by date then type order
getSeries(key) → Series|null                // key: 'all' | accountId; null if no transactions
positions({ accIds = null, date = today }) → Position[]   // open and closed (qty 0) positions as of date
realizedEvents(accIds|null) → [{ date, acc, aid, qty, proceeds, cost, pl, fee, fxFee, tax, txId }]
incomeEvents(accIds|null) → [{ date, acc, aid, kind: 'dividend'|'coupon'|'interest', net, tax, gross, fxFee, txId }]
costEvents(accIds|null) → [{ date, acc, aid, kind: 'transaction'|'autofx'|'connectivity'|'other', amount, txId, ref, desc }]
taxEvents(accIds|null) → [{ date, acc, aid, kind: 'capital'|'income'|'stamp'|'other', amount, txId }]
cashAt(accIds|null, date) → number
qtyAt(accIds|null, aid, date) → number
```

`Series` (calendar days, first transaction date → today):

```js
{
  key, accIds, start, end,
  dates: string[],
  value: Float64Array,      // EUR, positions market value + cash
  cash: Float64Array,       // EUR (0 for auto accounts)
  invested: Float64Array,   // EUR cost basis of open positions (incl. buy fees)
  flowIn: Float64Array,     // EUR external inflows (>= 0)
  flowOut: Float64Array,    // EUR external outflows (>= 0)
  income: Float64Array,     // EUR net dividends + coupons + interest received that day
  ret: Float64Array,        // daily time-weighted return: (value + flowOut) / (prevValue + flowIn) − 1, 0 if denominator <= 0
  byType: { [assetType]: Float64Array },  // market value by asset type; cash balance under 'cash'
  index(date) → number      // index of date in dates (clamped), -1 if before start
}
```

`Position`:

```js
{
  aid, asset, qty, priceLocal, priceDate, currency, fx,
  value,            // EUR
  cost,             // EUR cost basis incl. fees
  costLocal,        // local currency, excl. fees
  avgLocal,         // costLocal / qty
  avgEUR,           // cost / qty
  unreal, unrealPct,
  fxPL,             // unrealized FX component: value − valueLocal × (costEURexFees / costLocal)
  realized, income, fees, taxes,   // since inception up to date
  dayChange, dayChangePct,         // EUR, vs previous close (0 if unknown)
  weight,           // value / Σ value of open positions (cash balances excluded)
  accounts: [accId]
}
```

## market.js (core exists; add network + persistence)

```js
market.version                       // number, bump on any data change
market.apiBase                       // string ('' = same origin)
market.status                        // 'unknown' | 'online' | 'offline'
market.lastRefresh                   // ms or 0
market.getHistory(symbol) → History|null   // synchronous, from memory
market.inject(symbol, history, { persist = false })   // used by demo.js and network layer
market.fxSymbol(ccy) → 'EURUSD=X'
async market.init({ apiBase })       // open IndexedDB 'gruzzolo-market', load all histories into memory, ping /api/health
async market.search(query) → [{ symbol, name, exchange, type, typeDisp, sector, industry }]   // [] when offline
async market.ensureHistory(symbol, { force = false }) → History|null   // 10y daily (+dividends), cached, refetch if > 12h old and force
async market.refresh(symbols, { onProgress }) → { updated: string[], failed: string[] }   // latest quotes appended; also FX for their currencies
async market.lookup(symbol) → { symbol, name, currency, type, exchange, price } | null   // single quote + meta (for adding assets)
market.subscribe(fn)                 // called after data changes (UI re-render)
```

`History`: `{ symbol, currency, name, type, exchange, dates: string[], close: number[], adj: number[], divs: [[date, amountPerShare]], price, prev, time, updatedAt, synthetic? }`
(`adj` = dividend-adjusted close, same length as close; `price/prev/time` = last quote, previous close, quote epoch ms).
Yahoo `quoteType` → type: EQUITY→stock, ETF→etf, MUTUALFUND→fund, CRYPTOCURRENCY→crypto, INDEX→other, CURRENCY→other, FUTURE→commodity.

## Server API (`functions/api/[[path]].js`)

Exports `onRequest(context)` (Cloudflare Pages). Pure `fetch`-based so `dev/server.mjs` can call it with `{ request, env }`.
All responses JSON with `Access-Control-Allow-Origin: *`; OPTIONS preflight handled.

- `GET /api/health` → `{ ok: true, sync: boolean }`
- `GET /api/search?q=` → `{ results: [{ symbol, name, exchange, type, typeDisp, sector, industry }] }`
- `GET /api/chart?symbol=&range=10y&interval=1d` → `{ symbol, currency, name, type, exchange, price, prev, time, dates, close, adj, divs }`
- `GET /api/quotes?symbols=A,B,C` (≤ 50) → `{ quotes: { [symbol]: { currency, price, prev, time, dates, close, adj, divs } } }` (last ~5 days)
- `GET /api/sync/:id` → `{ updatedAt, iv, ct }` or 404; `PUT /api/sync/:id` body same → `{ ok: true }`; 501 if no KV binding `GRUZZOLO_KV`. `:id` = 64 hex chars; body ≤ 4 MB.

Yahoo endpoints: `https://query1.finance.yahoo.com/v1/finance/search`, `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=&interval=&events=div,split&includeAdjustedClose=true`
(fallback host `query2`), browser-like `User-Agent`. Edge cache (Cache API when present): search 1h, chart 10y 12h, quotes 60s.

## Analytics modules (pure functions; no DOM, no `Date.now()`)

### metrics.js

```js
periodBounds(series, from, to) → { i0, i1, startValue }      // i0 = first index inside period, startValue = value[i0-1] or 0
periodStats(series, from, to, { rf, benchRet? }) → {
  from, to, days, startValue, endValue, netFlows, inflows, outflows, income,
  twr, cagr, irr, vol, sharpe, sortino, maxDD, maxDDFrom, maxDDTo, activeVsBench, benchTwr, positiveShare
}
cumulative(dates, ret, from, to) → { dates, cum }             // cum[k] = Π(1+r) − 1 within period (first point 0)
drawdowns(cum) → number[]                                    // (1+cum)/runningMax(1+cum) − 1
monthlyReturns(dates, ret, from, to) → [{ month, r }]
businessDays(dates, ret) → { dates, ret }                    // weekends compounded into next weekday
rollingVol(dates, ret, window = 60) → { dates, vol }          // annualized √252, on business days, null until window filled
benchReturns(history, fxHistory|null, dates) → Float64Array   // daily total return of benchmark (adj close, EUR) aligned to calendar dates
xirr(flows: [{ date, amount }]) → number|null                 // amount < 0 investor pays, > 0 investor receives
annualize(twr, days) → number
regression(rp, rb, rf) → { beta, alpha, corr, te }           // daily arrays same length; alpha/te annualized
riskStats(ret, { rf, benchRet? }) → { annReturn, vol, maxDD, sharpe, sortino, var95, cvar95, gainLoss, positiveShare, beta, alpha, corr, te, n }
backProjected(positions, { years = 5, today }) → { dates, ret, bench?, weights: [{ aid, symbol, weight }], start, missing: [aid] }
  // constant current weights applied to each asset's daily EUR total-return history (market.getHistory adj + FX)
```

### markowitz.js

```js
frontier(input: { names: string[], returns: number[][] /* T×N weekly */, rf, periodsPerYear = 52, minW = 0.001, maxW = 0.2, points = 30, current?: number[] }) → {
  mu: number[], cov: number[][], shrinkage,                 // annualized, Ledoit–Wolf shrunk covariance
  frontier: [{ ret, vol, sharpe, weights }],
  minVar: {...}, maxSharpe: {...}, current: {...}|null,
  assets: [{ name, ret, vol }], maxWUsed
}
weeklyReturns(histories, fxHistories, { years = 10 }) → { dates, names, returns, missing }
frontierCsv(result) → string                               // ; separated, Italian decimals
```

### income.js

```js
incomeStats({ accIds, from, to, today }) → {
  total, dividends, coupons, interest, taxes,
  yield12m,                       // trailing 12m income / current value
  yieldPeriod,                    // income / average value, annualized
  priceReturn, incomeReturn,      // decomposition of period TWR
  forecast12m, forecastByAsset: [{ aid, amount, perShare, frequency }],
  byCurrency: [{ key, label, value }], bondByCurrency: [{ key, label, value }],
  calendar: (year) → [{ month: 0..11, items: [{ date, aid, amount, kind, forecast: bool }] }],
  cumulative: { dates, dividends, coupons },
  frequency: { label, byAsset: [{ aid, label, count }] },
  missing: [{ aid, date, perShare, qty, gross, net }]       // market dividends not yet recorded (suggestions)
}
```

### costs.js

```js
costStats({ accIds, from, to, today, settings }) → {
  transaction, autofx, connectivity, other, totalBroker,
  breakdown: [{ key, label, amount, share }],
  monthly: [{ month, broker, incomeTaxes, total }],
  events: [{ date, acc, kind, label, desc, ref, amount }],
  capitalTaxes, incomeTaxes, stampDuty: { amount, base, refDate, recorded }, totalTaxesPrevYear,
  ter: { end, average, coverage, annualCost, series: { dates, ter } }
}
fiscalBackpack({ accIds, today, settings }) → {
  rows: [{ year, portfolio, external, net, status: 'scaduta'|'compensata'|'anno positivo'|'usabile entro YYYY'|'in corso', expires, remaining }],
  available, potentialSaving, expired, notes: [string]
}
```

## charts.js

All functions return an HTML string (a `.chart` wrapper containing an `<svg>` and a legend) and register tooltip data under `id`.
`initCharts()` installs delegated pointer listeners once (crosshair + tooltip on lines, per-mark tooltip on bars/points; touch: drag to scrub).

```js
lineChart(id, { dates, series: [{ name, color, values, width?, dash?, area? }], w, h = 220, yFormat, log = false, zero = false, legend, tooltipValue?, ariaLabel })
barChart(id, { labels, series: [{ name, color, values }], w, h = 220, yFormat, legend, ariaLabel })   // grouped, negatives below zero line
stackedArea(id, { dates, series: [{ name, color, values }], w, h = 220, percent = true, legend, ariaLabel })
donutChart(id, { items: [{ key, label, value, color }], size = 200, centerValue, centerLabel, selected, actKey, ariaLabel })
scatterChart(id, { points: [{ x, y, label, color, r = 5 }], lines: [{ name, color, points: [{ x, y }], dash? }], w, h = 300, xFormat, yFormat, xLabel, yLabel, legend, ariaLabel })
sparkline(values, { w = 80, h = 28, color })
chartScrubHandlers(id, { onScrub(i), onEnd() })   // optional hooks, e.g. home hero update
```

## UI structure

- Mobile (< 900px): sticky header (brand, scope picker, privacy eye, refresh), bottom tab bar
  `Portafoglio | Report | (+) | Mercati | Altro`. Sheets are bottom sheets.
- Desktop (≥ 900px): left sidebar with the same destinations and a primary "Nuova transazione" button; content max 1240px;
  KPI grids 4 columns; chart grids 2 columns; sheets are centered dialogs.
- iPhone: `viewport-fit=cover`, safe-area insets on header/tab bar, inputs ≥ 16px, touch targets ≥ 44px, no hover-only affordances,
  `apple-mobile-web-app-capable`, icons, standalone display.

Shared CSS classes (defined in `css/app.css`): `.page`, `.page-head`, `.page-title`, `.eyebrow`, `.card`, `.card-head`, `.card-title`,
`.kpi-grid`, `.kpi`, `.kpi.wide`, `.kpi.hero`, `.kpi-label`, `.kpi-value`, `.kpi-sub`, `.badge.up|down|flat`, `.info-btn`,
`.chart-grid`, `.chart-card`, `.table-wrap`, `.table`, `.chips`, `.chip[aria-pressed]`, `.seg`, `.btn`, `.btn.primary|danger|sm|block`,
`.list`, `.row`, `.row-main`, `.row-title`, `.row-sub`, `.row-end`, `.row-value`, `.avatar`, `.pill.up|down|flat`, `.delta`, `.empty`,
`.banner`, `.toolbar`, `.field`, `.grid2`, `.form`, `.form-error`, `.muted`, `.up`, `.down`, `.num`, `.sr-only`, `.stack`, `.cluster`.
Design tokens: see `:root` in `css/app.css` (`--bg --surface --surface-2 --line --grid --ink --ink-2 --muted --accent --accent-ink
--accent-line --accent-soft --up --up-soft --down --down-soft --c1..--c8 --c-other --font-ui --font-display --radius`).

Metric explanations live in `js/info.js` as `INFO[key] = { title, text }`; any `.info-btn[data-act="info"][data-key]` opens them.
Report sheets register with `registerSheet({ id, order, title, subtitle, render(ctx) })` from `js/views/report.js`.

Report `ctx`:

```js
{ accIds, scopeKey, from, to, today, rf, settings,
  bench: { symbol, name, history|null, ret: Float64Array|null },   // ret aligned to series.dates
  base100, logScale, series /* total Series */, accSeries: { [accId]: Series },
  w /* inner width of a full-width card */, wHalf /* inner width of a half-width chart card */, desktop }
```
