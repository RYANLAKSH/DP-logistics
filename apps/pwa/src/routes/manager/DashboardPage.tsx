import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { ProgressBar, SlotDots } from '@/components/Progress'
import { EmptyState, ErrorState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { useActiveYard } from '@/lib/useActiveYard'
import { dateLong, relativeTime, timeOfDay } from '@/lib/format'
import type { ConnectionState } from '@/lib/realtime'
import type { ActivityItem } from '@/data/types'

type FeedFilter = 'ALL' | 'MOVEMENTS' | 'EXCEPTIONS'

export function DashboardPage() {
  const data = useData()
  const queryClient = useQueryClient()

  const { yardId: activeYard, setYardId, yards } = useActiveYard()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date())
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('ALL')
  const [driverFilter, setDriverFilter] = useState('ALL')
  const [containerQuery, setContainerQuery] = useState('')

  const board = useQuery({
    queryKey: ['board', activeYard, date],
    queryFn: () => data.getBoard(activeYard!, date),
    enabled: Boolean(activeYard),
    // Realtime is the primary signal. This is the fallback for the case that
    // matters most: a socket that looks connected and is not.
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  })

  useEffect(() => {
    if (!activeYard) return
    // Event invalidates, query fetches. The payload is never rendered.
    const unsubscribe = data.subscribeToYard(
      activeYard,
      () => {
        setLastUpdate(new Date())
        void queryClient.invalidateQueries({ queryKey: ['board', activeYard] })
        void queryClient.invalidateQueries({ queryKey: ['exceptions'] })
      },
      setConnection,
    )
    return unsubscribe
  }, [activeYard, data, queryClient])

  useEffect(() => { if (board.dataUpdatedAt) setLastUpdate(new Date(board.dataUpdatedAt)) },
    [board.dataUpdatedAt])

  const feed = useMemo(() => {
    if (!board.data) return []
    const items: ActivityItem[] =
      feedFilter === 'MOVEMENTS' ? board.data.activity
      : feedFilter === 'EXCEPTIONS' ? board.data.exceptionFeed
      : [...board.data.activity, ...board.data.exceptionFeed]
    const needle = containerQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    return items
      .filter((i) => driverFilter === 'ALL' || i.actorName === driverFilter)
      .filter((i) => !needle
        || (i.containerNo ?? '').toUpperCase().includes(needle)
        || (i.chassisNo ?? '').toUpperCase().includes(needle))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 40)
  }, [board.data, feedFilter, driverFilter, containerQuery])

  const drivers = useMemo(() => {
    if (!board.data) return []
    return [...new Set([...board.data.activity, ...board.data.exceptionFeed]
      .map((i) => i.actorName))].sort()
  }, [board.data])

  const containers = useMemo(() => {
    const needle = containerQuery.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    return (board.data?.containers ?? [])
      .filter((c) => !needle || c.container_no.toUpperCase().includes(needle))
  }, [board.data, containerQuery])

  const counters = board.data?.counters
  const containersComplete = containers.filter((c) => c.filled >= c.capacity).length

  return (
    <ManagerShell
      title={yards.find((y) => y.id === activeYard)?.name ?? 'Board'}
      subtitle={dateLong(date)}
      action={<ConnectionBadge state={connection} lastUpdate={lastUpdate} />}
    >
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Yard
              </span>
              <select
                value={activeYard ?? ''}
                onChange={(e) => setYardId(e.target.value)}
                className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
              >
                {yards.map((y) => (
                  <option key={y.id} value={y.id}>{y.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Date
              </span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
              />
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Container or chassis
              </span>
              <input
                value={containerQuery}
                onChange={(e) => setContainerQuery(e.target.value)}
                placeholder="Search"
                className="w-full max-w-xs rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </Card>

        {board.isLoading && <Spinner label="Loading the board" />}
        {board.error && (
          <ErrorState
            detail={board.error instanceof Error ? board.error.message : 'The board could not be loaded.'}
            onRetry={() => void board.refetch()}
          />
        )}

        {counters && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Vehicles scheduled" value={counters.vehiclesScheduled} />
              <Metric label="Completed" value={counters.vehiclesCompleted} tone="ok" />
              <Metric label="Pending" value={counters.vehiclesPending} />
              <Metric
                label="Open exceptions"
                value={board.data!.openExceptions}
                tone={board.data!.openExceptions > 0 ? 'bad' : undefined}
                to="/manager/exceptions"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Progress" />
                <ProgressBar
                  value={counters.vehiclesCompleted}
                  total={counters.vehiclesScheduled}
                  tone="ok"
                  label="Vehicles moved"
                />
                <div className="mt-4">
                  <ProgressBar
                    value={containersComplete}
                    total={containers.length}
                    label="Containers complete"
                  />
                </div>
                <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line/15 pt-4 text-sm">
                  <Mini term="In progress" value={counters.vehiclesInProgress} />
                  <Mini term="Blocked" value={counters.vehiclesException} />
                  <Mini term="Active drivers" value={counters.activeDrivers} />
                </dl>
              </Card>

              <Card>
                <CardHeader
                  title="Containers"
                  subtitle="A half-filled container is the error no single scan can catch"
                />
                {containers.length === 0 ? (
                  <EmptyState
                    title="No containers"
                    detail="No manifest is published for this yard and date."
                  />
                ) : (
                  <ul className="max-h-80 divide-y divide-line/15 overflow-y-auto">
                    {containers.map((c) => (
                      <li key={c.container_no} className="flex items-center gap-3 py-2.5">
                        <SlotDots filled={c.filled} capacity={c.capacity} />
                        <span className="code min-w-0 flex-1 truncate text-sm font-semibold">
                          {c.container_no}
                        </span>
                        <span className="text-sm text-ink-600">
                          {c.filled} / {c.capacity}
                        </span>
                        <StatusBadge
                          status={
                            c.filled >= c.capacity ? 'COMPLETED'
                            : c.filled > 0 ? 'IN_PROGRESS'
                            : 'PENDING'
                          }
                          size="sm"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <Card>
              <CardHeader
                title="Activity"
                subtitle="Newest first"
                right={
                  <div className="flex flex-wrap gap-2">
                    {(['ALL', 'MOVEMENTS', 'EXCEPTIONS'] as const).map((f) => (
                      <button
                        key={f}
                        onClick={() => setFeedFilter(f)}
                        className={`min-h-11 rounded-full border px-4 text-xs font-semibold ${
                          feedFilter === f
                            ? 'border-ink-900 bg-ink-900 text-paper'
                            : 'border-line/30 bg-white text-ink-700'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                    <select
                      aria-label="Filter the feed by driver"
                      value={driverFilter}
                      onChange={(e) => setDriverFilter(e.target.value)}
                      className="min-h-11 rounded-full border border-line/30 px-3 text-xs"
                    >
                      <option value="ALL">All drivers</option>
                      {drivers.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                }
              />
              {feed.length === 0 ? (
                <EmptyState
                  title="Nothing yet"
                  detail="Movements and exceptions appear here the moment they happen."
                />
              ) : (
                <ul className="divide-y divide-line/15">
                  {feed.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                      <span className="code w-16 shrink-0 text-sm text-ink-600">
                        {timeOfDay(item.occurredAt)}
                      </span>
                      <span className="font-medium text-ink-900">{item.actorName}</span>
                      {item.kind === 'MOVEMENT' ? (
                        <span className="text-sm text-ink-700">
                          verified <span className="code">{item.chassisNo}</span>
                          {' → '}
                          <span className="code">{item.containerNo}</span>
                        </span>
                      ) : (
                        <Link
                          to="/manager/exceptions"
                          className="flex min-h-11 items-center gap-2 text-sm text-bad-500 underline"
                        >
                          <StatusBadge status="EXCEPTION" size="sm" />
                          {item.detail}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </div>
    </ManagerShell>
  )
}

/**
 * The connection state, stated honestly.
 *
 * A dashboard that silently goes stale is worse than one that says so: a
 * manager may believe a truck has been stopped when it has not. When the
 * socket is not live, the badge says when the data is actually from.
 */
function ConnectionBadge({
  state, lastUpdate,
}: { state: ConnectionState; lastUpdate: Date }) {
  const meta = {
    live: { text: 'Live', tone: 'bg-ok-100 text-ok-500', icon: '●' },
    connecting: { text: 'Connecting', tone: 'bg-idle-100 text-idle-500', icon: '◌' },
    reconnecting: { text: 'Reconnecting', tone: 'bg-warn-100 text-warn-500', icon: '◌' },
    offline: { text: 'Not live', tone: 'bg-warn-100 text-warn-500', icon: '✕' },
  }[state]

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs
                  font-semibold uppercase tracking-wide ${meta.tone}`}
      role="status"
    >
      <span aria-hidden="true">{meta.icon}</span>
      {meta.text}
      {state !== 'live' && (
        <span className="font-normal normal-case opacity-80">
          · showing data from {relativeTime(lastUpdate.toISOString())}
        </span>
      )}
    </span>
  )
}

function Metric({
  label, value, tone, to,
}: { label: string; value: number; tone?: 'ok' | 'bad'; to?: string }) {
  const colour =
    tone === 'ok' ? 'text-ok-500' : tone === 'bad' ? 'text-bad-500' : 'text-ink-900'
  const body = (
    <Card className={to ? 'transition hover:border-ink-900' : ''}>
      <p className={`text-4xl font-bold ${colour}`}>{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-ink-600">
        {label}
      </p>
    </Card>
  )
  return to ? <Link to={to}>{body}</Link> : body
}

function Mini({ term, value }: { term: string; value: number }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">{term}</dt>
      <dd className="text-xl font-bold text-ink-900">{value}</dd>
    </div>
  )
}
