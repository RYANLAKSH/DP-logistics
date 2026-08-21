import { useCallback, useEffect, useState } from 'react'

/**
 * The two captures for one task, held across navigation and page reloads.
 *
 * Phone browsers evict backgrounded tabs aggressively, and a driver who takes a
 * call between the container scan and the chassis scan must not lose the first
 * one. Phase 3 persists to localStorage; phase 13 moves this to IndexedDB
 * alongside the image blobs, which localStorage cannot hold.
 */
export type ValueSource = 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY'

export interface ScanDraft {
  containerValue?: string
  chassisValue?: string
  /**
   * How each value was obtained. Carried through to the audit record, where
   * distinguishing a clean read from a corrected one from a typed one is what
   * makes the evidence meaningful years later.
   */
  containerSource?: ValueSource
  chassisSource?: ValueSource
  /** Attempt ids for the two captures. The server requires both to exist. */
  containerAttemptId?: string
  chassisAttemptId?: string
  /** Client-generated. The idempotency key for the eventual movement. */
  movementId: string
}

const KEY = (assignmentId: string) => `dp.draft.${assignmentId}`

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mv-${Math.random().toString(36).slice(2)}`
}

function read(assignmentId: string): ScanDraft {
  try {
    const raw = globalThis.localStorage?.getItem(KEY(assignmentId))
    if (raw) return JSON.parse(raw) as ScanDraft
  } catch {
    // A corrupt draft is not worth failing a shift over — start a fresh one.
  }
  return { movementId: newId() }
}

function write(assignmentId: string, draft: ScanDraft): void {
  try {
    globalThis.localStorage?.setItem(KEY(assignmentId), JSON.stringify(draft))
  } catch {
    // Storage full or blocked. Phase 13 surfaces this properly; losing a draft
    // is recoverable (rescan), losing captured evidence is not.
  }
}

export function clearScanDraft(assignmentId: string): void {
  globalThis.localStorage?.removeItem(KEY(assignmentId))
}

export function useScanDraft(assignmentId: string) {
  const [draft, setDraft] = useState<ScanDraft>(() => read(assignmentId))

  useEffect(() => { setDraft(read(assignmentId)) }, [assignmentId])

  const update = useCallback((patch: Partial<ScanDraft>) => {
    setDraft((prev) => {
      const next = { ...prev, ...patch }
      write(assignmentId, next)
      return next
    })
  }, [assignmentId])

  const reset = useCallback(() => {
    clearScanDraft(assignmentId)
    setDraft({ movementId: newId() })
  }, [assignmentId])

  return { ...draft, update, reset }
}
