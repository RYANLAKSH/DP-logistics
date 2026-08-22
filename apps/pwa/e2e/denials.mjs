/**
 * What happens when the phone says no.
 *
 * Two permissions, two very different answers, and the difference is the
 * product's position on what evidence is:
 *
 *   camera denied   → the movement cannot be completed at all. The photograph
 *                     IS the evidence; typing the number instead proves only
 *                     that someone can type. The driver is not left stuck —
 *                     they report the problem and the next vehicle opens.
 *   location denied → the movement completes. Location corroborates, it does
 *                     not prove, and blocking a shift over a setting a driver
 *                     may not control would push the work off the system.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { cameraStubScript } from './camera-stub.mjs'

const OUT = process.argv[2] ?? 'e2e-shots/denials'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

const CONTAINER = 'TRHU8755445'
const VEHICLE_1 = 'MAT752389T7R20588'

const report = {}
const errors = []
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})

async function signInAsDriver(ctx) {
  const page = await ctx.newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(`${BASE}/login`)
  await page.fill('input[type=email]', 'driver@dp.test')
  await page.fill('input[type=password]', 'x')
  await page.click('button[type=submit]')
  await page.waitForURL('**/driver')
  await page.waitForSelector('button:has-text("Start this pickup")', { timeout: 30000 })
  return page
}

// --- camera denied ---------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  // The real refusal: getUserMedia rejects with NotAllowedError, which is what
  // a browser throws after the user taps Block.
  await ctx.addInitScript(`
    navigator.mediaDevices.getUserMedia = async () => {
      const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e
    }
  `)
  const page = await signInAsDriver(ctx)
  await page.click('button:has-text("Start this pickup")')
  await page.waitForSelector('text=Scan container')
  await page.click('text=Scan container')

  await page.waitForSelector('text=Why the camera is needed', { timeout: 20000 })
  const body = await page.textContent('body')
  report.cameraDeniedIsExplained = /Why the camera is needed/.test(body)
  report.cameraDeniedSaysWhyTypingIsNotEnough = /anyone can type a number/.test(body)
  // No path to completion — not even the manual-entry escape hatch.
  report.cameraDeniedOffersNoCapture =
    (await page.locator('button:has-text("Capture")').count()) === 0
  report.cameraDeniedOffersNoTypeIn =
    (await page.locator('button:has-text("Type it instead")').count()) === 0
  await page.screenshot({ path: `${OUT}/01-camera-denied.png`, fullPage: true })

  // But the driver is not stranded: reporting it is one tap, and that is the
  // manager-authorised skip.
  await page.click('button:has-text("Report the problem")')
  await page.waitForURL('**/exception', { timeout: 15000 })
  report.cameraDeniedLeadsToException = true
  await page.screenshot({ path: `${OUT}/02-report-problem.png`, fullPage: true })
  await ctx.close()
}

// --- location denied -------------------------------------------------------
{
  // No geolocation permission granted, so getCurrentPosition fails with
  // PERMISSION_DENIED. The camera works.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ['camera'],
  })
  await ctx.addInitScript(cameraStubScript(CONTAINER))
  await ctx.addInitScript(`
    navigator.geolocation.getCurrentPosition = (_ok, fail) =>
      fail({ code: 1, message: 'User denied Geolocation', PERMISSION_DENIED: 1 })
  `)
  const page = await signInAsDriver(ctx)
  await page.click('button:has-text("Start this pickup")')
  await page.waitForSelector('text=Scan container')

  async function scan(which, value) {
    await page.click(`text=Scan ${which}`)
    await page.waitForSelector(`text=Expected ${which} number`)
    await page.waitForSelector('button:has-text("Capture"):not([disabled])', { timeout: 30000 })
    await page.click('button:has-text("Capture")')
    await page.waitForSelector('text=/Detected|Could not read it/', { timeout: 120000 })
    await page.click('button:has-text("Type it instead")')
    await page.fill('input[autocapitalize=characters]', value)
    await page.click('button:has-text("Use this value")')
    await page.waitForSelector('text=Collect')
  }

  const detail = await page.textContent('body')
  report.locationDeniedIsDisclosed = /Location is switched off|not shared/i.test(detail)

  await scan('container', CONTAINER)
  await scan('chassis', VEHICLE_1)
  await page.click('button:has-text("Verify vehicle")')
  await page.waitForSelector('text=VERIFIED', { timeout: 20000 })
  await page.click('button:has-text("Confirm vehicle moved")')
  await page.waitForSelector('button:has-text("Next pickup")', { timeout: 20000 })
  report.locationDeniedStillCompletes = true
  await page.screenshot({ path: `${OUT}/03-location-denied-complete.png`, fullPage: true })
  await ctx.close()
}

await browser.close()

report.errors = errors
console.log(JSON.stringify(report, null, 2))
const failed = Object.entries(report).filter(([k, v]) => k !== 'errors' && v !== true)
if (failed.length || errors.length) {
  console.error('FAILED:', failed.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
