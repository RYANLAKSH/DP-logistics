import { Button } from '@/components/Button'
import { Card, CardHeader } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { DriverShell } from '@/components/Layout'
import { EmptyState } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useConnectivity } from '@/lib/offline/connectivity'
import { useOutbox } from '@/lib/offline/useOutbox'
import { isStale } from '@/lib/offline/outbox'
import { db, type OutboxItem } from '@/lib/offline/db'
import { relativeTime } from '@/lib/format'
import type { StatusKey } from '@/lib/status'

/**
 * The screen a driver opens when something feels wrong.
 *
 * It is therefore detailed and honest rather than reassuring: per-item state,
 * per-item error, how much storage the queue is using, and when the last
 * successful sync was. A vague "everything's fine" here is how a driver ends
 * up finishing a shift with six unsynced movements.
 */
const STATE_LABEL: Record<OutboxItem['state'], { status: StatusKey; text: string }> = {
  queued:     { status: 'PENDING_SYNC', text: 'Waiting for a connection' },
  uploading:  { status: 'PENDING_SYNC', text: 'Sending the photographs' },
  verifying:  { status: 'PENDING_SYNC', text: 'Waiting for the server’s decision' },
  confirmed:  { status: 'COMPLETED',    text: 'Confirmed by the server' },
  rejected:   { status: 'MISMATCH',     text: 'The server refused this movement' },
  conflict:   { status: 'EXCEPTION',    text: 'Someone else completed this vehicle' },
  failed:     { status: 'EXCEPTION',    text: 'Could not reach the server' },
}

export function SyncPage() {
  const online = useConnectivity()
  const { items, pendingCount, syncing, usage, storageWarning, storageBlocked, sync, refresh } =
    useOutbox()

  const megabytes = usage ? (usage.usedBytes / (1024 * 1024)).toFixed(1) : null

  return (
    <DriverShell title="Sync" subtitle="What is on this phone" back="/driver">
      <div className="flex flex-1 flex-col gap-4">
        <Card
          className={
            online === 'offline' ? 'border-2 border-warn-500 bg-warn-100'
            : pendingCount > 0 ? 'border-2 border-warn-500'
            : 'border-2 border-ok-500 bg-ok-100'
          }
        >
          <p className="text-lg font-bold text-ink-900">
            {online === 'offline'
              ? 'You are offline'
              : pendingCount > 0
                ? `${pendingCount} movement${pendingCount === 1 ? '' : 's'} waiting to sync`
                : 'Everything is synced'}
          </p>
          <p className="mt-1 text-sm text-ink-700">
            {online === 'offline'
              ? 'You can keep scanning. Movements are saved on this phone and sent when signal returns — they are not complete until the server confirms them.'
              : pendingCount > 0
                ? 'These are saved on this phone. They are not complete until the server confirms them.'
                : 'Every movement on this phone has been confirmed by the server.'}
          </p>
          {online !== 'offline' && pendingCount > 0 && (
            <Button className="mt-3" disabled={syncing} onClick={() => void sync()}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </Card>

        {storageBlocked && (
          <Card className="border-2 border-bad-500 bg-bad-100">
            <p className="font-bold text-bad-500">This phone is nearly out of space</p>
            <p className="mt-1 text-sm text-ink-700">
              New photographs cannot be saved. Find signal and sync before scanning again —
              photographs that cannot be saved would leave movements without evidence.
            </p>
          </Card>
        )}
        {storageWarning && !storageBlocked && (
          <Card className="border-2 border-warn-500 bg-warn-100">
            <p className="font-semibold text-warn-500">Storage is filling up</p>
            <p className="mt-1 text-sm text-ink-700">
              {megabytes} MB of queued photographs. Sync when you next have signal.
            </p>
          </Card>
        )}

        {items.length === 0 ? (
          <EmptyState
            title="Nothing queued"
            detail="Movements appear here between being scanned and being confirmed by the server."
          />
        ) : (
          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-ink-600">
              Queue
            </h2>
            <ul className="space-y-2">
              {items.map((item) => {
                const meta = STATE_LABEL[item.state]
                  ?? { status: 'PENDING_SYNC' as const, text: 'Waiting' }
                const stale = isStale(item)
                return (
                  <Card as="li" key={item.id} className={stale ? 'border-2 border-bad-500' : ''}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CodeValue label="Container" value={item.containerNo} size="sm" />
                        <div className="mt-1">
                          <CodeValue label="Chassis" value={item.chassisNo} size="sm" />
                        </div>
                      </div>
                      <StatusBadge status={meta.status} size="sm" />
                    </div>
                    <p className="mt-2 text-sm text-ink-700">{meta.text}</p>
                    <p className="text-xs text-ink-600">
                      Queued {relativeTime(item.queuedAt)}
                      {item.attempts > 0 && ` · ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`}
                    </p>
                    {item.lastError && (
                      <p className="mt-1 rounded bg-paper px-2 py-1 text-xs text-ink-600">
                        {item.lastError}
                      </p>
                    )}
                    {stale && (
                      <p className="mt-2 rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
                        This has been waiting more than a day. Show it to your manager —
                        a movement may have happened with no record of it.
                      </p>
                    )}
                  </Card>
                )
              })}
            </ul>
          </section>
        )}

        <Card>
          <CardHeader title="This device" />
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
                Storage used
              </dt>
              <dd className="font-medium">{megabytes ? `${megabytes} MB` : 'unknown'}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
                Protected from clearing
              </dt>
              <dd className="font-medium">
                {usage?.persisted ? 'Yes' : 'No — sync often'}
              </dd>
            </div>
          </dl>
          <Button variant="ghost" className="mt-3" onClick={() => void refresh()}>
            Refresh
          </Button>
        </Card>

        {/* Deliberately last: clearing confirmed items is safe, clearing
            anything else is not, so only confirmed items can be cleared. */}
        {items.some((i) => i.state === 'confirmed') && (
          <Button
            variant="ghost"
            onClick={() => {
              void db.outbox.where('state').equals('confirmed').delete().then(refresh)
            }}
          >
            Clear confirmed items
          </Button>
        )}
      </div>
    </DriverShell>
  )
}
