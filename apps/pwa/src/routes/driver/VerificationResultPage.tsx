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
import { capturesFor, enqueue } from '@/lib/offline/outbox'
import { connectivity } from '@/lib/offline/connectivity'
import { currentFix } from '@/lib/geolocation'

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
  const [overrideNote, setOverrideNote] = useState('')
  const [overrideAsked, setOverrideAsked] = useState(false)
  const [overrideSent, setOverrideSent] = useState(false)

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
        containerAttemptId: draft.containerAttemptId,
        chassisAttemptId: draft.chassisAttemptId,
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
      const captures = await capturesFor(assignmentId)
      const allUploaded = captures.length >= 2 && captures.every((c) => c.uploaded)

      // Offline, or evidence still on the phone: queue it. Do NOT report a
      // completion the server has not made. A green tick here would train
      // drivers to trust a screen that can be wrong, which is worse than
      // having no app at all.
      if (connectivity() === 'offline' || !allUploaded) {
        await enqueue({
          id: draft.movementId,
          assignmentId,
          containerNo: result?.expectedContainerNo ?? draft.containerValue,
          chassisNo: result?.expectedChassisNo ?? draft.chassisValue,
          scannedContainerNo: draft.containerValue,
          scannedChassisNo: draft.chassisValue,
          images: captures.map((c) => ({
            kind: c.kind,
            blob: c.blob,
            attemptId: c.attemptId,
            scannedValue: c.scannedValue,
            ocrTextRaw: c.ocrTextRaw,
            ocrConfidence: c.ocrConfidence,
            ocrEngine: c.ocrEngine,
            source: c.source,
            uploaded: c.uploaded,
          })),
          gps: await currentFix(),
        })
        setResult({
          ...result!,
          status: 'PENDING_SYNC',
        })
        clearScanDraft(assignmentId)
        queryClient.removeQueries({ queryKey: ['driver'] })
        return
      }

      const r = await data.verifyMovement({
        assignmentId,
        scannedContainerNo: draft.containerValue,
        scannedChassisNo: draft.chassisValue,
        containerAttemptId: draft.containerAttemptId,
        chassisAttemptId: draft.chassisAttemptId,
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

  /**
   * Request an override.
   *
   * The driver asks; they cannot grant. Approval happens in the manager's own
   * authenticated session, on the manager's own device — not by a code read
   * over the radio, which would reduce dual control to "the manager told me
   * the number once".
   */
  async function askForOverride() {
    if (!result?.exceptionId) return
    setConfirming(true)
    try {
      await data.requestOverride(result.exceptionId, overrideNote)
      setOverrideSent(true)
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
  const queued = result.status === 'PENDING_SYNC'

  return (
    <DriverShell
      title={
        queued ? 'Saved on this phone'
        : passed ? (awaitingConfirmation ? 'Verified' : 'Moved')
        : 'Blocked'
      }
      subtitle={assignment?.containerNo}
    >
      <div className="flex flex-1 flex-col gap-4">
        <div
          className={`rounded-card px-5 py-8 text-center ${
            queued ? 'bg-warn-500 text-white'
            : passed ? 'bg-ok-500 text-white'
            : 'bg-bad-500 text-white'
          }`}
          role="status"
          aria-live="assertive"
        >
          <p className="text-6xl leading-none" aria-hidden="true">
            {queued ? '↻' : passed ? '✓' : '✕'}
          </p>
          <p className="mt-3 text-hero font-bold tracking-tight">
            {queued ? 'PENDING SYNC' : passed ? 'VERIFIED' : 'DO NOT LOAD'}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-white/90">
            {queued
              ? 'Saved on this phone. This movement is NOT complete until the server confirms it — check Sync before you finish your shift.'
              : awaitingConfirmation
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

              {overrideSent ? (
                <p className="rounded-lg bg-info-100 px-3 py-3 text-sm text-ink-900">
                  Sent. Your manager will review the photographs and decide. Wait here —
                  do not load the vehicle.
                </p>
              ) : overrideAsked ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="mb-1 block text-sm font-semibold text-ink-700">
                      Why should this be allowed?
                    </span>
                    <textarea
                      rows={3}
                      value={overrideNote}
                      onChange={(e) => setOverrideNote(e.target.value)}
                      className="w-full rounded-lg border-2 border-line/40 px-3 py-2 text-base"
                    />
                  </label>
                  <p className="text-xs text-ink-600">
                    Only a manager can approve this, from their own device. You cannot
                    approve it yourself.
                  </p>
                  <Button
                    disabled={confirming || overrideNote.trim().length < 10}
                    onClick={() => void askForOverride()}
                  >
                    {confirming ? 'Sending…' : 'Send the request'}
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setOverrideAsked(true)}>
                  Ask a manager to authorise this
                </Button>
              )}
            </div>
          </Card>
        )}

        <ActionBar>
          {queued ? (
            <>
              <Link to="/driver"><Button hero>Next pickup</Button></Link>
              <Link to="/driver/sync">
                <Button variant="secondary" className="w-full">See what is pending</Button>
              </Link>
            </>
          ) : passed && awaitingConfirmation ? (
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
