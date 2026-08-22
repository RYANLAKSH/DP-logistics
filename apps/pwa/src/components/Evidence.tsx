import { useQuery } from '@tanstack/react-query'
import { useData } from '@/data/provider'
import type { EvidenceAttempt } from '@/data/types'
import { CodeValue } from './CodeValue'
import { Card } from './Card'
import { StatusBadge } from './StatusBadge'
import { timeOfDay } from '@/lib/format'

/**
 * One stored photograph.
 *
 * The image is fetched through a short-lived signed URL. When there is no URL
 * — no object store, an expired link, a revoked permission — this says so
 * explicitly. A silently missing image in an evidence viewer is worse than an
 * absent one: it reads as "there was never a photograph".
 */
export function EvidenceImage({
  path, alt,
}: { path?: string; alt: string }) {
  const data = useData()
  const { data: url, isLoading, isError } = useQuery({
    queryKey: ['evidence-url', path],
    queryFn: () => data.getEvidenceUrl(path!),
    enabled: Boolean(path),
    // Signed URLs expire; do not serve a stale one from cache.
    staleTime: 4 * 60_000,
    gcTime: 4 * 60_000,
  })

  if (!path) {
    return (
      <Placeholder>No photograph was stored for this step.</Placeholder>
    )
  }
  if (isLoading) return <Placeholder>Loading the photograph…</Placeholder>
  if (isError || !url) {
    return (
      <Placeholder>
        The photograph exists but could not be opened. Its hash is recorded below —
        the record is intact even when the image cannot be displayed here.
      </Placeholder>
    )
  }
  return (
    <img
      src={url}
      alt={alt}
      className="w-full rounded-lg border border-line/25 bg-ink-950 object-contain"
    />
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-32 items-center justify-center rounded-lg border
                    border-dashed border-line/40 bg-paper px-4 py-6 text-center
                    text-sm text-ink-600">
      {children}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  CONTAINER: 'Container plate',
  CHASSIS: 'Chassis plate',
  VEHICLE_REG: 'Registration plate',
  FINAL: 'Verification',
}

/**
 * One attempt, with everything that makes it defensible.
 *
 * The raw engine output is shown NEXT TO the confirmed value, deliberately.
 * That pairing is what shows a human corrected a machine rather than the
 * reverse — and it is the first thing anyone disputing a movement will ask
 * about.
 */
export function EvidenceAttemptCard({ attempt }: { attempt: EvidenceAttempt }) {
  const value = attempt.scannedContainerNo ?? attempt.scannedChassisNo
  const skewed = (attempt.clockSkewSeconds ?? 0) > 300

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-widest text-ink-600">
          {KIND_LABEL[attempt.kind] ?? attempt.kind}
        </span>
        <StatusBadge
          status={attempt.result === 'PASS' ? 'VERIFIED' : 'MISMATCH'}
          size="sm"
        />
        {attempt.valueSource && (
          <span className="rounded-full bg-idle-100 px-2 py-0.5 text-xs font-semibold
                           uppercase tracking-wide text-ink-700">
            {attempt.valueSource.replaceAll('_', ' ').toLowerCase()}
          </span>
        )}
      </div>

      {attempt.kind !== 'FINAL' && (
        <EvidenceImage
          path={attempt.imagePath}
          alt={`${KIND_LABEL[attempt.kind] ?? attempt.kind} as photographed`}
        />
      )}

      <dl className="mt-3 space-y-2 text-sm">
        {value && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
              Recorded value
            </dt>
            <dd><CodeValue value={value} size="sm" /></dd>
          </div>
        )}

        {attempt.ocrTextRaw != null && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
              What the engine read
            </dt>
            <dd className="code text-sm text-ink-700">
              {attempt.ocrTextRaw || <em className="not-italic">nothing readable</em>}
              {attempt.ocrConfidence != null && (
                <span className="ml-2 text-ink-600">
                  ({Math.round(attempt.ocrConfidence * 100)}%{' '}
                  {attempt.ocrEngine ?? 'engine'})
                </span>
              )}
            </dd>
          </div>
        )}

        {attempt.imageSha256 && (
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
              Image hash (SHA-256)
            </dt>
            <dd className="code break-all text-xs text-ink-600">{attempt.imageSha256}</dd>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {attempt.attemptedAtDevice && (
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
                Taken
              </dt>
              <dd className="text-ink-900">{timeOfDay(attempt.attemptedAtDevice)}</dd>
            </div>
          )}
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wider text-ink-600">
              Location
            </dt>
            <dd className="text-ink-900">
              {attempt.gps
                ? <>
                    {attempt.gps.lat.toFixed(4)}, {attempt.gps.lng.toFixed(4)}
                    <span className="text-ink-600"> ±{Math.round(attempt.gps.accuracyM)} m</span>
                  </>
                : <span className="text-ink-600">
                    {attempt.gpsDenied ? 'not shared' : 'unavailable'}
                  </span>}
            </dd>
          </div>
        </div>

        {skewed && (
          <p className="rounded-lg bg-warn-100 px-3 py-2 text-xs text-warn-500">
            This device's clock was {Math.round((attempt.clockSkewSeconds ?? 0) / 60)} minutes
            behind the server. Times reported by the device should be treated with care.
          </p>
        )}
      </dl>
    </Card>
  )
}
