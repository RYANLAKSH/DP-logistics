import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { Card, CardHeader } from '@/components/Card'
import { CodeValue } from '@/components/CodeValue'
import { EvidenceAttemptCard } from '@/components/Evidence'
import { ManagerShell } from '@/components/Layout'
import { ErrorState, Spinner } from '@/components/States'
import { StatusBadge } from '@/components/StatusBadge'
import { useData } from '@/data/provider'
import { dateLong, timeOfDay } from '@/lib/format'

/**
 * Everything about one movement, in the order a dispute is argued.
 *
 * The test for this screen: a customer says their vehicle arrived in the wrong
 * container, six months on. If this page cannot settle that in two minutes,
 * the audit design has failed regardless of how much was collected.
 */
export function MovementDetailPage() {
  const { movementId = '' } = useParams()
  const data = useData()

  const { data: evidence, isLoading, error, refetch } = useQuery({
    queryKey: ['movement-evidence', movementId],
    queryFn: () => data.getMovementEvidence(movementId),
  })

  return (
    <ManagerShell title="Movement" subtitle={movementId}>
      {isLoading && <Spinner label="Loading the record" />}
      {error && (
        <ErrorState
          detail={error instanceof Error ? error.message : 'That movement could not be loaded.'}
          onRetry={() => void refetch()}
        />
      )}

      {evidence && (
        <div className="grid gap-4 xl:grid-cols-[1fr_28rem]">
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="What was recorded"
                right={
                  <StatusBadge
                    status={evidence.movement.status === 'OVERRIDDEN' ? 'EXCEPTION' : 'COMPLETED'}
                    size="lg"
                  />
                }
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <CodeValue label="Manifest expected — container"
                             value={evidence.movement.expectedContainerNo} />
                  <div className="mt-2">
                    <CodeValue label="Scanned"
                               value={evidence.movement.scannedContainerNo} />
                  </div>
                </div>
                <div>
                  <CodeValue label="Manifest expected — chassis"
                             value={evidence.movement.expectedChassisNo} />
                  <div className="mt-2">
                    <CodeValue label="Scanned"
                               value={evidence.movement.scannedChassisNo} />
                  </div>
                </div>
              </div>

              {evidence.movement.status === 'OVERRIDDEN' && (
                <p className="mt-4 rounded-lg bg-warn-100 px-3 py-3 text-sm text-ink-900">
                  This movement was <strong>authorised by a manager</strong> despite not
                  matching the manifest. The values above are what the driver actually
                  scanned — an override records what happened, it does not rewrite it.
                </p>
              )}
            </Card>

            <Card>
              <CardHeader title="Context" />
              <dl className="grid gap-3 sm:grid-cols-2">
                <Field term="Driver" value={evidence.movement.driverName ?? 'unknown'} />
                <Field term="Verified by the server"
                       value={`${dateLong(evidence.movement.verifiedAt)} ${timeOfDay(evidence.movement.verifiedAt)}`} />
                <Field
                  term="Reported by the device"
                  value={evidence.movement.completedAtDevice
                    ? timeOfDay(evidence.movement.completedAtDevice)
                    : 'not reported'}
                />
                <Field
                  term="Clock difference"
                  value={evidence.movement.clockSkewSeconds == null
                    ? 'unknown'
                    : `${evidence.movement.clockSkewSeconds} s`}
                  warn={(evidence.movement.clockSkewSeconds ?? 0) > 300}
                />
                <Field
                  term="Location"
                  value={evidence.movement.gps
                    ? `${evidence.movement.gps.lat.toFixed(4)}, ${evidence.movement.gps.lng.toFixed(4)} ±${Math.round(evidence.movement.gps.accuracyM)} m`
                    : 'not shared'}
                />
                <Field term="App version" value={evidence.movement.appVersion ?? 'unknown'} />
              </dl>
            </Card>
          </div>

          <div className="space-y-3">
            <h2 className="text-sm font-bold uppercase tracking-widest text-ink-600">
              Evidence
            </h2>
            {evidence.attempts.length === 0 ? (
              <Card>
                <p className="text-sm text-ink-600">
                  No attempts are attached to this movement.
                </p>
              </Card>
            ) : (
              evidence.attempts.map((a) => (
                <EvidenceAttemptCard key={a.id} attempt={a} />
              ))
            )}
          </div>
        </div>
      )}
    </ManagerShell>
  )
}

function Field({
  term, value, warn,
}: { term: string; value: string; warn?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">{term}</dt>
      <dd className={`font-medium ${warn ? 'text-warn-500' : 'text-ink-900'}`}>{value}</dd>
    </div>
  )
}
