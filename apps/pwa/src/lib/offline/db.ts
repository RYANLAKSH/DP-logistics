import Dexie, { type Table } from 'dexie'

/**
 * The device's local store.
 *
 * Two things live here, and they have very different value:
 *
 *  - The cached manifest. Losing it costs a sync.
 *  - Queued movements and their photographs. Losing THOSE loses evidence that
 *    cannot be recreated — the container is sealed and the truck has gone.
 *
 * Everything about the queue's design follows from the second point: nothing
 * is deleted until the server has confirmed it, storage pressure is surfaced
 * to the driver rather than absorbed silently, and an item that will not sync
 * becomes a supervisor's problem rather than a cleanup task.
 */

export type OutboxState =
  | 'queued'        // waiting for a connection
  | 'uploading'     // evidence going up
  | 'verifying'     // waiting on the server's decision
  | 'confirmed'     // the server accepted it
  | 'rejected'      // the server refused it — a real business outcome
  | 'conflict'      // someone else completed this assignment first
  | 'failed'        // transport failure, retrying

export interface OutboxImage {
  kind: 'CONTAINER' | 'CHASSIS'
  blob: Blob
  attemptId: string
  /** The hash taken at capture. Re-checked before upload — see outbox.ts. */
  sha256?: string
  scannedValue: string
  ocrTextRaw?: string
  ocrConfidence?: number
  ocrEngine?: string
  source: 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY'
  uploaded: boolean
}

export interface OutboxItem {
  /** The movement id. Client-generated, and the server's idempotency key. */
  id: string
  assignmentId: string
  containerNo: string
  chassisNo: string
  scannedContainerNo: string
  scannedChassisNo: string
  images: OutboxImage[]
  gps?: { lat: number; lng: number; accuracy: number } | null
  queuedAt: string
  state: OutboxState
  attempts: number
  lastAttemptAt?: string
  lastError?: string
  /** The server's verdict, once there is one. */
  outcome?: string
}

export interface CachedManifest {
  yardId: string
  operatingDate: string
  manifestVersionId: string
  cachedAt: string
  payload: unknown
}

/**
 * A photograph, stored the instant it is taken.
 *
 * Captures are written locally BEFORE any upload is attempted, online or off.
 * One code path either way is the point: an upload that fails halfway through
 * a shift then costs nothing, because the bytes were never only in memory.
 */
export interface Capture {
  attemptId: string
  assignmentId: string
  kind: 'CONTAINER' | 'CHASSIS'
  blob: Blob
  scannedValue: string
  ocrTextRaw?: string
  ocrConfidence?: number
  ocrEngine?: string
  source: 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY'
  uploaded: boolean
  capturedAt: string
  /**
   * Hashed at CAPTURE, not at upload.
   *
   * A queued photograph sits in IndexedDB, which the person holding the phone
   * can edit with devtools. Hashing only at upload would happily certify a
   * substituted image. Hashing at capture and re-checking before send makes
   * the substitution detectable — the two hashes disagree, and the mismatch is
   * reported rather than uploaded.
   */
  sha256: string
}

/** SHA-256 of a blob, as lowercase hex. */
export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

class DpDatabase extends Dexie {
  outbox!: Table<OutboxItem, string>
  manifests!: Table<CachedManifest, string>
  captures!: Table<Capture, string>

  constructor() {
    super('dp-verify')
    this.version(1).stores({
      outbox: 'id, state, assignmentId, queuedAt',
      manifests: 'yardId, operatingDate',
      captures: 'attemptId, assignmentId, uploaded',
    })
  }
}

export const db = new DpDatabase()

/**
 * Ask the browser not to evict this data.
 *
 * Without it, iOS in particular can clear IndexedDB under storage pressure —
 * including photographs of movements that have not synced yet. The request is
 * silently ignored on some browsers, which is why §usage below is surfaced to
 * the driver rather than trusted.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export interface StorageUsage {
  usedBytes: number
  quotaBytes: number
  persisted: boolean
}

export async function storageUsage(): Promise<StorageUsage | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const estimate = await navigator.storage.estimate()
    return {
      usedBytes: estimate.usage ?? 0,
      quotaBytes: estimate.quota ?? 0,
      persisted: (await navigator.storage.persisted?.()) ?? false,
    }
  } catch {
    return null
  }
}

/** Warn here, refuse new captures here. Evidence must never fail silently. */
export const STORAGE_WARN_BYTES = 100 * 1024 * 1024
export const STORAGE_BLOCK_BYTES = 200 * 1024 * 1024
