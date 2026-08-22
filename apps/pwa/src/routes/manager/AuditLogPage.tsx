import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { EmptyState, ErrorState, Spinner } from '@/components/States'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'
import { dateLong, timeOfDay } from '@/lib/format'

/**
 * The audit log is append-only and the screen says so, prominently.
 *
 * Not decoration: a reader needs to know whether what they are looking at
 * could have been edited, and the answer changes how much weight it carries.
 */
const ACTION_GROUPS: Record<string, string[]> = {
  'Movements': ['movement.verified', 'movement.blocked', 'movement.replay_conflict'],
  'Scans': ['scan.passed', 'scan.failed'],
  'Manifests': ['manifest.published', 'manifest.archived', 'manifest.corrected'],
  'Exceptions': ['exception.raised', 'exception.acknowledged', 'exception.resolved',
                 'exception.cancelled'],
  'Overrides': ['override.requested', 'override.approved'],
  'Users and devices': ['user.created', 'user.role_changed', 'user.deactivated',
                        'device.approved', 'device.revoked'],
  'Access': ['auth.login', 'auth.logout', 'evidence.viewed'],
}

export function AuditLogPage() {
  const data = useData()
  const [search, setSearch] = useState('')
  const [action, setAction] = useState('ALL')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const entries = useQuery({
    queryKey: ['audit', action, from, to, search],
    queryFn: () => data.listAuditEntries({
      action: action === 'ALL' ? undefined : action,
      from: from || undefined,
      to: to || undefined,
      search: search || undefined,
    }),
  })

  const corrections = useQuery({
    queryKey: ['corrections'],
    queryFn: () => data.listCorrections(),
  })

  const actions = useMemo(
    () => Object.entries(ACTION_GROUPS).map(([group, list]) => ({ group, list })),
    [],
  )

  return (
    <ManagerShell
      title="Audit log"
      subtitle="Append-only. No account, including an administrator's, can edit or delete an entry"
    >
      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Action
              </span>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value)}
                className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
              >
                <option value="ALL">Everything</option>
                {actions.map(({ group, list }) => (
                  <optgroup key={group} label={group}>
                    {list.map((a) => <option key={a} value={a}>{a}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                From
              </span>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                     className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                To
              </span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                     className="rounded-lg border-2 border-line/40 px-3 py-2 text-sm" />
            </label>
            <label className="block flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-ink-600">
                Search
              </span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Actor, action, container, chassis"
                className="w-full max-w-sm rounded-lg border-2 border-line/40 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </Card>

        {corrections.data && corrections.data.length > 0 && (
          <Card>
            <CardHeader
              title="Manifest corrections"
              subtitle="Every change to the source of truth, with what it was and why"
            />
            <Table headers={['When', 'What changed', 'Before', 'After', 'Reason', 'Affected']}>
              {corrections.data.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap text-ink-600">
                    {dateLong(c.correctedAt)}<br />
                    <span className="code text-xs">{timeOfDay(c.correctedAt)}</span>
                  </Td>
                  <Td className="font-medium">{c.fieldName.replaceAll('_', ' ')}</Td>
                  <Td className="code text-bad-500">{c.beforeValue ?? '—'}</Td>
                  <Td className="code text-ok-500">{c.afterValue ?? '—'}</Td>
                  <Td className="max-w-sm">{c.reason}</Td>
                  <Td>
                    {c.affectedMovementCount > 0 ? (
                      <span className="font-semibold text-bad-500">
                        {c.affectedMovementCount} completed movement
                        {c.affectedMovementCount === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-ink-600">none</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        {entries.isLoading && <Spinner label="Loading the log" />}
        {entries.error && (
          <ErrorState
            detail={entries.error instanceof Error
              ? entries.error.message : 'The audit log could not be loaded.'}
            onRetry={() => void entries.refetch()}
          />
        )}

        {entries.data && (
          entries.data.length === 0 ? (
            <EmptyState
              title="No entries match"
              detail="Widen the date range or clear the filters. An empty result here means nothing matched — never that an entry was removed."
            />
          ) : (
            <Table headers={['Time', 'Actor', 'Role', 'Action', 'Entity', 'Detail']}>
              {entries.data.map((e) => (
                <tr key={e.id}>
                  <Td className="whitespace-nowrap text-ink-600">
                    {dateLong(e.occurredAt)}<br />
                    <span className="code text-xs">{timeOfDay(e.occurredAt)}</span>
                  </Td>
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
          )
        )}
      </div>
    </ManagerShell>
  )
}
