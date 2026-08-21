/**
 * A synthetic camera for end-to-end runs.
 *
 * The Chromium build available in CI exposes no capture device at all, and its
 * fake-device flag does not take effect, so getUserMedia is replaced with a
 * canvas stream. This is not a stub of OUR code: openCamera, captureFrame, the
 * preprocessing and the real Tesseract engine all run exactly as they do on a
 * phone. What changes is only where the pixels come from — and because the
 * canvas draws a real plate, the OCR result is a real OCR result.
 */
export function cameraStubScript(text) {
  return `(() => {
    const W = 1280, H = 960
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d')

    function draw() {
      ctx.fillStyle = '#c8c8c0'
      ctx.fillRect(0, 0, W, H)
      // A plate panel roughly where the on-screen guide sits.
      ctx.fillStyle = '#e8e8e4'
      ctx.fillRect(W * 0.06, H * 0.38, W * 0.88, H * 0.24)
      ctx.fillStyle = '#101010'
      ctx.font = 'bold 96px monospace'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(${JSON.stringify(text)}, W / 2, H * 0.5)
      requestAnimationFrame(draw)
    }
    draw()

    const stream = canvas.captureStream(15)
    navigator.mediaDevices.getUserMedia = async () => stream
    navigator.mediaDevices.enumerateDevices = async () => ([
      { kind: 'videoinput', deviceId: 'stub', label: 'Synthetic yard camera', groupId: 'g' },
    ])
  })()`
}
