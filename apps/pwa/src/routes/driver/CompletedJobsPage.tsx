import { useQuery } from '@tanstack/react-query'
import { Card } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { DriverShell } from '@/components/Layout'
import { EmptyState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { timeOfDay } from '@/lib/format'

export function CompletedJobsPage() {
  const data = useData()
  const { data: movements, isLoading } = useQuery({
    queryKey: ['driver', 'movements'],
    queryFn: () => data.listMyMovements(),
  })

  return (
    <DriverShell title="Completed jobs" subtitle="Verified today" back="/driver">
      {isLoading && <Spinner />}

      {movements && movements.length === 0 && (
        <EmptyState
          title="Nothing completed yet"
          detail="Movements appear here once the server has verified both the container and the chassis."
        />
      )}

      {movements && movements.length > 0 && (
        <ul className="space-y-2">
          {movements.map((m) => (
            <Card as="li" key={m.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CodeValue label="Container" value={m.containerNo} size="sm" />
                  <div className="mt-1">
                    <CodeValue label="Chassis" value={m.chassisNo} size="sm" />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <StatusBadge status="COMPLETED" size="sm" />
                  <p className="mt-1 text-sm text-ink-600">{timeOfDay(m.verifiedAt)}</p>
                </div>
              </div>
            </Card>
          ))}
        </ul>
      )}
    </DriverShell>
  )
}
