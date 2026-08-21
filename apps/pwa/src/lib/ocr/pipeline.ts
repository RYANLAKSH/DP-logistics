import type { OcrProvider, ScanKind } from './types'
import {
  isIso6346Shaped, isValidContainerNo, normalize, repairContainerCandidate,
  repairVinCandidate, scoreAgainstCandidates, type MatchDecision,
} from './normalize'

/**
 * The scan pipeline: capture -> OCR -> normalise -> repair -> score -> decide.
 *
 * Two invariants, both load-bearing:
 *
 *  1. The engine's raw output is preserved verbatim on every outcome. It is
 *     what proves, in a dispute, that a human corrected a machine rather than
 *     the other way round, and it is the only way to tune thresholds against
 *     real yard conditions instead of guesses.
 *
 *  2. Nothing is ever silently modified. A confusable repair is a PROPOSAL,
 *     carried alongside the original and marked as repaired, and a human
 *     confirms it. `accepted` here means "safe to propose", never "verified" —
 *     the verdict belongs to the server.
 */

export interface ScanOutcome {
  /** Exactly what the engine produced. Always populated when it produced anything. */
  rawText: string | null
  /** The engine's own confidence for the winning candidate, 0..1. */
  confidence: number
  /** The value to show the driver, or null when nothing is worth showing. */
  proposal: string | null
  /** True when a positional repair produced the proposal. Always disclosed. */
  repaired: boolean
  /** Safe to auto-fill and offer for confirmation. Never a verification. */
  accepted: boolean
  /** Set when the container number failed its ISO 6346 check digit. */
  checkDigitFailed: boolean
  /** Why, in words a driver can act on. */
  message: string
  decision: MatchDecision | null
  engine: string
  durationMs: number
}

export interface ScanRequest {
  kind: ScanKind
  expected: string
  /** Every other value of this kind on the manifest. See the margin rule. */
  others: string[]
  minConfidence?: number
  minMargin?: number
}

const FAILED: Omit<ScanOutcome, 'engine' | 'durationMs'> = {
  rawText: null,
  confidence: 0,
  proposal: null,
  repaired: false,
  accepted: false,
  checkDigitFailed: false,
  message: 'Nothing readable in that photo. Move closer, wipe the plate, or type it in.',
  decision: null,
}

export async function runScan(
  provider: OcrProvider,
  image: HTMLCanvasElement | Blob | ImageBitmap,
  request: ScanRequest,
): Promise<ScanOutcome> {
  const result = await provider.recognize(image, request.kind)
  const base = { engine: result.engine, durationMs: result.durationMs }

  if (result.candidates.length === 0) return { ...FAILED, ...base }

  const top = result.candidates[0]!
  const minConfidence = request.minConfidence ?? (request.kind === 'container' ? 0.7 : 0.85)

  let value = top.normalized
  let repaired = false
  let checkDigitFailed = false

  if (request.kind === 'container' && isIso6346Shaped(request.expected)) {
    if (!isValidContainerNo(value)) {
      const fixed = repairContainerCandidate(value)
      if (fixed) {
        value = fixed
        repaired = true
      } else {
        checkDigitFailed = true
      }
    }
  } else if (request.kind === 'chassis') {
    const fixed = repairVinCandidate(value)
    if (fixed) {
      value = fixed
      repaired = true
    }
  }

  // The check digit is arithmetic, not a probability. A container number that
  // fails it is not a low-confidence read of the right number — it is a
  // different number, and no confidence score should be allowed to argue.
  if (checkDigitFailed) {
    return {
      ...base,
      rawText: top.raw,
      confidence: top.confidence,
      proposal: value,
      repaired: false,
      accepted: false,
      checkDigitFailed: true,
      message:
        'That container number fails its own check digit, so at least one character was misread. Retake it, or type it in.',
      decision: null,
    }
  }

  if (top.confidence < minConfidence) {
    return {
      ...base,
      rawText: top.raw,
      confidence: top.confidence,
      proposal: null,
      repaired,
      accepted: false,
      checkDigitFailed: false,
      message: 'That read was too unclear to trust. Retake the photo, or type it in.',
      decision: null,
    }
  }

  const decision = scoreAgainstCandidates(value, {
    expected: request.expected,
    others: request.others,
    minMargin: request.minMargin,
  })

  return {
    ...base,
    rawText: top.raw,
    confidence: top.confidence,
    proposal: decision.proposal ?? (decision.accept ? value : null),
    repaired,
    accepted: decision.accept,
    checkDigitFailed: false,
    message: decision.reason,
    decision,
  }
}

/** How the value reached the record. Carried through to the audit trail. */
export function sourceFor(outcome: ScanOutcome, typed: boolean): 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY' {
  if (typed) return 'MANUAL_ENTRY'
  return outcome.accepted && !outcome.repaired ? 'OCR_AUTO' : 'OCR_CONFIRMED'
}

export { normalize }
