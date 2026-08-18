/**
 * Trade document repository.
 *
 * The paperwork a shipment travels on — pickup list, delivery order, commercial
 * invoice, packing list, shipping bill and its summary, LEO, bill of lading —
 * stored under the same integrity discipline as scan evidence: declare a hash,
 * upload, verify what landed.
 *
 * The part that earns its keep is auto-linking. A document is scanned for
 * container numbers and VINs using the SAME extractors the camera uses, and
 * every identifier found becomes a link. That is what lets a container's
 * dossier — report line, verdict, photographs, paperwork — be assembled without
 * anyone filing anything by hand.
 *
 * An extracted link records what the document actually says. A manual link
 * records someone's claim about it. They are stored distinctly on purpose,
 * because in a dispute the difference matters.
 */

import {
  extractContainerNumbers,
  extractVins,
  normalizeContainerNo,
  normalizeVin,
} from '@dp/shared-rules';

import { type Db, newId, nowIso, audit } from '../lib/db.ts';
import { enqueueOcr } from './ocr.ts';
import {
  getStorage,
  documentKey,
  DOCUMENT_CONTENT_TYPES,
  type PresignedUpload,
} from '../lib/storage.ts';

/** Documents can be large — a scanned shipping bill runs to several megabytes. */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

export const UPLOAD_TTL_SECONDS = 60 * 60;
export const VIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The document types this system understands.
 *
 * Open-ended by design — OTHER exists so an unrecognised document can still be
 * stored and linked rather than being turned away, which is what drives people
 * back to email attachments.
 */
