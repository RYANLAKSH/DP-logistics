import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Button } from '@/components/Button'
import { ManagerShell } from '@/components/Layout'
import { Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'
import { dateLong, timeOfDay } from '@/lib/format'
import type { ManifestStatus } from '@/data/types'
import type { StatusKey } from '@/lib/status'

const MANIFEST_STATUS: Record<ManifestStatus, StatusKey> = {
  DRAFT: 'PENDING',
  VALIDATION_FAILED: 'EXCEPTION',
  READY: 'READY',
  PUBLISHED: 'VERIFIED',
  ARCHIVED: 'COMPLETED',
}

export function ManifestHistoryPage() {
  const data = useData()
  const { data: manifests, isLoading } = useQuery({
    queryKey: ['manifests'],
    queryFn: () => data.listManifests(),
  })

  return (
    <ManagerShell
      title="Manifests"
      subtitle="Every version, kept"
      action={
        <Link to="/manager/manifests/upload"><Button>Upload a manifest</Button></Link>
      }
    >
      {isLoading && <Spinner />}

      {manifests && (
        <div className="space-y-4">
          <p className="max-w-2xl text-sm text-ink-600">
            A manifest is never overwritten. Re-uploading for the same yard and day
            publishes a new version and archives the previous one, so what a movement was
            verified against stays readable for as long as the record exists.
          </p>

          <Table headers={['Operating date', 'Version', 'Reference', 'Containers', 'Vehicles', 'Published', 'Status']}>
            {manifests.map((m) => (
              <tr key={m.id}>
                <Td className="font-medium">{dateLong(m.operatingDate)}</Td>
                <Td className="code">v{m.version}</Td>
                <Td className="code text-ink-600">{m.referenceNo ?? '—'}</Td>
                <Td>{m.totalContainers}</Td>
                <Td>{m.totalVehicles}</Td>
                <Td className="text-ink-600">
                  {m.publishedAt
                    ? <>{timeOfDay(m.publishedAt)}<br />
                        <span className="text-xs">{m.publishedBy}</span></>
                    : '—'}
                </Td>
                <Td><StatusBadge status={MANIFEST_STATUS[m.status]} size="sm" /></Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </ManagerShell>
  )
}
