/**
 * Header detection.
 *
 * Operations will change their column headings without telling anyone. Matching
 * on a normalised set of synonyms, and letting an administrator correct the
 * mapping when it fails, turns that from an outage into a two-minute task.
 */

export type FieldName =
  | 'containerNo'
  | 'chassisNo'
  | 'sequenceNo'
  | 'vehicleRegNo'
  | 'makeModel'
  | 'colour'
  | 'bayPosition'
  | 'operatingDate'
  | 'invoiceNo'
  | 'sealNo'

export type ColumnMap = Partial<Record<FieldName, number>>

const SYNONYMS: Record<FieldName, string[]> = {
  containerNo: [
    'containerno', 'containernumber', 'container', 'containerid', 'contno',
    'cntrno', 'cntr', 'equipmentno', 'equipment',
  ],
  chassisNo: [
    'chassisno', 'chassisnumber', 'chassis', 'vin', 'vinno', 'framenumber',
    'frameno', 'vehiclechassisno', 'chassisnovin',
  ],
  // Deliberately NOT 'sr'/'srno'. On every real list seen so far, "SR" is a
  // running serial down the whole sheet (1..40), not the slot within a
  // container (1..2). Mapping it here rejected every row past the sixth for
  // SEQUENCE_INVALID. Slot order is inferred from row order instead, which
  // gives the same answer when SR really is ascending anyway.
  sequenceNo: ['sequence', 'seq', 'sequenceno', 'slot', 'slotno', 'position'],
  vehicleRegNo: [
    'registration', 'regno', 'registrationno', 'vehicleno', 'vehiclenumber', 'plate',
  ],
  makeModel: ['model', 'makemodel', 'make', 'vehiclemodel', 'description'],
  colour: ['colour', 'color'],
  bayPosition: ['bay', 'bayposition', 'location', 'position2', 'yardposition'],
  operatingDate: ['date', 'operatingdate', 'loadingdate', 'movementdate'],
  invoiceNo: ['invoiceno', 'invoice', 'invno', 'billno'],
  // The seal is applied after both vehicles are loaded, so it identifies the
  // container's closure, not a vehicle. Captured for the shift report and for
  // reconciliation with the shipping line; never used for matching.
  sealNo: ['seal', 'sealno', 'sealnumber'],
}

function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function detectColumns(header: string[]): ColumnMap {
  const normalized = header.map(normalizeHeader)
  const map: ColumnMap = {}

  for (const [field, synonyms] of Object.entries(SYNONYMS) as Array<[FieldName, string[]]>) {
    // Exact match first, then a contains match, so "Container Number (ISO)"
    // still resolves but never beats a column literally called "Container".
    let index = normalized.findIndex((h) => synonyms.includes(h))
    if (index === -1) {
      index = normalized.findIndex((h) => h !== '' && synonyms.some((s) => h.includes(s)))
    }
    if (index !== -1) map[field] = index
  }

  return map
}

/** True when the mapping has enough to build assignments from. */
export function isUsableMapping(map: ColumnMap): boolean {
  return map.containerNo !== undefined && map.chassisNo !== undefined
}

/**
 * Finds the header row. Real files carry a title, a blank line and a logo
 * before the table, so assuming row 0 is the header fails on the first real
 * upload.
 */
export function findHeaderRow(rows: string[][], searchDepth = 10): number {
  for (let i = 0; i < Math.min(rows.length, searchDepth); i++) {
    const candidate = detectColumns(rows[i] ?? [])
    if (isUsableMapping(candidate)) return i
  }
  return -1
}
