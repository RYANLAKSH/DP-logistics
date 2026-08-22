/**
 * What the demo's camera is currently pointing at.
 *
 * The demo replaces the yard, not the app. `openCamera`, `captureFrame`, the
 * ROI crop, the scan pipeline and every matching rule run exactly as they do on
 * a phone — the only thing that changes is where the pixels come from. So this
 * module holds the one piece of state a real yard would hold for us: which
 * physical object is in front of the lens.
 *
 * Deliberately NOT reachable from the scan pipeline. The OCR provider reads
 * what the camera is showing, and is never told what the manifest expects, so
 * a demo read can be wrong in exactly the ways a real one can.
 */

export interface DemoLabel {
  /** The characters printed on the thing being photographed. */
  text: string
  /** Extra codes crowding the label, as the real despatch labels do. */
  clutter: string[]
  /** How legible it is, 0..1. Below the pipeline's floor, nothing is proposed. */
  legibility: number
}

const BLANK: DemoLabel = { text: '', clutter: [], legibility: 0 }

let current: DemoLabel = BLANK
const listeners = new Set<(l: DemoLabel) => void>()

export function setDemoLabel(label: DemoLabel): void {
  current = label
  for (const fn of listeners) fn(label)
}

export function getDemoLabel(): DemoLabel {
  return current
}

export function onDemoLabel(fn: (l: DemoLabel) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** A Tata despatch label: the chassis number among five other codes. */
export function chassisLabel(chassis: string, legibility = 0.93): DemoLabel {
  const type = chassis.slice(3, 9)
  return {
    text: chassis,
    clutter: [`TYPE: ${type}`, 'ASN: 30495315', '267515100104', 'EVR: 4SPTC1234567'],
    legibility,
  }
}

/** A container's door-end marking. */
export function containerLabel(containerNo: string, legibility = 0.9): DemoLabel {
  return { text: containerNo, clutter: ['22G1', 'MAX GROSS 30480 KG'], legibility }
}

/** A plate too damaged to read. Forces the manual-entry path. */
export function unreadableLabel(): DemoLabel {
  return { text: '', clutter: ['░▒▓ ▓▒░', '▒░▓▒'], legibility: 0.15 }
}
