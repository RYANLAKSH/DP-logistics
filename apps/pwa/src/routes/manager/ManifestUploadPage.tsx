import { useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { useData, useIsMockBackend } from '@/data/provider'
import { samplePickupListFile } from '@/data/mock/samplePickupList'

const MAX_BYTES = 10 * 1024 * 1024
const ACCEPTED = ['.csv', '.xlsx', '.xls']

export function ManifestUploadPage() {
  const data = useData()
  const isMock = useIsMockBackend()
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setError(null)
    if (!picked) return setFile(null)
    const ext = picked.name.slice(picked.name.lastIndexOf('.')).toLowerCase()
    if (!ACCEPTED.includes(ext)) {
      setError(`Unsupported file type "${ext}". Upload a CSV or XLSX.`)
      return setFile(null)
    }
    if (picked.size > MAX_BYTES) {
      setError('That file is larger than 10 MB.')
      return setFile(null)
    }
    setFile(picked)
  }

  async function onParse() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const imported = await data.parseManifestFile(file, 'yard-nsa', date)
      navigate(`/manager/manifests/import/${imported.id}`)
    } catch (e) {
      // A parse failure has to say what went wrong. "Upload failed" leaves an
      // administrator with a file they cannot fix and a yard that cannot start.
      setError(e instanceof Error ? e.message : 'That file could not be parsed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ManagerShell title="Upload a manifest" subtitle="Nhava Sheva">
      <div className="max-w-2xl space-y-4">
        <Card>
          <CardHeader
            title="Choose the file"
            subtitle="CSV or XLSX, with container number, chassis number and sequence"
          />

          <label className="block">
            <span className="mb-1 block text-sm font-semibold text-ink-700">
              Operating date
            </span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border-2 border-line/40 px-3 py-2.5 text-base
                         focus:border-ink-900"
            />
          </label>

          <label className="mt-4 flex cursor-pointer flex-col items-center justify-center
                            gap-2 rounded-card border-2 border-dashed border-line/40
                            bg-paper px-6 py-10 text-center hover:border-ink-900">
            <span className="text-3xl" aria-hidden="true">⇪</span>
            <span className="font-semibold text-ink-900">
              {file ? file.name : 'Choose a manifest file'}
            </span>
            <span className="text-sm text-ink-600">CSV or XLSX · up to 10 MB</span>
            <input type="file" className="sr-only" accept={ACCEPTED.join(',')} onChange={onPick} />
          </label>

          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
              {error}
            </p>
          )}

          <Button className="mt-4" disabled={!file || busy} onClick={() => void onParse()}>
            {busy ? 'Parsing…' : 'Parse and preview'}
          </Button>
        </Card>

        {/* Only on fixtures. Picking a file is the one step of this flow that
            cannot be demonstrated without one, and on a phone it is the step
            people give up at. */}
        {isMock && (
          <Card>
            <CardHeader
              title="Or try the real pickup list"
              subtitle="TATA MOTORS CULVNSA2601795 — 20 containers, 40 vehicles"
            />
            <p className="text-sm text-ink-600">
              The list exactly as it arrives: container number written once per pair,
              a running SR column, no sequence column. One container in it,
              BMOU6433014, fails its own check digit — the first button shows what
              happens to it, the second is the same list with that one corrected.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              <Button
                variant="secondary"
                onClick={() => { setError(null); setFile(samplePickupListFile(false)) }}
              >
                Load it as received
              </Button>
              <Button
                variant="secondary"
                onClick={() => { setError(null); setFile(samplePickupListFile(true)) }}
              >
                Load it corrected
              </Button>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader title="Expected columns" />
          <div className="overflow-x-auto">
            <pre className="code rounded-lg bg-paper p-3 text-sm">
{`Container Number | Chassis Number    | Sequence
CULVNSA2601795   | MAT752389T7R19810 | 1
CULVNSA2601795   | MAT464844TSR09249 | 2`}
            </pre>
          </div>
          <p className="mt-3 text-sm text-ink-600">
            Nothing goes live until you review the preview and publish. A manifest that is
            wrong blocks every vehicle in the yard, so the preview step is not skippable.
          </p>
        </Card>
      </div>
    </ManagerShell>
  )
}
