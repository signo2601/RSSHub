// Screenshots of every screen of Gruzzolo, for design reviews.
//
//   node dev/server.mjs                 (in another terminal: app + /api on http://127.0.0.1:8787)
//   node dev/screens.mjs                → screenshots/ (iPhone 13 and iPhone SE, light and dark)
//   node dev/screens.mjs --out /tmp/s --devices iphone13 --themes dark --only market,report --full
//
// Options: --base URL (default http://127.0.0.1:8787), --out DIR (default ./screenshots),
// --devices iphone13,iphonese,desktop, --themes light,dark, --only <screen names>, --full (whole page
// instead of the first screen). Needs Playwright (npm i -D playwright, or a global install; Chromium
// from PLAYWRIGHT_BROWSERS_PATH or CHROMIUM_PATH). The app starts with the example portfolio.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const BASE = opt('base', 'http://127.0.0.1:8787').replace(/\/+$/, '');
const OUT = path.resolve(opt('out', 'screenshots'));
const DEVICES = opt('devices', 'iphone13,iphonese').split(',');
const THEMES = opt('themes', 'light,dark').split(',');
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
const FULL = args.includes('--full');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Global installs (e.g. /opt/node22/lib/node_modules/playwright)
    const { execSync } = await import('node:child_process');
    const root = execSync('npm root -g').toString().trim();
    return import(path.join(root, 'playwright', 'index.mjs'));
  }
}

const VIEWPORTS = {
  iphone13: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  iphonese: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 },
};

// name → UI state saved in localStorage before the app starts, plus an optional action after it
const SCREENS = [
  ['home', { tab: 'home' }],
  ['transactions', { tab: 'tx' }],
  ...[0, 1, 2, 3, 4, 5].map((i) => [`report-${i + 1}`, { tab: 'report', sheet: i }, null, 'report']),
  ['market-overview', { tab: 'market', eco: { page: 'overview' } }, null, 'market'],
  ['market-heatmap', { tab: 'market', eco: { page: 'heatmap' } }, null, 'market'],
  ['market-curves', { tab: 'market', eco: { page: 'curves' } }, null, 'market'],
  ['market-macro', { tab: 'market', eco: { page: 'macro' } }, null, 'market'],
  ['market-calendar', { tab: 'market', eco: { page: 'calendar' } }, null, 'market'],
  ['more', { tab: 'more' }],
  ['sheet-new-transaction', { tab: 'home' }, async (p) => p.click('.tabbar .fab, .side-add .btn')],
  ['sheet-asset', { tab: 'home' }, async (p) => p.click('[data-act="open-asset"]')],
  ['sheet-heatmap-stock', { tab: 'market', eco: { page: 'heatmap' } }, async (p) => p.click('.hm-tile >> nth=0'), 'market'],
];

// Capture mode: the page grows to its content so a full-page screenshot shows everything
const FULL_CSS = 'html,body{height:auto!important;overflow:visible!important}.app{position:static!important;min-height:100vh}.shell{min-height:100vh}#view{overflow:visible!important}';

const { chromium } = await loadPlaywright();
const executablePath = process.env.CHROMIUM_PATH || (process.env.PLAYWRIGHT_BROWSERS_PATH === '/opt/pw-browsers' ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : {});
await mkdir(OUT, { recursive: true });
const problems = [];
let count = 0;
for (const device of DEVICES) {
  for (const theme of THEMES) {
    for (const [name, ui, action, group] of SCREENS) {
      if (ONLY && !ONLY.has(name) && !(group && ONLY.has(group))) continue;
      const ctx = await browser.newContext({ ...VIEWPORTS[device], colorScheme: theme, serviceWorkers: 'block', locale: 'it-IT' });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`${device}/${theme}/${name}: ${e.message}`));
      await page.addInitScript((state) => {
        try {
          localStorage.setItem('gruzzolo:ui:v2', JSON.stringify(state));
        } catch { /* private mode */ }
      }, ui);
      await page.goto(BASE + '/');
      await page.waitForFunction(() => window.__gruzzoloReady === true, null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(group === 'market' ? 3500 : 1500); // market data comes from the network
      if (action) {
        try {
          await action(page);
          await page.waitForTimeout(800);
        } catch (e) {
          problems.push(`${device}/${theme}/${name}: action failed (${e.message.split('\n')[0]})`);
        }
      }
      const sheetOpen = await page.evaluate(() => !document.getElementById('sheet-layer').hidden);
      if (FULL && !sheetOpen) await page.addStyleTag({ content: FULL_CSS });
      const file = path.join(OUT, `${device}-${theme}-${name}.png`);
      await page.screenshot({ path: file, fullPage: FULL && !sheetOpen });
      count++;
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`${count} screenshots in ${OUT}`);
if (problems.length) console.log('Problems:\n' + problems.join('\n'));
