import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ManagerShell } from '@/components/Layout'
import { Spinner } from '@/components/States'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'
import { timeOfDay } from '@/lib/format'

export function AuditLogPage() {
  const data = useData()
  const [query, setQuery] = useState('')
  const [action, setAction] = useState('ALL')

  const { data: entries, isLoading } = useQuery({
    queryKey: ['audit'],
    queryFn: () => data.listAuditEntries(),
  })

  const actions = useMemo(
    () => ['ALL', ...new Set((entries ?? []).map((e) => e.action))],
    [entries],
  )

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (entries ?? []).filter((e) => {
      if (action !== 'ALL' && e.action !== action) return false
      if (!needle) return true
      return (
        e.actorName.toLowerCase().includes(needle) ||
        e.action.toLowerCase().includes(needle) ||
        JSON.stringify(e.detail ?? {}).toLowerCase().includes(needle)
      )
    })
  }, [entries, query, action])

  return (
    <ManagerShell title="Audit log" subtitle="Append-only. Nothing here can be edited or deleted">
      {isLoading && <Spinner />}

      {entries && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm focus:border-ink-900"
            >
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search actor, action or detail"
              className="w-full max-w-sm rounded-lg border-2 border-line/40 px-3 py-2
                         text-sm focus:border-ink-900"
            />
          </div>

          <Table headers={['Time', 'Actor', 'Role', 'Action', 'Entity', 'Detail']}>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td className="code whitespace-nowrap text-ink-600">{timeOfDay(e.occurredAt)}</Td>
                <Td className="font-medium">{e.actorName}</Td>
                <Td className="text-ink-600">{e.actorRole}</Td>
                <Td className="code">{e.action}</Td>
                <Td className="text-ink-600">{e.entityType}</Td>
                <Td className="code max-w-md truncate text-xs text-ink-600">
                  {e.detail ? JSON.stringify(e.detail) : '—'}
                </Td>
              </tr>
            ))}
          </Table>

          {rows.length === 0 && (
            <p className="py-6 text-center text-ink-600">No entries match that filter.</p>
          )}
        </div>
      )}
    </ManagerShell>
  )
}
