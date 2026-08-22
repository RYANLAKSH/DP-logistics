import { describe, expect, it } from 'vitest'
import { MockOcrProvider } from '../MockOcrProvider'
import { runScan, sourceFor } from '../pipeline'

const CONTAINER = 'CSQU3054383'          // a valid ISO 6346 number
const NON_ISO = 'CULVNSA2601795'         // the customer's real reference format
const CHASSIS = 'MAT752389T7R19810'
const OTHER_CHASSIS = 'MAT464844TSR09249'

const canvas = {} as HTMLCanvasElement

describe('runScan', () => {
  it('accepts a clean read of the expected container', async () => {
    const p = new MockOcrProvider().willRead(CONTAINER, 0.94)
    const r = await runScan(p, canvas, {
      kind: 'container', expected: CONTAINER, others: [],
    })
    expect(r.accepted).toBe(true)
    expect(r.proposal).toBe(CONTAINER)
    expect(r.repaired).toBe(false)
  })

  it('always preserves the engine output verbatim', async () => {
    // This is what proves a human corrected a machine, not the reverse.
    const p = new MockOcrProvider().willRead('csqu 3054383', 0.94)
    const r = await runScan(p, canvas, {
      kind: 'container', expected: CONTAINER, others: [],
    })
    expect(r.rawText).toBe('csqu 3054383')
  })

  it('repairs a positional confusable and DISCLOSES that it did', async () => {
    const p = new MockOcrProvider().willRead('CSQU3O54383', 0.9)
    const r = await runScan(p, canvas, {
      kind: 'container', expected: CONTAINER, others: [],
    })
    expect(r.proposal).toBe(CONTAINER)
    expect(r.repaired).toBe(true)
    expect(r.rawText).toBe('CSQU3O54383')
    // A repaired read is never OCR_AUTO — it needs an explicit human tap.
    expect(sourceFor(r, false)).toBe('OCR_CONFIRMED')
  })

  it('refuses a container that fails its check digit, whatever the confidence', async () => {
    // Arithmetic beats a probability: it is a different number, not a bad read.
    const p = new MockOcrProvider().willRead('CSQU3054389', 0.99)
    const r = await runScan(p, canvas, {
      kind: 'container', expected: CONTAINER, others: [],
    })
    expect(r.accepted).toBe(false)
    expect(r.checkDigitFailed).toBe(true)
    expect(r.message).toMatch(/check digit/i)
  })

  it('does not demand a check digit from a non-ISO reference', async () => {
    const p = new MockOcrProvider().willRead(NON_ISO, 0.9)
    const r = await runScan(p, canvas, {
      kind: 'container', expected: NON_ISO, others: [],
    })
    expect(r.accepted).toBe(true)
    expect(r.checkDigitFailed).toBe(false)
  })

  it('asks for a retake when confidence is below the threshold', async () => {
    const p = new MockOcrProvider().willRead(CHASSIS, 0.4)
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: CHASSIS, others: [],
    })
    expect(r.accepted).toBe(false)
    expect(r.proposal).toBeNull()
    expect(r.message).toMatch(/retake/i)
    expect(r.rawText).toBe(CHASSIS)   // still recorded
  })

  it('gives a clear retry state when the engine reads nothing', async () => {
    const r = await runScan(new MockOcrProvider(), canvas, {
      kind: 'chassis', expected: CHASSIS, others: [],
    })
    expect(r.accepted).toBe(false)
    expect(r.rawText).toBeNull()
    expect(r.message).toMatch(/nothing readable/i)
  })

  it('refuses a read too close to another chassis on the manifest', async () => {
    const p = new MockOcrProvider().willRead('MAT752389T7R1981X', 0.95)
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: CHASSIS, others: ['MAT752389T7R19811'],
    })
    expect(r.accepted).toBe(false)
    expect(r.message).toMatch(/too close/i)
  })

  it('proposes — and refuses — a confident read of a different manifest value', async () => {
    const p = new MockOcrProvider().willRead(OTHER_CHASSIS, 0.97)
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: CHASSIS, others: [OTHER_CHASSIS],
    })
    expect(r.accepted).toBe(false)
    expect(r.proposal).toBe(OTHER_CHASSIS)   // the driver must see what they scanned
  })

  it('resolves VIN confusables, which are never valid in a VIN', async () => {
    const p = new MockOcrProvider().willRead('MAT752389T7RI9810', 0.93)
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: CHASSIS, others: [],
    })
    expect(r.proposal).toBe(CHASSIS)
    expect(r.repaired).toBe(true)
  })
})

/**
 * A real Tata Motors despatch label, as photographed in the yard. The chassis
 * number is one string among six, it is NOT the most confident read, and the
 * TYPE code is a substring of it. Every one of those facts breaks a pipeline
 * that trusts the top line.
 */
describe('runScan on a real despatch label', () => {
  const LABEL = [
    { text: 'TYPE: 464844', confidence: 0.97 },
    { text: 'ASN: 30495315', confidence: 0.95 },
    { text: '267515100104', confidence: 0.94 },
    { text: 'MAT464844TSR10851', confidence: 0.88 },
    { text: 'EVR: 4SPTC1234567', confidence: 0.86 },
  ]
  const LABEL_CHASSIS = 'MAT464844TSR10851'

  it('picks the chassis number out of the surrounding clutter', async () => {
    const p = new MockOcrProvider().willReadFrame(LABEL)
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: LABEL_CHASSIS, others: [CHASSIS],
    })
    expect(r.accepted).toBe(true)
    expect(r.proposal).toBe(LABEL_CHASSIS)
    expect(r.candidateCount).toBe(5)
    // The winning candidate's own raw text, not the loudest line on the label.
    expect(r.rawText).toBe(LABEL_CHASSIS)
  })

  it('does not accept the TYPE code just because it is a substring', async () => {
    // Only the type code is legible. It is a prefix-adjacent fragment of the
    // expected chassis number, which is exactly the read that must NOT pass.
    const p = new MockOcrProvider().willReadFrame([LABEL[0]!, LABEL[1]!])
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: LABEL_CHASSIS, others: [CHASSIS],
    })
    expect(r.accepted).toBe(false)
    expect(r.proposal).not.toBe(LABEL_CHASSIS)
  })

  it('still refuses the label when it belongs to another container\'s vehicle', async () => {
    // The driver photographs the right kind of label on the wrong vehicle.
    // Reading every candidate must not turn that into a match.
    const p = new MockOcrProvider().willReadFrame([
      { text: 'TYPE: 752389', confidence: 0.97 },
      { text: OTHER_CHASSIS, confidence: 0.93 },
    ])
    const r = await runScan(p, canvas, {
      kind: 'chassis', expected: CHASSIS, others: [OTHER_CHASSIS],
    })
    expect(r.accepted).toBe(false)
  })
})

describe('sourceFor', () => {
  it('distinguishes how each value reached the record', async () => {
    const clean = await runScan(
      new MockOcrProvider().willRead(CONTAINER, 0.95), canvas,
      { kind: 'container', expected: CONTAINER, others: [] },
    )
    expect(sourceFor(clean, false)).toBe('OCR_AUTO')
    expect(sourceFor(clean, true)).toBe('MANUAL_ENTRY')
  })
})
