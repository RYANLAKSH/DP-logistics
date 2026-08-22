import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { ManagerShell } from '@/components/Layout'
import { EmptyState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { relativeTime } from '@/lib/format'
import { EvidenceAttemptCard } from '@/components/Evidence'
import type { ExceptionRecord } from '@/data/types'

const RESOLUTIONS = [
  { code: 'CORRECTED_AND_RESCANNED', label: 'Driver corrected and rescanned',
    effect: 'Releases the task back to the driver' },
  { code: 'MANIFEST_AMENDED', label: 'Manifest was wrong — amended',
    effect: 'The task stays blocked until the amendment is published' },
  { code: 'MANUAL_ENTRY_AUTHORISED', label: 'Authorised manual entry',
    effect: 'Releases the task; the typed value is marked as authorised' },
  { code: 'TASK_REASSIGNED', label: 'Reassigned to another driver',
    effect: 'The task stays blocked for this driver' },
  { code: 'VEHICLE_RESCHEDULED', label: 'Vehicle rescheduled',
    effect: 'Cancels the assignment for today' },
  { code: 'NO_ACTION_REQUIRED', label: 'No action required',
    effect: 'Releases the task back to the driver' },
  { code: 'FALSE_ALARM', label: 'Raised in error',
    effect: 'Releases the task. Counts towards the false-alarm rate' },
]

/**
 * Overrides are NOT in the list above, deliberately.
 *
 * An override lets a vehicle be loaded into a container the manifest did not
 * assign — the one operation that defeats the product's core control. It has
 * its own action, its own reason codes, and dual control enforced in the
 * database. Offering it as a dropdown entry alongside "no action required"
 * would make the most serious decision on this screen the easiest one to make.
 */
const OVERRIDE_REASONS = [
  { code: 'LAST_MINUTE_SUBSTITUTION', label: 'Last-minute substitution' },
  { code: 'MANIFEST_ERROR', label: 'The manifest is wrong' },
  { code: 'DAMAGED_PLATE', label: 'Plate damaged or unreadable' },
  { code: 'OPERATIONAL_EXCEPTION', label: 'Operational exception' },
  { code: 'OTHER', label: 'Other (explain below)' },
]

export function ExceptionsPage() {
  const data = useData()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ExceptionRecord | null>(null)

  const { data: exceptions, isLoading } = useQuery({
    queryKey: ['exceptions', 'yard-nsa'],
    queryFn: () => data.listExceptions('yard-nsa'),
  })

  const [error, setError] = useState<string | null>(null)

  function afterChange() {
    setSelected(null)
    setError(null)
    void queryClient.invalidateQueries({ queryKey: ['exceptions'] })
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    void queryClient.invalidateQueries({ queryKey: ['assignments'] })
    void queryClient.invalidateQueries({ queryKey: ['activity'] })
  }

  const resolve = useMutation({
    mutationFn: ({ id, code, note }: { id: string; code: string; note: string }) =>
      data.resolveException(id, code, note),
    onSuccess: afterChange,
    onError: (e) => setError(e instanceof Error ? e.message : 'That could not be saved.'),
  })

  const override = useMutation({
    mutationFn: ({ id, reason, note }: { id: string; reason: string; note: string }) =>
      data.approveOverride(id, reason, note),
    onSuccess: afterChange,
    onError: (e) => setError(e instanceof Error ? e.message : 'That could not be approved.'),
  })

  const open = exceptions?.filter((x) => x.status === 'OPEN' || x.status === 'UNDER_REVIEW') ?? []
  const closed = exceptions?.filter((x) => x.status === 'RESOLVED' || x.status === 'CANCELLED') ?? []

  return (
    <ManagerShell title="Exceptions" subtitle="Blocked movements and reported issues">
      {isLoading && <Spinner />}

      {exceptions && (
        <div className="grid gap-5 xl:grid-cols-[1fr_24rem]">
          <div className="space-y-5">
            <section>
              <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-ink-600">
                Open ({open.length})
              </h2>
              {open.length === 0 ? (
                <EmptyState
                  title="Nothing open"
                  detail="Blocked movements arrive here the moment the server refuses them."
                />
              ) : (
                <ul className="space-y-2">
                  {open.map((x) => (
                    <ExceptionRow key={x.id} record={x} onSelect={setSelected} selected={selected?.id === x.id} />
                  ))}
                </ul>
              )}
            </section>

            {closed.length > 0 && (
              <section>
                <h2 className="mb-2 text-sm font-bold uppercase tracking-widest text-ink-600">
                  Resolved ({closed.length})
                </h2>
                <ul className="space-y-2">
                  {closed.map((x) => (
                    <ExceptionRow key={x.id} record={x} onSelect={setSelected} selected={selected?.id === x.id} />
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside>
            {selected ? (
              <ResolvePanel
                record={selected}
                busy={resolve.isPending || override.isPending}
                error={error}
                onResolve={(code, note) =>
                  resolve.mutate({ id: selected.id, code, note })
                }
                onOverride={(reason, note) =>
                  override.mutate({ id: selected.id, reason, note })
                }
                onClose={() => { setSelected(null); setError(null) }}
              />
            ) : (
              <Card>
                <p className="text-sm text-ink-600">
                  Select an exception to see the evidence and resolve it. Resolution always
                  records a reason — history is appended to, never edited.
                </p>
              </Card>
            )}
          </aside>
        </div>
      )}
    </ManagerShell>
  )
}

function ExceptionRow({
  record, onSelect, selected,
}: {
  record: ExceptionRecord
  onSelect: (r: ExceptionRecord) => void
  selected: boolean
}) {
  return (
    <li>
      <button
        onClick={() => onSelect(record)}
        className={`w-full rounded-card border-2 bg-white p-4 text-left ${
          selected ? 'border-ink-900' : 'border-line/25 hover:border-ink-600'
        }`}
      >
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            status={record.status === 'RESOLVED' ? 'COMPLETED' : 'EXCEPTION'}
            size="sm"
          />
          <span className="font-semibold text-ink-900">
            {record.type.replaceAll('_', ' ').toLowerCase()}
          </span>
          <span className="ml-auto text-sm text-ink-600">
            {relativeTime(record.raisedAt)}
          </span>
        </div>
        {record.expectedValue && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <CodeValue label="Expected" value={record.expectedValue} size="sm" />
            <CodeValue label="Scanned" value={record.actualValue ?? '—'} size="sm" />
          </div>
        )}
        {record.description && (
          <p className="mt-2 text-sm text-ink-700">{record.description}</p>
        )}
        <p className="mt-2 text-sm text-ink-600">Raised by {record.raisedByName}</p>
      </button>
    </li>
  )
}

function ResolvePanel({
  record, onResolve, onOverride, onClose, busy, error,
}: {
  record: ExceptionRecord
  onResolve: (code: string, note: string) => void
  onOverride: (reason: string, note: string) => void
  onClose: () => void
  busy: boolean
  error: string | null
}) {
  const [code, setCode] = useState(RESOLUTIONS[0]!.code)
  const [note, setNote] = useState('')
  const [overrideMode, setOverrideMode] = useState(false)
  const [overrideReason, setOverrideReason] = useState(OVERRIDE_REASONS[0]!.code)
  const done = record.status === 'RESOLVED' || record.status === 'CANCELLED'
  const effect = RESOLUTIONS.find((r) => r.code === code)?.effect

  return (
    <Card className="sticky top-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-lg font-bold">
          {record.type.replaceAll('_', ' ').toLowerCase()}
        </h2>
        <button onClick={onClose} aria-label="Close" className="text-xl text-ink-600">×</button>
      </div>

      <ExceptionEvidence exceptionId={record.id} />

      {done ? (
        <div className="rounded-lg bg-ok-100 px-3 py-3 text-sm">
          <p className="font-semibold text-ok-500">Resolved</p>
          <p className="mt-1 text-ink-700">{record.resolution}</p>
          {record.resolutionNote && (
            <p className="mt-1 text-ink-700">{record.resolutionNote}</p>
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => { e.preventDefault(); onResolve(code, note) }}
          className="space-y-3"
        >
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">Resolution</span>
            <select
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-2.5 text-base
                         focus:border-ink-900"
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">Note</span>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-2 text-sm
                         focus:border-ink-900"
            />
          </label>

          <p className="text-xs text-ink-600">{effect}</p>

          {error && (
            <p role="alert" className="rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
              {error}
            </p>
          )}

          <Button type="submit" disabled={busy || note.trim().length < 5}>
            {busy ? 'Saving…' : 'Resolve'}
          </Button>
        </form>
      )}

      {!done && record.overrideRequested && !overrideMode && (
        <div className="mt-4 rounded-lg border-2 border-warn-500 bg-warn-100 px-3 py-3">
          <p className="font-semibold text-warn-500">An override has been requested</p>
          <p className="mt-1 text-sm text-ink-700">
            Approving lets this vehicle be loaded into a container the manifest did not
            assign it to. It is recorded permanently against your name, and it counts
            towards your yard's override rate.
          </p>
          <Button variant="danger" className="mt-3" onClick={() => setOverrideMode(true)}>
            Review the override
          </Button>
        </div>
      )}

      {!done && overrideMode && (
        <form
          className="mt-4 space-y-3 rounded-lg border-2 border-bad-500 bg-bad-100 p-3"
          onSubmit={(e) => { e.preventDefault(); onOverride(overrideReason, note) }}
        >
          <p className="font-semibold text-bad-500">Authorise this movement</p>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">Reason</span>
            <select
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-2.5 text-base"
            >
              {OVERRIDE_REASONS.map((r) => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">
              What did you check?
            </span>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
            />
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-white px-3 py-2 text-sm text-bad-500">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="danger" type="submit" disabled={busy || note.trim().length < 10}>
              {busy ? 'Approving…' : 'Approve the override'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOverrideMode(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}


/**
 * The photographs behind an exception.
 *
 * Fetched only when a manager opens the panel, and every fetch is audited
 * server-side. Loading evidence for a whole queue would log a hundred views
 * nobody made, which would make the access log useless as chain of custody.
 */
function ExceptionEvidence({ exceptionId }: { exceptionId: string }) {
  const data = useData()
  const { data: evidence, isLoading, isError } = useQuery({
    queryKey: ['exception-evidence', exceptionId],
    queryFn: () => data.getExceptionEvidence(exceptionId),
  })

  if (isLoading) return <Spinner label="Loading the evidence" />
  if (isError) {
    return (
      <p className="mb-4 rounded-lg bg-warn-100 px-3 py-2 text-sm text-warn-500">
        The evidence could not be loaded.
      </p>
    )
  }
  if (!evidence?.attempts.length) {
    return (
      <p className="mb-4 rounded-lg border border-dashed border-line/40 bg-paper px-3
                    py-4 text-center text-sm text-ink-600">
        No photographs are attached to this exception.
      </p>
    )
  }
  return (
    <div className="mb-4 space-y-3">
      {evidence.attempts.map((a) => (
        <EvidenceAttemptCard key={a.id} attempt={a} />
      ))}
    </div>
  )
}
