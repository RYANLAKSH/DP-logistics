/**
 * The OCR seam.
 *
 * The engine is deliberately behind an interface. Browser OCR is the weakest
 * link in this product (docs/design/14 §R2), and it is the component most
 * likely to be replaced — by a server-side vision API, by a native wrapper, or
 * by whatever is better in two years. Every one of those swaps should be a new
 * class here and nothing else.
 */

export type ScanKind = 'container' | 'chassis' | 'vehicle_reg'

export interface OcrCandidate {
  /** Exactly what the engine produced, before any cleaning. Kept for audit. */
  raw: string
  /** After safe normalisation: case-folded, separators stripped. */
  normalized: string
  /** The engine's own confidence, 0..1. Not comparable across engines. */
  confidence: number
}

export interface OcrResult {
  candidates: OcrCandidate[]
  engine: string
  /** Milliseconds spent in the engine. Used to tune the frame rate. */
  durationMs: number
}

export interface OcrProvider {
  readonly name: string
  /** Warm the engine. Called when the task screen opens, not at the shutter. */
  initialize(): Promise<void>
  recognize(image: ImageBitmap | Blob | HTMLCanvasElement, kind: ScanKind): Promise<OcrResult>
  terminate(): Promise<void>
}
