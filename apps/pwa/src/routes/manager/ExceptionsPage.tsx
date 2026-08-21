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
import type { ExceptionRecord } from '@/data/types'

const RESOLUTIONS = [
  { code: 'CORRECTED_AND_RESCANNED', label: 'Driver corrected and rescanned' },
  { code: 'MANIFEST_AMENDED', label: 'Manifest was wrong — amended' },
  { code: 'MANUAL_ENTRY_AUTHORISED', label: 'Authorised manual entry' },
  { code: 'TASK_REASSIGNED', label: 'Reassigned to another driver' },
  { code: 'VEHICLE_RESCHEDULED', label: 'Vehicle rescheduled' },
  { code: 'NO_ACTION_REQUIRED', label: 'No action required' },
  { code: 'FALSE_ALARM', label: 'Raised in error' },
]

export function ExceptionsPage() {
  const data = useData()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ExceptionRecord | null>(null)

  const { data: exceptions, isLoading } = useQuery({
    queryKey: ['exceptions', 'yard-nsa'],
    queryFn: () => data.listExceptions('yard-nsa'),
  })

  const resolve = useMutation({
    mutationFn: ({ id, code, note }: { id: string; code: string; note: string }) =>
      data.resolveException(id, code, note),
    onSuccess: () => {
      setSelected(null)
      void queryClient.invalidateQueries({ queryKey: ['exceptions'] })
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
    },
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
                busy={resolve.isPending}
                onResolve={(code, note) =>
                  resolve.mutate({ id: selected.id, code, note })
                }
                onClose={() => setSelected(null)}
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
  record, onResolve, onClose, busy,
}: {
  record: ExceptionRecord
  onResolve: (code: string, note: string) => void
  onClose: () => void
  busy: boolean
}) {
  const [code, setCode] = useState(RESOLUTIONS[0]!.code)
  const [note, setNote] = useState('')
  const done = record.status === 'RESOLVED' || record.status === 'CANCELLED'

  return (
    <Card className="sticky top-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="text-lg font-bold">
          {record.type.replaceAll('_', ' ').toLowerCase()}
        </h2>
        <button onClick={onClose} aria-label="Close" className="text-xl text-ink-600">×</button>
      </div>

      {/* Phase 11 renders the captured evidence here. */}
      <div className="mb-4 flex h-32 items-center justify-center rounded-lg border
                      border-dashed border-line/40 bg-paper text-sm text-ink-600">
        Evidence images — phase 11
      </div>

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

          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Resolve'}
          </Button>
        </form>
      )}
    </Card>
  )
}
