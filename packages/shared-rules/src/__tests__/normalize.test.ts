import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeIdentifier,
  normalizeVin,
  coerceContainerShape,
  resolveContainerCandidates,
  extractContainerNumbers,
  extractVins,
  levenshtein,
} from '../normalize.ts';

describe('normalizeIdentifier', () => {
  test('strips separators and uppercases', () => {
    for (const input of [
      'tghu 739121-8',
      'TGHU-7391218',
      '  tghu7391218  ',
      'TGHU/739/1218',
      'TGHU.7391218',
      'tghu_7391218',
    ]) {
      assert.equal(normalizeIdentifier(input), 'TGHU7391218', `failed on ${input}`);
    }
  });

  test('folds unicode dashes and non-breaking spaces from spreadsheet paste', () => {
    assert.equal(normalizeIdentifier('TGHU–7391218'), 'TGHU7391218');
    assert.equal(normalizeIdentifier('TGHU 7391218'), 'TGHU7391218');
  });

  test('tolerates null and undefined without throwing', () => {
    assert.equal(normalizeIdentifier(undefined as unknown as string), '');
    assert.equal(normalizeIdentifier(null as unknown as string), '');
  });
});

describe('normalizeVin', () => {
  test('maps the three illegal VIN characters to their digits', () => {
    assert.equal(normalizeVin('MA3EJKDIS00100001'), 'MA3EJKD1S00100001');
    assert.equal(normalizeVin('MA3EJKD1S0O1OOOO1'), 'MA3EJKD1S00100001');
    assert.equal(normalizeVin('MA3EJKD1SQ0100001'), 'MA3EJKD1S00100001');
  });

  test('preserves D, L, S, B and Z — all legal VIN characters', () => {
    // Folding these into digits would corrupt genuine VINs.
    const vin = 'MDLSBZ1234567890X'.slice(0, 17);
    const normalized = normalizeVin(vin);
    assert.match(normalized, /^MDLSBZ/);
  });
});

describe('container OCR recovery', () => {
  test('coerces confusables in the direction each position demands', () => {
    // Digits misread as letters in the owner code, letters as digits in serial.
    assert.equal(coerceContainerShape('7GHU739I2I8'), 'TGHU7391218');
  });

  test('proposes a check-digit-valid candidate from a corrupted read', () => {
    const candidates = resolveContainerCandidates('7GHU739I2I8');
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0]!.value, 'TGHU7391218');
    assert.equal(candidates[0]!.exact, false);
  });

  test('marks an already-valid read as exact', () => {
    const candidates = resolveContainerCandidates('TGHU7391218');
    assert.equal(candidates[0]!.value, 'TGHU7391218');
    assert.equal(candidates[0]!.exact, true);
    assert.equal(candidates[0]!.corrections, 0);
  });

  test('returns nothing for a read that cannot be repaired in one substitution', () => {
    // 'TGHU7391217' is one digit off a valid number in the CHECK digit, which
    // no single serial substitution can reconcile.
    assert.deepEqual(resolveContainerCandidates('TGHU0000000'), []);
  });

  test('rejects candidates without a valid equipment category', () => {
    // XXXX9999999 happens to satisfy the check digit, but X is not a valid
    // equipment category — extraction must not surface it.
    assert.deepEqual(extractContainerNumbers('XXXX9999999'), []);
  });

  test('returns nothing for wrong-length input', () => {
    assert.deepEqual(resolveContainerCandidates('TGHU73912'), []);
    assert.deepEqual(resolveContainerCandidates(''), []);
  });

  test('pulls the container number out of a noisy plate read', () => {
    // A real container plate carries the ISO type code, tare and payload.
    const plate = `
      TGHU 739121 8
      45G1
      MAX GROSS 32,500 KG
      TARE 3,750 KG
      NET 28,750 KG
    `;
    assert.deepEqual(extractContainerNumbers(plate), ['TGHU7391218']);
  });
});

describe('VIN extraction', () => {
  test('pulls the VIN out of a door jamb label', () => {
    const label = `
      MARUTI SUZUKI INDIA LIMITED
      MFD BY: GURUGRAM
      DATE 03/2026
      VIN MA3EJKD1S00100001
      GVW 1450 KG
      TYRE 185/65R15 33 PSI
    `;
    assert.deepEqual(extractVins(label), ['MA3EJKD1S00100001']);
  });

  test('recovers a VIN when label text runs together', () => {
    const found = extractVins('VIN:MA3EJKD1S00100001GVW1450KG');
    assert.ok(found.includes('MA3EJKD1S00100001'), `got ${JSON.stringify(found)}`);
  });

  test('ignores runs that are not VIN-shaped', () => {
    assert.deepEqual(extractVins('GVW 1450 KG TYRE 185/65R15'), []);
  });
});

describe('levenshtein', () => {
  test('computes small distances exactly', () => {
    assert.equal(levenshtein('abc', 'abc'), 0);
    assert.equal(levenshtein('abc', 'abd'), 1);
    assert.equal(levenshtein('abc', 'axd'), 2);
    assert.equal(levenshtein('abc', 'ab'), 1);
  });

  test('short-circuits beyond the cap rather than computing exactly', () => {
    assert.ok(levenshtein('aaaaaaaa', 'bbbbbbbb', 2) > 2);
    assert.ok(levenshtein('a', 'aaaaaaaaaa', 2) > 2);
  });
});
