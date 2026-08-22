/**
 * Where errors go.
 *
 * Deliberately not a third-party SDK. Those arrive with their own network
 * client, their own storage, an API key to keep out of the bundle, and a habit
 * of collecting more than anyone agreed to — on an app whose whole point is a
 * careful evidence trail. This is a seam instead: errors are recorded locally
 * so a manager can read them off the device, and forwarded to whatever
 * endpoint an operator configures. Wiring it to Sentry or a log drain is a
 * deployment decision, documented in docs/deployment.md, not a build one.
 *
 * What is sent is bounded on purpose: what broke, where, and which role was
 * using it. Never a container number, a chassis number, a name or a token —
 * an error report should not become a second, unaudited copy of the manifest.
 */
const ENDPOINT = import.meta.env.VITE_ERROR_ENDPOINT as string | undefined
const RELEASE = import.meta.env.VITE_APP_VERSION as string | undefined

export interface ErrorReport {
  message: string
  stack?: string
  /** The route pattern, never the populated path: ids are not diagnostics. */
  where: string
  role?: string
  release?: string
  at: string
  online: boolean
}

const RECENT_MAX = 50
const recent: ErrorReport[] = []

/** The last errors this device saw, newest first. Read by the sync screen. */
export function recentErrors(): ErrorReport[] {
  return [...recent].reverse()
}

/**
 * Strips the identifiers out of a path.
 *
 * /driver/pickup/8f2c.../scan/chassis becomes /driver/pickup/:id/scan/chassis,
 * which is the part that says what broke. The id says which vehicle, and that
 * belongs in the audit log — behind access control — rather than in an error
 * sink that has none.
 *
 * An allowlist, not a blocklist. Listing the identifier shapes to remove meant
 * every new id format leaked until someone noticed; keeping only what is
 * recognisably a route word means a shape nobody anticipated is redacted by
 * default. Route segments are lowercase words; container numbers, chassis
 * numbers, uuids and the RPCs' short ids all carry digits or capitals.
 */
const ROUTE_WORD = /^[a-z][a-z-]*$/
const STATUS_PAGE = /^[0-9]{3}$/

export function scrubPath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (segment === '' || segment === '#') return segment
      if (ROUTE_WORD.test(segment) || STATUS_PAGE.test(segment)) return segment
      return ':id'
    })
    .join('/')
}

export function reportError(error: unknown, context: { role?: string } = {}): void {
  const err = error instanceof Error ? error : new Error(String(error))
  const report: ErrorReport = {
    message: err.message.slice(0, 500),
    stack: err.stack?.split('\n').slice(0, 12).join('\n'),
    where: scrubPath(
      typeof location === 'undefined' ? '' : location.pathname + location.hash),
    role: context.role,
    release: RELEASE,
    at: new Date().toISOString(),
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  }

  recent.push(report)
  if (recent.length > RECENT_MAX) recent.shift()

  // Always visible locally. A yard phone is often the only place an error was
  // ever seen, and a manager plugging it in should not need a network.
  console.error('[ryla]', report.message, report)

  if (!ENDPOINT) return
  // keepalive so a report survives the navigation that a crash usually causes.
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Reporting must never be the thing that breaks the app.
  }
}

/**
 * Catches what React cannot: rejected promises and errors thrown outside the
 * render tree. Without these, an upload that fails inside an event handler
 * disappears without trace.
 */
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (e) => reportError(e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason))
}
