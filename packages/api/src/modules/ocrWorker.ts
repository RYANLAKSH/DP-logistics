/**
 * OCR worker.
 *
 * Drains the recognition queue: takes a queued document, sends it to the
 * provider, stores the text, then re-runs auto-linking so the paperwork attaches
 * itself to the containers and VINs it names.
 *
 * In-process rather than a separate BullMQ worker. That is a deliberate
 * simplification at pilot volume — a handful of documents per shipment, not
 * thousands per second — and the queue lives in the database, so moving to a
 * real worker later means pointing a different process at the same table rather
 * than redesigning anything.
 *
 * Recognition costs money per page, so the cost guards are part of the design
 * rather than an afterthought: skip when text already exists, reuse text from an
 * identical file, cap pages, and cap retries.
 */

import { type Db, newId, nowIso, audit } from '../lib/db.ts';
import { autoLinkFromText, type AutoLinkResult } from './documents.ts';
import {
  getOcrProvider,
  MAX_OCR_PAGES,
  type OcrProvider,
} from './ocr.ts';

/** Attempts before a job is abandoned. Recognition failures are rarely transient. */
export const MAX_OCR_ATTEMPTS = 3;

/**
 * Passes a job may spend waiting on an async provider before it is abandoned.
 *
 * Much higher than MAX_OCR_ATTEMPTS because polling is not failing — a
 * multi-page Textract job legitimately takes minutes. But it is bounded: a
 * provider job that never leaves IN_PROGRESS would otherwise be polled forever,
 * costing an API call every pass with nothing to show for it.
 */
export const MAX_OCR_POLLS = 60;

interface JobRow {
  id: string;
  org_id: string;
  document_id: string;
  state: string;
  provider_job_ref: string | null;
  attempts: number;
}

interface DocumentRow {
  id: string;
  file_key: string | null;
  file_content_type: string | null;
  file_bytes: number | null;
  file_sha256: string | null;
  extracted_text: string | null;
}

export interface OcrWorkerResult {
  processed: number;
  completed: number;
  pendingProvider: number;
  failed: number;
  skipped: number;
  reused: number;
  /** Linking outcomes per completed document. */
  linked: { documentId: string; result: AutoLinkResult }[];
}

const emptyResult = (): OcrWorkerResult => ({
  processed: 0, completed: 0, pendingProvider: 0, failed: 0, skipped: 0, reused: 0, linked: [],
});

function setJobState(
  db: Db,
  jobId: string,
  state: string,
  fields: Record<string, string | number | null> = {},
): void {
  const columns = Object.keys(fields);
  const assignments = ['state = ?', ...columns.map((column) => `${column} = ?`)].join(', ');

  db.prepare(`UPDATE ocr_jobs SET ${assignments} WHERE id = ?`)
    .run(state, ...columns.map((column) => fields[column]!), jobId);
}

function mirrorToDocument(db: Db, documentId: string, state: string): void {
  db.prepare('UPDATE documents SET ocr_state = ? WHERE id = ?').run(state, documentId);
}

/**
 * Applies recognised text: stores it, links it, and records what it linked.
 */
function applyText(
  db: Db,
  job: JobRow,
  text: string,
  pages: number | null,
  reusedFrom: string | null,
): AutoLinkResult {
  db.prepare('UPDATE documents SET extracted_text = ? WHERE id = ?').run(text, job.document_id);

  const linked = autoLinkFromText(db, job.org_id, job.document_id, text);

  setJobState(db, job.id, 'done', {
    pages: pages ?? null,
    linked_containers: JSON.stringify(linked.containers),
    linked_vins: JSON.stringify(linked.vins),
    unmatched: JSON.stringify(linked.unmatched),
    reused_from_id: reusedFrom,
    finished_at: nowIso(),
  });
  mirrorToDocument(db, job.document_id, 'done');

  audit(db, {
    orgId: job.org_id,
    action: reusedFrom ? 'document.ocr_reused' : 'document.ocr_complete',
    entityType: 'document',
    entityId: job.document_id,
    after: {
      pages,
      containers: linked.containers.length,
      vins: linked.vins.length,
      unmatched: linked.unmatched.length,
    },
  });

  return linked;
}

/**
 * Text already recognised for a byte-identical file.
 *
 * The same invoice gets uploaded by two people, or re-sent after an email
 * thread goes sideways. Paying per page twice for identical bytes is pure waste,
 * and the hash makes the identity check exact rather than heuristic.
 */
