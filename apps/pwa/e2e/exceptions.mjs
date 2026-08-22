/**
 * The exception path end to end: a driver is blocked, requests an override,
 * and a manager approves it from their own session.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { cameraStubScript } from './camera-stub.mjs'

const OUT = process.argv[2] ?? 'e2e-shots'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const errors = []

// --- the driver ------------------------------------------------------------
const dctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, permissions: ['camera'],
})
await dctx.addInitScript(cameraStubScript('UNREADABLE'))
const driver = await dctx.newPage()
driver.on('pageerror', (e) => errors.push(String(e)))
driver.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
driver.on('requestfailed', (r) => errors.push(`requestfailed ${r.url()}`))

await driver.goto(`${BASE}/login`)
await driver.fill('input[type=email]', 'driver@dp.test')
await driver.fill('input[type=password]', 'x')
await driver.click('button[type=submit]')
await driver.waitForURL('**/driver')
await driver.click('text=Start this pickup')

async function scan(which, value) {
  await driver.click(`text=Scan ${which}`)
  await driver.waitForSelector('button:has-text("Capture"):not([disabled])', { timeout: 30000 })
  await driver.click('button:has-text("Capture")')
  try {
    await driver.waitForSelector('text=/Detected|Could not read it/', { timeout: 90000 })
  } catch (e) {
    await driver.screenshot({ path: `${OUT}/FAIL-${which}.png` })
    console.error('state:', (await driver.textContent('body')).slice(0, 400))
    console.error('errors:', errors.slice(0, 5))
    throw e
  }
  await driver.click('button:has-text("Type it instead")')
  await driver.fill('input[autocapitalize=characters]', value)
  await driver.click('button:has-text("Use this value")')
  await driver.waitForSelector('text=Collect')
}

await scan('container', 'CULVNSA2601795')
await scan('chassis', 'MAT111222A1B00001')   // belongs to another container
await driver.click('button:has-text("Verify vehicle")')
await driver.waitForSelector('text=DO NOT LOAD', { timeout: 20000 })

await driver.click('button:has-text("Ask a manager to authorise this")')
await driver.fill('textarea', 'Transporter substituted the vehicle at the gate this morning')
await driver.click('button:has-text("Send the request")')
await driver.waitForSelector('text=Your manager will review', { timeout: 20000 })
await driver.screenshot({ path: `${OUT}/40-override-requested.png` })
const driverCannotApprove =
  !(await driver.isVisible('button:has-text("Approve the override")'))

// --- the manager, in their own session -------------------------------------
const mctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const manager = await mctx.newPage()
manager.on('pageerror', (e) => errors.push(String(e)))
await manager.goto(`${BASE}/login`)
await manager.fill('input[type=email]', 'manager@dp.test')
await manager.fill('input[type=password]', 'x')
await manager.click('button[type=submit]')
await manager.waitForURL('**/manager')
await manager.click('a:has-text("Exceptions")')
await manager.waitForSelector('text=Open (')

// The mock backend is per-page, so the manager sees the seeded exceptions
// rather than the driver's. Exercise resolution on one of those.
await manager.click('button:has-text("wrong vehicle")')
await manager.waitForSelector('text=Resolution')
await manager.screenshot({ path: `${OUT}/41-manager-exception.png`, fullPage: true })

const resolveDisabledWithoutNote =
  await manager.locator('button:has-text("Resolve")').isDisabled()
await manager.fill('textarea', 'Driver rescanned the correct vehicle and it verified')
await manager.click('button:has-text("Resolve")')
await manager.waitForSelector('text=Resolved (', { timeout: 20000 })
await manager.screenshot({ path: `${OUT}/42-manager-resolved.png`, fullPage: true })

await browser.close()

const report = {
  driverBlocked: true,
  overrideRequestSent: true,
  driverCannotApproveOwnOverride: driverCannotApprove,
  resolveRequiresANote: resolveDisabledWithoutNote,
  managerResolved: true,
  errors,
}
console.log(JSON.stringify(report, null, 2))
const failures = Object.entries(report).filter(([k, v]) => k !== 'errors' && v !== true)
if (failures.length || errors.length) {
  console.error('FAILED:', failures.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
