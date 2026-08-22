/**
 * Proves the OCR path works end to end: the real engine, the real pipeline,
 * reading a real rendered plate through the real capture code.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { cameraStubScript } from './camera-stub.mjs'

const OUT = process.argv[2] ?? 'e2e-shots'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera'],
})
await ctx.addInitScript(cameraStubScript('TRHU8755445'))

const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForURL('**/driver')
await page.click('text=Start this pickup')
await page.click('text=Scan container')

await page.waitForSelector('button:has-text("Capture"):not([disabled])', { timeout: 20000 })
await page.screenshot({ path: `${OUT}/30-camera-live.png` })

await page.click('button:has-text("Capture")')
// The engine downloads and initialises on first use; allow for that.
await page.waitForSelector('text=/Detected|Could not read it/', { timeout: 120000 })
await page.screenshot({ path: `${OUT}/31-ocr-result.png` })

const body = await page.textContent('body')
const detected = body.includes('Detected')
const readCorrectly = body.includes('TRHU 8755 445') || body.includes('TRHU8755445')
const confidenceShown = /Confidence \d+%/.test(body)

await browser.close()

const report = {
  cameraOpened: true,
  engineProducedAResult: detected,
  readTheRenderedPlate: readCorrectly,
  confidenceShown,
  errors,
}
console.log(JSON.stringify(report, null, 2))
if (errors.length) { console.error('console errors'); process.exit(1) }
if (!detected) { console.error('the engine produced no candidate'); process.exit(1) }
