import { useEffect, useState } from 'react'
import { currentFix, permissionState, type GeoState } from '@/lib/geolocation'
import { Button } from './Button'

/**
 * Explains why location is asked for, and what happens if it is refused.
 *
 * Shown before the first scan rather than as a bare browser prompt with no
 * context. A permission dialog that arrives unexplained gets denied, and a
 * driver who denies it once has denied it for good.
 */
export function LocationNotice() {
  const [state, setState] = useState<GeoState>('unknown')
  const [asking, setAsking] = useState(false)

  useEffect(() => { void permissionState().then(setState) }, [])

  if (state === 'granted' || state === 'unsupported') return null

  async function ask() {
    setAsking(true)
    const fix = await currentFix()
    setState(fix ? 'granted' : 'denied')
    setAsking(false)
  }

  return (
    <div className="rounded-card border border-line/25 bg-white p-4">
      <p className="font-semibold text-ink-900">
        {state === 'denied' ? 'Location is switched off' : 'Share your location?'}
      </p>
      <p className="mt-1 text-sm text-ink-700">
        Each scan records where it was taken, so a movement can be shown to have happened
        in this yard. It is read only when you scan — you are not tracked between tasks.
      </p>
      <p className="mt-2 text-sm text-ink-600">
        You can carry on without it. Scans will be recorded as “location not shared”.
      </p>
      {state !== 'denied' && (
        <Button variant="secondary" className="mt-3" disabled={asking} onClick={() => void ask()}>
          {asking ? 'Asking…' : 'Share my location'}
        </Button>
      )}
    </div>
  )
}
