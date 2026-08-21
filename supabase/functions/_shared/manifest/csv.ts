/**
 * A CSV reader, written rather than installed.
 *
 * This parses files an operations team emails in, which is untrusted input by
 * any reasonable definition. The obvious dependency (SheetJS on npm) carries
 * prototype-pollution and ReDoS advisories, and pulling a large parser in to
 * split on commas is a poor trade. RFC 4180 is small enough to implement
 * exactly, and the implementation here has no regular expressions on the hot
 * path, so it cannot be made to backtrack.
 */

export interface CsvOptions {
  /** Guard against a file that is technically valid and operationally absurd. */
  maxRows?: number
  maxCells?: number
}

const DEFAULTS = { maxRows: 10_000, maxCells: 200_000 }

export function parseCsv(input: string, options: CsvOptions = {}): string[][] {
  const { maxRows, maxCells } = { ...DEFAULTS, ...options }

  // Strip a UTF-8 BOM. Excel writes one, and without this the first header
  // never matches and every column mapping silently fails.
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let cells = 0
  let i = 0

  const pushField = () => {
    row.push(field)
    field = ''
    if (++cells > maxCells) throw new CsvTooLargeError('too many cells')
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
    if (rows.length > maxRows) throw new CsvTooLargeError('too many rows')
  }

  while (i < text.length) {
    const ch = text[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }

    if (ch === '"' && field === '') { inQuotes = true; i++; continue }
    if (ch === ',') { pushField(); i++; continue }
    if (ch === '\r') { i++; continue }          // CRLF and lone CR both fine
    if (ch === '\n') { pushRow(); i++; continue }

    field += ch; i++
  }

  // A trailing newline should not produce a phantom final row.
  if (field !== '' || row.length > 0) pushRow()

  return rows
}

export class CsvTooLargeError extends Error {}

/** Detects the delimiter from the header line: comma, semicolon or tab. */
export function detectDelimiter(input: string): ',' | ';' | '\t' {
  const firstLine = input.split(/\r?\n/, 1)[0] ?? ''
  const counts: Array<[',' | ';' | '\t', number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

/**
 * Parses with a detected delimiter by normalising to commas first — safe
 * because the normalisation is quote-aware.
 */
export function parseDelimited(input: string, options?: CsvOptions): string[][] {
  const delimiter = detectDelimiter(input)
  if (delimiter === ',') return parseCsv(input, options)

  let out = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (ch === '"') inQuotes = !inQuotes
    out += !inQuotes && ch === delimiter ? ',' : ch
  }
  return parseCsv(out, options)
}
