/**
 * Normalization and OCR error recovery.
 *
 * Every value is normalized before comparison — OCR output, manual entry, and
 * report ingest alike. Comparing un-normalized strings is the classic source of
 * phantom mismatches ("MSKU 451234-0" vs "MSKU4512340").
 */

import {
  CONTAINER_NO_PATTERN,
  containerCheckDigit,
  isValidContainerNo,
  isPlausibleVin,
  hasStandardCategory,
} from './checkDigit.ts';

/** Separators and whitespace that appear on plates and in spreadsheets alike. */
const SEPARATORS = /[\s\-_./\\|:,]+/g;

/** Unicode lookalikes that arrive via copy-paste from PDFs and Excel. */
const UNICODE_FOLD: Readonly<Record<string, string>> = Object.freeze({
  '‐': '', '‑': '', '‒': '', '–': '', '—': '', // dashes
  ' ': '', ' ': '', ' ': '', // non-breaking spaces
  'İ': 'I', 'ı': 'I', // Turkish dotted/dotless i
  '０': '0', '１': '1', // fullwidth digits
});

function fold(raw: string): string {
  let out = '';
  for (const ch of raw) out += UNICODE_FOLD[ch] ?? ch;
  return out;
}

/** Uppercase, strip separators and unicode noise. Safe for any identifier. */
export function normalizeIdentifier(raw: string): string {
  return fold(String(raw ?? ''))
    .toUpperCase()
    .replace(SEPARATORS, '')
    .trim();
}

export const normalizeContainerNo = normalizeIdentifier;

/**
 * VIN normalization can be stricter than the generic case: I, O and Q are
 * illegal in a VIN, so any occurrence is unambiguously a misread of 1, 0, 0.
 * No positional guessing required.
 *
 * Only those three. D, L, S, B and Z are all legal VIN characters — folding
 * them into digits would corrupt genuine VINs, which is a far worse failure
 * than leaving a misread uncorrected for the officer to fix.
 */
export function normalizeVin(raw: string): string {
  return normalizeIdentifier(raw)
    .replace(/I/g, '1')
    .replace(/[OQ]/g, '0');
}

/* ------------------------------------------------------------------ *
 * Confusable-character recovery for container numbers
 * ------------------------------------------------------------------ */

/**
 * A container number is positionally strict: 1-4 are letters, 5-11 are digits.
 * So we know which direction to resolve each confusable, and we can verify the
 * result with the check digit rather than guessing.
 */
const TO_DIGIT: Readonly<Record<string, string>> = Object.freeze({
  O: '0', Q: '0', D: '0', U: '0',
  I: '1', L: '1', T: '1',
  Z: '2',
  E: '3',
  A: '4',
  S: '5',
  G: '6', C: '6',
  Y: '7',
  B: '8',
  P: '9',
});

const TO_LETTER: Readonly<Record<string, string>> = Object.freeze({
  '0': 'O', '1': 'I', '2': 'Z', '3': 'E', '4': 'A',
  '5': 'S', '6': 'G', '7': 'T', '8': 'B', '9': 'P',
});

/** Applies the substitution each position demands, without validating. */
export function coerceContainerShape(value: string): string {
  if (value.length !== 11) return value;
  let out = '';
  for (let i = 0; i < 11; i++) {
    const ch = value[i]!;
    if (i < 4) out += TO_LETTER[ch] ?? ch;
    else out += TO_DIGIT[ch] ?? ch;
  }
  return out;
}

export interface ContainerCandidate {
  value: string;
  /** True when no substitution was needed. */
  exact: boolean;
  /** Characters changed from the raw read. */
  corrections: number;
}

/**
 * Turns a raw OCR read into check-digit-valid candidates, best first.
 *
 * Strategy, in order of trust:
 *   1. The read is already valid                        → exact
 *   2. Positional coercion makes it valid               → corrected
 *   3. A single further substitution makes it valid     → corrected
 *
 * Step 3 is deliberately capped at one substitution. Allowing two produces
 * multiple valid candidates for the same read, and a check digit that "passes"
 * after enough edits is not evidence of anything.
 */
