import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ManagerShell } from '@/components/Layout'
import { SlotDots } from '@/components/Progress'
import { Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'
import { assignmentStatusKey } from '@/lib/status'
import { useActiveYard } from '@/lib/useActiveYard'

const FILTERS = ['ALL', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'EXCEPTION'] as const

export function AssignmentsPage() {
  const data = useData()
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL')
  const [query, setQuery] = useState('')

  const { yardId } = useActiveYard()

  const { data: assignments, isLoading } = useQuery({
    queryKey: ['assignments', yardId],
    queryFn: () => data.listAssignments(yardId!),
    enabled: Boolean(yardId),
  })

  const rows = useMemo(() => {
    const needle = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    return (assignments ?? []).filter((a) => {
      if (filter !== 'ALL' && a.status !== filter) return false
      if (!needle) return true
      return (
        a.containerNo.toUpperCase().includes(needle) ||
        a.chassisNo.toUpperCase().includes(needle)
      )
    })
  }, [assignments, filter, query])

  return (
    <ManagerShell title="Assignments" subtitle="Today’s published manifest">
      {isLoading && <Spinner />}

      {assignments && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
                  filter === f
                    ? 'border-ink-900 bg-ink-900 text-paper'
                    : 'border-line/30 bg-white text-ink-700 hover:border-ink-900'
                }`}
              >
                {f.replace('_', ' ')}
              </button>
            ))}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search container or chassis"
              className="ml-auto w-full max-w-xs rounded-lg border-2 border-line/40 px-3
                         py-2 text-sm focus:border-ink-900"
            />
          </div>

          <Table headers={['Container', 'Slot', 'Chassis', 'Vehicle', 'Container fill', 'Status']}>
            {rows.map((a) => (
              <tr key={a.id}>
                <Td className="code font-semibold">{a.containerNo}</Td>
                <Td className="text-ink-600">{a.sequenceNo} of {a.expectedVehicleCount}</Td>
                <Td className="code">{a.chassisNo}</Td>
                <Td className="text-ink-600">
                  {[a.makeModel, a.colour].filter(Boolean).join(' · ') || '—'}
                </Td>
                <Td>
                  <span className="flex items-center gap-2">
                    <SlotDots filled={a.containerFilled} capacity={a.expectedVehicleCount} />
                    <span className="text-ink-600">
                      {a.containerFilled}/{a.expectedVehicleCount}
                    </span>
                  </span>
                </Td>
                <Td><StatusBadge status={assignmentStatusKey(a.status)} size="sm" /></Td>
              </tr>
            ))}
          </Table>

          {rows.length === 0 && (
            <p className="py-6 text-center text-ink-600">
              No assignments match that filter.
            </p>
          )}
        </div>
      )}
    </ManagerShell>
  )
}
