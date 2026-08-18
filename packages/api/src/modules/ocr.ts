/**
 * Text recognition for scanned documents.
 *
 * The gap this closes: auto-linking needs text, and a CHA sending a photographed
 * shipping bill sends no text at all. Without recognition those documents have
 * to be linked by hand, which is exactly the manual filing the document store
 * was meant to remove.
 *
 * Providers behind one interface:
 *
 *   NoopOcrProvider    — the DEFAULT. Recognition costs money per page, so it
 *                        stays off until someone configures it. Documents still
 *                        upload and link manually.
 *   TextractOcrProvider — AWS Textract. Synchronous for single images, async for
 *                        multi-page PDFs (start a job, poll it).
 *   FixtureOcrProvider  — test seam with canned text, so the whole pipeline is
 *                        exercisable without credentials.
 */

import { type Db, newId, nowIso } from '../lib/db.ts';

/** Refuse anything longer. Textract bills per page; a 400-page scan is a mistake. */
export const MAX_OCR_PAGES = 30;

export interface OcrInput {
  key: string;
  contentType: string;
  bytes: number;
}

export type OcrOutcome =
  /** Text is available now. */
  | { status: 'done'; text: string; pages?: number }
  /** Provider accepted an async job; poll it with this handle. */
  | { status: 'pending'; jobRef: string }
  /** This provider cannot handle this input at all. */
  | { status: 'unsupported'; reason: string };

export interface OcrProvider {
  readonly name: string;
  recognize(input: OcrInput): Promise<OcrOutcome>;
  /** Only needed by providers that return 'pending'. */
  poll?(jobRef: string): Promise<OcrOutcome>;
}

/* ------------------------------------------------------------------ *
 * Noop — the default
 * ------------------------------------------------------------------ */

export class NoopOcrProvider implements OcrProvider {
  readonly name = 'none';

  async recognize(): Promise<OcrOutcome> {
    return { status: 'unsupported', reason: 'OCR_NOT_CONFIGURED' };
  }
}

/* ------------------------------------------------------------------ *
 * Textract
 * ------------------------------------------------------------------ */

/** Loaded dynamically — an optional dependency, like the S3 client. */
const optionalImport = (specifier: string): Promise<any> => import(specifier);

/**
 * AWS Textract.
 *
 * Two paths, because Textract has two:
 *   - single-page images (JPEG/PNG/TIFF) → DetectDocumentText, synchronous
 *   - PDFs                               → StartDocumentTextDetection, async
 *
 * The async path reads the object straight out of the bucket, so nothing is
 * re-uploaded and the bytes never pass through this process.
 *
 * NOT exercised by the test suite — that needs real credentials and real spend.
 * FixtureOcrProvider covers the pipeline; this class covers the API surface.
 */
export class TextractOcrProvider implements OcrProvider {
  readonly name = 'textract';

  private readonly bucket: string;
  private readonly region: string;

  constructor(bucket: string, region: string) {
    this.bucket = bucket;
    this.region = region;
  }

  private async client() {
    const { TextractClient } = await optionalImport('@aws-sdk/client-textract');
    return new TextractClient({ region: this.region });
  }

  /** Joins Textract LINE blocks in reading order. */
  private static linesFrom(blocks: any[]): string {
    return (blocks ?? [])
      .filter((block) => block.BlockType === 'LINE')
      .map((block) => String(block.Text ?? ''))
      .join('\n');
  }

  async recognize(input: OcrInput): Promise<OcrOutcome> {
    const textract = await optionalImport('@aws-sdk/client-textract');
    const client = await this.client();

    // PDFs go through the async path even when single-page: Textract's sync API
    // rejects multi-page PDFs and we cannot tell the page count from here.
    if (input.contentType === 'application/pdf') {
      const started = await client.send(
        new textract.StartDocumentTextDetectionCommand({
          DocumentLocation: { S3Object: { Bucket: this.bucket, Name: input.key } },
        }),
      );
      return { status: 'pending', jobRef: String(started.JobId) };
    }

    const detected = await client.send(
      new textract.DetectDocumentTextCommand({
        Document: { S3Object: { Bucket: this.bucket, Name: input.key } },
      }),
    );

    return {
      status: 'done',
      text: TextractOcrProvider.linesFrom(detected.Blocks),
      pages: 1,
    };
  }

