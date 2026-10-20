// Bundles src/ into one self-contained file: Simulatore-Valore-Minerario.html (works offline, no server needed).
import { readFileSync, writeFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The browser build is a classic script: drop the module syntax, keep the code.
const engine = read('./src/engine.mjs').replaceAll(/^export /gm, '');
const app = read('./src/app.mjs').replace(/^import [\s\S]*? from '\.\/engine\.mjs';\n/m, '');
const example = JSON.stringify(JSON.parse(read('./examples/global-atomic-dasa.json')));
const script = `${engine}\nconst EXAMPLE_PROJECT = ${example};\n${app}`;

// A literal "</script" inside the data would end the inline script early.
const safeScript = script.replaceAll('</script', String.raw`<\/script`);
const artifactArgument = process.argv.indexOf('--artifact');
const artifactPath = artifactArgument === -1 ? null : process.argv[artifactArgument + 1];

// Function replacers keep "$&"-style sequences in the code from being expanded.
const standalone = read('./src/template.html')
    .replace('/*STYLES*/', () => read('./src/styles.css'))
    .replace('/*SCRIPT*/', () => safeScript);

// Artifact hosts wrap the page themselves and block downloads: ship the body only, without the download buttons.
const artifactPage = [
    '<title>Simulatore Valore Minerario</title>',
    '<meta name="claude:viewport-fit-sides" content="cover">',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">',
    `<style>\n${read('./src/styles.css')}\n</style>`,
    '<div id="app"></div>',
    `<script>\n'use strict';\n${safeScript.replace('const CAN_DOWNLOAD = true;', 'const CAN_DOWNLOAD = false;')}\n</script>`,
].join('\n');

const html = artifactPath ? artifactPage : standalone;

writeFileSync(artifactPath ?? new URL('./Simulatore-Valore-Minerario.html', import.meta.url), html);
console.log(`${artifactPath ?? 'Simulatore-Valore-Minerario.html'} written (${Math.round(html.length / 1024)} KB)`);
