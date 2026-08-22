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
  /** How many candidates the frame produced. A despatch label yields many. */
  candidateCount: number
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
  candidateCount: 0,
  rawText: null,
  confidence: 0,
  proposal: null,
  repaired: false,
  accepted: false,
  checkDigitFailed: false,
  message: 'Nothing readable in that photo. Move closer, wipe the plate, or type it in.',
  decision: null,
}

/**
 * Evaluates EVERY candidate the frame produced, not just the most confident.
 *
 * This is the change the real labels forced. A Tata despatch label carries the
 * chassis number alongside a type code, an ASN, a part number, an engine
 * number and an EVR — six or more strings, any of which OCR may return with
 * high confidence. Picking the top-confidence line alone would pick the wrong
 * code routinely. Worse, the type code is a SUBSTRING of the chassis number
 * (MAT_464844_TSR10851), so a partial read of the wrong field looks plausible.
 *
 * Scoring every candidate against the manifest and taking the best match makes
 * the surrounding clutter irrelevant instead of dangerous. It does not weaken
 * anything: a candidate still has to clear the confidence floor, the check
 * digit and the margin rule on its own merits before it can be proposed.
 */
export async function runScan(
  provider: OcrProvider,
  image: HTMLCanvasElement | Blob | ImageBitmap,
  request: ScanRequest,
): Promise<ScanOutcome> {
  const result = await provider.recognize(image, request.kind)
  const base = { engine: result.engine, durationMs: result.durationMs }

  if (result.candidates.length === 0) return { ...FAILED, ...base }

  const evaluated = result.candidates
    .map((candidate) => evaluate(candidate, request))
    .sort(rank)

  const best = evaluated[0]!
  return { ...best.outcome, ...base, candidateCount: result.candidates.length }
}

interface Evaluated {
  outcome: Omit<ScanOutcome, 'engine' | 'durationMs'>
  score: number
  confidence: number
}

/**
 * An accepted candidate always beats an unaccepted one; among equals the
 * better match wins, and engine confidence breaks the remaining ties. Ordering
 * acceptance first is what stops a confident read of the ASN outranking a
 * slightly less confident read of the chassis number itself.
 */
function rank(a: Evaluated, b: Evaluated): number {
  if (a.outcome.accepted !== b.outcome.accepted) return a.outcome.accepted ? -1 : 1
  if (a.score !== b.score) return b.score - a.score
  return b.confidence - a.confidence
}

function evaluate(
  candidate: { raw: string; normalized: string; confidence: number },
  request: ScanRequest,
): Evaluated {
  const minConfidence = request.minConfidence
    ?? (request.kind === 'container' ? 0.7 : 0.85)

  let value = candidate.normalized
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

  const shell = {
    candidateCount: 1,
    rawText: candidate.raw,
    confidence: candidate.confidence,
  }

  // The check digit is arithmetic, not a probability. A container number that
  // fails it is not a low-confidence read of the right number — it is a
  // different number, and no confidence score should be allowed to argue.
  if (checkDigitFailed) {
    return {
      score: 0,
      confidence: candidate.confidence,
      outcome: {
        ...shell,
        proposal: value,
        repaired: false,
        accepted: false,
        checkDigitFailed: true,
        message:
          'That container number fails its own check digit, so at least one character was misread. Retake it, or type it in.',
        decision: null,
      },
    }
  }

  if (candidate.confidence < minConfidence) {
    return {
      score: 0,
      confidence: candidate.confidence,
      outcome: {
        ...shell,
        proposal: null,
        repaired,
        accepted: false,
        checkDigitFailed: false,
        message: 'That read was too unclear to trust. Retake the photo, or type it in.',
        decision: null,
      },
    }
  }

  const decision = scoreAgainstCandidates(value, {
    expected: request.expected,
    others: request.others,
    minMargin: request.minMargin,
  })

  return {
    score: decision.best?.score ?? 0,
    confidence: candidate.confidence,
    outcome: {
      ...shell,
      proposal: decision.proposal ?? (decision.accept ? value : null),
      repaired,
      accepted: decision.accept,
      checkDigitFailed: false,
      message: decision.reason,
      decision,
    },
  }
}

/** How the value reached the record. Carried through to the audit trail. */
export function sourceFor(
  outcome: ScanOutcome, typed: boolean,
): 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY' {
  if (typed) return 'MANUAL_ENTRY'
  return outcome.accepted && !outcome.repaired ? 'OCR_AUTO' : 'OCR_CONFIRMED'
}

export { normalize }
