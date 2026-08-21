import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ActionBar, DriverShell } from '@/components/Layout'
import { Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { useScanDraft } from '@/lib/scanDraft'

type Kind = 'container' | 'chassis'

/**
 * The capture screen.
 *
 * PHASE 3: the camera and OCR are not built yet (phase 7). This screen renders
 * the real frame, the alignment guide and the confirm/manual-entry flow, with a
 * simulated read, so the interaction can be reviewed and the surrounding
 * workflow can be finished first. Phase 7 replaces the simulate button with
 * getUserMedia and a Tesseract worker; nothing else on this screen changes.
 *
 * The expected value stays visible throughout. Hiding it to make the driver
 * read "blind" sounds more rigorous and is worse in practice: they end up
 * cross-checking against a paper sheet, which is the process being replaced.
 * Verification integrity comes from the photograph and the server-side
 * comparison, not from keeping the driver ignorant.
 */
export function ScanPage({ kind }: { kind: Kind }) {
  const { assignmentId = '' } = useParams()
  const navigate = useNavigate()
  const data = useData()
  const draft = useScanDraft(assignmentId)

  const { data: assignment, isLoading } = useQuery({
    queryKey: ['assignment', assignmentId],
    queryFn: () => data.getAssignment(assignmentId),
  })

  const [reading, setReading] = useState(false)
  const [candidate, setCandidate] = useState<string | null>(
    kind === 'container' ? draft.containerValue ?? null : draft.chassisValue ?? null,
  )
  const [manual, setManual] = useState(false)
  const [typed, setTyped] = useState('')

  const expected = kind === 'container' ? assignment?.containerNo : assignment?.chassisNo
  const label = kind === 'container' ? 'Container number' : 'Chassis number'

  function simulateRead(value: string) {
    setReading(true)
    window.setTimeout(() => {
      setCandidate(value)
      setReading(false)
    }, 700)
  }

  function accept(value: string, source: 'OCR_AUTO' | 'MANUAL_ENTRY') {
    draft.update(
      kind === 'container'
        ? { containerValue: value, containerSource: source }
        : { chassisValue: value, chassisSource: source },
    )
    navigate(`/driver/pickup/${assignmentId}`)
  }

  function onManualSubmit(e: FormEvent) {
    e.preventDefault()
    if (typed.trim()) accept(typed.trim().toUpperCase(), 'MANUAL_ENTRY')
  }

  return (
    <DriverShell
      title={`Scan ${kind}`}
      subtitle="Hold the plate inside the frame"
      back={`/driver/pickup/${assignmentId}`}
    >
      {isLoading && <Spinner />}

      {assignment && (
        <div className="space-y-4">
          {/* Camera viewport. Phase 7 renders a live <video> here. */}
          <div className="relative aspect-4/3 overflow-hidden rounded-card bg-ink-950">
            <div className="absolute inset-0 flex items-center justify-center">
              <div
                className="relative h-24 w-11/12 rounded-lg border-4 border-brand-500"
                aria-hidden="true"
              >
                <span className="absolute inset-x-0 top-1/2 h-px bg-brand-500/40" />
              </div>
            </div>
            <p className="absolute inset-x-0 bottom-3 text-center text-sm text-paper/70">
              {reading ? 'Reading…' : 'Camera preview — phase 7'}
            </p>
            {reading && (
              <div className="absolute right-3 top-3">
                <StatusBadge status="SCANNING" size="sm" />
              </div>
            )}
          </div>

          <Card>
            <CodeValue label={`Expected ${label.toLowerCase()}`} value={expected ?? ''} />
          </Card>

          {candidate && (
            <Card
              className={
                candidate === expected
                  ? 'border-2 border-ok-500 bg-ok-100'
                  : 'border-2 border-warn-500 bg-warn-100'
              }
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-ink-700">
                  Detected
                </span>
                <StatusBadge
                  status={candidate === expected ? 'READY' : 'MISMATCH'}
                  size="sm"
                />
              </div>
              <CodeValue value={candidate} size="lg" />
              <p className="mt-2 text-sm text-ink-700">
                {candidate === expected
                  ? 'This matches the assignment. Confirm to continue.'
                  : 'This does not match what the manifest expects. Retake, or continue and the server will decide.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => accept(candidate, 'OCR_AUTO')}>Confirm</Button>
                <Button variant="secondary" onClick={() => setCandidate(null)}>
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
                    Type the {label.toLowerCase()}
                  </span>
                  <input
                    autoFocus
                    value={typed}
                    onChange={(e) => setTyped(e.target.value.toUpperCase())}
                    className="code w-full rounded-lg border-2 border-line/40 px-3 py-3
                               text-lg tracking-widest focus:border-ink-900"
                    aria-describedby="manual-help"
                  />
                </label>
                <p id="manual-help" className="mt-2 text-sm text-ink-600">
                  A photograph is still required. Typing the value is recorded as manual
                  entry and is visible to your manager.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button type="submit" disabled={!typed.trim()}>Use this value</Button>
                  <Button type="button" variant="ghost" onClick={() => setManual(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}

          <ActionBar>
            {!candidate && !manual && (
              <>
                <Button hero disabled={reading} onClick={() => simulateRead(expected ?? '')}>
                  {reading ? 'Reading…' : 'Capture'}
                </Button>
                {/* Phase 3 affordance so the blocked paths can be reviewed. */}
                <Button
                  variant="secondary"
                  onClick={() =>
                    simulateRead(kind === 'container' ? 'CULVNSA2601796' : 'MAT111222A1B00001')
                  }
                >
                  Simulate a wrong plate
                </Button>
              </>
            )}
            {!manual && (
              <Button variant="ghost" onClick={() => setManual(true)}>
                Type it instead
              </Button>
            )}
          </ActionBar>
        </div>
      )}
    </DriverShell>
  )
}
