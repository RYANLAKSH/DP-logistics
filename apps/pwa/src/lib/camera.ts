/**
 * Camera access.
 *
 * Deliberately getUserMedia and not `<input type="file" capture>`. A file input
 * lets the driver pick an existing photograph from their gallery, which
 * defeats the whole control: the evidence is supposed to prove the plate was in
 * front of them. See docs/design/08 §6.
 */

export interface CameraHandle {
  stream: MediaStream
  track: MediaStreamTrack
  stop(): void
  /** Torch, where the device exposes it. Container yards are dark at 6am. */
  setTorch(on: boolean): Promise<boolean>
  hasTorch: boolean
}

export class CameraError extends Error {
  constructor(
    message: string,
    readonly kind: 'denied' | 'unavailable' | 'unsupported' | 'in-use',
  ) {
    super(message)
  }
}

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export async function openCamera(): Promise<CameraHandle> {
  if (!cameraSupported()) {
    throw new CameraError(
      'This browser cannot open the camera. Use Chrome on Android or Safari on iOS 16.4 or later.',
      'unsupported',
    )
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        // Plates are small in frame and stamped. Resolution is what makes them
        // legible; the capture is downscaled afterwards, not before.
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
  } catch (e) {
    const name = (e as DOMException).name
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('Camera permission was refused.', 'denied')
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('No camera is available on this device.', 'unavailable')
    }
    if (name === 'NotReadableError') {
      throw new CameraError('The camera is already in use by another app.', 'in-use')
    }
    throw new CameraError('The camera could not be opened.', 'unavailable')
  }

  const track = stream.getVideoTracks()[0]!
  const capabilities = (track.getCapabilities?.() ?? {}) as { torch?: boolean }
  const hasTorch = capabilities.torch === true

  return {
    stream,
    track,
    hasTorch,
    stop: () => { for (const t of stream.getTracks()) t.stop() },
    async setTorch(on: boolean) {
      if (!hasTorch) return false
      try {
        // `torch` is a real constraint on Android Chrome and absent from the
        // DOM typings, so the cast is unavoidable rather than careless.
        await track.applyConstraints(
          { advanced: [{ torch: on }] } as unknown as MediaTrackConstraints,
        )
        return true
      } catch {
        return false
      }
    },
  }
}

export interface CaptureOptions {
  /** Region of interest as fractions of the frame, matching the on-screen guide. */
  roi?: { x: number; y: number; width: number; height: number }
  /** Long edge of the stored evidence image. */
  maxEdge?: number
  quality?: number
}

export interface Capture {
  /** The full frame, as stored evidence. Never the crop — the crop is a UI aid. */
  evidence: Blob
  /** The cropped, preprocessed region the OCR engine reads. */
  ocrInput: HTMLCanvasElement
  width: number
  height: number
}

/**
 * Takes one frame.
 *
 * The evidence image is the WHOLE frame at full resolution. The crop exists
 * only to make OCR faster and more accurate; storing the crop would throw away
 * the surrounding context that makes a photograph worth having in a dispute.
 */
export function captureFrame(
  video: HTMLVideoElement, options: CaptureOptions = {},
): Promise<Capture> {
  const { roi, maxEdge = 1600, quality = 0.85 } = options
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) {
    return Promise.reject(
      new CameraError(
        'The camera has not produced a frame yet. Wait a moment and try again.',
        'unavailable',
      ),
    )
  }

  const full = document.createElement('canvas')
  const scale = Math.min(1, maxEdge / Math.max(w, h))
  full.width = Math.round(w * scale)
  full.height = Math.round(h * scale)
  full.getContext('2d')!.drawImage(video, 0, 0, full.width, full.height)

  const region = roi ?? { x: 0.05, y: 0.35, width: 0.9, height: 0.3 }
  const crop = document.createElement('canvas')
  crop.width = Math.max(1, Math.round(w * region.width))
  crop.height = Math.max(1, Math.round(h * region.height))
  crop.getContext('2d')!.drawImage(
    video,
    Math.round(w * region.x), Math.round(h * region.y),
    crop.width, crop.height,
    0, 0, crop.width, crop.height,
  )
  preprocess(crop)

  return new Promise((resolve, reject) => {
    full.toBlob(
      (blob) => blob
        ? resolve({ evidence: blob, ocrInput: crop, width: full.width, height: full.height })
        : reject(new Error('the frame could not be encoded')),
      'image/jpeg',
      quality,
    )
  })
}

/**
 * Grayscale plus local contrast stretch.
 *
 * Stamped metal has almost no contrast, which is the single biggest reason
 * chassis plates read worse than container plates. This is cheap and makes a
 * measurable difference; anything heavier belongs in a worker.
 */
export function preprocess(canvas: HTMLCanvasElement): void {
  // A zero-sized canvas makes getImageData throw, and the caller is left with
  // a frozen button and no idea why.
  if (canvas.width < 1 || canvas.height < 1) return
  const ctx = canvas.getContext('2d')!
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data

  let min = 255
  let max = 0
  const grey = new Uint8ClampedArray(data.length / 4)
  for (let i = 0, g = 0; i < data.length; i += 4, g++) {
    const value = (data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114) | 0
    grey[g] = value
    if (value < min) min = value
    if (value > max) max = value
  }

  const range = Math.max(1, max - min)
  for (let i = 0, g = 0; i < data.length; i += 4, g++) {
    const stretched = ((grey[g]! - min) * 255) / range
    data[i] = data[i + 1] = data[i + 2] = stretched
  }
  ctx.putImageData(image, 0, 0)
}

/**
 * Waits until the element actually has a decoded frame.
 *
 * `getUserMedia` resolving means the track exists, not that a frame has been
 * decoded — videoWidth stays 0 until then. Capturing in that window produces a
 * zero-sized canvas and an opaque DOM error, which is exactly what happened
 * the first time this ran under a synthetic camera.
 */
export function waitForFrame(video: HTMLVideoElement, timeoutMs = 5000): Promise<boolean> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      requestAnimationFrame(tick)
    }
    tick()
  })
}
