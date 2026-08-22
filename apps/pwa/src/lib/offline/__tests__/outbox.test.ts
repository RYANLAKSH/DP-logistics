import { describe, expect, it, vi } from 'vitest'
import { backoffFor, drainOne, isStale, STALE_AFTER_MS } from '../outbox'
import type { OutboxItem } from '../db'

// Dexie needs IndexedDB; these tests exercise the pure decisions instead, and
// stub the store for drainOne. The queue's SEQUENCING is what matters and is
// what would break silently.
vi.mock('../db', async () => {
  const updates: Record<string, unknown>[] = []
  return {
    db: {
      outbox: {
        update: async (_id: string, patch: Record<string, unknown>) => {
          updates.push(patch)
          return 1
        },
        __updates: updates,
      },
    },
    // A deterministic stand-in for crypto.subtle. Keyed on size rather than
    // content because jsdom's Blob implements neither text() nor
    // arrayBuffer() — and the test is about the COMPARISON, not the digest.
    hashBlob: async (blob: Blob) => `h:${blob.size}`,
  }
})

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    id: 'mv-1',
    assignmentId: 'a-1',
    containerNo: 'CULVNSA2601795',
    chassisNo: 'MAT752389T7R19810',
    scannedContainerNo: 'CULVNSA2601795',
    scannedChassisNo: 'MAT752389T7R19810',
    images: [
      { kind: 'CONTAINER', blob: new Blob(['c']), attemptId: 'at-c', sha256: 'h:1',
        scannedValue: 'CULVNSA2601795', source: 'OCR_AUTO', uploaded: false },
      { kind: 'CHASSIS', blob: new Blob(['h']), attemptId: 'at-h', sha256: 'h:1',
        scannedValue: 'MAT752389T7R19810', source: 'MANUAL_ENTRY', uploaded: false },
    ],
    queuedAt: new Date().toISOString(),
    state: 'queued',
    attempts: 0,
    ...overrides,
  }
}

function fakeData(overrides: Record<string, unknown> = {}) {
  return {
    recordScan: vi.fn().mockResolvedValue({ attemptId: 'x', result: 'PASS' }),
    verifyMovement: vi.fn().mockResolvedValue({ outcome: 'MATCH', status: 'COMPLETED' }),
    ...overrides,
  } as never
}

describe('backoff', () => {
  it('grows and then holds, rather than hammering a server that is down', () => {
    expect(backoffFor(0)).toBe(2_000)
    expect(backoffFor(3)).toBe(16_000)
    expect(backoffFor(99)).toBe(60_000)
  })
})

describe('drainOne', () => {
  it('uploads every image BEFORE asking for verification', async () => {
    const order: string[] = []
    const data = fakeData({
      recordScan: vi.fn(async () => { order.push('scan'); return { attemptId: 'x', result: 'PASS' } }),
      verifyMovement: vi.fn(async () => { order.push('verify'); return { outcome: 'MATCH', status: 'COMPLETED' } }),
    })
    await drainOne(data, item())
    // Verifying before the evidence exists is refused by the server with
    // EVIDENCE_MISSING, which would turn a connectivity problem into a
    // permanent block.
    expect(order).toEqual(['scan', 'scan', 'verify'])
  })

  it('commits — a queued movement is not a provisional one once it syncs', async () => {
    const data = fakeData()
    await drainOne(data, item())
    const call = (data as never as { verifyMovement: ReturnType<typeof vi.fn> })
      .verifyMovement.mock.calls[0]!
    expect(call[0]).toMatchObject({ commit: true })
  })

  it('passes the client-generated id so a replay is recognised', async () => {
    const data = fakeData()
    await drainOne(data, item({ id: 'stable-movement-id' }))
    const call = (data as never as { verifyMovement: ReturnType<typeof vi.fn> })
      .verifyMovement.mock.calls[0]!
    expect(call[0].movementId).toBe('stable-movement-id')
  })

  it('does not re-upload an image that already went up', async () => {
    const data = fakeData()
    const partly = item()
    partly.images[0]!.uploaded = true
    await drainOne(data, partly)
    expect((data as never as { recordScan: ReturnType<typeof vi.fn> })
      .recordScan).toHaveBeenCalledTimes(1)
  })

  it('treats a business refusal as a result, not a retry', async () => {
    // Retrying a wrong-vehicle block forever would hide it from the driver and
    // hammer the server with a question it has already answered.
    const data = fakeData({
      verifyMovement: vi.fn().mockResolvedValue({ outcome: 'WRONG_VEHICLE', status: 'BLOCKED' }),
    })
    expect(await drainOne(data, item())).toBe('rejected')
  })

  it('reports a conflict when someone else completed the assignment first', async () => {
    const data = fakeData({
      verifyMovement: vi.fn().mockResolvedValue({ outcome: 'ALREADY_COMPLETED', status: 'BLOCKED' }),
    })
    expect(await drainOne(data, item())).toBe('conflict')
  })

  it('treats a transport failure as retryable', async () => {
    const data = fakeData({
      verifyMovement: vi.fn().mockRejectedValue(new Error('network down')),
    })
    expect(await drainOne(data, item())).toBe('failed')
  })

  it('does not verify at all when an upload fails', async () => {
    const data = fakeData({
      recordScan: vi.fn().mockRejectedValue(new Error('upload failed')),
    })
    expect(await drainOne(data, item())).toBe('failed')
    expect((data as never as { verifyMovement: ReturnType<typeof vi.fn> })
      .verifyMovement).not.toHaveBeenCalled()
  })
})

describe('staleness', () => {
  it('flags an item that has not synced for a day', () => {
    const now = Date.now()
    const old = item({ queuedAt: new Date(now - STALE_AFTER_MS - 1000).toISOString() })
    expect(isStale(old, now)).toBe(true)
  })

  it('never flags a confirmed item', () => {
    const now = Date.now()
    const done = item({
      state: 'confirmed',
      queuedAt: new Date(now - STALE_AFTER_MS - 1000).toISOString(),
    })
    expect(isStale(done, now)).toBe(false)
  })
})


describe('queue tampering', () => {
  it('refuses to upload a photograph that was swapped in IndexedDB', async () => {
    // A queued photograph sits in storage the phone's owner can edit. Hashing
    // only at upload would happily certify a substituted image.
    const data = fakeData()
    const tampered = item()
    tampered.images[0]!.blob = new Blob(['a different photograph'])

    expect(await drainOne(data, tampered)).toBe('rejected')
    expect((data as never as { recordScan: ReturnType<typeof vi.fn> })
      .recordScan).not.toHaveBeenCalled()
    expect((data as never as { verifyMovement: ReturnType<typeof vi.fn> })
      .verifyMovement).not.toHaveBeenCalled()
  })

  it('uploads normally when the photograph is untouched', async () => {
    const data = fakeData()
    expect(await drainOne(data, item())).toBe('confirmed')
  })

  it('does not block an item captured before hashing existed', async () => {
    // Defensive: an item queued by an older build carries no hash. Refusing it
    // would strand real evidence over a version boundary.
    const data = fakeData()
    const legacy = item()
    for (const image of legacy.images) delete image.sha256
    expect(await drainOne(data, legacy)).toBe('confirmed')
  })
})
