import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ActionBar, DriverShell } from '@/components/Layout'
import { SlotDots } from '@/components/Progress'
import { ErrorState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { useScanDraft } from '@/lib/scanDraft'

/**
 * The task screen — and the control that prevents the first risk in the brief.
 *
 * The driver reads what they are supposed to collect BEFORE any camera opens.
 * Picking up the wrong vehicle is prevented here, in words, not later by a scan.
 */
export function PickupDetailPage() {
  const { assignmentId = '' } = useParams()
  const data = useData()
  const draft = useScanDraft(assignmentId)

  const { data: assignment, isLoading, error, refetch } = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => data.getAssignment(assignmentId),
  })

  const bothScanned = Boolean(draft.containerValue && draft.chassisValue)

  return (
    <DriverShell title="Pickup" subtitle="Read this before you start" back="/driver">
      {isLoading && <Spinner />}
      {error && <ErrorState detail="Could not load this task." onRetry={() => void refetch()} />}

      {assignment && (
        <div className="space-y-4">
          <Card className="border-2 border-ink-900">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-widest text-ink-600">
                Collect
              </span>
              <StatusBadge status={bothScanned ? 'READY' : 'PENDING'} size="sm" />
            </div>

            <div className="space-y-5">
              <div>
                <CodeValue label="Container" value={assignment.containerNo} size="lg" />
                {assignment.bayPosition && (
                  <p className="mt-1 text-sm font-medium text-ink-700">
                    {assignment.bayPosition}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 text-sm text-ink-600">
                  <SlotDots
                    filled={assignment.containerFilled}
                    capacity={assignment.expectedVehicleCount}
                  />
                  <span>
                    {assignment.containerFilled} of {assignment.expectedVehicleCount} loaded
                  </span>
                </div>
              </div>

              <div className="border-t border-line/20 pt-4">
                <CodeValue label="Vehicle chassis" value={assignment.chassisNo} size="lg" />
                <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                  {assignment.makeModel && <Detail term="Model" value={assignment.makeModel} />}
                  {assignment.colour && <Detail term="Colour" value={assignment.colour} />}
                  {assignment.vehicleRegNo && (
                    <Detail term="Registration" value={assignment.vehicleRegNo} />
                  )}
                  <Detail
                    term="Slot"
                    value={`${assignment.sequenceNo} of ${assignment.expectedVehicleCount}`}
                  />
                </dl>
              </div>
            </div>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <ScanTile
              to={`/driver/pickup/${assignment.id}/scan/container`}
              label="Scan container"
              value={draft.containerValue}
            />
            <ScanTile
              to={`/driver/pickup/${assignment.id}/scan/chassis`}
              label="Scan chassis"
              value={draft.chassisValue}
            />
          </div>

          <p className="text-center text-sm text-ink-600">
            You can scan them in either order.
          </p>

          <ActionBar>
            <Link to={`/driver/pickup/${assignment.id}/result`} aria-disabled={!bothScanned}>
              <Button hero disabled={!bothScanned}>
                {bothScanned ? 'Verify vehicle' : 'Scan both to continue'}
              </Button>
            </Link>
            <Link to={`/driver/pickup/${assignment.id}/exception`}>
              <Button variant="ghost" className="w-full">
                I can’t do this task
              </Button>
            </Link>
          </ActionBar>
        </div>
      )}
    </DriverShell>
  )
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">{term}</dt>
      <dd className="font-medium text-ink-900">{value}</dd>
    </div>
  )
}

function ScanTile({
  to, label, value,
}: { to: string; label: string; value?: string }) {
  return (
    <Link
      to={to}
      className={`flex min-h-touch flex-col justify-center gap-1 rounded-card border-2 p-4
                  ${value ? 'border-ok-500 bg-ok-100' : 'border-ink-900 bg-white'}`}
    >
      <span className="flex items-center gap-2 font-semibold text-ink-900">
        <span aria-hidden="true">{value ? '✓' : '⛶'}</span>
        {label}
      </span>
      {value
        ? <span className="code text-sm text-ink-700">{value}</span>
        : <span className="text-sm text-ink-600">Not scanned yet</span>}
    </Link>
  )
}
