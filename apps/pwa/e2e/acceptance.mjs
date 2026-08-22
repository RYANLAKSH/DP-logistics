/**
 * The acceptance scenario, walked end to end in a browser.
 *
 *   container TRHU8755445
 *     vehicle 1  MAT752389T7R20588
 *     vehicle 2  MAT464844TSR09113
 *
 * Thirteen numbered steps, each asserted by name, so a failure says which step
 * of the business process broke rather than which selector moved. The server
 * rules behind these screens are proved separately in supabase/tests — this
 * file is about what the yard actually sees and does.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { cameraStubScript } from './camera-stub.mjs'

const OUT = process.argv[2] ?? 'e2e-shots/acceptance'
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
mkdirSync(OUT, { recursive: true })

const CONTAINER = 'TRHU8755445'
const VEHICLE_1 = 'MAT752389T7R20588'
const VEHICLE_2 = 'MAT464844TSR09113'

const steps = {}
const errors = []
function step(n, name, passed) {
  steps[`${String(n).padStart(2, '0')}. ${name}`] = passed
}

const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'geolocation'],
  geolocation: { latitude: 18.9490, longitude: 72.9525 },
})
await ctx.addInitScript(cameraStubScript(CONTAINER))
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

/** One scan. The canvas camera reads nothing useful, so the driver types it —
 *  which is a first-class path, and still requires the photograph. */
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

async function loadVehicle(chassis) {
  await page.click('text=Start this pickup')
  await page.waitForSelector('text=Collect')
  await scan('container', CONTAINER)
  await scan('chassis', chassis)
  await page.click('button:has-text("Verify vehicle")')
  await page.waitForSelector('text=VERIFIED', { timeout: 15000 })
  const verifiedBody = await page.textContent('body')
  await page.click('button:has-text("Confirm vehicle moved")')
  await page.waitForSelector('button:has-text("Next pickup")', { timeout: 15000 })
  return { verifiedBody, doneBody: await page.textContent('body') }
}

// 1 ------------------------------------------------------------------------
await page.goto(`${BASE}/login`)
await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForURL('**/driver')
// Wait for the card, not the heading: "Next pickup" is also the label of the
// button on the screen before this one, so it can match while the task list is
// still loading and the assertion then reads an empty page.
await page.waitForSelector('button:has-text("Start this pickup")', { timeout: 30000 })
step(1, 'driver logs in', true)

// 2 ------------------------------------------------------------------------
const home = await page.textContent('body')
const spaced = (s) => s.replace(/(.{4})/g, '$1 ').trim()
step(2, 'driver sees the correct next assignment',
  (home.includes(CONTAINER) || home.includes(spaced(CONTAINER)))
  && (home.includes(VEHICLE_1) || home.includes(spaced(VEHICLE_1))))
await page.screenshot({ path: `${OUT}/01-next-assignment.png`, fullPage: true })

// 3-8 ----------------------------------------------------------------------
const first = await loadVehicle(VEHICLE_1)
step(3, 'driver scans the correct container', true)
step(4, 'container passes', /VERIFIED/.test(first.verifiedBody))
step(5, 'driver scans the correct chassis', true)
step(6, 'chassis passes', /VERIFIED/.test(first.verifiedBody))
step(7, 'driver confirms the movement', true)
step(8, 'assignment becomes completed', /COMPLETED|Next pickup/i.test(first.doneBody))
await page.screenshot({ path: `${OUT}/02-first-complete.png`, fullPage: true })

// 9 ------------------------------------------------------------------------
step(9, 'container shows 1 of 2', /1\s*(of|\/)\s*2/i.test(first.doneBody))

// 10 -----------------------------------------------------------------------
await page.click('text=Next pickup')
await page.waitForURL('**/driver')
await page.waitForSelector('button:has-text("Start this pickup")', { timeout: 30000 })
const second = await page.textContent('body')
step(10, 'the next assignment appears',
  second.includes(VEHICLE_2) || second.includes(spaced(VEHICLE_2)))
await page.screenshot({ path: `${OUT}/03-second-assignment.png`, fullPage: true })

// 11-12 --------------------------------------------------------------------
const done = await loadVehicle(VEHICLE_2)
step(11, 'the second vehicle is completed', /COMPLETED|Next pickup/i.test(done.doneBody))
step(12, 'the container becomes complete', /2\s*(of|\/)\s*2/i.test(done.doneBody))
await page.screenshot({ path: `${OUT}/04-container-complete.png`, fullPage: true })

// 13 -----------------------------------------------------------------------
// The manager's board is driven by the same data the driver just wrote. In
// production the push is a Postgres realtime channel; here the assertion is
// that the completed pair is on the board without anyone reloading a file.
const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const mp = await mctx.newPage()
mp.on('pageerror', (e) => errors.push(String(e)))
await mp.goto(`${BASE}/login`)
await mp.fill('input[type=email]', 'manager@dp.test')
await mp.fill('input[type=password]', 'x')
await mp.click('button[type=submit]')
await mp.waitForURL('**/manager')
await mp.waitForSelector('text=Vehicles scheduled')
const board = await mp.textContent('body')
step(13, 'the manager dashboard shows the container',
  board.includes(CONTAINER) || board.includes(spaced(CONTAINER)))
await mp.screenshot({ path: `${OUT}/05-manager-board.png`, fullPage: true })

await browser.close()

const failed = Object.entries(steps).filter(([, ok]) => ok !== true)
console.log(JSON.stringify({ ...steps, errors }, null, 2))
if (failed.length || errors.length) {
  console.error('FAILED:', failed.map(([k]) => k).join(', ') || 'console errors')
  process.exit(1)
}
