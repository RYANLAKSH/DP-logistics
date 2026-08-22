import { chromium } from 'playwright'
const BASE = 'http://localhost:4180/'
const OUT = process.argv[2] ?? '/tmp/claude-0/-home-user-DP-logistics/90b26267-c79d-5c8b-b70f-3b50c632d8fd/scratchpad/demo-shots'
import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
// One context throughout: the demo's backend lives in the page, so a reload
// would reset the manifest the manager just published — exactly as a tester
// would find if they refreshed between roles.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

const report = {}
await page.goto(BASE)
await page.waitForSelector('input[type=email]', { timeout: 20000 })
report.loginRendered = true
await page.screenshot({ path: `${OUT}/01-login.png` })

// --- manager: upload the real list as received -----------------------------
await page.fill('input[type=email]', 'manager@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForSelector('text=/Dashboard|Today/i', { timeout: 20000 })
report.managerLandedOnDashboard = true
await page.screenshot({ path: `${OUT}/02-dashboard.png`, fullPage: true })

await page.click('text=Manifests')
await page.waitForSelector('text=/Upload/i', { timeout: 10000 })
await page.click('a:has-text("Upload"), button:has-text("Upload")').catch(() => {})
await page.goto(`${BASE}#/manager/manifests/upload`)
await page.waitForSelector('text=Load it as received', { timeout: 15000 })
await page.click('button:has-text("Load it as received")')
await page.click('button:has-text("Parse and preview")')
await page.waitForSelector('text=Rows', { timeout: 20000 })
const asReceived = await page.textContent('body')
report.realListParsed = asReceived.includes('40')
report.checkDigitBlocked = asReceived.includes('check digit')
report.blockedFromPublishing =
  await page.locator('button:has-text("Publish manifest")').isDisabled()
report.carryForwardShown = asReceived.includes('from row above')
await page.screenshot({ path: `${OUT}/03-preview-as-received.png`, fullPage: true })

// --- manager: the corrected list, published --------------------------------
await page.goto(`${BASE}#/manager/manifests/upload`)
await page.waitForSelector('text=Load it corrected', { timeout: 10000 })
await page.click('button:has-text("Load it corrected")')
await page.click('button:has-text("Parse and preview")')
await page.waitForSelector('text=Rows', { timeout: 20000 })
report.correctedPublishable =
  (await page.locator('button:has-text("Publish manifest")').isDisabled()) === false
await page.click('button:has-text("Publish manifest")')
await page.waitForSelector('text=/PUBLISHED|Manifests/i', { timeout: 20000 })
await page.screenshot({ path: `${OUT}/04-published.png`, fullPage: true })

// --- driver: walk a pickup on the real numbers -----------------------------
await page.click('text=Sign out')
await page.waitForSelector('input[type=email]', { timeout: 20000 })
await page.setViewportSize({ width: 390, height: 844 })
await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForSelector('text=/pickup|Next|Start/i', { timeout: 20000 })
const home = await page.textContent('body')
report.driverSeesRealContainer = /TGCU5033177|CAIU7456843|TGCU5034147/.test(home)
report.driverSeesRealChassis = /MAT752389T7R|MAT464844TSR/.test(home)
await page.screenshot({ path: `${OUT}/05-driver-home.png`, fullPage: true })

// --- driver: walk one pickup all the way through ---------------------------
await page.click('button:has-text("Start this pickup")')
await page.waitForSelector('text=Scan container', { timeout: 20000 })
await page.screenshot({ path: `${OUT}/06-pickup.png`, fullPage: true })

async function scanStep(tile, choice) {
  await page.click(`text=${tile}`)
  await page.waitForSelector('text=/what is in front of the camera/i', { timeout: 20000 })
  if (choice) await page.click(`button:has-text("${choice}")`)
  await page.waitForTimeout(700)
  await page.click('button:has-text("Capture")')
  await page.waitForSelector('text=/Detected|Could not read it/', { timeout: 60000 })
  const body = await page.textContent('body')
  await page.click('button:has-text("Confirm"), button:has-text("Use this value anyway")')
  return body
}

const containerBody = await scanStep('Scan container', 'The container on my job sheet')
report.containerRead = /Detected/i.test(containerBody)
await page.screenshot({ path: `${OUT}/07-after-container.png`, fullPage: true })

await page.waitForSelector('text=Scan chassis', { timeout: 20000 })
const chassisBody = await scanStep('Scan chassis', 'The vehicle on my job sheet')
report.chassisRead = /Detected/i.test(chassisBody)
await page.screenshot({ path: `${OUT}/08-after-chassis.png`, fullPage: true })

const afterScans = await page.textContent('body')
report.reachedConfirm = /Confirm|Complete the movement|VERIFIED|MATCH/i.test(afterScans)
await page.screenshot({ path: `${OUT}/09-result.png`, fullPage: true })

report.errors = errors
console.log(JSON.stringify(report, null, 2))
await browser.close()
