/**
 * Offline behaviour, driven for real.
 *
 * The property that matters most: a movement captured with no connection must
 * NEVER be presented as complete. It is PENDING SYNC until the server says
 * otherwise, and the screen has to say so.
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
  viewport: { width: 390, height: 844 }, permissions: ['camera'],
})
await ctx.addInitScript(cameraStubScript('CULVNSA2601795'))

const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForURL('**/driver')

// A real shift starts with signal: the service worker registers and the OCR
// engine downloads at the home screen. Wait for both before cutting the
// connection, because that is what actually happens in a yard.
await page.waitForFunction(
  () => navigator.serviceWorker?.controller != null,
  null, { timeout: 30000 },
)
await page.click('text=Start this pickup')
await page.click('text=Scan container')
await page.waitForSelector('button:has-text("Capture"):not([disabled])', { timeout: 30000 })
// One online scan, so the engine and its language data are in the cache.
await page.click('button:has-text("Capture")')
await page.waitForSelector('text=/Detected|Could not read it/', { timeout: 120000 })
await page.click('button:has-text("Retake")')
await page.goBack()
await page.waitForSelector('text=Collect')

async function scan(which, value) {
  await page.click(`text=Scan ${which}`)
  await page.waitForSelector('button:has-text("Capture"):not([disabled])', { timeout: 30000 })
  await page.click('button:has-text("Capture")')
  await page.waitForSelector('text=/Detected|Could not read it/', { timeout: 120000 })
  await page.click('button:has-text("Type it instead")')
  await page.fill('input[autocapitalize=characters]', value)
  await page.click('button:has-text("Use this value")')
  await page.waitForSelector('text=Collect')
}

// ------------------------------------------------------------------ offline
await ctx.setOffline(true)

await scan('container', 'CULVNSA2601795')
await scan('chassis', 'MAT752389T7R19810')
await page.screenshot({ path: `${OUT}/50-offline-scanned.png` })

// The app must keep working with no connection at all.
const capturedOffline = (await page.textContent('body')).includes('Verify vehicle')

await page.click('button:has-text("Verify vehicle")')
await page.waitForSelector('text=/VERIFIED|DO NOT LOAD|PENDING SYNC/', { timeout: 30000 })
await page.click('button:has-text("Confirm vehicle moved")')
await page.waitForSelector('text=PENDING SYNC', { timeout: 30000 })
await page.screenshot({ path: `${OUT}/51-pending-sync.png` })

const body = await page.textContent('body')
const saysPendingNotComplete = body.includes('PENDING SYNC')
  && body.includes('NOT complete until the server confirms')
const doesNotClaimVerified = !body.includes('VERIFIED')

// The sync screen is reachable and honest while offline.
await page.click('button:has-text("See what is pending")')
await page.waitForSelector('text=Sync')
await page.screenshot({ path: `${OUT}/52-sync-screen.png`, fullPage: true })
const syncBody = await page.textContent('body')
// Offline, the header states the connection rather than a pending count —
// so assert what the screen is meant to say in THAT state: the connection,
// the queued movement, and that it is not complete.
// Case-insensitive: the badge is uppercased by CSS, so textContent keeps the
// original casing.
const syncScreenWorksOffline = syncBody.includes('You are offline')
  && /pending sync/i.test(syncBody)
  && syncBody.includes('not complete until the server confirms')
  && syncBody.includes('Storage used')

await browser.close()

const report = {
  capturedWithNoConnection: capturedOffline,
  saysPendingNotComplete,
  neverClaimsVerifiedWhenQueued: doesNotClaimVerified,
  syncScreenWorksOffline,
  errors: errors.filter((e) => !/Failed to fetch|NetworkError|net::ERR/i.test(e)),
}
console.log(JSON.stringify(report, null, 2))
const failures = Object.entries(report).filter(([k, v]) => k !== 'errors' && v !== true)
if (failures.length || report.errors.length) {
  console.error('FAILED:', failures.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
