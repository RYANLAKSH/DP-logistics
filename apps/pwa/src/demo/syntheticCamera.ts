/**
 * A canvas standing in for the yard's camera.
 *
 * The hosted demo runs in a sandboxed frame with no capture device, and a
 * laptop has nothing useful to point at anyway. Replacing `getUserMedia` with a
 * canvas stream keeps every line of our own capture code on the real path —
 * openCamera negotiates the stream, captureFrame crops the ROI, the pipeline
 * scores the result — while the pixels come from `demo/label` instead of a lens.
 */
import { getDemoLabel, onDemoLabel, type DemoLabel } from './label'

const W = 1280
const H = 960

function paint(ctx: CanvasRenderingContext2D, label: DemoLabel) {
  // Yard background: a dull mid-grey, so the label has to carry the contrast.
  ctx.fillStyle = '#8f9296'
  ctx.fillRect(0, 0, W, H)

  // The label panel sits where the app's on-screen guide is, so a tester lines
  // it up the same way a driver would.
  const x = W * 0.06, y = H * 0.30, w = W * 0.88, h = H * 0.40
  ctx.fillStyle = '#f4f2ec'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = '#20242a'
  ctx.lineWidth = 4
  ctx.strokeRect(x, y, w, h)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  // Legibility is drawn, not faked downstream: a poor label is genuinely
  // fainter, and the tester can see why the read was refused.
  const ink = Math.max(0.12, Math.min(1, label.legibility))
  ctx.fillStyle = `rgba(16, 16, 16, ${ink})`
  ctx.font = 'bold 84px ui-monospace, monospace'
  ctx.fillText(label.text || '— — —', W / 2, H * 0.5)

  // The surrounding codes. On a real despatch label these outnumber the
  // chassis number, and one of them is a substring of it.
  ctx.font = '40px ui-monospace, monospace'
  ctx.fillStyle = `rgba(24, 24, 24, ${ink * 0.9})`
  label.clutter.forEach((line, i) => {
    const row = i < 2 ? y + 54 + i * 52 : y + h - 54 - (label.clutter.length - 1 - i) * 52
    ctx.fillText(line, W / 2, row)
  })
}

export function installSyntheticCamera(): void {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  let label = getDemoLabel()
  onDemoLabel((next) => { label = next })

  const tick = () => {
    paint(ctx, label)
    requestAnimationFrame(tick)
  }
  tick()

  const stream = canvas.captureStream(15)
  const media = {
    getUserMedia: async () => stream,
    enumerateDevices: async () => [
      { kind: 'videoinput', deviceId: 'demo', label: 'Demo yard camera', groupId: 'demo' },
    ],
  }
  Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true })
}
