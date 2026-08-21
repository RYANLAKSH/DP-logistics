/**
 * Drives the manifest upload and preview flow against the built app.
 * Uploads a clean file and a deliberately broken one.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = process.argv[2] ?? 'e2e-shots'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'manager@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForURL('**/manager')

async function upload(fixture) {
  await page.goto(`${BASE}/manager/manifests/upload`)
  await page.setInputFiles('input[type=file]', resolve(HERE, 'fixtures', fixture))
  await page.click('button:has-text("Parse and preview")')
  await page.waitForSelector('text=Rows', { timeout: 10000 })
  const body = await page.textContent('body')
  const publish = page.locator('button:has-text("Publish manifest")')
  return { body, publishDisabled: await publish.isDisabled() }
}

// --- a file with a title block, a blank line, then the table ---------------
const clean = await upload('manifest-valid.csv')
await page.screenshot({ path: `${OUT}/20-preview-clean.png`, fullPage: true })

// --- a file carrying one of each error class -------------------------------
const broken = await upload('manifest-broken.csv')
await page.screenshot({ path: `${OUT}/21-preview-broken.png`, fullPage: true })

await browser.close()

const report = {
  cleanFileParsed: clean.body.includes('4') && !clean.body.includes('cannot be published'),
  cleanFilePublishable: clean.publishDisabled === false,
  brokenFileBlocked: broken.body.includes('cannot be published'),
  brokenPublishDisabled: broken.publishDisabled === true,
  reportsMissingContainer: broken.body.includes('container number is missing'),
  reportsDuplicateChassis: broken.body.includes('already assigned to'),
  reportsCheckDigit: broken.body.includes('check digit'),
  reportsBadSequence: broken.body.includes('whole number between 1 and 6'),
  errors,
}
console.log(JSON.stringify(report, null, 2))
const failures = Object.entries(report).filter(([k, v]) => k !== 'errors' && v !== true)
if (failures.length || errors.length) {
  console.error('FAILED:', failures.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
