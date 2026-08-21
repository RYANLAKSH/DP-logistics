import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ActionBar, DriverShell } from '@/components/Layout'
import { SlotDots } from '@/components/Progress'
import { Spinner } from '@/components/States'
import { useData } from '@/data/provider'
import type { VerificationResult } from '@/data/types'
import { diffPositions } from '@/lib/format'
import { OUTCOME_MESSAGE } from '@/lib/status'
import { clearScanDraft, useScanDraft } from '@/lib/scanDraft'

/**
 * The verdict.
 *
 * The result comes from the data source, which in production is the server-side
 * verification function. The client computes nothing here — it renders what it
 * was told. A verdict this screen invented would be a verdict a driver could
 * change.
 */
export function VerificationResultPage() {
  const { assignmentId = '' } = useParams()
  const data = useData()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const draft = useScanDraft(assignmentId)
  const [result, setResult] = useState<VerificationResult | null>(null)
  const [submitting, setSubmitting] = useState(true)
  const [confirming, setConfirming] = useState(false)

  const { data: assignment } = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => data.getAssignment(assignmentId),
  })

  useEffect(() => {
    if (!draft.containerValue || !draft.chassisValue) {
      navigate(`/driver/pickup/${assignmentId}`, { replace: true })
      return
    }
    let cancelled = false
    // VERIFY VEHICLE. The server runs the full decision and records a block if
    // there is one, but does not record a movement: nothing has been loaded
    // yet, and a record that says otherwise would be a lie in the audit trail.
    void data
      .verifyMovement({
        assignmentId,
        scannedContainerNo: draft.containerValue,
        scannedChassisNo: draft.chassisValue,
        movementId: draft.movementId,
        commit: false,
      })
      .then((r) => {
        if (cancelled) return
        setResult(r)
        if (r.status === 'BLOCKED') {
          queryClient.removeQueries({ queryKey: ['driver'] })
          queryClient.removeQueries({ queryKey: ['assignment', assignmentId] })
        }
      })
      .finally(() => { if (!cancelled) setSubmitting(false) })
    return () => { cancelled = true }
    // Runs once per visit: this submits, and must not resubmit on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId])

  /**
   * CONFIRM VEHICLE MOVED — the driver asserting the physical act happened.
   *
   * This is the call that records the movement, so verified_at marks the load
   * rather than the scan. The server re-runs the entire decision here; the
   * check above is a courtesy to the driver, never a permission granted.
   */
  async function confirmMoved() {
    if (!draft.containerValue || !draft.chassisValue) return
    setConfirming(true)
    try {
      const r = await data.verifyMovement({
        assignmentId,
        scannedContainerNo: draft.containerValue,
        scannedChassisNo: draft.chassisValue,
        movementId: draft.movementId,
        commit: true,
      })
      setResult(r)
      // Drop the cached task list rather than marking it stale. Invalidating
      // would re-render the previous list while it refetches, and for a moment
      // the driver's next pickup would be the vehicle they just loaded.
      queryClient.removeQueries({ queryKey: ['driver'] })
      queryClient.removeQueries({ queryKey: ['assignment', assignmentId] })
      if (r.outcome === 'MATCH') clearScanDraft(assignmentId)
    } finally {
      setConfirming(false)
    }
  }

  if (submitting || !result) {
    return (
      <DriverShell title="Verifying" subtitle="Checking against the manifest">
        <Spinner label="Verifying with the server" />
      </DriverShell>
    )
  }

  const passed = result.outcome === 'MATCH'
  const awaitingConfirmation = result.status === 'READY_TO_CONFIRM'

  return (
    <DriverShell
      title={passed ? (awaitingConfirmation ? 'Verified' : 'Moved') : 'Blocked'}
      subtitle={assignment?.containerNo}
    >
      <div className="space-y-4">
        <div
          className={`rounded-card px-5 py-8 text-center ${
            passed ? 'bg-ok-500 text-white' : 'bg-bad-500 text-white'
          }`}
          role="status"
          aria-live="assertive"
        >
          <p className="text-6xl leading-none" aria-hidden="true">{passed ? '✓' : '✕'}</p>
          <p className="mt-3 text-hero font-bold tracking-tight">
            {passed ? 'VERIFIED' : 'DO NOT LOAD'}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-white/90">
            {awaitingConfirmation
              ? 'Both values match the manifest. Load the vehicle, then confirm.'
              : OUTCOME_MESSAGE[result.outcome] ?? result.outcome}
          </p>
        </div>

        {passed ? (
          <Card>
            <p className="mb-3 text-sm font-semibold text-ink-700">
              Loaded into this container
            </p>
            <CodeValue label="Container" value={result.expectedContainerNo} />
            <div className="mt-2">
              <CodeValue label="Chassis" value={result.expectedChassisNo} />
            </div>
            {result.containerCapacity != null && (
              <div className="mt-4 flex items-center gap-3 border-t border-line/20 pt-4">
                <SlotDots
                  filled={result.containerFilled ?? 0}
                  capacity={result.containerCapacity}
                />
                <span className="text-sm font-medium text-ink-700">
                  {result.containerFilled} of {result.containerCapacity} vehicles loaded
                </span>
              </div>
            )}
          </Card>
        ) : (
          <Card className="border-2 border-bad-500">
            <div className="space-y-4">
              <div>
                <CodeValue label="Manifest expects — container" value={result.expectedContainerNo} />
                <div className="mt-1">
                  <CodeValue
                    label="You scanned"
                    value={result.scannedContainerNo ?? '—'}
                    highlight={diffPositions(
                      result.scannedContainerNo ?? '',
                      result.expectedContainerNo,
                    )}
                  />
                </div>
              </div>

              <div className="border-t border-line/20 pt-4">
                <CodeValue label="Manifest expects — chassis" value={result.expectedChassisNo} />
                <div className="mt-1">
                  <CodeValue
                    label="You scanned"
                    value={result.scannedChassisNo ?? '—'}
                    highlight={diffPositions(
                      result.scannedChassisNo ?? '',
                      result.expectedChassisNo,
                    )}
                  />
                </div>
              </div>

              {result.scannedVehicleBelongsToContainer && (
                <p className="rounded-lg bg-warn-100 px-3 py-3 text-sm text-ink-900">
                  That vehicle is assigned to container{' '}
                  <strong className="code">{result.scannedVehicleBelongsToContainer}</strong>
                  {result.bayPosition && <> · {result.bayPosition}</>}.
                </p>
              )}

              <p className="text-sm font-medium text-ink-700">
                Your manager has been notified. This movement cannot be completed.
              </p>
            </div>
          </Card>
        )}

        <ActionBar>
          {passed && awaitingConfirmation ? (
            <>
              <Button hero onClick={() => void confirmMoved()} disabled={confirming}>
                {confirming ? 'Recording…' : 'Confirm vehicle moved'}
              </Button>
              <p className="text-center text-sm text-ink-600">
                Confirm once the vehicle is physically inside the container.
              </p>
            </>
          ) : passed ? (
            <Link to="/driver"><Button hero>Next pickup</Button></Link>
          ) : (
            <>
              <Link to={`/driver/pickup/${assignmentId}/scan/chassis`}>
                <Button hero>Rescan the vehicle</Button>
              </Link>
              <Link to={`/driver/pickup/${assignmentId}/exception`}>
                <Button variant="secondary" className="w-full">Report an issue</Button>
              </Link>
              <Link to="/driver">
                <Button variant="ghost" className="w-full">Back to today</Button>
              </Link>
            </>
          )}
        </ActionBar>
      </div>
    </DriverShell>
  )
}
