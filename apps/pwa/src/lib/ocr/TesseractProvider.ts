import type { OcrProvider, OcrResult, ScanKind } from './types'
import { normalize } from './normalize'

/**
 * Tesseract, compiled to WebAssembly, running in a worker.
 *
 * WHY THIS ENGINE
 *
 * It is the only OCR that runs entirely on the device in a browser, and
 * on-device is not negotiable here: a driver between two stacks of containers
 * has no signal, and a verdict that needs a round trip is a verdict they do not
 * get. Everything else was rejected for a specific reason:
 *
 *  - Cloud vision APIs (Google, Textract) read stamped metal considerably
 *    better, and need a network. They are designed in as a phase-4 second
 *    opinion on low-confidence scans, off the critical path — see
 *    docs/design/09 §2 — not as the thing a driver waits on.
 *  - The browser Shape Detection API (TextDetector) is fast and free, and does
 *    not exist on iOS at all.
 *  - A native wrapper would give frame processors and better camera control,
 *    and would stop this being a PWA.
 *
 * Tesseract alone is mediocre on a dirty chassis plate. What makes it good
 * enough is everything around it: the ISO 6346 check digit rejects most
 * container misreads for free, the manifest narrows chassis recognition to a
 * verification against a handful of known values, and manual entry is a
 * first-class path rather than a fallback.
 *
 * Constrained hard: a 36-character allow-list, single-line page segmentation,
 * and a cropped, contrast-stretched region. An unconstrained engine proposes
 * punctuation and lowercase that no plate ever contains.
 */
export class TesseractProvider implements OcrProvider {
  readonly name = 'tesseract-6-wasm'

  private worker: import('tesseract.js').Worker | null = null
  private initializing: Promise<void> | null = null

  /** Where the wasm core, worker script and language data are served from. */
  private readonly assetBase = import.meta.env.VITE_OCR_ASSET_BASE ?? '/ocr'

  async initialize(): Promise<void> {
    if (this.worker) return
    // Concurrent callers must not each spawn a worker: it is a 4 MB download
    // and a second one would evict the first from cache on a low-end phone.
    this.initializing ??= this.start()
    await this.initializing
  }

  private async start(): Promise<void> {
    const { createWorker } = await import('tesseract.js')
    this.worker = await createWorker('eng', 1, {
      workerPath: `${this.assetBase}/worker.min.js`,
      corePath: `${this.assetBase}/`,
      langPath: this.assetBase,
      // Nothing is fetched from a CDN at runtime. The assets are precached by
      // the service worker so the first scan of a shift works without signal.
      cacheMethod: 'none',
      gzip: true,
    })
    await this.worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      // PSM 7: one line of text. Plates are one line, and letting the engine
      // hunt for paragraphs finds text elsewhere on the container.
      tessedit_pageseg_mode: '7' as never,
      preserve_interword_spaces: '0',
    })
  }

  async recognize(
    image: ImageBitmap | Blob | HTMLCanvasElement, kind: ScanKind,
  ): Promise<OcrResult> {
    await this.initialize()
    if (!this.worker) throw new Error('the OCR engine failed to start')

    const started = performance.now()
    const { data } = await this.worker.recognize(image as never)
    const durationMs = performance.now() - started

    // Lines first, then the whole block. A plate is one line; the block-level
    // read is a fallback for when line segmentation goes wrong.
    // `lines` is populated at runtime but is not in the published Page type
    // for this version, so it is read defensively rather than asserted.
    const page = data as unknown as {
      text?: string
      confidence?: number
      lines?: Array<{ text: string; confidence: number }>
    }
    const seen = new Set<string>()
    const candidates = [
      ...(page.lines ?? []).map((l) => ({
        raw: l.text, confidence: l.confidence / 100,
      })),
      { raw: page.text ?? '', confidence: (page.confidence ?? 0) / 100 },
    ]
      .map((c) => ({ ...c, normalized: normalize(c.raw) }))
      .filter((c) => {
        if (!c.normalized || c.normalized.length < 4) return false
        if (seen.has(c.normalized)) return false
        seen.add(c.normalized)
        return true
      })
      .sort((a, b) => b.confidence - a.confidence)

    void kind
    return { candidates, engine: this.name, durationMs }
  }

  async terminate(): Promise<void> {
    await this.worker?.terminate()
    this.worker = null
    this.initializing = null
  }
}
