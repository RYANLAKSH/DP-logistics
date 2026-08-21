import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ActionBar, DriverShell } from '@/components/Layout'
import { ErrorState } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { openCamera, captureFrame, CameraError, type CameraHandle } from '@/lib/camera'
import { useOcr } from '@/lib/ocr/provider'
import { runScan, sourceFor, type ScanOutcome } from '@/lib/ocr/pipeline'
import { normalize } from '@/lib/ocr/normalize'
import { diffPositions } from '@/lib/format'
import { useScanDraft } from '@/lib/scanDraft'

type Kind = 'container' | 'chassis'

/** The alignment guide, and the region OCR actually reads. */
const ROI = { x: 0.06, y: 0.38, width: 0.88, height: 0.24 }

export function ScanPage({ kind }: { kind: Kind }) {
  const { assignmentId = '' } = useParams()
  const navigate = useNavigate()
  const data = useData()
  const ocr = useOcr()
  const draft = useScanDraft(assignmentId)

  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraRef = useRef<CameraHandle | null>(null)

  const [cameraError, setCameraError] = useState<CameraError | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null)
  const [pendingImage, setPendingImage] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [typed, setTyped] = useState('')
  const [torchOn, setTorchOn] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const { data: assignment } = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => data.getAssignment(assignmentId),
  })
  // Every other value of this kind on the manifest. The scoring rule needs the
  // whole set: a read is accepted only if it beats the runner-up clearly.
  const { data: allAssignments } = useQuery({
    queryKey: ['driver', 'assignments'],
    queryFn: () => data.listMyAssignments(),
  })

  const expected = kind === 'container' ? assignment?.containerNo : assignment?.chassisNo
  const others = (allAssignments ?? [])
    .map((a) => (kind === 'container' ? a.containerNo : a.chassisNo))
    .filter((v) => normalize(v) !== normalize(expected ?? ''))

  // Warm the engine when the screen opens, not at the shutter. A 2-second
  // pause after pressing capture reads as a broken app.
  useEffect(() => { void ocr.initialize().catch(() => {}) }, [ocr])

  useEffect(() => {
    let cancelled = false
    openCamera()
      .then((handle) => {
        if (cancelled) { handle.stop(); return }
        cameraRef.current = handle
        if (videoRef.current) {
          videoRef.current.srcObject = handle.stream
          void videoRef.current.play()
        }
        setReady(true)
      })
      .catch((e) => { if (!cancelled) setCameraError(e as CameraError) })
    return () => {
      cancelled = true
      cameraRef.current?.stop()
      cameraRef.current = null
    }
  }, [])

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const capture = useCallback(async () => {
    if (!videoRef.current || !expected) return
    setBusy(true)
    setSaveError(null)
    try {
      const shot = await captureFrame(videoRef.current, { roi: ROI })
      const result = await runScan(ocr, shot.ocrInput, { kind, expected, others })
      setOutcome(result)
      setPendingImage(shot.evidence)
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(shot.evidence)
      })
    } finally {
      setBusy(false)
    }
  }, [expected, kind, ocr, others])

  /**
   * Accepts a value and records the attempt.
   *
   * The photograph is uploaded whichever way the value was obtained. Typing it
   * in is a first-class path, not a way around the evidence requirement.
   */
  async function accept(value: string, typedIn: boolean) {
    if (!pendingImage || !outcome) return
    setBusy(true)
    setSaveError(null)
    const attemptId = crypto.randomUUID()
    try {
      await data.recordScan({
        attemptId,
        assignmentId,
        kind: kind === 'container' ? 'CONTAINER' : 'CHASSIS',
        scannedValue: value,
        image: pendingImage,
        ocrTextRaw: outcome.rawText ?? undefined,
        ocrConfidence: outcome.confidence,
        ocrEngine: outcome.engine,
        source: sourceFor(outcome, typedIn),
      })
      draft.update(
        kind === 'container'
          ? { containerValue: value, containerSource: sourceFor(outcome, typedIn),
              containerAttemptId: attemptId }
          : { chassisValue: value, chassisSource: sourceFor(outcome, typedIn),
              chassisAttemptId: attemptId },
      )
      navigate(`/driver/pickup/${assignmentId}`)
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : 'The photo could not be saved. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  function onManualSubmit(e: FormEvent) {
    e.preventDefault()
    const value = normalize(typed)
    if (value) void accept(value, true)
  }

  if (cameraError) return <CameraBlocked error={cameraError} assignmentId={assignmentId} />

  const label = kind === 'container' ? 'container number' : 'chassis number'
  const mismatch = outcome?.proposal
    && normalize(outcome.proposal) !== normalize(expected ?? '')

  return (
    <DriverShell
      title={`Scan ${kind}`}
      subtitle="Hold the plate inside the frame"
      back={`/driver/pickup/${assignmentId}`}
    >
      <div className="space-y-4">
        <div className="relative aspect-4/3 overflow-hidden rounded-card bg-ink-950">
          {previewUrl ? (
            <img src={previewUrl} alt="The photo just taken" className="h-full w-full object-cover" />
          ) : (
            <video
              ref={videoRef}
              playsInline
              muted
              className="h-full w-full object-cover"
              aria-label="Camera preview"
            />
          )}

          {!previewUrl && (
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <div
                className="absolute rounded-lg border-4 border-brand-500"
                style={{
                  left: `${ROI.x * 100}%`, top: `${ROI.y * 100}%`,
                  width: `${ROI.width * 100}%`, height: `${ROI.height * 100}%`,
                }}
              />
            </div>
          )}

          {!ready && !previewUrl && (
            <div className="absolute inset-0 flex items-center justify-center text-paper/70">
              Starting the camera…
            </div>
          )}

          {busy && (
            <div className="absolute right-3 top-3">
              <StatusBadge status="SCANNING" size="sm" />
            </div>
          )}

          {cameraRef.current?.hasTorch && !previewUrl && (
            <button
              onClick={() => {
                const next = !torchOn
                setTorchOn(next)
                void cameraRef.current?.setTorch(next)
              }}
              className="absolute bottom-3 right-3 rounded-full bg-ink-900/80 px-4 py-2
                         text-sm font-semibold text-paper"
            >
              {torchOn ? 'Light off' : 'Light on'}
            </button>
          )}
        </div>

        <Card>
          <CodeValue label={`Expected ${label}`} value={expected ?? ''} />
        </Card>

        {outcome && (
          <Card
            className={
              outcome.accepted ? 'border-2 border-ok-500 bg-ok-100'
              : 'border-2 border-warn-500 bg-warn-100'
            }
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-widest text-ink-700">
                {outcome.proposal ? 'Detected' : 'Could not read it'}
              </span>
              <StatusBadge status={outcome.accepted ? 'READY' : 'MISMATCH'} size="sm" />
            </div>

            {outcome.proposal && (
              <CodeValue
                value={outcome.proposal}
                size="lg"
                highlight={mismatch ? diffPositions(outcome.proposal, expected ?? '') : undefined}
              />
            )}

            <p className="mt-2 text-sm text-ink-700">{outcome.message}</p>

            {outcome.repaired && (
              // Never silently modified: the correction is stated, and the
              // original is kept in the record.
              <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-ink-700">
                Read as <span className="code">{outcome.rawText}</span> and corrected using the
                number format. Check it before confirming.
              </p>
            )}

            {outcome.confidence > 0 && (
              <p className="mt-1 text-xs text-ink-600">
                Confidence {Math.round(outcome.confidence * 100)}%
              </p>
            )}

            {saveError && (
              <p role="alert" className="mt-3 rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
                {saveError}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              {outcome.proposal && (
                <Button disabled={busy} onClick={() => void accept(outcome.proposal!, false)}>
                  {outcome.accepted ? 'Confirm' : 'Use this value anyway'}
                </Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => {
                setOutcome(null); setPendingImage(null)
                setPreviewUrl((old) => { if (old) URL.revokeObjectURL(old); return null })
              }}>
                Retake
              </Button>
            </div>
          </Card>
        )}

        {manual && (
          <Card>
            <form onSubmit={onManualSubmit}>
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-ink-700">
                  Type the {label}
                </span>
                <input
                  autoFocus
                  value={typed}
                  onChange={(e) => setTyped(e.target.value.toUpperCase())}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="code w-full rounded-lg border-2 border-line/40 px-3 py-3
                             text-lg tracking-widest focus:border-ink-900"
                  aria-describedby="manual-help"
                />
              </label>
              {typed && expected && (
                <p className="mt-2 text-sm">
                  {normalize(typed) === normalize(expected)
                    ? <span className="font-semibold text-ok-500">Matches the assignment</span>
                    : <span className="text-warn-500">Does not match yet</span>}
                </p>
              )}
              <p id="manual-help" className="mt-2 text-sm text-ink-600">
                A photograph is still required. Typing the value is recorded as manual
                entry and is visible to your manager.
              </p>
              <div className="mt-3 flex gap-2">
                <Button type="submit" disabled={!typed.trim() || !pendingImage || busy}>
                  Use this value
                </Button>
                <Button type="button" variant="ghost" onClick={() => setManual(false)}>
                  Cancel
                </Button>
              </div>
              {!pendingImage && (
                <p className="mt-2 text-sm text-warn-500">
                  Take the photo first — the evidence is required either way.
                </p>
              )}
            </form>
          </Card>
        )}

        <ActionBar>
          {!outcome && (
            <Button hero disabled={!ready || busy} onClick={() => void capture()}>
              {busy ? 'Reading…' : 'Capture'}
            </Button>
          )}
          {!manual && (
            <Button variant="ghost" onClick={() => setManual(true)}>
              Type it instead
            </Button>
          )}
        </ActionBar>
      </div>
    </DriverShell>
  )
}

/**
 * Camera refused or unavailable.
 *
 * Explains why it is needed and how to grant it, per browser. The movement
 * cannot proceed without it, because the photograph IS the evidence — but the
 * driver is not left stuck: they can report the problem instead.
 */
function CameraBlocked({
  error, assignmentId,
}: { error: CameraError; assignmentId: string }) {
  const navigate = useNavigate()
  return (
    <DriverShell title="Camera" back={`/driver/pickup/${assignmentId}`}>
      <ErrorState detail={error.message} />
      <Card className="mt-4">
        <h2 className="text-lg font-bold">Why the camera is needed</h2>
        <p className="mt-2 text-sm text-ink-700">
          The photograph of the plate is the evidence that the right vehicle went into
          the right container. Without it a movement cannot be completed — not even by
          typing the number, because anyone can type a number.
        </p>
        {error.kind === 'denied' && (
          <div className="mt-4 text-sm text-ink-700">
            <p className="font-semibold">To allow it again</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li><strong>Android, Chrome:</strong> tap the lock icon in the address bar → Permissions → Camera → Allow.</li>
              <li><strong>iPhone, Safari:</strong> Settings → Safari → Camera → Allow, then reload.</li>
              <li><strong>Installed app:</strong> your phone’s Settings → Apps → DP Verify → Permissions.</li>
            </ul>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Button
            variant="secondary"
            onClick={() => navigate(`/driver/pickup/${assignmentId}/exception`)}
          >
            Report the problem
          </Button>
        </div>
      </Card>
    </DriverShell>
  )
}
