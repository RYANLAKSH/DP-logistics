/**
 * Normalisation and scoring for OCR output.
 *
 * The reframe that makes browser OCR viable: the manifest already says what we
 * expect to see, so this is a verification problem over a candidate set of a
 * few, not a recognition problem over an open vocabulary.
 *
 * The risk that reframe introduces is the one this file spends most of its
 * effort on. A pipeline looking for MAT752389T7R19810 will find it in noise —
 * confirmation bias, implemented in software, producing exactly the false pass
 * the product exists to prevent. So acceptance is COMPARATIVE, never absolute:
 * see scoreAgainstCandidates().
 */

/** Case-fold and strip separators. Nothing else. Mirrors app.normalize_code(). */
export function normalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {}
  let v = 10
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    while (v % 11 === 0) v++
    map[ch] = v++
  }
  return map
})()

export function isIso6346Shaped(value: string): boolean {
  return /^[A-Z]{4}[0-9]{7}$/.test(normalize(value))
}

export function containerCheckDigit(first10: string): number | null {
  if (!/^[A-Z]{4}[0-9]{6}$/.test(first10)) return null
  let sum = 0
  for (let i = 0; i < 10; i++) {
    const ch = first10[i]!
    sum += (i < 4 ? LETTER_VALUES[ch]! : Number(ch)) * 2 ** i
  }
  return (sum % 11) % 10
}

/**
 * The highest-leverage arithmetic in the system: it rejects roughly ten out of
 * eleven single-character misreads, offline, in microseconds. Run it in the
 * camera loop before showing a candidate to anyone.
 */
export function isValidContainerNo(value: string): boolean {
  const s = normalize(value)
  if (!isIso6346Shaped(s)) return false
  return containerCheckDigit(s.slice(0, 10)) === Number(s[10])
}

/**
 * Positional confusable repair for ISO 6346 numbers.
 *
 * The format is positionally strict — four letters then seven digits — so a
 * substitution can be applied in the direction the position demands rather than
 * guessed at. Returns a PROPOSAL. It is never accepted without a human, and the
 * original raw text is always retained.
 */
const TO_DIGIT: Record<string, string> = {
  O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', T: '7',
}
const TO_LETTER: Record<string, string> = {
  '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G',
}

export function repairContainerCandidate(raw: string): string | null {
  const s = normalize(raw)
  if (s.length !== 11) return null

  let out = ''
  for (let i = 0; i < 11; i++) {
    const ch = s[i]!
    if (i < 4) out += /[A-Z]/.test(ch) ? ch : (TO_LETTER[ch] ?? ch)
    else out += /[0-9]/.test(ch) ? ch : (TO_DIGIT[ch] ?? ch)
  }

  if (out === s) return null
  return isValidContainerNo(out) ? out : null
}

/**
 * VIN confusables are unambiguous: I, O and Q are never valid in a VIN, so any
 * occurrence in a 17-character value is certainly 1, 0 and 0.
 */
export function repairVinCandidate(raw: string): string | null {
  const s = normalize(raw)
  if (s.length !== 17 || !/[IOQ]/.test(s)) return null
  return s.replace(/I/g, '1').replace(/[OQ]/g, '0')
}

/** Levenshtein distance, bounded so a pathological pair cannot burn the frame. */
export function editDistance(a: string, b: string, cap = 8): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost)
      row.push(value)
      if (value < best) best = value
    }
    if (best > cap) return cap + 1
    prev = row
  }
  return prev[b.length]!
}

export interface Scored {
  value: string
  score: number
  reason: 'exact' | 'suffix' | 'near' | 'weak'
}

/** How well a read matches one known value. */
export function scoreOne(read: string, candidate: string): Scored {
  const a = normalize(read)
  const b = normalize(candidate)
  if (!a || !b) return { value: candidate, score: 0, reason: 'weak' }
  if (a === b) return { value: candidate, score: 1, reason: 'exact' }

  // Plates are commonly stamped with only the serial portion legible.
  if (a.length >= 6 && (b.endsWith(a) || a.endsWith(b))) {
    return { value: candidate, score: 0.9, reason: 'suffix' }
  }

  const distance = editDistance(a, b)
  const longest = Math.max(a.length, b.length)
  const similarity = 1 - distance / longest
  return {
    value: candidate,
    score: similarity,
    reason: similarity >= 0.85 ? 'near' : 'weak',
  }
}

export interface MatchDecision {
  /** The value to propose, or null when the read is too ambiguous to propose. */
  proposal: string | null
  best: Scored | null
  runnerUp: Scored | null
  margin: number
  accept: boolean
  /** Why it was refused, in words a driver can act on. */
  reason: string
}

export interface MatchOptions {
  /** The value the manifest expects for this task. */
  expected: string
  /**
   * EVERY other value of the same kind on the manifest. Scoring against the
   * whole set is what stops the pipeline confirming what it hoped to see.
   */
  others: string[]
  minScore?: number
  minMargin?: number
}

/**
 * The acceptance rule.
 *
 * A read is accepted only if the expected value is the best match AND it beats
 * the runner-up from the whole manifest by a clear margin. If two candidates
 * score similarly, that is not a match — it is an ambiguous read on two similar
 * numbers, which is precisely the situation where the wrong vehicle gets
 * loaded. Refuse and ask the driver.
 */
export function scoreAgainstCandidates(
  read: string, options: MatchOptions,
): MatchDecision {
  const minScore = options.minScore ?? 0.9
  const minMargin = options.minMargin ?? 0.15

  const all = [options.expected, ...options.others]
  const scored = all.map((c) => scoreOne(read, c)).sort((a, b) => b.score - a.score)
  const best = scored[0] ?? null
  const runnerUp = scored[1] ?? null
  const margin = best && runnerUp ? best.score - runnerUp.score : 1

  if (!best || best.score < minScore) {
    return {
      proposal: null, best, runnerUp, margin, accept: false,
      reason: 'The plate could not be read clearly enough.',
    }
  }
  // An exact match is not ambiguous, whatever else is on the manifest.
  //
  // The margin rule exists to catch NEAR matches, where a one-character OCR
  // error could equally have produced a different value. Applying it to an
  // exact read would refuse almost every correct scan in a real yard: manifest
  // containers are numbered sequentially, so CULVNSA2601795 and CULVNSA2601796
  // differ by one character out of fourteen and always score close together.
  if (best.reason === 'exact' && normalize(best.value) === normalize(options.expected)) {
    return {
      proposal: best.value, best, runnerUp, margin, accept: true,
      reason: 'Matches the assignment exactly.',
    }
  }

  if (normalize(best.value) !== normalize(options.expected)) {
    // A confident read of a DIFFERENT manifest value. Propose it: the server
    // will block it, and the driver needs to see what they actually scanned.
    return {
      proposal: best.value, best, runnerUp, margin, accept: false,
      reason: 'That is not the value this task expects.',
    }
  }
  if (runnerUp && margin < minMargin) {
    return {
      proposal: null, best, runnerUp, margin, accept: false,
      reason:
        'This read is too close to another number on the manifest to be trusted. Retake it, or type it in.',
    }
  }
  return {
    proposal: best.value, best, runnerUp, margin, accept: true,
    reason: 'Matches the assignment.',
  }
}
