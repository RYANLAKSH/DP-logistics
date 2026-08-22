import { useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/Button'
import { Card, CardHeader } from '@/components/Card'
import { ManagerShell } from '@/components/Layout'
import { useData, useIsMockBackend } from '@/data/provider'
import { samplePickupListFile } from '@/data/mock/samplePickupList'
import { MANIFEST_ACCEPT, sniffManifestKind } from '@/lib/manifestFile'

const MAX_BYTES = 10 * 1024 * 1024

export function ManifestUploadPage() {
  const data = useData()
  const isMock = useIsMockBackend()
  const navigate = useNavigate()
  const [file, setFile] = useState<File | null>(null)
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pasted, setPasted] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null
    setError(null)
    if (!picked) return setFile(null)

    if (picked.size > MAX_BYTES) {
      setError('That file is larger than 10 MB.')
      return setFile(null)
    }

    // Judged by content, not by name. A file arriving from Drive, an email or
    // a messaging app on a phone often has no usable extension, and rejecting
    // the right file on the strength of its name leaves a manager with nothing
    // they can do from the device they are holding.
    const kind = await sniffManifestKind(picked, picked.name)
    if (kind === 'xls') {
      setError(
        'That is an older Excel file (.xls). Open it and use File → Save As to make a .xlsx or a CSV, then upload that.',
      )
      return setFile(null)
    }
    if (kind === 'unknown') {
      setError(
        `"${picked.name}" is not a spreadsheet or a CSV. If you meant to send a photo of the manifest, the file itself is needed — the numbers have to be read exactly.`,
      )
      return setFile(null)
    }
    setFile(picked)
  }

  async function onParse(source: File | null = file) {
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      const imported = await data.parseManifestFile(source, 'yard-nsa', date)
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

          {/* A real button rather than a label wrapping a hidden input. The
              label works on a desktop and is unreliable inside the in-app
              browsers a manifest actually arrives in — the mail client, the
              messaging app — where a tap on the label is not always forwarded
              to the input. A button that calls click() is not ambiguous. */}
          <input
            ref={inputRef}
            type="file"
            className="sr-only"
            accept={MANIFEST_ACCEPT}
            onChange={(e) => void onPick(e)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-4 flex w-full min-h-touch cursor-pointer flex-col items-center
                       justify-center gap-2 rounded-card border-2 border-dashed
                       border-line/40 bg-paper px-6 py-10 text-center
                       hover:border-ink-900 focus-visible:border-ink-900"
          >
            <span className="text-3xl" aria-hidden="true">⇪</span>
            <span className="font-semibold break-all text-ink-900">
              {file ? file.name : 'Choose a manifest file'}
            </span>
            <span className="text-sm text-ink-600">CSV or XLSX · up to 10 MB</span>
          </button>

          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-bad-100 px-3 py-2 text-sm text-bad-500">
              {error}
            </p>
          )}

          <Button className="mt-4" disabled={!file || busy} onClick={() => void onParse()}>
            {busy ? 'Parsing…' : 'Parse and preview'}
          </Button>
        </Card>

        {/* The way in when there is no way in.
            Some phone browsers refuse to open a file picker for a page shown
            inside another page — the button is tapped and simply nothing
            happens, with no error to act on. Pasting needs no file access at
            all, and it is often the faster path anyway: the list arrives in an
            email or a message, and copying the rows beats saving an
            attachment and hunting for it in a file browser. */}
        <Card>
          <CardHeader
            title="Or paste the rows"
            subtitle="Select the sheet in Excel, copy, and paste here"
          />
          <p className="text-sm text-ink-600">
            Use this if tapping the button above does nothing — some phone browsers
            will not open a file picker inside an embedded page. Include the heading
            row; columns separated by tabs or commas both work.
          </p>
          <textarea
            value={pasted}
            onChange={(e) => { setPasted(e.target.value); setError(null) }}
            rows={6}
            spellCheck={false}
            autoCapitalize="characters"
            placeholder={'SR\tCHASSIS NO\tMODEL\tINVOICE NO\tCONT NO\tSEAL\n1\tMAT752389T7R20588\t…\t…\tTRHU8755445\t13064'}
            className="code mt-3 w-full rounded-lg border-2 border-line/40 p-3 text-sm
                       focus:border-ink-900"
          />
          <Button
            className="mt-3"
            disabled={!pasted.trim() || busy}
            onClick={() => void onParse(
              new File([pasted], 'pasted-manifest.csv', { type: 'text/csv' }))}
          >
            {busy ? 'Parsing…' : 'Parse pasted rows'}
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
              The list exactly as it arrives: a title row above the headings, a running
              SR column, no sequence column, and blank rows between pairs.
            </p>
            <Button
              className="mt-3"
              variant="secondary"
              onClick={() => { setError(null); setFile(samplePickupListFile()) }}
            >
              Load the pickup list
            </Button>
          </Card>
        )}

        <Card>
          <CardHeader
            title="What the file needs"
            subtitle="Column order does not matter — headings are matched by name"
          />
          <div className="overflow-x-auto">
            <pre className="code rounded-lg bg-paper p-3 text-sm">
{`SR | CHASSIS NO        | MODEL | INVOICE NO | CONT NO     | SEAL
1  | MAT752389T7R20588 | …     | …          | TRHU8755445 | 13064
2  | MAT464844TSR09113 | …     | …          | TRHU8755445 |`}
            </pre>
          </div>
          <p className="mt-3 text-sm text-ink-600">
            A chassis column and a container column are the only two required, and the
            headings are matched by name — put them in any order. Write the container on
            <strong> both </strong> vehicles of a pair: it takes a second, and it means the
            pairing a driver is held to is the one you wrote rather than one this screen
            worked out.
          </p>
          <p className="mt-2 text-sm text-ink-600">
            A file that names the container only on the first vehicle still works. The
            second row inherits it, and every row where that happened is marked
            <em> from row above </em> in the preview for you to check.
          </p>
          <p className="mt-2 text-sm text-ink-600">
            Nothing goes live until you review the preview and publish. A manifest that is
            wrong blocks every vehicle in the yard, so the preview step is not skippable.
          </p>
        </Card>
      </div>
    </ManagerShell>
  )
}