  async poll(jobRef: string): Promise<OcrOutcome> {
    const textract = await optionalImport('@aws-sdk/client-textract');
    const client = await this.client();

    const blocks: any[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    // Results are paginated independently of document pages, so drain fully
    // before declaring the job done.
    do {
      const page: any = await client.send(
        new textract.GetDocumentTextDetectionCommand({ JobId: jobRef, NextToken: nextToken }),
      );

      if (page.JobStatus === 'IN_PROGRESS') return { status: 'pending', jobRef };
      if (page.JobStatus === 'FAILED') {
        return { status: 'unsupported', reason: String(page.StatusMessage ?? 'TEXTRACT_FAILED') };
      }

      blocks.push(...(page.Blocks ?? []));
      pages = Number(page.DocumentMetadata?.Pages ?? pages);
      nextToken = page.NextToken;
    } while (nextToken);

    return { status: 'done', text: TextractOcrProvider.linesFrom(blocks), pages };
  }
}

/* ------------------------------------------------------------------ *
 * Fixture provider
 * ------------------------------------------------------------------ */

/**
 * Returns canned text per object key, so the queue, linking, cost guards and
 * failure handling can all be tested without a cloud account.
 */
export class FixtureOcrProvider implements OcrProvider {
  readonly name = 'fixture';

  private readonly byKey = new Map<string, string>();
  private readonly asyncKeys = new Set<string>();
  private readonly failKeys = new Set<string>();
  private readonly pending = new Map<string, string>();

  /** Text this key should recognise as. */
  set(key: string, text: string): void {
    this.byKey.set(key, text);
  }

  /** Makes this key take the async path, returning 'pending' first. */
  setAsync(key: string, text: string): void {
    this.byKey.set(key, text);
    this.asyncKeys.add(key);
  }

  /** Makes this key fail recognition. */
  setFailing(key: string): void {
    this.failKeys.add(key);
  }

  async recognize(input: OcrInput): Promise<OcrOutcome> {
    if (this.failKeys.has(input.key)) {
      return { status: 'unsupported', reason: 'FIXTURE_FAILURE' };
    }

    const text = this.byKey.get(input.key);
    if (text === undefined) return { status: 'unsupported', reason: 'NO_FIXTURE_FOR_KEY' };

    if (this.asyncKeys.has(input.key)) {
      const jobRef = `fixture-${newId()}`;
      this.pending.set(jobRef, text);
      return { status: 'pending', jobRef };
    }

    return { status: 'done', text, pages: 1 };
  }

  async poll(jobRef: string): Promise<OcrOutcome> {
    const text = this.pending.get(jobRef);
    if (text === undefined) return { status: 'unsupported', reason: 'UNKNOWN_JOB' };

    this.pending.delete(jobRef);
    return { status: 'done', text, pages: 2 };
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

let provider: OcrProvider | null = null;

export function getOcrProvider(): OcrProvider {
  if (provider) return provider;

  // Textract reads from the bucket, so it is only available alongside S3
  // storage — there is nothing for it to read in a local deployment.
  if (process.env.OCR_PROVIDER === 'textract' && process.env.S3_BUCKET) {
    provider = new TextractOcrProvider(
      process.env.S3_BUCKET,
      process.env.TEXTRACT_REGION ?? process.env.S3_REGION ?? 'ap-south-1',
    );
  } else {
    provider = new NoopOcrProvider();
  }
  return provider;
}

export const setOcrProvider = (next: OcrProvider | null): void => { provider = next; };

/* ------------------------------------------------------------------ *
 * Queueing
 * ------------------------------------------------------------------ */

/** Content types worth sending to recognition. */
const RECOGNISABLE = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
]);

export const isRecognisable = (contentType: string): boolean => RECOGNISABLE.has(contentType);

/**
 * Queues recognition for a document, unless there is no point.
 *
 * Skips when text already exists — a CSV, or an admin who pasted it — because
 * recognition would cost money to produce something we already have.
 */
export function enqueueOcr(
  db: Db,
  orgId: string,
  documentId: string,
): { queued: boolean; reason?: string } {
  const document = db
    .prepare(
      `SELECT file_content_type, extracted_text, verified
         FROM documents WHERE id = ? AND org_id = ?`,
    )
    .get(documentId, orgId) as
    | { file_content_type: string | null; extracted_text: string | null; verified: number }
    | undefined;

  if (!document) return { queued: false, reason: 'UNKNOWN_DOCUMENT' };

  // Never recognise an unverified file: it may not be the document it claims.
  if (!document.verified) return { queued: false, reason: 'NOT_VERIFIED' };

  if (document.extracted_text?.trim()) return { queued: false, reason: 'TEXT_ALREADY_PRESENT' };
  if (!document.file_content_type || !isRecognisable(document.file_content_type)) {
    return { queued: false, reason: 'NOT_RECOGNISABLE' };
  }

  const alreadyQueued = db
    .prepare(
      `SELECT 1 AS ok FROM ocr_jobs
        WHERE document_id = ? AND state IN ('queued','running','pending_provider')`,
    )
    .get(documentId);
  if (alreadyQueued) return { queued: false, reason: 'ALREADY_QUEUED' };

  db.prepare(
    `INSERT INTO ocr_jobs (id, org_id, document_id, provider, state, queued_at)
     VALUES (?,?,?,?,'queued',?)`,
  ).run(newId(), orgId, documentId, getOcrProvider().name, nowIso());

  db.prepare(`UPDATE documents SET ocr_state = 'queued' WHERE id = ?`).run(documentId);

  return { queued: true };
}
