/**
 * What kind of file did the manager actually hand us?
 *
 * By content, not by name. A phone is where file names go to die: a
 * spreadsheet arriving from Drive, an email attachment or a messaging app is
 * routinely handed over as "document", "Untitled", or a name with no extension
 * at all. Gating on the extension meant a manager could pick the right file and
 * be told it was the wrong type, with nothing they could do about it from a
 * phone.
 *
 * The signatures are short and unambiguous, which is the whole reason to use
 * them: an .xlsx is a ZIP, and the old binary .xls is an OLE2 compound file.
 */
export type ManifestKind = 'csv' | 'xlsx' | 'xls' | 'unknown'

const ZIP = [0x50, 0x4b, 0x03, 0x04]                          // "PK\x03\x04"
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] // legacy .xls

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((b, i) => bytes[i] === b)
}

export function kindFromBytes(bytes: Uint8Array, name = ''): ManifestKind {
  if (startsWith(bytes, ZIP)) return 'xlsx'
  if (startsWith(bytes, OLE2)) return 'xls'

  // Everything else is judged as text. A manifest is identifiers and
  // separators; a JPEG or a PDF is not, and saying so early is kinder than a
  // parser error about a missing container column.
  //
  // Judged on the bytes rather than on decoded text. Decoding first and looking
  // for the replacement character means putting one in this source file, and a
  // stray U+FFFD in the bundle is its own small landmine.
  const head = bytes.subarray(0, 512)
  let control = 0
  for (const b of head) {
    if (b === 0) return 'unknown'                       // NUL: never in a manifest
    // Tab, newline and carriage return are the separators a CSV is made of.
    if (b < 0x09 || (b > 0x0d && b < 0x20)) control++
  }
  if (control > head.length / 20) return 'unknown'
  void name
  return 'csv'
}

export async function sniffManifestKind(file: Blob, name = ''): Promise<ManifestKind> {
  const head = file.slice(0, 512)
  const bytes = new Uint8Array(
    typeof head.arrayBuffer === 'function'
      ? await head.arrayBuffer()
      : await new Response(head).arrayBuffer(),
  )
  return kindFromBytes(bytes, name)
}

/**
 * What the file picker should offer.
 *
 * Extensions AND media types. Android's picker and the iOS Files app hand
 * cloud-stored documents to the page by media type, and a list of extensions
 * alone leaves those files greyed out and unselectable — the exact symptom of
 * "I cannot upload anything on my phone". Listing both costs nothing; the
 * content check above is what actually decides.
 */
export const MANIFEST_ACCEPT = [
  '.csv', '.xlsx', '.xls',
  'text/csv', 'text/comma-separated-values', 'application/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/zip',
].join(',')
