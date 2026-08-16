/**
 * Check-digit algorithms for the two identifiers this system reconciles.
 *
 * These run in the camera loop on the device, so they must be allocation-light
 * and free of dependencies.
 */

/* ------------------------------------------------------------------ *
 * ISO 6346 — container numbers
 * ------------------------------------------------------------------ */

/**
 * Letter values skip every multiple of 11: A=10, B=12 ... K=21, L=23 (22 skipped).
 */
const CONTAINER_LETTER_VALUES: Readonly<Record<string, number>> = (() => {
  const map: Record<string, number> = {};
  let value = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    while (value % 11 === 0) value++;
    map[ch] = value++;
  }
  return Object.freeze(map);
})();

export const CONTAINER_NO_PATTERN = /^[A-Z]{4}[0-9]{7}$/;

/** Valid equipment category identifiers (4th character) per ISO 6346. */
const CONTAINER_CATEGORIES = new Set(['U', 'J', 'Z']);

/**
 * Computes the ISO 6346 check digit from the first 10 characters.
 * Returns null if the input is not 4 letters followed by 6 digits.
 */
export function containerCheckDigit(first10: string): number | null {
  if (!/^[A-Z]{4}[0-9]{6}$/.test(first10)) return null;

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i]!;
    const value = i < 4 ? CONTAINER_LETTER_VALUES[ch]! : ch.charCodeAt(0) - 48;
    sum += value * (1 << i); // weight is 2^i
  }
  // A remainder of 10 maps to check digit 0.
  return (sum % 11) % 10;
}

/**
 * Full ISO 6346 validation. Expects an already-normalized value —
 * call normalizeContainerNo first.
 *
 * Known weakness: remainder 10 folds to check digit 0, so remainders 0 and 10
 * are indistinguishable. A number ending in 0 has measurably weaker error
 * detection than one ending 1-9, and a passing check on such a number is
 * correspondingly weaker evidence. Callers that auto-accept an OCR read should
 * consult isCheckDigitAmbiguous and demand explicit confirmation.
 */
export function isValidContainerNo(value: string): boolean {
  if (!CONTAINER_NO_PATTERN.test(value)) return false;
  return containerCheckDigit(value.slice(0, 10)) === Number(value[10]);
}

/**
 * True when this container number sits in the weaker 0/10 collision class.
 * Such reads should be confirmed by the officer rather than auto-accepted.
 */
export function isCheckDigitAmbiguous(value: string): boolean {
  return value.length === 11 && value[10] === '0';
}

/** True when the 4th character is a recognised equipment category (U/J/Z). */
export function hasStandardCategory(value: string): boolean {
  return CONTAINER_CATEGORIES.has(value[3] ?? '');
}

/** Appends the correct check digit to a 10-character prefix. Used by fixtures. */
export function completeContainerNo(first10: string): string | null {
  const digit = containerCheckDigit(first10);
  return digit === null ? null : first10 + digit;
}

/* ------------------------------------------------------------------ *
 * ISO 3779 — vehicle identification numbers
 * ------------------------------------------------------------------ */

/**
 * I, O and Q are never valid in a VIN — that exclusion exists precisely so the
 * digits 1 and 0 are unambiguous. We exploit it in normalization.
 */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const VIN_TRANSLITERATION: Readonly<Record<string, number>> = Object.freeze({
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
});

const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;

/**
 * Computes the ISO 3779 check character for position 9. Returns '0'-'9' or 'X'.
 *
 * Note: the check digit is mandatory for North American VINs but only
 * conventional elsewhere. Many Asian-market VINs carry a valid one, but a
 * failure here is NOT proof of a bad read — see isPlausibleVin.
 */
export function vinCheckDigit(vin: string): string | null {
  if (!VIN_PATTERN.test(vin)) return null;

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]!;
    const value = ch >= '0' && ch <= '9' ? ch.charCodeAt(0) - 48 : VIN_TRANSLITERATION[ch];
    if (value === undefined) return null;
    sum += value * VIN_WEIGHTS[i]!;
  }

  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/** True only when the VIN is well-formed AND its check digit verifies. */
export function isValidVin(vin: string): boolean {
  const expected = vinCheckDigit(vin);
  return expected !== null && expected === vin[8];
}

/**
 * Shape-only validity: 17 characters from the legal alphabet.
 *
 * This is the check that gates a scan, not isValidVin. Blocking a load because
 * a manufacturer declined to populate position 9 would strand real cargo.
 */
export function isPlausibleVin(vin: string): boolean {
  return VIN_PATTERN.test(vin);
}

/** Rewrites position 9 so the VIN check digit verifies. Used by fixtures. */
export function withValidVinCheckDigit(vin: string): string | null {
  if (!VIN_PATTERN.test(vin)) return null;
  const provisional = vin.slice(0, 8) + '0' + vin.slice(9);
  const digit = vinCheckDigit(provisional);
  return digit === null ? null : vin.slice(0, 8) + digit + vin.slice(9);
}
