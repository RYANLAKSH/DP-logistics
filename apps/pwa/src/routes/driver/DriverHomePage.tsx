import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { DriverShell } from '@/components/Layout'
import { ProgressBar, SlotDots } from '@/components/Progress'
import { EmptyState, ErrorState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { dateLong } from '@/lib/format'
import { pickNextAssignment } from '@/data/nextAssignment'
import { useSession, useSignOut } from '@/lib/session'
import { SyncIndicator } from '@/components/SyncIndicator'
import { useOcr } from '@/lib/ocr/provider'
import { useEffect } from 'react'

export function DriverHomePage() {
  const data = useData()
  const { profile } = useSession()
  const signOut = useSignOut()
  const ocr = useOcr()

  // Download and start the OCR engine at shift start, while there is still
  // signal. Waiting until the first shutter means the first scan of the day
  // happens in whatever connectivity the driver has at that moment — which,
  // between two stacks of containers, is often none.
  useEffect(() => { void ocr.initialize().catch(() => {}) }, [ocr])

  const { data: assignments, isLoading, error, refetch } = useQuery({
    queryKey: ['driver', 'assignments'],
    queryFn: () => data.listMyAssignments(),
  })

  const total = assignments?.length ?? 0
  const done = assignments?.filter((a) => a.status === 'COMPLETED').length ?? 0
  const blocked = assignments?.filter((a) => a.status === 'EXCEPTION').length ?? 0
  const pending = total - done - blocked
  // The driver does not pick. Work is handed out one at a time, in loading
  // order, skipping anything parked by an exception.
  const next = pickNextAssignment(assignments ?? [])

  return (
    <DriverShell
      title={`Today · ${dateLong(new Date().toISOString())}`}
      subtitle={profile ? `${profile.fullName} · Nhava Sheva` : undefined}
      action={
        <div className="flex items-center gap-3">
          <SyncIndicator />
          <button
            onClick={signOut}
            className="inline-flex min-h-11 items-center text-sm text-paper/70 underline"
          >
            Sign out
          </button>
        </div>
      }
    >
      {isLoading && <Spinner label="Loading your assignments" />}
      {error && <ErrorState detail="Could not load your assignments." onRetry={() => void refetch()} />}

      {assignments && (
        <div className="space-y-5">
          <Card>
            <div className="mb-4 grid grid-cols-3 gap-3 text-center">
              <Stat label="Vehicles" value={total} />
              <Stat label="Completed" value={done} tone="ok" />
              <Stat label="Pending" value={pending} />
            </div>
            <ProgressBar value={done} total={total} label="Shift progress" tone="ok" />
            {blocked > 0 && (
              <p className="mt-3 rounded-lg bg-bad-100 px-3 py-2 text-sm font-medium text-bad-500">
                {blocked} {blocked === 1 ? 'task is' : 'tasks are'} blocked and waiting on
                your manager.
              </p>
            )}
          </Card>

          {next ? (
            <Card className="border-2 border-ink-900">
              <p className="mb-3 text-xs font-bold uppercase tracking-widest text-ink-600">
                Next pickup
              </p>

              <div className="space-y-4">
                <div>
                  <CodeValue label="Container" value={next.containerNo} size="lg" />
                  {next.bayPosition && (
                    <p className="mt-1 text-sm text-ink-600">{next.bayPosition}</p>
                  )}
                </div>

                <div className="flex items-center gap-3 text-sm text-ink-700">
                  <SlotDots filled={next.containerFilled} capacity={next.expectedVehicleCount} />
                  <span>
                    Vehicle {next.sequenceNo} of {next.expectedVehicleCount}
                  </span>
                </div>

                <div>
                  <CodeValue label="Chassis" value={next.chassisNo} size="lg" />
                  {(next.makeModel || next.colour) && (
                    <p className="mt-1 text-sm text-ink-600">
                      {[next.makeModel, next.colour].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
              </div>

              <Link to={`/driver/pickup/${next.id}`} className="mt-5 block">
                <Button hero>Start this pickup</Button>
              </Link>
            </Card>
          ) : (
            <EmptyState
              title="Nothing left to move"
              detail={
                total === 0
                  ? 'No manifest has been published for your yard today. Your manager publishes it at the start of the shift.'
                  : 'Every vehicle assigned to you today has been moved and verified.'
              }
              action={<Link to="/driver/completed"><Button variant="secondary">View completed</Button></Link>}
            />
          )}

          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-ink-600">
              Remaining today
            </h2>
            {/* Shown, not offered. Tasks are handed out in order — a driver who
                could pick from this list could pick the wrong vehicle, which is
                the first risk the product exists to remove. */}
            <ul className="space-y-2">
              {assignments
                .filter((a) => a.status !== 'COMPLETED')
                .map((a) => (
                  <li
                    key={a.id}
                    className={`flex items-center gap-3 rounded-card border p-3 ${
                      a.id === next?.id
                        ? 'border-ink-900 bg-white'
                        : 'border-line/25 bg-white/60'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <CodeValue value={a.containerNo} size="sm" />
                      <CodeValue value={a.chassisNo} size="sm" />
                    </div>
                    <StatusBadge
                      status={
                        a.status === 'EXCEPTION' ? 'EXCEPTION'
                        : a.id === next?.id ? 'READY'
                        : 'PENDING'
                      }
                      size="sm"
                    />
                  </li>
                ))}
            </ul>
            <p className="mt-2 text-sm text-ink-600">
              Vehicles are loaded in this order. If you cannot take the next one, open it
              and report why — the one after it will then be released to you.
            </p>
          </section>

          <Link to="/driver/completed" className="block">
            <Button variant="secondary" hero>Completed jobs ({done})</Button>
          </Link>
        </div>
      )}
    </DriverShell>
  )
}

function Stat({
  label, value, tone,
}: { label: string; value: number; tone?: 'ok' }) {
  return (
    <div>
      <p className={`text-3xl font-bold ${tone === 'ok' ? 'text-ok-500' : 'text-ink-900'}`}>
        {value}
      </p>
      <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">{label}</p>
    </div>
  )
}
