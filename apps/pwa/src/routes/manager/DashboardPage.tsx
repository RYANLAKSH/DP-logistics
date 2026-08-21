import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { ProgressBar, SlotDots } from '@/components/Progress'
import { EmptyState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { dateLong, timeOfDay } from '@/lib/format'

const YARD = 'yard-nsa'

export function DashboardPage() {
  const data = useData()
  const counters = useQuery({
    queryKey: ['dashboard', YARD],
    queryFn: () => data.getDashboard(YARD),
  })
  const activity = useQuery({
    queryKey: ['activity', YARD],
    queryFn: () => data.listActivity(YARD),
  })
  const assignments = useQuery({
    queryKey: ['assignments', YARD],
    queryFn: () => data.listAssignments(YARD),
  })

  const containers = groupByContainer(assignments.data ?? [])

  return (
    <ManagerShell
      title="Nhava Sheva"
      subtitle={dateLong(new Date().toISOString())}
      action={
        // Phase 10 replaces this with a live Supabase Realtime indicator.
        <span className="rounded-full bg-idle-100 px-3 py-1 text-xs font-semibold
                         uppercase tracking-wide text-idle-500">
          ◌ Live updates — phase 10
        </span>
      }
    >
      {counters.isLoading && <Spinner />}

      {counters.data && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Vehicles scheduled" value={counters.data.vehiclesScheduled} />
            <Metric label="Completed" value={counters.data.vehiclesCompleted} tone="ok" />
            <Metric label="Pending" value={counters.data.vehiclesPending} />
            <Metric
              label="Open exceptions"
              value={counters.data.openExceptions}
              tone={counters.data.openExceptions > 0 ? 'bad' : undefined}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Vehicle progress" />
              <ProgressBar
                value={counters.data.vehiclesCompleted}
                total={counters.data.vehiclesScheduled}
                tone="ok"
                label="Vehicles moved"
              />
              <div className="mt-4">
                <ProgressBar
                  value={counters.data.containersCompleted}
                  total={counters.data.containersScheduled}
                  label="Containers complete"
                />
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Containers"
                subtitle="A half-filled container is the error no single scan can catch"
              />
              <ul className="divide-y divide-line/15">
                {containers.map((c) => (
                  <li key={c.containerId} className="flex items-center gap-3 py-2.5">
                    <SlotDots filled={c.filled} capacity={c.capacity} />
                    <span className="code min-w-0 flex-1 truncate text-sm font-semibold">
                      {c.containerNo}
                    </span>
                    <span className="text-sm text-ink-600">
                      {c.filled} / {c.capacity}
                    </span>
                    <StatusBadge
                      status={c.filled >= c.capacity ? 'COMPLETED' : c.filled > 0 ? 'IN_PROGRESS' : 'PENDING'}
                      size="sm"
                    />
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          <Card>
            <CardHeader title="Activity" subtitle="Newest first" />
            {activity.isLoading && <Spinner />}
            {activity.data?.length === 0 && (
              <EmptyState title="Nothing yet today" detail="Movements and exceptions appear here as they happen." />
            )}
            <ul className="divide-y divide-line/15">
              {activity.data?.slice(0, 12).map((item) => (
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
                    <span className="flex items-center gap-2 text-sm text-bad-500">
                      <StatusBadge status="EXCEPTION" size="sm" />
                      {item.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </ManagerShell>
  )
}

function Metric({
  label, value, tone,
}: { label: string; value: number; tone?: 'ok' | 'bad' }) {
  const colour =
    tone === 'ok' ? 'text-ok-500' : tone === 'bad' ? 'text-bad-500' : 'text-ink-900'
  return (
    <Card>
      <p className={`text-4xl font-bold ${colour}`}>{value}</p>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-ink-600">
        {label}
      </p>
    </Card>
  )
}

function groupByContainer(assignments: Array<{
  containerId: string; containerNo: string; expectedVehicleCount: number; status: string
}>) {
  const map = new Map<string, { containerId: string; containerNo: string; capacity: number; filled: number }>()
  for (const a of assignments) {
    const entry = map.get(a.containerId) ?? {
      containerId: a.containerId,
      containerNo: a.containerNo,
      capacity: a.expectedVehicleCount,
      filled: 0,
    }
    if (a.status === 'COMPLETED') entry.filled += 1
    map.set(a.containerId, entry)
  }
  return [...map.values()].sort((a, b) => a.containerNo.localeCompare(b.containerNo))
}
