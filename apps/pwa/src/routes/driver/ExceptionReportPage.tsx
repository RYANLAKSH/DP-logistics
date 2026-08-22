import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { ActionBar, DriverShell } from '@/components/Layout'
import { useData } from '@/data/provider'
import type { ExceptionType } from '@/data/types'

/**
 * A taxonomy first, free text second.
 *
 * "Other" with a text box is easy to build and produces data nobody can act on.
 * Named reasons are what let a manager see that eleven container plates were
 * unreadable this week, which is a yard maintenance job, not eleven incidents.
 */
const REASONS: Array<{ type: ExceptionType; label: string; detail: string }> = [
  { type: 'DAMAGED_CONTAINER_MARKING', label: 'Container number unreadable',
    detail: 'Painted over, damaged or obscured' },
  { type: 'DAMAGED_CHASSIS_MARKING', label: 'Chassis plate unreadable',
    detail: 'Corroded, dirty or inaccessible' },
  { type: 'MISSING_VEHICLE', label: 'Vehicle is not in the yard',
    detail: 'Cannot find the assigned vehicle' },
  { type: 'VEHICLE_UNAVAILABLE', label: 'Vehicle cannot be moved',
    detail: 'Blocked in, will not start, damaged' },
  { type: 'CONTAINER_FULL', label: 'Container is already full',
    detail: 'Someone has loaded out of sequence' },
  { type: 'OCR_FAILURE', label: 'Scanning keeps failing',
    detail: 'The app cannot read either plate' },
  { type: 'OTHER', label: 'Something else', detail: 'Describe it below' },
]

export function ExceptionReportPage() {
  const { assignmentId = '' } = useParams()
  const navigate = useNavigate()
  const data = useData()
  const [type, setType] = useState<ExceptionType | null>(null)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const needsText = type === 'OTHER'
  const canSubmit = type != null && (!needsText || description.trim().length > 5)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!type) return
    setBusy(true)
    try {
      await data.raiseException({ assignmentId, type, description: description.trim() })
      navigate('/driver', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <DriverShell
      title="Report an issue"
      subtitle="Your manager will pick this up"
      back={`/driver/pickup/${assignmentId}`}
    >
      <form onSubmit={onSubmit} className="flex flex-1 flex-col gap-3">
        <fieldset>
          <legend className="mb-2 text-sm font-bold uppercase tracking-widest text-ink-600">
            What is wrong?
          </legend>
          <ul className="space-y-2">
            {REASONS.map((r) => (
              <li key={r.type}>
                <label
                  className={`flex min-h-touch cursor-pointer items-start gap-3 rounded-card
                              border-2 p-4 ${
                                type === r.type
                                  ? 'border-ink-900 bg-white'
                                  : 'border-line/25 bg-white'
                              }`}
                >
                  <input
                    type="radio"
                    name="reason"
                    className="mt-1 h-5 w-5"
                    checked={type === r.type}
                    onChange={() => setType(r.type)}
                  />
                  <span>
                    <span className="block font-semibold text-ink-900">{r.label}</span>
                    <span className="block text-sm text-ink-600">{r.detail}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <Card>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">
              Anything else your manager should know{needsText ? '' : ' (optional)'}
            </span>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-2 text-base
                         focus:border-ink-900"
            />
          </label>
        </Card>

        <p className="text-sm text-ink-600">
          Reporting an issue does not complete the movement. The vehicle stays where it is
          until your manager responds.
        </p>

        <ActionBar>
          <Button hero type="submit" disabled={!canSubmit || busy}>
            {busy ? 'Sending…' : 'Send to manager'}
          </Button>
        </ActionBar>
      </form>
    </DriverShell>
  )
}
