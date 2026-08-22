import { useEffect, useState } from 'react'

/**
 * Whether the app can actually reach the server.
 *
 * `navigator.onLine` is not that question. It reports "online" for a captive
 * portal, for a yard's dead-zone Wi-Fi, and for a phone attached to a network
 * with no route out. Using it alone produces an app that insists it is online
 * while every request times out.
 *
 * So: onLine as a fast negative signal (it is reliable when it says OFFLINE),
 * and the timestamp of the last successful request as the positive one.
 */
export type Connectivity = 'online' | 'offline' | 'unknown'

let lastSuccess = 0
let lastFailure = 0

export function noteSuccess(): void { lastSuccess = Date.now() }
export function noteFailure(): void { lastFailure = Date.now() }

export function connectivity(): Connectivity {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  if (lastFailure > lastSuccess && Date.now() - lastFailure < 30_000) return 'offline'
  if (lastSuccess === 0) return 'unknown'
  return 'online'
}

export function useConnectivity(): Connectivity {
  const [state, setState] = useState<Connectivity>(connectivity)

  useEffect(() => {
    const update = () => setState(connectivity())
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    const timer = window.setInterval(update, 5_000)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
      window.clearInterval(timer)
    }
  }, [])

  return state
}
