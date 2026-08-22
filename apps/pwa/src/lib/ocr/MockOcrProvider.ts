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

  private queue: Array<Array<{ text: string; confidence: number }>> = []

  /** Queue what the next recognise call should "read". */
  willRead(text: string, confidence = 0.95): this {
    this.queue.push([{ text, confidence }])
    return this
  }

  /**
   * Queue a whole frame: several strings read from one photo. Real despatch
   * labels are never one line, so a provider that can only return one is not
   * exercising the case the pipeline exists to handle.
   */
  willReadFrame(lines: Array<{ text: string; confidence: number }>): this {
    this.queue.push(lines)
    return this
  }

  async initialize(): Promise<void> {}

  async recognize(_image: unknown, kind: ScanKind): Promise<OcrResult> {
    void kind
    const next = this.queue.shift()
    if (!next || next.length === 0) {
      return { candidates: [], engine: this.name, durationMs: 0 }
    }
    return {
      candidates: next.map((line) => ({
        raw: line.text,
        normalized: normalize(line.text),
        confidence: line.confidence,
      })),
      engine: this.name,
      durationMs: 1,
    }
  }

  async terminate(): Promise<void> {
    this.queue = []
  }
}
