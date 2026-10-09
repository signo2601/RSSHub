// Build the single-file version of Gruzzolo for the Claude artifact host.
//
//   node dev/build-artifact.mjs                      → dist/gruzzolo-artifact.html
//   node dev/build-artifact.mjs out/page.html        → another output file
//   node dev/build-artifact.mjs --minify             → smaller, less readable script
//
// What it does: bundles js/main.js and every module it imports with esbuild (downloaded once
// by npx, no install needed) into one inline <script>, inlines all the stylesheets linked by
// index.html into one <style>, and copies the body markup of index.html (between the
// <!-- APP:BODY:START --> and <!-- APP:BODY:END --> markers). The result is an HTML fragment:
// no <!doctype>, <html>, <head> or <body>, no manifest, service worker or icons.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESBUILD = 'esbuild@0.24.0';
const BODY_START = '<!-- APP:BODY:START -->';
const BODY_END = '<!-- APP:BODY:END -->';

const args = process.argv.slice(2);
const minify = args.includes('--minify');
const outArg = args.find((a) => !a.startsWith('--'));
const outFile = path.resolve(outArg || path.join(ROOT, 'dist', 'gruzzolo-artifact.html'));

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// Attributes of every <link> tag in the page
function linkTags(html) {
  const tags = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name) => {
      const a = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'));
      return a ? a[1] : null;
    };
    tags.push({ tag, rel: (attr('rel') || '').toLowerCase(), href: attr('href') || '' });
  }
  return tags;
}

// Text that would close the inline <script>/<style> early
const safeScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\x21--');
const safeStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

async function bundle() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gruzzolo-build-'));
  const outJs = path.join(dir, 'main.js');
  const esbuildArgs = ['-y', ESBUILD, 'js/main.js', '--bundle', '--format=iife', '--target=es2020', `--outfile=${outJs}`, '--log-level=warning'];
  if (minify) esbuildArgs.push('--minify');
  const res = spawnSync('npx', esbuildArgs, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) fail(`npx non trovato: installa Node.js (https://nodejs.org) e riprova. (${res.error.message})`);
  if (res.status !== 0) fail('esbuild non è riuscito a creare il bundle: leggi gli errori qui sopra.');
  const js = await readFile(outJs, 'utf8');
  await rm(dir, { recursive: true, force: true });
  return js;
}

async function main() {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');

  const start = html.indexOf(BODY_START);
  const end = html.indexOf(BODY_END);
  if (start < 0 || end < start) fail(`index.html deve contenere i marcatori ${BODY_START} e ${BODY_END}.`);
  const body = html.slice(start + BODY_START.length, end).trim();

  const links = linkTags(html);
  const fontLinks = links
    .filter((l) => /^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(l.href))
    .map((l) => l.tag);
  const cssFiles = links
    .filter((l) => l.rel === 'stylesheet' && !/^[a-z]+:/i.test(l.href))
    .map((l) => l.href);
  if (!cssFiles.length) fail('Nessun foglio di stile locale trovato in index.html.');

  const cssParts = [];
  for (const href of cssFiles) {
    let css;
    try {
      css = await readFile(path.join(ROOT, href), 'utf8');
    } catch {
      fail(`Manca il file ${href} (collegato da index.html).`);
    }
    cssParts.push(`/* ${href} */\n${css.trim()}\n`);
  }

  const js = await bundle();

  const page = [
    '<title>Gruzzolo</title>',
    ...fontLinks,
    `<style>\n${safeStyle(cssParts.join('\n'))}</style>`,
    body,
    `<script>\nwindow.__GRUZZOLO_ARTIFACT__ = true;\n${safeScript(js)}</script>`,
    '',
  ].join('\n');

  // The fragment must not contain document-level tags (only the markup copied from index.html can)
  const copied = [...fontLinks, body].join('\n');
  const forbidden = [/<!doctype/i, /<html[\s>]/i, /<head[\s>]/i, /<body[\s>]/i, /rel="(manifest|icon|apple-touch-icon)"/i, /serviceWorker/];
  for (const re of forbidden) {
    const m = copied.match(re);
    if (m) fail(`La parte copiata da index.html contiene "${m[0]}": spostalo fuori dai marcatori.`);
  }

  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, page, 'utf8');
  const kb = (Buffer.byteLength(page, 'utf8') / 1024).toFixed(0);
  console.log(`✓ ${path.relative(process.cwd(), outFile) || outFile} (${kb} KB: ${cssFiles.length} fogli di stile, script ${(js.length / 1024).toFixed(0)} KB${minify ? ', minificato' : ''})`);
}

main().catch((e) => fail(e && e.stack ? e.stack : String(e)));
