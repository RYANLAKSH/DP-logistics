import { Link } from 'react-router-dom'
import { useConnectivity } from '@/lib/offline/connectivity'
import { useOutbox } from '@/lib/offline/useOutbox'

/**
 * Always visible in the driver's header.
 *
 * The one thing it must never do is imply that queued work is complete. A
 * pending count is shown as pending, in amber, with the word "sync" — never a
 * tick, never green.
 */
export function SyncIndicator() {
  const online = useConnectivity()
  const { pendingCount, syncing } = useOutbox()

  if (online === 'offline') {
    return (
      <Link
        to="/driver/sync"
        className="flex items-center gap-1.5 rounded-full bg-warn-500 px-3 py-1
                   text-xs font-bold uppercase tracking-wide text-white"
      >
        <span aria-hidden="true">⚡</span>
        Offline{pendingCount > 0 && ` · ${pendingCount}`}
      </Link>
    )
  }

  if (syncing || pendingCount > 0) {
    return (
      <Link
        to="/driver/sync"
        className="flex items-center gap-1.5 rounded-full bg-warn-100 px-3 py-1
                   text-xs font-bold uppercase tracking-wide text-warn-500"
      >
        <span aria-hidden="true">↻</span>
        {syncing ? 'Syncing' : `${pendingCount} pending sync`}
      </Link>
    )
  }

  return (
    <Link to="/driver/sync" aria-label="Everything is synced">
      <span className="flex items-center gap-1.5 rounded-full bg-ok-100 px-3 py-1
                       text-xs font-bold uppercase tracking-wide text-ok-500">
        <span aria-hidden="true">●</span>
        Synced
      </span>
    </Link>
  )
}
