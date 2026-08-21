import { describe, expect, it } from 'vitest'
import {
  containerCheckDigit, editDistance, isValidContainerNo, normalize,
  repairContainerCandidate, repairVinCandidate, scoreAgainstCandidates, scoreOne,
} from '../normalize'

describe('normalize', () => {
  it('folds case and strips separators, and nothing else', () => {
    expect(normalize(' culv nsa-2601795 ')).toBe('CULVNSA2601795')
  })

  it('never maps confusable characters', () => {
    // Doing so could make two genuinely different identifiers compare equal.
    expect(normalize('MATO123')).not.toBe(normalize('MAT0123'))
  })
})

describe('ISO 6346', () => {
  it('validates the published worked example', () => {
    expect(isValidContainerNo('CSQU3054383')).toBe(true)
  })

  it('computes the check digit', () => {
    expect(containerCheckDigit('MSKU451234')).toBe(0)
    expect(containerCheckDigit('CSQU305438')).toBe(3)
  })

  it('rejects every single-digit mutation of a valid number', () => {
    for (let i = 4; i < 11; i++) {
      const base = 'CSQU3054383'
      const digit = Number(base[i])
      const mutated = base.slice(0, i) + ((digit + 1) % 10) + base.slice(i + 1)
      expect(isValidContainerNo(mutated)).toBe(false)
    }
  })

  it('rejects a value that is not ISO shaped at all', () => {
    expect(isValidContainerNo('CULVNSA2601795')).toBe(false)
  })
})

describe('positional confusable repair', () => {
  it('repairs a digit read as a letter in the numeric section', () => {
    // CSQU3O54383: the O at position 6 must be a digit.
    expect(repairContainerCandidate('CSQU3O54383')).toBe('CSQU3054383')
  })

  it('repairs a letter read as a digit in the alpha section', () => {
    expect(repairContainerCandidate('C5QU3054383')).toBe('CSQU3054383')
  })

  it('proposes nothing when the repair still fails the check digit', () => {
    // A repair that does not validate is a guess, and guesses are what put a
    // vehicle in the wrong container.
    expect(repairContainerCandidate('CSQU3O54389')).toBeNull()
  })

  it('proposes nothing when there was nothing to repair', () => {
    expect(repairContainerCandidate('CSQU3054383')).toBeNull()
  })

  it('resolves VIN confusables, which are unambiguous', () => {
    // I, O and Q are never valid in a VIN.
    expect(repairVinCandidate('MATO52389T7RI9810')).toBe('MAT052389T7R19810')
  })

  it('leaves a VIN alone when it has no confusable characters', () => {
    expect(repairVinCandidate('MAT752389T7R19810')).toBeNull()
  })
})

describe('editDistance', () => {
  it('measures single substitutions', () => {
    expect(editDistance('MAT752389T7R19810', 'MAT752389T7R19811')).toBe(1)
  })
  it('bails out on wildly different lengths rather than grinding', () => {
    expect(editDistance('AB', 'A'.repeat(50))).toBeGreaterThan(8)
  })
})

describe('scoreOne', () => {
  it('scores an exact match at 1', () => {
    expect(scoreOne('CULVNSA2601795', 'culv-nsa 2601795').score).toBe(1)
  })
  it('scores a legible suffix highly — plates are often partly stamped', () => {
    const s = scoreOne('T7R19810', 'MAT752389T7R19810')
    expect(s.reason).toBe('suffix')
    expect(s.score).toBe(0.9)
  })
  it('scores an unrelated value low', () => {
    expect(scoreOne('MAT752389T7R19810', 'CULVNSA2601795').score).toBeLessThan(0.5)
  })
})

describe('scoreAgainstCandidates — the acceptance rule', () => {
  const expected = 'MAT752389T7R19810'

  it('accepts a clean read of the expected value', () => {
    const d = scoreAgainstCandidates(expected, {
      expected, others: ['MAT464844TSR09249'],
    })
    expect(d.accept).toBe(true)
    expect(d.proposal).toBe(expected)
  })

  it('refuses a read too close to another number on the manifest', () => {
    // THE case this rule exists for. A pipeline looking for the expected value
    // will find it in noise; two similar chassis numbers are exactly when the
    // wrong vehicle gets loaded.
    const near = 'MAT752389T7R19811'
    const d = scoreAgainstCandidates('MAT752389T7R1981X', {
      expected, others: [near],
    })
    expect(d.accept).toBe(false)
    expect(d.margin).toBeLessThan(0.15)
    expect(d.reason).toMatch(/too close/i)
  })

  it('proposes a confident read of a DIFFERENT manifest value, and refuses it', () => {
    // The driver must see what they actually scanned — the server blocks it.
    const other = 'MAT464844TSR09249'
    const d = scoreAgainstCandidates(other, { expected, others: [other] })
    expect(d.accept).toBe(false)
    expect(d.proposal).toBe(other)
    expect(d.reason).toMatch(/not the value/i)
  })

  it('refuses an unreadable smear rather than proposing the expected value', () => {
    const d = scoreAgainstCandidates('X8', { expected, others: [] })
    expect(d.accept).toBe(false)
    expect(d.proposal).toBeNull()
  })

  it('accepts when there is nothing else on the manifest to confuse it with', () => {
    const d = scoreAgainstCandidates(expected, { expected, others: [] })
    expect(d.accept).toBe(true)
    expect(d.margin).toBe(1)
  })

  it('honours a stricter margin — for near reads, which is what it governs', () => {
    const d = scoreAgainstCandidates('MAT752389T7R1981X', {
      expected,
      others: ['MAT752389T7R19811'],
      minMargin: 0.99,
    })
    expect(d.accept).toBe(false)
  })

  it('a stricter margin does not override an exact read', () => {
    // The margin governs ambiguity. An exact read is not ambiguous, and
    // tightening the threshold must not turn correct scans into refusals.
    const d = scoreAgainstCandidates(expected, {
      expected,
      others: ['MAT752389T7R19811'],
      minMargin: 0.99,
    })
    expect(d.accept).toBe(true)
  })
})

describe('the margin rule versus real manifests', () => {
  // Manifest containers are numbered sequentially, so neighbours differ by one
  // character out of fourteen. Without the exact-match carve-out the margin
  // rule refuses almost every correct scan — which is how this was found.
  const SEQUENTIAL = [
    'CULVNSA2601795', 'CULVNSA2601796', 'CULVNSA2601797', 'CULVNSA2601798',
  ]

  it('accepts an exact read even when siblings are one character away', () => {
    const d = scoreAgainstCandidates('CULVNSA2601795', {
      expected: 'CULVNSA2601795',
      others: SEQUENTIAL.slice(1),
    })
    expect(d.accept).toBe(true)
    expect(d.best?.reason).toBe('exact')
    expect(d.margin).toBeLessThan(0.15)   // the margin IS small — and irrelevant
  })

  it('still refuses a NEAR read among those same siblings', () => {
    // One character unreadable: this could be any of the four. Refuse.
    const d = scoreAgainstCandidates('CULVNSA260179X', {
      expected: 'CULVNSA2601795',
      others: SEQUENTIAL.slice(1),
    })
    expect(d.accept).toBe(false)
    expect(d.reason).toMatch(/too close/i)
  })

  it('still refuses an exact read of the WRONG sibling', () => {
    const d = scoreAgainstCandidates('CULVNSA2601796', {
      expected: 'CULVNSA2601795',
      others: SEQUENTIAL.slice(1),
    })
    expect(d.accept).toBe(false)
    expect(d.proposal).toBe('CULVNSA2601796')
  })
})
