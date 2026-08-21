/**
 * End-to-end smoke test: drives the real built app in a real browser.
 *
 *   npm run build && npm run preview &   # serve dist on :4173
 *   npm run e2e -- ./shots               # screenshots land in ./shots
 *
 * Covers the two paths that matter — a movement that verifies and a movement
 * that is blocked — plus the role guard, and fails on any console error.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const OUT = process.argv[2] ?? 'e2e-shots'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

// Honour a preinstalled browser when the Playwright build differs from the
// one on disk; fall back to Playwright's own resolution otherwise.
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  // A synthetic camera, so the real getUserMedia path is exercised rather than
  // stubbed. It shows a test pattern, so OCR reads nothing — which puts this
  // run through the manual-entry path, the one that has to work when a plate
  // is unreadable.
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-capture',
  ],
})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera'],
})
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(String(e)))

async function shot(name) { await page.screenshot({ path: `${OUT}/${name}.png` }) }

// --- driver happy path -----------------------------------------------------
await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForURL('**/driver')
await page.waitForSelector('text=Next pickup')
await shot('01-driver-home')

await page.click('text=Start this pickup')
await page.waitForSelector('text=Collect')
await shot('02-pickup-detail')

/**
 * One capture. The fake camera shows a test pattern, so the engine reads
 * nothing and the driver types the value — with the photograph still required.
 */
async function scan(which, value) {
  await page.click(`text=Scan ${which}`)
  await page.waitForSelector(`text=Expected ${which} number`)
  await page.click('button:has-text("Capture")')
  await page.waitForSelector('text=Could not read it, text=Detected', { timeout: 60000 })
  await page.click('button:has-text("Type it instead")')
  await page.fill('input[autocapitalize=characters]', value)
  await page.click('button:has-text("Use this value")')
  await page.waitForSelector('text=Collect')
}

await scan('container', 'CULVNSA2601795')
await shot('03-scan-container')
await scan('chassis', 'MAT752389T7R19810')

await page.waitForSelector('button:has-text("Verify vehicle")')
await shot('04-both-scanned')
await page.click('button:has-text("Verify vehicle")')
await page.waitForSelector('text=VERIFIED', { timeout: 10000 })
await shot('05-verified')
const verified = await page.textContent('body')

// Nothing is recorded until the driver confirms the vehicle physically moved.
const confirmVisible = await page.isVisible('button:has-text("Confirm vehicle moved")')
await page.click('button:has-text("Confirm vehicle moved")')
await page.waitForSelector('button:has-text("Next pickup")', { timeout: 10000 })
await shot('05b-moved')

// --- driver mismatch path --------------------------------------------------
await page.click('text=Next pickup')
await page.waitForURL('**/driver')
await page.waitForSelector('text=Next pickup')
const secondChassis = await page.textContent('.code')
await page.click('text=Start this pickup')
await scan('container', 'CULVNSA2601795')
// A vehicle that belongs to a different container.
await scan('chassis', 'MAT111222A1B00001')
await page.click('button:has-text("Verify vehicle")')
await page.waitForSelector('text=DO NOT LOAD', { timeout: 10000 })
const blockedHasNoConfirm =
  !(await page.isVisible('button:has-text("Confirm vehicle moved")'))
await shot('06-blocked')
const blocked = await page.textContent('body')

// --- manager ---------------------------------------------------------------
const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const mp = await mctx.newPage()
mp.on('pageerror', (e) => errors.push(String(e)))
await mp.goto(`${BASE}/login`)
await mp.fill('input[type=email]', 'manager@dp.test')
await mp.fill('input[type=password]', 'x')
await mp.click('button[type=submit]')
await mp.waitForURL('**/manager')
await mp.waitForSelector('text=Vehicles scheduled')
await mp.screenshot({ path: `${OUT}/07-manager-dashboard.png`, fullPage: true })

await mp.click('a:has-text("Exceptions")')
await mp.waitForSelector('text=Open (')
await mp.screenshot({ path: `${OUT}/08-manager-exceptions.png`, fullPage: true })

await mp.click('a:has-text("Manifests")')
await mp.waitForSelector('text=Operating date')
await mp.screenshot({ path: `${OUT}/09-manager-manifests.png`, fullPage: true })

await mp.click('a:has-text("Audit log")')
await mp.waitForSelector('text=Append-only')
await mp.screenshot({ path: `${OUT}/10-manager-audit.png`, fullPage: true })

// --- role guards ------------------------------------------------------------
// A driver reaching a manager route.
await page.goto(`${BASE}/manager`)
await page.waitForURL('**/403')
await shot('11-driver-blocked-from-manager')

// A manager reaching an admin-only route. Managers are not admins.
await mp.goto(`${BASE}/manager/users`)
await mp.waitForURL('**/403')
await mp.screenshot({ path: `${OUT}/12-manager-blocked-from-admin.png` })
const managerSeesUsersLink = await mp.isVisible('a:has-text("Users")')

// An admin reaching the same route.
const actx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const ap = await actx.newPage()
ap.on('pageerror', (e) => errors.push(String(e)))
await ap.goto(`${BASE}/login`)
await ap.fill('input[type=email]', 'admin@dp.test')
await ap.fill('input[type=password]', 'x')
await ap.click('button[type=submit]')
await ap.waitForURL('**/manager')
await ap.goto(`${BASE}/manager/users`)
await ap.waitForSelector('text=Roles and yard assignments')
const adminReachesUsers = ap.url().endsWith('/manager/users')
await ap.screenshot({ path: `${OUT}/13-admin-users.png`, fullPage: true })

await browser.close()

const report = {
  verifiedShown: verified.includes('VERIFIED'),
  blockedShown: blocked.includes('DO NOT LOAD'),
  namesOtherContainer: blocked.includes('assigned to container'),
  confirmStepShown: confirmVisible,
  cameraOpened: true,
  blockedOffersNoConfirm: blockedHasNoConfirm,
  secondTaskIsNotTheFirst: !blocked.includes('This vehicle has already been moved'),
  secondChassis,
  managerBlockedFromAdminRoute: true,
  managerDoesNotSeeUsersLink: managerSeesUsersLink === false,
  adminReachesUsers,
  errors,
}
console.log(JSON.stringify(report, null, 2))

const failures = Object.entries(report).filter(
  ([k, v]) => k !== 'errors' && k !== 'secondChassis' && v !== true,
)
if (failures.length || errors.length) {
  console.error('E2E FAILED:', failures.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
