/**
 * Evidence object storage.
 *
 * Images never travel through the API. The device asks for a short-lived
 * upload URL, PUTs the bytes straight at the store, and then tells the API it
 * is done — so a slow connection degrades evidence transfer rather than
 * blocking the reconciliation and its email.
 *
 * Two drivers behind one interface:
 *
 *   LocalStorageDriver — files on disk, HMAC-signed URLs with an expiry. The
 *                        default, and what runs in development and in a
 *                        self-hosted deployment with no cloud account.
 *   S3StorageDriver    — S3 / R2 / any S3-compatible store via genuine
 *                        presigned URLs.
 *
 * Both mint capability URLs with the same shape and semantics, so moving
 * between them changes configuration, not calling code.
 */

import { createHmac, timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** Hard ceiling on a single evidence image. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Content types accepted for scan evidence — photographs only. */
export const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Content types accepted for trade documents: pickup lists, delivery orders,
 * invoices, shipping bills, LEO copies. Broader than evidence because these
 * arrive as whatever the issuer produced — usually a PDF, sometimes a scan,
 * sometimes a spreadsheet.
 *
 * Note what is absent: no HTML, no SVG, no archives. Those either execute in a
 * viewer or hide arbitrary content, and a document store that renders untrusted
 * markup is a stored-XSS vector against the admin panel.
 */
export const DOCUMENT_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/tiff': 'tif',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

const EXTENSIONS = 'jpg|png|webp|tif|pdf|csv|xls|xlsx|bin';

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StorageDriver {
  readonly name: string;
  /** A capability URL the device can PUT bytes to. */
  presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedUpload>;
  /** A capability URL for viewing. Short-lived and revocable by rotating the key. */
  presignGet(key: string, ttlSeconds: number): Promise<{ url: string; expiresAt: string }>;
  /** Size and hash of a stored object, or null when it is not there. */
  stat(key: string): Promise<{ bytes: number; sha256: string } | null>;
  delete(key: string): Promise<void>;
}

/**
 * Builds the object key for a scan's image.
 *
 * Derived entirely from server-held facts. The client never supplies a key —
 * if it did, a compromised device could overwrite another officer's evidence
 * or escape the prefix with a traversal sequence.
 *
 * Date-partitioned so lifecycle rules (cold storage at 24 months) are a bucket
 * policy rather than a batch job.
 */
export function evidenceKey(args: {
  orgId: string;
  scanId: string;
  capturedAt: string;
  contentType: string;
}): string {
  const when = new Date(args.capturedAt);
  const date = Number.isNaN(when.getTime()) ? new Date() : when;

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const ext = EXTENSION[args.contentType] ?? 'bin';

  return `org/${args.orgId}/${yyyy}/${mm}/${dd}/${args.scanId}.${ext}`;
}

/**
 * Builds the object key for a trade document.
 *
 * Separate `doc/` prefix so bucket policy can treat documents and scan evidence
 * differently — they have different retention obligations and, often, different
 * audiences.
 */
export function documentKey(args: {
  orgId: string;
  documentId: string;
  uploadedAt: string;
  contentType: string;
}): string {
  const when = new Date(args.uploadedAt);
  const date = Number.isNaN(when.getTime()) ? new Date() : when;

  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const ext = EXTENSION[args.contentType] ?? 'bin';

  return `doc/org/${args.orgId}/${yyyy}/${mm}/${dd}/${args.documentId}.${ext}`;
}

/** Keys we generate are a known shape; anything else is rejected on sight. */
const KEY_PATTERN = new RegExp(
  `^(doc/)?org/[0-9a-f-]{36}/\\d{4}/\\d{2}/\\d{2}/[0-9a-f-]{36}\\.(${EXTENSIONS})$`,
);

export const isValidKey = (key: string): boolean => KEY_PATTERN.test(key);

/** Union of both accept-lists, for the storage endpoint that serves either. */
export const isAllowedContentType = (contentType: string): boolean =>
  ALLOWED_CONTENT_TYPES.has(contentType) || DOCUMENT_CONTENT_TYPES.has(contentType);

/* ------------------------------------------------------------------ *
 * Local driver
 * ------------------------------------------------------------------ */

export interface Capability {
  k: string;   // key
  o: 'put' | 'get';
  e: number;   // expiry, epoch seconds
  c?: string;  // content type, for put
}

/**
 * Signed capability URLs over a local directory.
 *
 * The token carries the key, the operation and an expiry, HMAC'd with the
 * storage secret. That is deliberately the same trust model as an S3 presigned
 * URL: possession of the URL is the authorisation, it expires, and it grants
 * exactly one operation on exactly one key.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';

  private readonly root: string;
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(root: string, baseUrl: string, secret: string) {
    this.root = root;
    this.baseUrl = baseUrl;
    this.secret = secret;
    mkdirSync(this.root, { recursive: true });
  }

  private sign(payload: Capability): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  /** Verifies a token and returns its capability, or null. */
  verify(token: string): Capability | null {
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;

    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    let payload: Capability;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }

    if (payload.e < Math.floor(Date.now() / 1000)) return null;
    if (!isValidKey(payload.k)) return null;
    return payload;
  }

  /**
   * Resolves a key to a path, refusing anything that escapes the root.
   *
   * isValidKey already excludes traversal, but a containment check here means
   * the filesystem write is safe even if the pattern is ever loosened.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    const bounded = resolve(this.root) + sep;
    if (!full.startsWith(bounded)) throw new Error('key escapes storage root');
    return full;
  }

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedUpload> {
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = this.sign({ k: key, o: 'put', e: expiry, c: contentType });

    return {
      url: `${this.baseUrl}/v1/storage/${token}`,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
  }

  async presignGet(key: string, ttlSeconds: number) {
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = this.sign({ k: key, o: 'get', e: expiry });

    return {
      url: `${this.baseUrl}/v1/storage/${token}`,
      expiresAt: new Date(expiry * 1000).toISOString(),
    };
  }

  /** Writes bytes for a verified put capability. */
  write(key: string, bytes: Buffer): void {
    const path = this.pathFor(key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  read(key: string): Buffer | null {
    const path = this.pathFor(key);
    return existsSync(path) ? readFileSync(path) : null;
  }

  async stat(key: string) {
    const path = this.pathFor(key);
    if (!existsSync(path)) return null;

    return {
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) unlinkSync(path);
  }
}

/* ------------------------------------------------------------------ *
 * S3 driver
 * ------------------------------------------------------------------ */

/**
 * S3-compatible storage using genuine presigned URLs.
 *
 * The AWS SDK is loaded dynamically and is an optional dependency, so the
 * default local deployment does not carry it. Install when you need it:
 *
 *   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w @dp/api
 *
 * NOT exercised by the test suite — that would need real credentials. The
 * local driver is what the tests cover, and it deliberately mirrors this one's
 * semantics.
 */
/**
 * Loads an optional dependency.
 *
 * The specifier is a variable so TypeScript does not try to resolve it — the
 * AWS SDK is not installed in the default deployment, and a missing module must
 * be a runtime concern for S3 users only, not a compile error for everyone.
 */
const optionalImport = (specifier: string): Promise<any> => import(specifier);

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';

  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string | undefined;

  constructor(bucket: string, region: string, endpoint?: string) {
    this.bucket = bucket;
    this.region = region;
    this.endpoint = endpoint;
  }

  private async client() {
    const { S3Client } = await optionalImport('@aws-sdk/client-s3');
    return new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
    });
  }

  async presignPut(key: string, contentType: string, ttlSeconds: number): Promise<PresignedUpload> {
    const { PutObjectCommand } = await optionalImport('@aws-sdk/client-s3');
    const { getSignedUrl } = await optionalImport('@aws-sdk/s3-request-presigner');

    const url = await getSignedUrl(
      await this.client(),
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        // Server-side encryption at rest; the bucket must also deny public ACLs.
        ServerSideEncryption: 'AES256',
      }),
      { expiresIn: ttlSeconds },
    );

    return {
      url,
      method: 'PUT',
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  async presignGet(key: string, ttlSeconds: number) {
    const { GetObjectCommand } = await optionalImport('@aws-sdk/client-s3');
    const { getSignedUrl } = await optionalImport('@aws-sdk/s3-request-presigner');

    const url = await getSignedUrl(
      await this.client(),
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );

    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async stat(key: string) {
    const { HeadObjectCommand } = await optionalImport('@aws-sdk/client-s3');
    try {
      const client = await this.client();
      const head = await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })) as {
        ContentLength?: number;
        ChecksumSHA256?: string;
      };

      return {
        bytes: head.ContentLength ?? 0,
        // S3 returns base64 checksums, and only when the upload requested one.
        // Empty string means "unknown", which the finalize path treats as a
        // failure to verify rather than a pass.
        sha256: head.ChecksumSHA256
          ? Buffer.from(head.ChecksumSHA256, 'base64').toString('hex')
          : '',
      };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = await optionalImport('@aws-sdk/client-s3');
    const client = await this.client();
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;

  const baseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

  if (process.env.S3_BUCKET) {
    driver = new S3StorageDriver(
      process.env.S3_BUCKET,
      process.env.S3_REGION ?? 'ap-south-1',
      process.env.S3_ENDPOINT,
    );
  } else {
    const secret = process.env.STORAGE_SECRET;
    if (!secret && process.env.NODE_ENV === 'production') {
      // Without a stable secret every capability URL breaks on restart, and a
      // predictable fallback would let anyone mint one.
      throw new Error('STORAGE_SECRET must be set in production');
    }
    driver = new LocalStorageDriver(
      process.env.STORAGE_DIR ?? './.evidence',
      baseUrl,
      secret ?? randomBytes(32).toString('hex'),
    );
  }
  return driver;
}

/** Test seam. */
export const setStorage = (next: StorageDriver | null): void => { driver = next; };
