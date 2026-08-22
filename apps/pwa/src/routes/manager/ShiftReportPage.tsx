import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ManagerShell } from '@/components/Layout'
import { SlotDots } from '@/components/Progress'
import { EmptyState, ErrorState, Spinner } from '@/components/States'
import { useData } from '@/data/provider'
import { useSession } from '@/lib/session'
import { dateLong } from '@/lib/format'

/**
 * Shift close.
 *
 * This screen exists for one thing: a container sealed with one vehicle
 * instead of two. Every scan for it passed, every movement was correct, and
 * nothing in the verification flow can see the problem — only the aggregate
 * can, and only if somebody looks. So it names the missing chassis, not just a
 * count, because a number tells a manager something is wrong and a chassis
 * number tells them where to go.
 */
export function ShiftReportPage() {
  const data = useData()
  const { profile } = useSession()
  const yards = useQuery({ queryKey: ['yards'], queryFn: () => data.listYards() })
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [yardId, setYardId] = useState<string | null>(null)

  const activeYard = yardId
    ?? yards.data?.find((y) => profile?.yardIds.includes(y.id))?.id
    ?? yards.data?.[0]?.id ?? null

  const report = useQuery({
    queryKey: ['shift-report', activeYard, date],
    queryFn: () => data.getShiftReport(activeYard!, date),
    enabled: Boolean(activeYard),
  })

  return (
    <ManagerShell title="Shift close" subtitle={dateLong(date)}>
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
                {yards.data?.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Date
              </span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                     className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm" />
            </label>
          </div>
        </Card>

        {report.isLoading && <Spinner label="Reconciling the shift" />}
        {report.error && (
          <ErrorState
            detail={report.error instanceof Error ? report.error.message : 'Could not load the report.'}
            onRetry={() => void report.refetch()}
          />
        )}

        {report.data && (
          <>
            <Card
              className={report.data.partiallyLoaded.length > 0
                ? 'border-2 border-bad-500' : 'border-2 border-ok-500'}
            >
              <CardHeader
                title={report.data.partiallyLoaded.length > 0
                  ? `${report.data.partiallyLoaded.length} container${report.data.partiallyLoaded.length === 1 ? '' : 's'} partially loaded`
                  : 'Every started container is complete'}
                subtitle="Every scan for these passed. Only the total reveals the problem"
              />
              {report.data.partiallyLoaded.length === 0 ? (
                <p className="text-sm text-ink-700">
                  No container was left with fewer vehicles than the manifest assigns it.
                </p>
              ) : (
                <ul className="divide-y divide-line/15">
                  {report.data.partiallyLoaded.map((c) => (
                    <li key={c.containerNo} className="py-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <SlotDots filled={c.loaded} capacity={c.expected} />
                        <span className="code font-bold text-ink-900">{c.containerNo}</span>
                        <span className="text-sm text-ink-600">
                          {c.loaded} of {c.expected}
                          {c.bayPosition && ` · ${c.bayPosition}`}
                        </span>
                      </div>
                      <div className="mt-2 pl-1">
                        <p className="text-xs font-semibold uppercase tracking-wider text-bad-500">
                          Not loaded
                        </p>
                        {c.missing.map((chassis) => (
                          <CodeValue key={chassis} value={chassis} size="sm" />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <Stat label="Vehicles moved" value={report.data.completed} />
              <Stat label="Containers not started" value={report.data.notStarted} />
              <Stat label="Exceptions still open" value={report.data.openExceptions}
                    tone={report.data.openExceptions > 0 ? 'bad' : undefined} />
              <Stat
                label="Overrides"
                value={report.data.overrides?.count ?? 0}
                suffix={report.data.overrides ? `${report.data.overrides.ratePercent}%` : undefined}
                tone={(report.data.overrides?.ratePercent ?? 0) > 5 ? 'bad' : undefined}
              />
              <Stat label="Typed in by hand" value={report.data.manualEntries}
                    tone={report.data.manualEntries > 0 ? 'warn' : undefined} />
            </div>

            {report.data.clockAnomalies > 0 && (
              <Card className="border-2 border-warn-500 bg-warn-100">
                <p className="font-semibold text-warn-500">
                  {report.data.clockAnomalies} movement
                  {report.data.clockAnomalies === 1 ? '' : 's'} with an unusual device clock
                </p>
                <p className="mt-1 text-sm text-ink-700">
                  A device reporting a time well off the server's is usually a wrong
                  timezone. A cluster of them is worth a closer look — it is the signature
                  of movements recorded in a batch after the fact rather than at the ramp.
                </p>
              </Card>
            )}

            {report.data.partiallyLoaded.length === 0
              && report.data.openExceptions === 0
              && report.data.notStarted === 0 && (
              <EmptyState
                title="Shift reconciles"
                detail="Every container assigned today is complete, nothing is outstanding, and no exception is open."
              />
            )}
          </>
        )}
      </div>
    </ManagerShell>
  )
}

function Stat({
  label, value, suffix, tone,
}: { label: string; value: number; suffix?: string; tone?: 'bad' | 'warn' }) {
  const colour = tone === 'bad' ? 'text-bad-500'
    : tone === 'warn' ? 'text-warn-500' : 'text-ink-900'
  return (
    <Card>
      <p className={`text-3xl font-bold ${colour}`}>
        {value}{suffix && <span className="ml-1 text-lg font-semibold">{suffix}</span>}
      </p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-ink-600">
        {label}
      </p>
    </Card>
  )
}
