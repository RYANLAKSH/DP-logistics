/**
 * Pickup report ingest: parse → map → preview → commit.
 *
 * Nothing goes live without an explicit commit. A bad import silently blocks
 * every vehicle at the gate, so the admin sees exactly what will be created —
 * and exactly what was rejected and why — before anything becomes active.
 */

import {
  normalizeContainerNo,
  normalizeVin,
  isValidContainerNo,
  isPlausibleVin,
  hasStandardCategory,
} from '@dp/shared-rules';

import { type Db, newId, nowIso, audit } from '../lib/db.ts';

export type RejectReason =
  | 'MALFORMED_CONTAINER_NO'
  | 'INVALID_CONTAINER_CHECK_DIGIT'
  | 'NON_STANDARD_EQUIPMENT_CATEGORY'
  | 'MALFORMED_VIN'
  | 'DUPLICATE_VIN_IN_FILE'
  | 'MISSING_REQUIRED_FIELD';

export interface ParsedRow {
  lineNo: number;
  containerNo: string;
  vin: string;
  make?: string;
  model?: string;
  variant?: string;
  colour?: string;
  loadPosition?: number;
  bookingRef?: string;
  destinationPort?: string;
  raw: Record<string, string>;
  errors: RejectReason[];
}

export interface PreviewResult {
  headerRow: number;
  detectedColumns: string[];
  mapping: Record<string, string | null>;
  rows: ParsedRow[];
  validCount: number;
  rejectedCount: number;
  containers: { containerNo: string; vehicleCount: number }[];
}

/* ------------------------------------------------------------------ *
 * CSV parsing
 * ------------------------------------------------------------------ */

/** Minimal RFC 4180 line splitter — handles quoted fields containing commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out.map((value) => value.trim());
}

/**
 * Header aliases, because every DO names these columns differently and the
 * names change without warning. A saved mapping template overrides this.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  containerNo: ['container no', 'container number', 'container', 'cntr no', 'cntr', 'equipment no'],
  vin: ['chassis no', 'chassis number', 'vin', 'vin no', 'vin number', 'frame no', 'chassis'],
  make: ['make', 'manufacturer', 'oem'],
  model: ['model', 'model name'],
  variant: ['variant', 'trim', 'grade'],
  colour: ['colour', 'color', 'paint'],
  loadPosition: ['position', 'load position', 'pos', 'slot'],
  bookingRef: ['booking ref', 'booking', 'booking no', 'bl no'],
  destinationPort: ['destination', 'destination port', 'discharge port', 'pod'],
  lineNo: ['sr no', 'sr', 's no', 'serial', 'line', 'line no', '#'],
};

/**
 * Finds the header row and infers a column mapping.
 *
 * Reports arrive with a preamble (report reference, DO number, validity dates)
 * above the table, so the header is rarely line 1.
 */
export function detectHeader(lines: string[]): { headerRow: number; columns: string[] } | null {
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cells = splitCsvLine(lines[i]!).map((cell) => cell.toLowerCase());

    const hasContainer = cells.some((cell) => COLUMN_ALIASES.containerNo!.includes(cell));
    const hasVin = cells.some((cell) => COLUMN_ALIASES.vin!.includes(cell));

    // Both identifier columns must be present — that is what makes it the
    // table header rather than a preamble line that happens to say "container".
    if (hasContainer && hasVin) return { headerRow: i, columns: splitCsvLine(lines[i]!) };
  }
  return null;
}

export function inferMapping(columns: string[]): Record<string, string | null> {
  const mapping: Record<string, string | null> = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = columns.find((column) => aliases.includes(column.trim().toLowerCase()));
    mapping[field] = found ?? null;
  }
  return mapping;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function validateRow(row: ParsedRow, seenVins: Set<string>): void {
  if (!row.containerNo) {
    row.errors.push('MISSING_REQUIRED_FIELD');
  } else if (!/^[A-Z]{4}[0-9]{7}$/.test(row.containerNo)) {
    row.errors.push('MALFORMED_CONTAINER_NO');
  } else {
    // Reject, never silently "correct". A wrong container number in the report
    // is the DO's error to fix at source; guessing here would launder it.
    if (!isValidContainerNo(row.containerNo)) row.errors.push('INVALID_CONTAINER_CHECK_DIGIT');
    if (!hasStandardCategory(row.containerNo)) row.errors.push('NON_STANDARD_EQUIPMENT_CATEGORY');
  }

  if (!row.vin) row.errors.push('MISSING_REQUIRED_FIELD');
  else if (!isPlausibleVin(row.vin)) row.errors.push('MALFORMED_VIN');
  else if (seenVins.has(row.vin)) row.errors.push('DUPLICATE_VIN_IN_FILE');
  else seenVins.add(row.vin);
}

