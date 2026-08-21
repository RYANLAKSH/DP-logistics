import type { OcrProvider, OcrResult, ScanKind } from './types'
import { normalize } from './normalize'

/**
 * A deterministic provider, for tests and for running the app without the
 * 4 MB engine. It reads nothing — it returns whatever it was told to return.
 *
 * This exists so the interface in types.ts is exercised by more than one
 * implementation. An abstraction with a single implementation is a guess about
 * the future; one with two is a seam that works.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock'

  private queue: Array<{ text: string; confidence: number }> = []

  /** Queue what the next recognise call should "read". */
  willRead(text: string, confidence = 0.95): this {
    this.queue.push({ text, confidence })
    return this
  }

  async initialize(): Promise<void> {}

  async recognize(_image: unknown, kind: ScanKind): Promise<OcrResult> {
    void kind
    const next = this.queue.shift()
    if (!next) return { candidates: [], engine: this.name, durationMs: 0 }
    return {
      candidates: [{
        raw: next.text,
        normalized: normalize(next.text),
        confidence: next.confidence,
      }],
      engine: this.name,
      durationMs: 1,
    }
  }

  async terminate(): Promise<void> {
    this.queue = []
  }
}