export const DOC_TYPES = [
  'PICKUP_LIST',
  'DELIVERY_ORDER',
  'COMMERCIAL_INVOICE',
  'PACKING_LIST',
  'SHIPPING_BILL',
  'SHIPPING_BILL_SUMMARY',
  'LEO',                    // Let Export Order — customs clearance to load
  'BILL_OF_LADING',
  'VGM_CERTIFICATE',        // Verified Gross Mass
  'SEAL_CERTIFICATE',
  'CUSTOMS_EXAM_REPORT',
  'EGM',                    // Export General Manifest
  'INSURANCE_CERTIFICATE',
  'OTHER',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export type EntityType = 'container' | 'vin' | 'delivery_order' | 'pickup_report' | 'booking';

export interface DocumentDeclaration {
  docType: DocType;
  referenceNo?: string;
  issuedOn?: string;
  issuedBy?: string;
  fileName?: string;
  contentType: string;
  sha256: string;
  bytes: number;
  locationId?: string;
  /** Links the uploader asserts, in addition to anything extracted. */
  links?: { entityType: EntityType; entityId: string }[];
  /** Text already extracted client-side, if any. */
  extractedText?: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type DocumentRejection =
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'FILE_TOO_LARGE'
  | 'MALFORMED_SHA256'
  | 'UNKNOWN_DOC_TYPE';

/**
 * Registers a document and returns an upload URL.
 *
 * Same shape as scan evidence: the declaration is committed first so the
 * expected hash exists independently of the bytes that later arrive.
 */
export async function declareDocument(
  db: Db,
  orgId: string,
  uploaderId: string,
  declaration: DocumentDeclaration,
): Promise<
  | { ok: true; documentId: string; upload: PresignedUpload }
  | { ok: false; reason: DocumentRejection }
> {
  if (!DOC_TYPES.includes(declaration.docType)) {
    return { ok: false, reason: 'UNKNOWN_DOC_TYPE' };
  }
  if (!DOCUMENT_CONTENT_TYPES.has(declaration.contentType)) {
    return { ok: false, reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }
  if (declaration.bytes <= 0 || declaration.bytes > MAX_DOCUMENT_BYTES) {
    return { ok: false, reason: 'FILE_TOO_LARGE' };
  }
  if (!SHA256_PATTERN.test(declaration.sha256)) {
    return { ok: false, reason: 'MALFORMED_SHA256' };
  }

  const documentId = newId();
  const at = nowIso();
  const key = documentKey({
    orgId,
    documentId,
    uploadedAt: at,
    contentType: declaration.contentType,
  });

  db.prepare(
    `INSERT INTO documents (id, org_id, doc_type, reference_no, issued_on, issued_by,
                            file_name, file_key, file_sha256, file_content_type, file_bytes,
                            extracted_text, uploaded_by, location_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    documentId, orgId, declaration.docType, declaration.referenceNo ?? null,
    declaration.issuedOn ?? null, declaration.issuedBy ?? null,
    declaration.fileName ?? null, key, declaration.sha256, declaration.contentType,
    declaration.bytes, declaration.extractedText ?? null, uploaderId,
    declaration.locationId ?? null, at,
  );

  for (const link of declaration.links ?? []) {
    linkDocument(db, documentId, link.entityType, link.entityId, 'manual');
  }

  if (declaration.extractedText) {
    autoLinkFromText(db, orgId, documentId, declaration.extractedText);
  }

  audit(db, {
    orgId, actorId: uploaderId, action: 'document.declare',
    entityType: 'document', entityId: documentId,
    after: { docType: declaration.docType, referenceNo: declaration.referenceNo },
  });

  const upload = await getStorage().presignPut(key, declaration.contentType, UPLOAD_TTL_SECONDS);
  return { ok: true, documentId, upload };
}

/** Idempotent link insert. */
export function linkDocument(
  db: Db,
  documentId: string,
  entityType: EntityType,
  entityId: string,
  source: 'manual' | 'extracted',
): void {
  // Normalize identifiers so a link created from document text matches one
  // created from a report — the whole point is that they join.
  const normalized =
    entityType === 'container' ? normalizeContainerNo(entityId)
    : entityType === 'vin' ? normalizeVin(entityId)
    : entityId;

  db.prepare(
    `INSERT OR IGNORE INTO document_links (document_id, entity_type, entity_id, link_source, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(documentId, entityType, normalized, source, nowIso());
}

export interface AutoLinkResult {
  containers: string[];
  vins: string[];
  /** Identifiers found in the text that appear on no active report line. */
  unmatched: string[];
}

/**
 * Scans document text for container numbers and VINs and links what it finds.
 *
 * Only identifiers that appear on an active report line are linked. That
 * restraint is deliberate: a shipping bill mentions container numbers from
 * other consignments, and linking every string that happens to satisfy a check
 * digit would attach documents to shipments they have nothing to do with.
 * Unmatched identifiers are reported so a human can decide.
 */
export function autoLinkFromText(
  db: Db,
  orgId: string,
  documentId: string,
  text: string,
): AutoLinkResult {
  const foundContainers = extractContainerNumbers(text);
  const foundVins = extractVins(text);

  const knownContainers = new Set(
    (db.prepare(
      `SELECT DISTINCT l.container_no FROM pickup_report_lines l
         JOIN pickup_reports r ON r.id = l.report_id
        WHERE r.org_id = ?`,
    ).all(orgId) as { container_no: string }[]).map((row) => row.container_no),
  );

  const knownVins = new Set(
    (db.prepare(
      `SELECT DISTINCT l.vin FROM pickup_report_lines l
         JOIN pickup_reports r ON r.id = l.report_id
        WHERE r.org_id = ?`,
    ).all(orgId) as { vin: string }[]).map((row) => row.vin),
  );

  const containers: string[] = [];
  const vins: string[] = [];
  const unmatched: string[] = [];

  for (const containerNo of foundContainers) {
    if (knownContainers.has(containerNo)) {
      linkDocument(db, documentId, 'container', containerNo, 'extracted');
      containers.push(containerNo);
    } else {
      unmatched.push(containerNo);
    }
  }

  for (const vin of foundVins) {
    if (knownVins.has(vin)) {
      linkDocument(db, documentId, 'vin', vin, 'extracted');
      vins.push(vin);
    } else {
      unmatched.push(vin);
    }
  }

  return { containers, vins, unmatched };
}

export type DocumentFinalizeResult =
  | {
      status: 'verified';
      bytes: number;
      /** True when recognition was queued; false with a reason when it was not. */
      ocrQueued?: boolean;
      ocrSkipReason?: string;
    }
  | { status: 'missing' }
  | { status: 'hash_mismatch'; expected: string; actual: string }
  | { status: 'unknown_document' };

/** Verifies an uploaded document against its declared hash. */
export async function finalizeDocument(
  db: Db,
  orgId: string,
  documentId: string,
  actorId: string,
): Promise<DocumentFinalizeResult> {
  const document = db
    .prepare('SELECT id, file_key, file_sha256 FROM documents WHERE id = ? AND org_id = ?')
    .get(documentId, orgId) as
    | { id: string; file_key: string | null; file_sha256: string | null }
    | undefined;

  if (!document?.file_key || !document.file_sha256) return { status: 'unknown_document' };

  const stored = await getStorage().stat(document.file_key);
  if (!stored) return { status: 'missing' };

  const record = (action: string) =>
    db.prepare(
      `INSERT INTO evidence_access_log (id, org_id, actor_id, document_id, action, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(newId(), orgId, actorId, documentId, action, nowIso());

  if (stored.sha256 !== document.file_sha256) {
    record('doc_verify_failed_hash');
    return { status: 'hash_mismatch', expected: document.file_sha256, actual: stored.sha256 };
  }

  db.prepare('UPDATE documents SET uploaded_at = ?, verified = 1 WHERE id = ?')
    .run(nowIso(), documentId);
  record('doc_verified');

  // Queue text recognition now that the bytes are confirmed. Recognising an
  // unverified file would mean extracting identifiers from something that may
  // not be the document it claims to be — and then linking on them.
  const ocr = enqueueOcr(db, orgId, documentId);

  return { status: 'verified', bytes: stored.bytes, ocrQueued: ocr.queued, ocrSkipReason: ocr.reason };
}

/** Re-extracts links, e.g. after a report is committed that the document predates. */
export function relinkDocument(db: Db, orgId: string, documentId: string): AutoLinkResult | null {
  const row = db
    .prepare('SELECT extracted_text FROM documents WHERE id = ? AND org_id = ?')
    .get(documentId, orgId) as { extracted_text: string | null } | undefined;

  if (!row?.extracted_text) return null;
  return autoLinkFromText(db, orgId, documentId, row.extracted_text);
}

/* ------------------------------------------------------------------ *
 * Retrieval
 * ------------------------------------------------------------------ */

export interface DocumentSummary {
  id: string;
  docType: string;
  referenceNo: string | null;
  issuedOn: string | null;
  issuedBy: string | null;
  fileName: string | null;
  contentType: string | null;
  bytes: number | null;
  sha256: string | null;
  verified: boolean;
  status: string;
  uploadedAt: string | null;
  /** Latest recognition state, mirrored onto the document row. */
  ocrState: string | null;
  linkSource?: string;
  url?: string | null;
  expiresAt?: string | null;
}

const toSummary = (row: Record<string, unknown>): DocumentSummary => ({
  id: String(row.id),
  docType: String(row.doc_type),
  referenceNo: (row.reference_no as string) ?? null,
  issuedOn: (row.issued_on as string) ?? null,
  issuedBy: (row.issued_by as string) ?? null,
  fileName: (row.file_name as string) ?? null,
  contentType: (row.file_content_type as string) ?? null,
  bytes: row.file_bytes == null ? null : Number(row.file_bytes),
  sha256: (row.file_sha256 as string) ?? null,
  verified: Boolean(row.verified),
  status: String(row.status),
  uploadedAt: (row.uploaded_at as string) ?? null,
  ocrState: (row.ocr_state as string) ?? null,
  ...(row.link_source ? { linkSource: String(row.link_source) } : {}),
});

export function listDocuments(
  db: Db,
  orgId: string,
  filters: { docType?: string; referenceNo?: string; limit?: number } = {},
): DocumentSummary[] {
  const rows = db
    .prepare(
      `SELECT * FROM documents
        WHERE org_id = ?
          AND (? IS NULL OR doc_type = ?)
          AND (? IS NULL OR reference_no = ?)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(orgId, filters.docType ?? null, filters.docType ?? null,
         filters.referenceNo ?? null, filters.referenceNo ?? null,
         Math.min(filters.limit ?? 100, 500)) as Record<string, unknown>[];

  return rows.map(toSummary);
}

/** Documents attached to one entity — a container, a VIN, a DO. */
export function documentsFor(
  db: Db,
  orgId: string,
  entityType: EntityType,
  entityId: string,
): DocumentSummary[] {
  const normalized =
    entityType === 'container' ? normalizeContainerNo(entityId)
    : entityType === 'vin' ? normalizeVin(entityId)
    : entityId;

  const rows = db
    .prepare(
      `SELECT d.*, dl.link_source FROM documents d
         JOIN document_links dl ON dl.document_id = d.id
        WHERE d.org_id = ? AND dl.entity_type = ? AND dl.entity_id = ?
          AND d.status = 'active'
        ORDER BY d.doc_type, d.created_at DESC`,
    )
    .all(orgId, entityType, normalized) as Record<string, unknown>[];

  return rows.map(toSummary);
}

/* ------------------------------------------------------------------ *
 * The dossier
 * ------------------------------------------------------------------ */

export interface DossierVehicle {
  vin: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  loadPosition: number | null;
  /** The live verdict for this vehicle, if it has been scanned. */
  outcome: string | null;
  reconciliationId: string | null;
  reconciledAt: string | null;
  /** Whether both photographs exist and were hash-verified. */
  evidenceVerified: number;
  evidenceExpected: number;
  documents: DocumentSummary[];
}

export interface Dossier {
  containerNo: string;
  reportReference: string | null;
  reportVersion: number | null;
  expected: number;
  loaded: number;
  complete: boolean;
  vehicles: DossierVehicle[];
  documents: DocumentSummary[];
  requirements: { docType: string; present: boolean }[];
  /** True when every mandatory document type is present and verified. */
  documentsComplete: boolean;
}

/**
 * Everything known about one container, assembled in one place.
 *
 * This is the answer to "can this container ship?" — the vehicles that should be
 * in it, which are confirmed aboard with verified photographs, and whether the
 * paperwork is complete. Each of those three lives in a different place
 * operationally, which is exactly why they get reconciled here rather than in
 * someone's head.
 */
export function buildDossier(db: Db, orgId: string, containerNoRaw: string): Dossier | null {
  const containerNo = normalizeContainerNo(containerNoRaw);

  const lines = db
    .prepare(
      `SELECT l.id, l.vin, l.make, l.model, l.colour, l.load_position,
              r.reference_no, r.version
         FROM pickup_report_lines l
         JOIN pickup_reports r ON r.id = l.report_id
        WHERE r.org_id = ? AND r.status = 'active' AND l.container_no = ?
        ORDER BY l.load_position, l.line_no`,
    )
    .all(orgId, containerNo) as Record<string, unknown>[];

  if (lines.length === 0) return null;

  const vehicles: DossierVehicle[] = lines.map((line) => {
    const vin = String(line.vin);

    const reconciliation = db
      .prepare(
        `SELECT id, outcome, reconciled_at, session_id FROM reconciliations
          WHERE org_id = ? AND vin = ? AND supersedes_id IS NULL
          ORDER BY reconciled_at DESC LIMIT 1`,
      )
      .get(orgId, vin) as
      | { id: string; outcome: string; reconciled_at: string; session_id: string }
      | undefined;

    const evidence = reconciliation
      ? db.prepare(
          `SELECT COUNT(*) AS expected,
                  SUM(CASE WHEN image_verified = 1 THEN 1 ELSE 0 END) AS verified
             FROM scans WHERE session_id = ?`,
        ).get(reconciliation.session_id) as { expected: number; verified: number | null }
      : { expected: 0, verified: 0 };

    return {
      vin,
      make: (line.make as string) ?? null,
      model: (line.model as string) ?? null,
      colour: (line.colour as string) ?? null,
      loadPosition: line.load_position == null ? null : Number(line.load_position),
      outcome: reconciliation?.outcome ?? null,
      reconciliationId: reconciliation?.id ?? null,
      reconciledAt: reconciliation?.reconciled_at ?? null,
      evidenceVerified: evidence.verified ?? 0,
      evidenceExpected: evidence.expected,
      documents: documentsFor(db, orgId, 'vin', vin),
    };
  });

  const containerDocuments = documentsFor(db, orgId, 'container', containerNo);

  // A requirement is satisfied by a verified document linked to the container
  // OR to any vehicle in it — an invoice covering the whole consignment is
  // linked per VIN, and demanding a container-level copy as well would be
  // paperwork for its own sake.
  const allDocTypes = new Set<string>([
    ...containerDocuments.filter((d) => d.verified).map((d) => d.docType),
    ...vehicles.flatMap((v) => v.documents.filter((d) => d.verified).map((d) => d.docType)),
  ]);

  const requiredTypes = (db
    .prepare(
      `SELECT doc_type FROM document_requirements
        WHERE org_id = ? AND is_active = 1 ORDER BY doc_type`,
    )
    .all(orgId) as { doc_type: string }[]).map((row) => row.doc_type);

  const requirements = requiredTypes.map((docType) => ({
    docType,
    present: allDocTypes.has(docType),
  }));

  const loaded = vehicles.filter((v) => v.outcome === 'MATCH').length;

  return {
    containerNo,
    reportReference: (lines[0]!.reference_no as string) ?? null,
    reportVersion: lines[0]!.version == null ? null : Number(lines[0]!.version),
    expected: vehicles.length,
    loaded,
    complete: loaded === vehicles.length,
    vehicles,
    documents: containerDocuments,
    requirements,
    documentsComplete: requirements.every((r) => r.present),
  };
}

/** A viewing link for one document. Logged, like evidence. */
export async function documentViewUrl(
  db: Db,
  orgId: string,
  documentId: string,
  actor: { id: string; ip?: string | null },
): Promise<{ url: string; expiresAt: string } | null> {
  const row = db
    .prepare('SELECT file_key, verified FROM documents WHERE id = ? AND org_id = ?')
    .get(documentId, orgId) as { file_key: string | null; verified: number } | undefined;

  // Unverified documents are not served, for the same reason unverified photos
  // are not: handing one over presents it as the record when it is not.
  if (!row?.file_key || !row.verified) return null;

  const signed = await getStorage().presignGet(row.file_key, VIEW_TTL_SECONDS);

  db.prepare(
    `INSERT INTO evidence_access_log (id, org_id, actor_id, document_id, action, ip, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(newId(), orgId, actor.id, documentId, 'doc_presign_view', actor.ip ?? null, nowIso());

  return signed;
}
