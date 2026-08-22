/**
 * Reads an .xlsx into the same `string[][]` grid the CSV parser produces, so
 * everything downstream — header detection, validation, the container
 * carry-forward — is the one implementation, exercised the same way whichever
 * file the manifest arrived as.
 *
 * Values only. Formatting, formulas, merged cells and dates are all ignored:
 * a manifest is a table of identifiers, and anything this reader "helpfully"
 * interpreted would be a value nobody typed.
 */
import { readCentralDirectory, readEntry } from './zip'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** A1 -> 0, B1 -> 1, AA1 -> 26. */
function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('That spreadsheet contains XML this reader could not parse.')
  }
  return doc
}

function textOf(el: Element): string {
  // <si> can hold one <t> or a run of them; concatenating is what a reader
  // sees on screen.
  return Array.from(el.getElementsByTagNameNS(MAIN_NS, 't'))
    .map((t) => t.textContent ?? '')
    .join('')
}

export interface SheetGrid {
  name: string
  rows: string[][]
}

export type WorkbookSource = Blob | ArrayBuffer | Uint8Array

/**
 * Takes bytes in whatever form the caller has them. A `File` from a picker, an
 * ArrayBuffer from a fetch, or a Uint8Array from disk in a test — normalising
 * here rather than at three call sites also sidesteps jsdom, whose Blob has no
 * arrayBuffer().
 */
async function toBytes(source: WorkbookSource): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (typeof source.arrayBuffer === 'function') {
    return new Uint8Array(await source.arrayBuffer())
  }
  return new Uint8Array(await new Response(source).arrayBuffer())
}

export async function readWorkbook(source: WorkbookSource): Promise<SheetGrid[]> {
  const bytes = await toBytes(source)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = readCentralDirectory(view)

  const get = async (path: string): Promise<string | null> => {
    const entry = entries.get(path)
    return entry ? readEntry(bytes, view, entry) : null
  }

  const workbookXml = await get('xl/workbook.xml')
  if (!workbookXml) {
    throw new Error(
      'That file is not an Excel workbook. If it came from an older Excel, save it as .xlsx or CSV.',
    )
  }

  // Shared strings are optional: a sheet written with inline strings has none.
  const sharedXml = await get('xl/sharedStrings.xml')
  const shared = sharedXml
    ? Array.from(parseXml(sharedXml).getElementsByTagNameNS(MAIN_NS, 'si')).map(textOf)
    : []

  // Sheets are addressed by relationship id, not by file name. sheet1.xml is
  // usually the first sheet and occasionally is not.
  const relsXml = await get('xl/_rels/workbook.xml.rels')
  const targets = new Map<string, string>()
  if (relsXml) {
    for (const rel of Array.from(
      parseXml(relsXml).getElementsByTagNameNS(REL_NS, 'Relationship'))) {
      const target = rel.getAttribute('Target') ?? ''
      targets.set(rel.getAttribute('Id') ?? '',
        target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
    }
  }

  const out: SheetGrid[] = []
  const sheets = Array.from(parseXml(workbookXml).getElementsByTagNameNS(MAIN_NS, 'sheet'))
  for (const [i, sheet] of sheets.entries()) {
    const rid = sheet.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
      ?? sheet.getAttribute('r:id') ?? ''
    const path = targets.get(rid) ?? `xl/worksheets/sheet${i + 1}.xml`
    const xml = await get(path)
    if (!xml) continue
    out.push({
      name: sheet.getAttribute('name') ?? `Sheet${i + 1}`,
      rows: readSheet(parseXml(xml), shared),
    })
  }
  return out
}

function readSheet(doc: Document, shared: string[]): string[][] {
  const rows: string[][] = []
  let width = 0

  for (const row of Array.from(doc.getElementsByTagNameNS(MAIN_NS, 'row'))) {
    const cells: string[] = []
    for (const cell of Array.from(row.getElementsByTagNameNS(MAIN_NS, 'c'))) {
      const at = columnIndex(cell.getAttribute('r') ?? '')
      const type = cell.getAttribute('t')

      let value = ''
      if (type === 'inlineStr') {
        value = textOf(cell)
      } else {
        const v = cell.getElementsByTagNameNS(MAIN_NS, 'v')[0]
        const raw = v?.textContent ?? ''
        value = type === 's' ? (shared[Number(raw)] ?? '') : raw
      }

      // Blank cells are omitted from the XML entirely, so gaps have to be
      // filled — otherwise every column after a blank shifts left, and a
      // chassis number lands in the container column.
      const index = at >= 0 ? at : cells.length
      while (cells.length < index) cells.push('')
      cells[index] = value.trim()
    }
    width = Math.max(width, cells.length)
    rows.push(cells)
  }

  // Square it off, so a short row does not read as a row missing its later
  // columns for a different reason.
  for (const row of rows) while (row.length < width) row.push('')
  return rows
}

/**
 * The sheet a manifest should be read from.
 *
 * A workbook with several sheets is usually several versions of one plan, and
 * reading the wrong one silently loads yesterday's allocation. Rather than
 * guess, this returns them all and lets the caller decide — the mock takes the
 * first that yields a usable table, and the preview names which one it read.
 */
export function isXlsx(name: string): boolean {
  return name.toLowerCase().endsWith('.xlsx')
}