function findReusableText(
  db: Db,
  orgId: string,
  sha256: string | null,
  excludeId: string,
): { text: string; sourceId: string } | null {
  if (!sha256) return null;

  const row = db
    .prepare(
      `SELECT id, extracted_text FROM documents
        WHERE org_id = ? AND file_sha256 = ? AND id <> ?
          AND extracted_text IS NOT NULL AND TRIM(extracted_text) <> ''
        ORDER BY created_at LIMIT 1`,
    )
    .get(orgId, sha256, excludeId) as { id: string; extracted_text: string } | undefined;

  return row ? { text: row.extracted_text, sourceId: row.id } : null;
}

/**
 * Processes up to `limit` jobs. Call repeatedly; safe to call concurrently
 * because each job is claimed by a state transition before any work happens.
 */
export async function runOcrWorker(
  db: Db,
  options: { limit?: number; provider?: OcrProvider } = {},
): Promise<OcrWorkerResult> {
  const provider = options.provider ?? getOcrProvider();
  const limit = options.limit ?? 5;
  const result = emptyResult();

  // Queued work and in-flight provider jobs have different budgets: a retry
  // means something went wrong, a poll just means the provider is still working.
  const jobs = db
    .prepare(
      `SELECT id, org_id, document_id, state, provider_job_ref, attempts
         FROM ocr_jobs
        WHERE (state = 'queued' AND attempts < ?)
           OR (state = 'pending_provider' AND attempts < ?)
        ORDER BY queued_at LIMIT ?`,
    )
    .all(MAX_OCR_ATTEMPTS, MAX_OCR_POLLS, limit) as unknown as JobRow[];

  for (const job of jobs) {
    result.processed++;

    // Claim the job before doing anything, so a second worker skips it.
    setJobState(db, job.id, 'running', {
      attempts: job.attempts + 1,
      started_at: nowIso(),
    });

    const document = db
      .prepare(
        `SELECT id, file_key, file_content_type, file_bytes, file_sha256, extracted_text
           FROM documents WHERE id = ?`,
      )
      .get(job.document_id) as unknown as DocumentRow | undefined;

    if (!document?.file_key || !document.file_content_type) {
      setJobState(db, job.id, 'failed', { error: 'DOCUMENT_INCOMPLETE', finished_at: nowIso() });
      mirrorToDocument(db, job.document_id, 'failed');
      result.failed++;
      continue;
    }

    // Text may have arrived while the job sat in the queue.
    if (document.extracted_text?.trim()) {
      applyText(db, job, document.extracted_text, null, null);
      setJobState(db, job.id, 'skipped', {
        error: 'TEXT_ALREADY_PRESENT', finished_at: nowIso(),
      });
      mirrorToDocument(db, job.document_id, 'done');
      result.skipped++;
      continue;
    }

    const reusable = findReusableText(db, job.org_id, document.file_sha256, document.id);
    if (reusable) {
      // Record the document the text CAME FROM, not this one — the whole value
      // of the field is being able to trace where the text originated.
      const linked = applyText(db, job, reusable.text, null, reusable.sourceId);
      result.linked.push({ documentId: job.document_id, result: linked });
      result.reused++;
      result.completed++;
      continue;
    }

    try {
      const outcome = job.state === 'pending_provider' && job.provider_job_ref && provider.poll
        ? await provider.poll(job.provider_job_ref)
        : await provider.recognize({
            key: document.file_key,
            contentType: document.file_content_type,
            bytes: document.file_bytes ?? 0,
          });

      if (outcome.status === 'pending') {
        // Keep the incremented count — the pass did real work — but the job now
        // sits under the poll budget rather than the retry budget.
        setJobState(db, job.id, 'pending_provider', {
          provider_job_ref: outcome.jobRef,
        });
        mirrorToDocument(db, job.document_id, 'pending');
        result.pendingProvider++;
        continue;
      }

      if (outcome.status === 'unsupported') {
        setJobState(db, job.id, 'failed', { error: outcome.reason, finished_at: nowIso() });
        mirrorToDocument(db, job.document_id, 'failed');
        result.failed++;
        continue;
      }

      if ((outcome.pages ?? 1) > MAX_OCR_PAGES) {
        setJobState(db, job.id, 'failed', {
          error: `TOO_MANY_PAGES:${outcome.pages}`, pages: outcome.pages ?? null,
          finished_at: nowIso(),
        });
        mirrorToDocument(db, job.document_id, 'failed');
        result.failed++;
        continue;
      }

      if (!outcome.text.trim()) {
        // A genuinely blank result. Distinguished from a failure because the
        // operational response differs: this document needs manual linking, it
        // does not need the pipeline debugged.
        setJobState(db, job.id, 'done', {
          pages: outcome.pages ?? null,
          error: 'NO_TEXT_FOUND',
          linked_containers: '[]', linked_vins: '[]', unmatched: '[]',
          finished_at: nowIso(),
        });
        mirrorToDocument(db, job.document_id, 'no_text');
        result.completed++;
        continue;
      }

      const linked = applyText(db, job, outcome.text, outcome.pages ?? null, null);
      result.linked.push({ documentId: job.document_id, result: linked });
      result.completed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = job.attempts + 1 >= MAX_OCR_ATTEMPTS;

      setJobState(db, job.id, exhausted ? 'failed' : 'queued', {
        error: message.slice(0, 500),
        ...(exhausted ? { finished_at: nowIso() } : {}),
      });
      mirrorToDocument(db, job.document_id, exhausted ? 'failed' : 'queued');
      result.failed++;
    }
  }

  return result;
}

