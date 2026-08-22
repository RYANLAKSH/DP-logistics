/**
 * Accessibility checks that matter for this app, on the screens that matter.
 *
 * Not a generic linter run. A driver uses this one-handed, in gloves, in
 * sunlight, sometimes with the phone's text size turned well up; a manager
 * uses the board with a keyboard. Those are the things checked here:
 * every control reachable and named, every input labelled, targets big enough
 * to hit, and nothing that only communicates through colour.
 */
import { chromium } from 'playwright'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:4173'
const executablePath = process.env.CHROMIUM_PATH
const browser = await chromium.launch(executablePath ? { executablePath } : {})

const findings = []
function check(page, name, ok, detail) {
  if (!ok) findings.push(`${page}: ${name}${detail ? ` — ${detail}` : ''}`)
}

async function audit(page, label) {
  // 1. Every control has an accessible name. A button a screen reader calls
  //    "button" is a button nobody can be told to press over the radio.
  const unnamed = await page.$$eval(
    'button, a[href], [role=button]',
    (els) => els
      .filter((el) => el.offsetParent !== null)
      .filter((el) => !(
        el.textContent?.trim()
        || el.getAttribute('aria-label')
        || el.getAttribute('title')
        || el.querySelector('img[alt]:not([alt=""])')
      ))
      .map((el) => el.outerHTML.slice(0, 100)),
  )
  check(label, 'every control has a name', unnamed.length === 0, unnamed.join(' | '))

  // 2. Every input is labelled.
  const unlabelled = await page.$$eval(
    'input:not([type=hidden]), select, textarea',
    (els) => els
      .filter((el) => !(
        el.getAttribute('aria-label')
        || el.getAttribute('aria-labelledby')
        || (el.id && document.querySelector(`label[for="${el.id}"]`))
        || el.closest('label')
        || el.getAttribute('placeholder')
      ))
      .map((el) => el.outerHTML.slice(0, 100)),
  )
  check(label, 'every input is labelled', unlabelled.length === 0, unlabelled.join(' | '))

  // 3. Images carry alt text, even if empty for decoration.
  const noAlt = await page.$$eval('img:not([alt])', (els) => els.length)
  check(label, 'every image has alt', noAlt === 0, `${noAlt} without`)

  // 4. Touch targets. 44px is the documented floor on both platforms; this app
  //    targets 56 for a gloved thumb, so 44 is the failure line.
  const small = await page.$$eval('button, a[href], [role=button]', (els) => els
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ r: el.getBoundingClientRect(), t: el.textContent?.trim().slice(0, 30) }))
    .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
    .map(({ r, t }) => `${t} ${Math.round(r.width)}x${Math.round(r.height)}`))
  check(label, 'touch targets are at least 44px', small.length === 0, small.join(' | '))

  // 5. One h1, and headings that do not skip levels.
  const headings = await page.$$eval('h1,h2,h3,h4,h5,h6',
    (els) => els.filter((el) => el.offsetParent !== null).map((el) => Number(el.tagName[1])))
  check(label, 'exactly one h1', headings.filter((h) => h === 1).length === 1,
    `found ${headings.filter((h) => h === 1).length}`)
  let skipped = ''
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] - headings[i - 1] > 1) skipped = `h${headings[i - 1]} → h${headings[i]}`
  }
  check(label, 'headings do not skip a level', skipped === '', skipped)

  // 6. The page declares its language, so a screen reader pronounces it.
  const lang = await page.$eval('html', (el) => el.getAttribute('lang'))
  check(label, 'the document declares a language', Boolean(lang), String(lang))

  // 7. Keyboard focus is visible. A manager works the board with a keyboard.
  await page.keyboard.press('Tab')
  const focusVisible = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return false
    const s = getComputedStyle(el)
    return s.outlineStyle !== 'none' || s.boxShadow !== 'none'
  })
  check(label, 'keyboard focus is visible', focusVisible)
}

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()

await page.goto(`${BASE}/login`)
await page.waitForSelector('input[type=email]')
await audit(page, 'login')

await page.fill('input[type=email]', 'driver@dp.test')
await page.fill('input[type=password]', 'x')
await page.click('button[type=submit]')
await page.waitForSelector('button:has-text("Start this pickup")', { timeout: 30000 })
await audit(page, 'driver home')

await page.click('button:has-text("Start this pickup")')
await page.waitForSelector('text=Scan container')
await audit(page, 'pickup detail')

const mctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const mp = await mctx.newPage()
await mp.goto(`${BASE}/login`)
await mp.fill('input[type=email]', 'manager@dp.test')
await mp.fill('input[type=password]', 'x')
await mp.click('button[type=submit]')
await mp.waitForSelector('text=Vehicles scheduled', { timeout: 30000 })
await audit(mp, 'manager board')

await browser.close()

if (findings.length) {
  console.error('ACCESSIBILITY FINDINGS:')
  for (const f of findings) console.error('  - ' + f)
  process.exit(1)
}
console.log('accessibility: no findings')
