import type { OcrProvider, OcrResult, ScanKind } from '@/lib/ocr/types'
import { normalize } from '@/lib/ocr/normalize'
import { getDemoLabel } from './label'

/**
 * Reads the demo's label instead of running Tesseract.
 *
 * The engine itself is 23 MB of WebAssembly and language data — more than the
 * hosted demo can carry, and nothing it would prove is about our code. What
 * matters downstream is the SHAPE of an OCR result: several candidate strings
 * from one frame, each with a confidence, the wanted value not necessarily
 * first, and a `TYPE` code that is a substring of the chassis number. This
 * returns exactly that, from whatever the camera is currently showing.
 *
 * It is never told what the manifest expects, so every judgement about the read
 * is still made by the real pipeline against the real manifest.
 */
export class DemoOcrProvider implements OcrProvider {
  readonly name = 'demo'

  async initialize(): Promise<void> {}

  async recognize(_image: unknown, kind: ScanKind): Promise<OcrResult> {
    void kind
    const label = getDemoLabel()
    const started = performance.now()

    // A real engine takes a beat, and the screen has a spinner that should be
    // seen doing its job.
    await new Promise((r) => setTimeout(r, 420))

    const lines: Array<{ raw: string; confidence: number }> = []
    // The clutter reads more confidently than the number of interest: it is
    // set in a larger, cleaner face on the real labels.
    label.clutter.forEach((c, i) => {
      lines.push({ raw: c, confidence: Math.min(0.97, label.legibility + 0.05 - i * 0.01) })
    })
    if (label.text) {
      lines.push({ raw: label.text, confidence: label.legibility })
    }

    return {
      candidates: lines
        .filter((l) => /[A-Za-z0-9]/.test(l.raw))
        .map((l) => ({
          raw: l.raw,
          normalized: normalize(l.raw),
          confidence: Math.max(0, Math.min(1, l.confidence)),
        })),
      engine: this.name,
      durationMs: Math.round(performance.now() - started),
    }
  }

  async terminate(): Promise<void> {}
}
