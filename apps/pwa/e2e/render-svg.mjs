/**
 * Renders an SVG to PNG so brand assets can be reviewed as images.
 *   node e2e/render-svg.mjs <in.svg> <out.png> [width] [height]
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const [, , input, output, w = '1000', h = '300'] = process.argv
const width = Number(w)
const height = Number(h)

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const page = await browser.newPage({ viewport: { width, height } })
await page.setContent(
  `<body style="margin:0;background:#fff;display:grid;place-items:center;height:${height}px">
     <div style="width:${width - 40}px">${readFileSync(input, 'utf8')}</div>
   </body>`,
)
await page.screenshot({ path: output })
await browser.close()
