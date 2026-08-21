import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useState } from 'react'
import { Button } from '@/components/Button'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'

/**
 * Preview, then publish. Never both in one action.
 *
 * The manager sees every rejected row and its reason before anything becomes
 * live, and cannot publish while rejections remain.
 */
export function ManifestPreviewPage() {
  const { importId = '' } = useParams()
  const data = useData()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const { data: imported, isLoading } = useQuery({
    queryKey: ['import', importId],
    queryFn: () => data.getManifestImport(importId),
  })

  async function publish() {
    setBusy(true)
    try {
      await data.publishManifestImport(importId)
      navigate('/manager/manifests')
    } finally {
      setBusy(false)
    }
  }

  const blocked = (imported?.rejectedCount ?? 0) > 0

  return (
    <ManagerShell
      title="Preview"
      subtitle={imported ? `${imported.fileName} · ${imported.operatingDate}` : undefined}
    >
      {isLoading && <Spinner />}

      {imported && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <p className="text-3xl font-bold text-ink-900">{imported.rowCount}</p>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">Rows</p>
            </Card>
            <Card>
              <p className="text-3xl font-bold text-ok-500">{imported.validCount}</p>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">Valid</p>
            </Card>
            <Card>
              <p className={`text-3xl font-bold ${blocked ? 'text-bad-500' : 'text-ink-900'}`}>
                {imported.rejectedCount}
              </p>
              <p className="text-xs font-semibold uppercase tracking-wider text-ink-600">
                Rejected
              </p>
            </Card>
          </div>

          {blocked && (
            <div className="rounded-card border-2 border-bad-500 bg-bad-100 px-4 py-3">
              <p className="font-semibold text-bad-500">
                This manifest cannot be published
              </p>
              <p className="mt-1 text-sm text-ink-700">
                {imported.rejectedCount} row{imported.rejectedCount === 1 ? '' : 's'} failed
                validation. Correct the source file and upload it again — rows are rejected,
                never guessed at.
              </p>
            </div>
          )}

          <Card>
            <CardHeader title="Rows" subtitle="Every row, with its reason for rejection" />
            <Table headers={['#', 'Container', 'Chassis', 'Seq', 'Status']}>
              {imported.rows.map((row) => (
                <tr key={row.rowNo} className={row.errors.length ? 'bg-bad-100/40' : ''}>
                  <Td className="code text-ink-600">{row.rowNo}</Td>
                  <Td className="code">{row.containerNo || <em className="text-bad-500">missing</em>}</Td>
                  <Td className="code">{row.chassisNo || <em className="text-bad-500">missing</em>}</Td>
                  <Td className="code">{row.sequenceNo ?? '—'}</Td>
                  <Td>
                    {row.errors.length === 0 ? (
                      <StatusBadge status="READY" size="sm" />
                    ) : (
                      <div className="space-y-1">
                        <StatusBadge status="EXCEPTION" size="sm" />
                        {row.errors.map((e) => (
                          <p key={e} className="text-xs text-bad-500">{e}</p>
                        ))}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>

          <div className="flex flex-wrap gap-3">
            <Button disabled={blocked || busy} onClick={() => void publish()}>
              {busy ? 'Publishing…' : 'Publish manifest'}
            </Button>
            <Button variant="secondary" onClick={() => navigate('/manager/manifests')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </ManagerShell>
  )
}