/**
 * Background loop for the dev server.
 *
 * Unhurried on purpose: recognition is not on anyone's critical path, and
 * polling Textract aggressively costs API calls for no benefit.
 */
export function startOcrWorker(db: Db, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void runOcrWorker(db).catch((error) => {
      console.error('[ocr] worker pass failed', error);
    });
  }, intervalMs);

  return () => clearInterval(timer);
}

/** Forces a fresh recognition pass, discarding whatever text is there. */
export function requeueOcr(db: Db, orgId: string, documentId: string): { queued: boolean; reason?: string } {
  const document = db
    .prepare('SELECT verified FROM documents WHERE id = ? AND org_id = ?')
    .get(documentId, orgId) as { verified: number } | undefined;

  if (!document) return { queued: false, reason: 'UNKNOWN_DOCUMENT' };
  if (!document.verified) return { queued: false, reason: 'NOT_VERIFIED' };

  db.prepare(
    `INSERT INTO ocr_jobs (id, org_id, document_id, provider, state, queued_at)
     VALUES (?,?,?,?,'queued',?)`,
  ).run(newId(), orgId, documentId, getOcrProvider().name, nowIso());

  mirrorToDocument(db, documentId, 'queued');
  return { queued: true };
}

export interface OcrJobSummary {
  id: string;
  documentId: string;
  state: string;
  provider: string;
  pages: number | null;
  attempts: number;
  error: string | null;
  linkedContainers: string[];
  linkedVins: string[];
  unmatched: string[];
  reusedFromId: string | null;
  queuedAt: string;
  finishedAt: string | null;
}

const parseArray = (value: unknown): string[] => {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const toSummary = (row: Record<string, unknown>): OcrJobSummary => ({
  id: String(row.id),
  documentId: String(row.document_id),
  state: String(row.state),
  provider: String(row.provider),
  pages: row.pages == null ? null : Number(row.pages),
  attempts: Number(row.attempts),
  error: (row.error as string) ?? null,
  linkedContainers: parseArray(row.linked_containers),
  linkedVins: parseArray(row.linked_vins),
  unmatched: parseArray(row.unmatched),
  reusedFromId: (row.reused_from_id as string) ?? null,
  queuedAt: String(row.queued_at),
  finishedAt: (row.finished_at as string) ?? null,
});

export function latestOcrJob(db: Db, orgId: string, documentId: string): OcrJobSummary | null {
  const row = db
    .prepare(
      `SELECT * FROM ocr_jobs WHERE org_id = ? AND document_id = ?
        ORDER BY queued_at DESC LIMIT 1`,
    )
    .get(orgId, documentId) as Record<string, unknown> | undefined;

  return row ? toSummary(row) : null;
}

export function listOcrJobs(db: Db, orgId: string, limit = 50): OcrJobSummary[] {
  const rows = db
    .prepare('SELECT * FROM ocr_jobs WHERE org_id = ? ORDER BY queued_at DESC LIMIT ?')
    .all(orgId, Math.min(limit, 200)) as Record<string, unknown>[];

  return rows.map(toSummary);
}