export function previewCsv(
  csv: string,
  overrideMapping?: Record<string, string | null>,
): PreviewResult {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = detectHeader(lines);

  if (!header) {
    return {
      headerRow: -1,
      detectedColumns: [],
      mapping: {},
      rows: [],
      validCount: 0,
      rejectedCount: 0,
      containers: [],
    };
  }

  const mapping = overrideMapping ?? inferMapping(header.columns);
  const indexOf = (field: string): number => {
    const column = mapping[field];
    return column ? header.columns.indexOf(column) : -1;
  };

  const idx = {
    containerNo: indexOf('containerNo'),
    vin: indexOf('vin'),
    make: indexOf('make'),
    model: indexOf('model'),
    variant: indexOf('variant'),
    colour: indexOf('colour'),
    loadPosition: indexOf('loadPosition'),
    bookingRef: indexOf('bookingRef'),
    destinationPort: indexOf('destinationPort'),
  };

  const at = (cells: string[], index: number): string =>
    index >= 0 ? (cells[index] ?? '') : '';

  const rows: ParsedRow[] = [];
  const seenVins = new Set<string>();

  for (let i = header.headerRow + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);

    // Skip trailing total/footer rows that carry neither identifier.
    if (!at(cells, idx.containerNo) && !at(cells, idx.vin)) continue;

    const raw: Record<string, string> = {};
    header.columns.forEach((column, index) => { raw[column] = cells[index] ?? ''; });

    const position = at(cells, idx.loadPosition);
    const row: ParsedRow = {
      lineNo: rows.length + 1,
      containerNo: normalizeContainerNo(at(cells, idx.containerNo)),
      vin: normalizeVin(at(cells, idx.vin)),
      make: at(cells, idx.make) || undefined,
      model: at(cells, idx.model) || undefined,
      variant: at(cells, idx.variant) || undefined,
      colour: at(cells, idx.colour) || undefined,
      loadPosition: position ? Number(position) || undefined : undefined,
      bookingRef: at(cells, idx.bookingRef) || undefined,
      destinationPort: at(cells, idx.destinationPort) || undefined,
      raw,
      errors: [],
    };

    validateRow(row, seenVins);
    rows.push(row);
  }

  const valid = rows.filter((row) => row.errors.length === 0);
  const byContainer = new Map<string, number>();
  for (const row of valid) {
    byContainer.set(row.containerNo, (byContainer.get(row.containerNo) ?? 0) + 1);
  }

  return {
    headerRow: header.headerRow,
    detectedColumns: header.columns,
    mapping,
    rows,
    validCount: valid.length,
    rejectedCount: rows.length - valid.length,
    containers: [...byContainer].map(([containerNo, vehicleCount]) => ({ containerNo, vehicleCount })),
  };
}

/* ------------------------------------------------------------------ *
 * Commit
 * ------------------------------------------------------------------ */

export interface CommitInput {
  orgId: string;
  locationId: string;
  uploadedBy: string;
  referenceNo: string;
  deliveryOrder: string;
  validFrom: string;
  validTo: string;
  sourceFileName?: string;
  sourceFileSha256?: string;
  /** Reference of a report this amendment supersedes. */
  supersedesReferenceNo?: string;
}

/**
 * Commits the valid rows as a new report version.
 *
 * Amendments never mutate the previous version: version N is marked superseded
 * and version N+1 becomes active, so any reconciliation already recorded still
 * points at the report text it was actually judged against.
 */
export function commitReport(
  db: Db,
  preview: PreviewResult,
  input: CommitInput,
): { reportId: string; version: number; lineCount: number } {
  const valid = preview.rows.filter((row) => row.errors.length === 0);
  if (valid.length === 0) throw new Error('refusing to commit a report with no valid rows');

  const previous = db
    .prepare(
      `SELECT id, version FROM pickup_reports
        WHERE org_id = ? AND reference_no = ?
        ORDER BY version DESC LIMIT 1`,
    )
    .get(input.orgId, input.referenceNo) as { id: string; version: number } | undefined;

  const version = previous ? previous.version + 1 : 1;
  const reportId = newId();

  db.exec('BEGIN');
  try {
    if (previous) {
      db.prepare(`UPDATE pickup_reports SET status = 'superseded' WHERE id = ?`).run(previous.id);
    }

    db.prepare(
      `INSERT INTO pickup_reports (id, org_id, location_id, reference_no, version,
                                   delivery_order, status, supersedes_id, valid_from, valid_to,
                                   source_file_name, source_file_sha256, uploaded_by,
                                   committed_at, created_at)
       VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`,
    ).run(
      reportId, input.orgId, input.locationId, input.referenceNo, version,
      input.deliveryOrder, previous?.id ?? null, input.validFrom, input.validTo,
      input.sourceFileName ?? null, input.sourceFileSha256 ?? null, input.uploadedBy,
      nowIso(), nowIso(),
    );

    const insertLine = db.prepare(
      `INSERT INTO pickup_report_lines (id, report_id, line_no, container_no, vin, make,
                                        model, variant, colour, load_position, booking_ref,
                                        destination_port, raw_row)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    for (const row of valid) {
      insertLine.run(
        newId(), reportId, row.lineNo, row.containerNo, row.vin,
        row.make ?? null, row.model ?? null, row.variant ?? null, row.colour ?? null,
        row.loadPosition ?? null, row.bookingRef ?? null, row.destinationPort ?? null,
        JSON.stringify(row.raw),
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  audit(db, {
    orgId: input.orgId,
    actorId: input.uploadedBy,
    action: 'report.commit',
    entityType: 'pickup_report',
    entityId: reportId,
    after: {
      referenceNo: input.referenceNo,
      version,
      lineCount: valid.length,
      rejectedCount: preview.rejectedCount,
    },
  });

  return { reportId, version, lineCount: valid.length };
}
