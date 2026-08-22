/**
 * Folds the demo build into one self-contained HTML file.
 *
 * The demo is hosted as a single static page, so every stylesheet, script and
 * image has to travel inside it — there is no second request to make. The
 * output is a fragment (title, style, root, script) rather than a whole
 * document, because the host supplies the surrounding skeleton.
 *
 *   node scripts/build-demo.mjs [outFile]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../dist-demo')
const out = process.argv[2] ?? resolve(HERE, '../dist-demo/ryla-verify-demo.html')

const css = readdirSync(join(DIST, 'assets'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, 'assets', f), 'utf8'))
  .join('\n')

let js = readFileSync(join(DIST, 'demo.js'), 'utf8')

// The one runtime asset reference the bundle keeps: the logo is loaded by URL
// rather than imported, so Vite never sees it.
const logo = readFileSync(resolve(HERE, '../public/brand/ryla-logo.svg'), 'utf8')
const logoUri = `data:image/svg+xml;base64,${Buffer.from(logo).toString('base64')}`
js = js.split('/brand/ryla-logo.svg').join(logoUri)

// A literal </script> anywhere in the bundle would end the tag early.
js = js.split('</script').join('<\\/script')

// The app commits to one light visual world on purpose: it is read in direct
// sun, on a phone, by someone wearing gloves. Declaring color-scheme keeps the
// native controls — the date picker above all — in that world when the page is
// opened by a viewer whose browser is set to dark.
const html = `<title>RYLA Verify</title>
<style>:root { color-scheme: light }</style>
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`

writeFileSync(out, html)
const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`${out} — ${kb} KB`)
