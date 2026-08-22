/**
 * Location, event-based.
 *
 * Read at the moment of a scan and never watched. This is evidence about a
 * movement, not a way to follow an employee around a yard, and that difference
 * has to be visible in the code as well as in the staff-facing policy. If the
 * business later asks for continuous tracking, that is a new decision with its
 * own consent conversation — not a flag flipped here.
 */

export type GeoState = 'unknown' | 'granted' | 'denied' | 'unsupported'

export interface Fix {
  lat: number
  lng: number
  accuracy: number
}

export async function permissionState(): Promise<GeoState> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unsupported'
  if (!navigator.permissions?.query) return 'unknown'
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' })
    return status.state === 'granted' ? 'granted'
      : status.state === 'denied' ? 'denied'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * One fix, or null.
 *
 * A refusal is recorded as a refusal and never blocks a scan. GPS corroborates;
 * the photograph is the evidence. Blocking a movement because a driver declined
 * location would make the app unusable indoors and teach drivers to grant
 * permissions they do not understand.
 */
export function currentFix(timeoutMs = 5000): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    )
  })
}
