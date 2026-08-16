/**
 * OCR behind a provider interface.
 *
 * Text recognition needs a native module (ML Kit), which means a development
 * build — not Expo Go. Rather than making the whole app unrunnable until that
 * is set up, the provider is swappable:
 *
 *   MockOcrProvider   — runs anywhere, replays label text from fixtures.
 *                       Lets the capture flow, the rules and the sync queue be
 *                       exercised end to end on day one.
 *   MlKitOcrProvider  — the real thing, once a dev build exists.
 *
 * The extraction and validation logic is identical in both cases because it
 * lives in @dp/shared-rules, so swapping providers changes only where the raw
 * text comes from.
 */

import {
  extractContainerNumbers,
  extractVins,
  normalizeIdentifier,
  isPlausibleVin,
  isCheckDigitAmbiguous,
  normalizeVin,
} from '@dp/shared-rules';

export type ScanTarget = 'container' | 'vin';

export interface OcrResult {
  /** Everything the engine read, kept verbatim for the evidence record. */
  rawText: string;
  /** Best candidate, or null when nothing usable was found. */
  value: string | null;
  confidence: number;
  /** True when the value came straight through with no correction applied. */
  exact: boolean;
  /**
   * True when the read should not be auto-accepted even though it validated —
   * a container number in the 0/10 check digit collision class, or a VIN with
   * no check digit to verify against.
   */
  needsConfirmation: boolean;
  candidates: string[];
}

export interface OcrProvider {
  readonly name: string;
  recognize(imageUri: string, target: ScanTarget): Promise<OcrResult>;
}

const EMPTY: OcrResult = {
  rawText: '',
  value: null,
  confidence: 0,
  exact: false,
  needsConfirmation: true,
  candidates: [],
};

/**
 * Turns raw recognized text into a decision.
 *
 * Shared by every provider — this is where the check digit does its work, and
 * it is the reason container capture can be trusted at a glance while VIN
 * capture cannot.
 */
export function interpret(rawText: string, target: ScanTarget): OcrResult {
  if (!rawText.trim()) return { ...EMPTY, rawText };

  if (target === 'container') {
    const found = extractContainerNumbers(rawText);
    if (found.length === 0) return { ...EMPTY, rawText };

    // More than one valid container number in frame means two plates are
    // visible. Never guess — make the officer frame one.
    if (found.length > 1) {
      return { rawText, value: null, confidence: 0, exact: false, needsConfirmation: true, candidates: found };
    }

    const value = found[0]!;

    // Exactness must be judged against the RAW read, not against the value
    // extraction already repaired — otherwise every corrected number reports
    // itself as exact and the officer is never told a substitution happened.
    const exact = normalizeIdentifier(rawText).includes(value);

    return {
      rawText,
      value,
      // A check-digit pass is strong evidence, but not when the number falls in
      // the 0/10 collision class.
      confidence: exact ? 0.99 : 0.9,
      exact,
      needsConfirmation: !exact || isCheckDigitAmbiguous(value),
      candidates: found,
    };
  }

  const found = extractVins(rawText);
  if (found.length === 0) return { ...EMPTY, rawText };
  if (found.length > 1) {
    return { rawText, value: null, confidence: 0, exact: false, needsConfirmation: true, candidates: found };
  }

  const value = normalizeVin(found[0]!);

  return {
    rawText,
    value,
    // A VIN has no reliable check digit outside North America, so a read is
    // never better than "shaped correctly". Confirmation is always required.
    confidence: isPlausibleVin(value) ? 0.75 : 0,
    exact: false,
    needsConfirmation: true,
    candidates: found,
  };
}

/* ------------------------------------------------------------------ *
 * Mock provider
 * ------------------------------------------------------------------ */

/**
 * Replays canned label text so the flow is testable without a native build.
 * Register the values the demo should read via `queue`.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  private pending: string[] = [];

  queue(...rawTexts: string[]): void {
    this.pending.push(...rawTexts);
  }

  async recognize(_imageUri: string, target: ScanTarget): Promise<OcrResult> {
    const rawText = this.pending.shift() ?? '';
    return interpret(rawText, target);
  }
}

/* ------------------------------------------------------------------ *
 * ML Kit provider
 * ------------------------------------------------------------------ */

/**
 * Google ML Kit text recognition — on-device, offline, free.
 *
 * Requires a development build:
 *   npx expo install @react-native-ml-kit/text-recognition
 *   npx expo prebuild && npx expo run:android
 *
 * Kept behind a dynamic import so the bundle still loads in Expo Go, where the
 * native module is absent; callers fall back to the mock or to manual entry.
 */
export class MlKitOcrProvider implements OcrProvider {
  readonly name = 'mlkit-v2';

  async recognize(imageUri: string, target: ScanTarget): Promise<OcrResult> {
    try {
      const module = await import('@react-native-ml-kit/text-recognition');
      const recognizer = (module as any).default ?? module;
      const result = await recognizer.recognize(imageUri);
      return interpret(String(result?.text ?? ''), target);
    } catch {
      // Native module unavailable — surface as "nothing read" so the UI falls
      // through to manual entry rather than crashing at a gate.
      return { ...EMPTY, rawText: '' };
    }
  }
}

let provider: OcrProvider = new MlKitOcrProvider();

export const getOcrProvider = (): OcrProvider => provider;
export const setOcrProvider = (next: OcrProvider): void => { provider = next; };
