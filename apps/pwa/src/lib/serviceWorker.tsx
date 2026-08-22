import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { Button } from '@/components/Button'

/**
 * Registers the service worker, and prompts before applying an update.
 *
 * Prompting rather than auto-reloading is a hard requirement, not a
 * preference: a worker that activates mid-scan and reloads the page destroys
 * an in-progress capture, and the driver has no idea why the photograph they
 * just took has gone.
 */
export function useServiceWorker() {
  const [updateReady, setUpdateReady] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)
  const [apply, setApply] = useState<(() => void) | null>(null)

  useEffect(() => {
    const update = registerSW({
      immediate: true,
      onNeedRefresh() {
        setUpdateReady(true)
        setApply(() => () => update(true))
      },
      onOfflineReady() { setOfflineReady(true) },
    })
  }, [])

  return { updateReady, offlineReady, apply }
}

export function UpdateBanner() {
  const { updateReady, apply } = useServiceWorker()
  const [dismissed, setDismissed] = useState(false)

  if (!updateReady || dismissed) return null

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-info-500 px-4 py-2 text-white">
      <div className="mx-auto flex max-w-2xl items-center gap-3 text-sm">
        <span className="flex-1">A new version is ready.</span>
        <Button
          variant="secondary"
          className="min-h-9 px-3 py-1 text-sm"
          onClick={() => apply?.()}
        >
          Update now
        </Button>
        <button
          onClick={() => setDismissed(true)}
          className="text-white/80 underline"
        >
          Later
        </button>
      </div>
    </div>
  )
}