export function resolveContainerCandidates(raw: string): ContainerCandidate[] {
  const normalized = normalizeContainerNo(raw);
  if (normalized.length !== 11) return [];

  const out: ContainerCandidate[] = [];
  const seen = new Set<string>();

  const push = (value: string, exact: boolean) => {
    if (seen.has(value) || !isValidContainerNo(value)) return;
    seen.add(value);
    out.push({ value, exact, corrections: countDiff(normalized, value) });
  };

  push(normalized, true);
  push(coerceContainerShape(normalized), false);

  // Last resort: one further substitution in the digit section, where misreads
  // cluster.
  //
  // Applied only when it is UNAMBIGUOUS. A blind sweep tries 70 variants and,
  // at a ~1-in-11 pass rate, typically finds six that satisfy the check digit —
  // so "it validates after one edit" carries almost no information. If more
  // than one survives we surface none and let the officer key it in.
  const base = coerceContainerShape(normalized);
  if (CONTAINER_NO_PATTERN.test(base) && out.length === 0) {
    const repairs: string[] = [];
    for (let i = 4; i < 11; i++) {
      for (const digit of '0123456789') {
        if (digit === base[i]) continue;
        const variant = base.slice(0, i) + digit + base.slice(i + 1);
        if (isValidContainerNo(variant)) repairs.push(variant);
      }
    }
    if (repairs.length === 1) push(repairs[0]!, false);
  }

  return out.sort((a, b) => Number(b.exact) - Number(a.exact) || a.corrections - b.corrections);
}

function countDiff(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

/**
 * Scans a block of OCR text for anything container-shaped and returns the
 * check-digit-valid readings. This is what the camera frame processor calls.
 *
 * Container plates carry the ISO type code and tare weights alongside the
 * number, so the raw text is always noisy.
 */
export function extractContainerNumbers(ocrText: string): string[] {
  const found = new Set<string>();

  const consider = (window: string) => {
    for (const candidate of resolveContainerCandidates(window)) {
      // The equipment category filter is what makes extraction usable. Without
      // it, roughly one in eleven arbitrary 11-character runs passes the check
      // digit, and a plate carrying weights and an ISO type code produces a
      // stream of plausible-looking rubbish.
      if (!hasStandardCategory(candidate.value)) continue;
      found.add(candidate.value);
      break; // best candidate per window only
    }
  };

  // Tokenize first. Plates print the number as "TGHU 739121 8", so join up to
  // three consecutive tokens — but never fuse the whole label, which would
  // invent numbers that straddle unrelated fields.
  const tokens = String(ocrText ?? '')
    .split(/\s+/)
    .map((token) => normalizeIdentifier(token))
    .filter(Boolean);

  for (let i = 0; i < tokens.length; i++) {
    let joined = '';
    for (let span = 0; span < 3 && i + span < tokens.length; span++) {
      joined += tokens[i + span]!;
      if (joined.length === 11) consider(joined);
      if (joined.length > 11) break;
    }

    // A single fused token (OCR ran the fields together) still gets a window
    // slide, but only within that token.
    const token = tokens[i]!;
    for (let j = 0; j + 11 <= token.length; j++) consider(token.slice(j, j + 11));
  }

  return [...found];
}

/**
 * Scans OCR text for VIN-shaped runs. Door jamb labels print the VIN alongside
 * tyre pressures, gross weights, paint codes and a Code 39 barcode, so the same
 * noise problem applies.
 */
export function extractVins(ocrText: string): string[] {
  const found = new Set<string>();

  // Split on whitespace BEFORE normalizing — normalizeIdentifier strips
  // whitespace, so splitting afterwards would yield a single fused token.
  for (const token of String(ocrText ?? '').split(/\s+/)) {
    const candidate = normalizeVin(token);
    if (isPlausibleVin(candidate)) found.add(candidate);
  }

  // Fall back to the printed "VIN" marker when the label text ran together.
  //
  // A bare sliding window is not viable here: "GVW1450KGTYRE18565R15" contains
  // several 17-character runs drawn entirely from the legal VIN alphabet, and
  // unlike a container number there is no check digit to reject them. Anchoring
  // on the marker is the only reliable cue.
  if (found.size === 0) {
    const compact = normalizeVin(ocrText);
    for (const match of compact.matchAll(/V1N([A-HJ-NPR-Z0-9]{17})/g)) {
      found.add(match[1]!); // normalizeVin has already rewritten I → 1
    }
  }
  return [...found];
}

/** Levenshtein distance, capped for early exit. Used for fuzzy VIN matching. */
export function levenshtein(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export { containerCheckDigit };
