/**
 * Normalisation, shared by the parser and mirrored by app.normalize_code() in
 * the database.
 *
 * SAFE normalisation only: case-fold and strip separators. Deliberately does
 * NOT map confusable characters (O->0, I->1, S->5) — those mappings can make
 * two genuinely different identifiers compare equal, which would mask exactly
 * the mismatch this system exists to catch.
 */
export function normalizeCode(raw: string | null | undefined): string {
  if (raw == null) return ''
  return String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function isBlank(value: string | null | undefined): boolean {
  return value == null || String(value).trim() === ''
}

const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {}
  let v = 10
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    while (v % 11 === 0) v++      // skip 11, 22, 33
    map[ch] = v++
  }
  return map
})()

/** ISO 6346 shape: four letters then seven digits. */
export function isIso6346Shaped(raw: string): boolean {
  return /^[A-Z]{4}[0-9]{7}$/.test(normalizeCode(raw))
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
 * Only meaningful for identifiers that are ISO 6346 shaped.
 *
 * Real operators do not universally use them — CULVNSA2601795 is fourteen
 * characters and carries no check digit — so callers must gate on
 * isIso6346Shaped() rather than rejecting everything that fails here.
 */
export function isValidContainerNo(raw: string): boolean {
  const s = normalizeCode(raw)
  if (!isIso6346Shaped(s)) return false
  return containerCheckDigit(s.slice(0, 10)) === Number(s[10])
}
