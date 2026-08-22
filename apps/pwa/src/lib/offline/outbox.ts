import type { DataSource } from '@/data/DataSource'
import { db, type Capture, type OutboxItem, type OutboxState } from './db'
import { noteFailure, noteSuccess } from './connectivity'

/**
 * The outbox.
 *
 * A driver offline can scan, get an advisory verdict, and queue a movement.
 * What they CANNOT get is a confirmation, because the server has not seen it.
 * That distinction is the whole design: a queued item is PENDING SYNC and says
 * so everywhere it appears. Showing a green tick for something the server has
 * not accepted would train drivers to trust a screen that can be wrong, which
 * is worse than no app at all.
 */

const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000]

export function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!
}

/**
 * Stores a capture locally and then tries to send it.
 *
 * The local write comes first, always. A driver who takes a photograph has
 * produced evidence; losing it to a failed request would be unrecoverable,
 * because the container is sealed and the truck has gone.
 */
export async function saveCapture(
  capture: Omit<Capture, 'uploaded' | 'capturedAt'>,
  upload: () => Promise<void>,
): Promise<{ uploaded: boolean }> {
  await db.captures.put({ ...capture, uploaded: false, capturedAt: new Date().toISOString() })
  try {
    await upload()
    await db.captures.update(capture.attemptId, { uploaded: true })
    noteSuccess()
    return { uploaded: true }
  } catch {
    noteFailure()
    return { uploaded: false }
  }
}

export async function capturesFor(assignmentId: string): Promise<Capture[]> {
  return db.captures.where('assignmentId').equals(assignmentId).toArray()
}

export async function enqueue(item: Omit<OutboxItem, 'state' | 'attempts' | 'queuedAt'>) {
  await db.outbox.put({
    ...item,
    state: 'queued',
    attempts: 0,
    queuedAt: new Date().toISOString(),
  })
}

export async function pending(): Promise<OutboxItem[]> {
  return db.outbox
    .filter((i) => i.state !== 'confirmed')
    .toArray()
}

export async function countPending(): Promise<number> {
  return (await pending()).length
}

/**
 * Drains one item, strictly in order: evidence first, then verification.
 *
 * Verification must never run before its evidence exists — the server refuses
 * it with EVIDENCE_MISSING, and a queue that produced that would turn a
 * connectivity problem into a permanent block.
 */
export async function drainOne(
  data: DataSource, item: OutboxItem,
): Promise<OutboxState> {
  await db.outbox.update(item.id, { state: 'uploading', attempts: item.attempts + 1,
                                    lastAttemptAt: new Date().toISOString() })

  try {
    for (const image of item.images) {
      if (image.uploaded) continue
      await data.recordScan({
        attemptId: image.attemptId,
        assignmentId: item.assignmentId,
        kind: image.kind,
        scannedValue: image.scannedValue,
        image: image.blob,
        ocrTextRaw: image.ocrTextRaw,
        ocrConfidence: image.ocrConfidence,
        ocrEngine: image.ocrEngine,
        source: image.source,
      })
      image.uploaded = true
      await db.outbox.update(item.id, { images: item.images })
    }

    await db.outbox.update(item.id, { state: 'verifying' })

    const container = item.images.find((i) => i.kind === 'CONTAINER')
    const chassis = item.images.find((i) => i.kind === 'CHASSIS')

    const result = await data.verifyMovement({
      assignmentId: item.assignmentId,
      scannedContainerNo: item.scannedContainerNo,
      scannedChassisNo: item.scannedChassisNo,
      containerAttemptId: container?.attemptId,
      chassisAttemptId: chassis?.attemptId,
      movementId: item.id,
      commit: true,
      gps: item.gps ?? null,
    })

    // A business refusal is a RESULT, not a failure to retry. Retrying a
    // wrong-vehicle block forever would hide it from the driver and hammer the
    // server with a question already answered.
    const state: OutboxState =
      result.outcome === 'MATCH' ? 'confirmed'
      : result.outcome === 'ALREADY_COMPLETED' ? 'conflict'
      : 'rejected'

    noteSuccess()
    await db.outbox.update(item.id, { state, outcome: result.outcome, lastError: undefined })

    if (state === 'confirmed') {
      // Free the photographs only once the server has them. Until then they
      // are the only copy in existence.
      await db.outbox.update(item.id, {
        images: item.images.map((i) => ({ ...i, blob: new Blob() })),
      })
    }
    return state
  } catch (e) {
    noteFailure()
    const message = e instanceof Error ? e.message : 'sync failed'
    await db.outbox.update(item.id, { state: 'failed', lastError: message })
    return 'failed'
  }
}

export interface DrainReport {
  attempted: number
  confirmed: number
  rejected: number
  failed: number
}

export async function drain(data: DataSource): Promise<DrainReport> {
  const items = (await pending()).filter(
    (i) => i.state === 'queued' || i.state === 'failed' || i.state === 'uploading'
        || i.state === 'verifying',
  )
  const report: DrainReport = { attempted: 0, confirmed: 0, rejected: 0, failed: 0 }

  for (const item of items) {
    // Respect the backoff rather than hammering a server that is down.
    if (item.lastAttemptAt) {
      const waited = Date.now() - new Date(item.lastAttemptAt).getTime()
      if (waited < backoffFor(item.attempts)) continue
    }
    report.attempted++
    const state = await drainOne(data, item)
    if (state === 'confirmed') report.confirmed++
    else if (state === 'rejected' || state === 'conflict') report.rejected++
    else report.failed++
  }
  return report
}

/**
 * An item that has not synced for a day is an operational problem, not a
 * cleanup task: a movement may have physically happened with no record of it.
 * Nothing is ever dropped automatically.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function isStale(item: OutboxItem, now = Date.now()): boolean {
  return item.state !== 'confirmed'
    && now - new Date(item.queuedAt).getTime() > STALE_AFTER_MS
}
