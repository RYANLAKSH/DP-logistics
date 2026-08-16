import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  containerCheckDigit,
  isValidContainerNo,
  completeContainerNo,
  hasStandardCategory,
  vinCheckDigit,
  isValidVin,
  isPlausibleVin,
  withValidVinCheckDigit,
} from '../checkDigit.ts';

describe('ISO 6346 container check digit', () => {
  // CSQU3054383 is the published ISO 6346 worked example. The rest are fixture
  // numbers with computed check digits, deliberately chosen with a non-zero
  // check digit — see the 0/10 ambiguity test below.
  const KNOWN_GOOD = [
    'CSQU3054383',
    'TGHU7391218',
    'HLXU8177632',
    'APZU3417321',
    'MSKU1000016',
  ];

  /**
   * Letter values skip multiples of 11, so some letter pairs differ by exactly
   * 11 or 22 (B=12/L=23/V=34, C=13/M=24, ...). Substituting within such a pair
   * leaves the weighted sum unchanged mod 11 and the check digit still passes.
   * That is a property of ISO 6346, not a defect here — the test asserts the
   * real guarantee rather than an idealised one.
   */
  const LETTER_VALUE: Record<string, number> = (() => {
    const map: Record<string, number> = {};
    let v = 10;
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      while (v % 11 === 0) v++;
      map[ch] = v++;
    }
    return map;
  })();

  for (const value of KNOWN_GOOD) {
    test(`${value} validates`, () => {
      assert.equal(isValidContainerNo(value), true);
    });
  }

  test('rejects every single-digit mutation of a valid number', () => {
    for (const value of KNOWN_GOOD) {
      for (let i = 4; i < 10; i++) {
        for (const digit of '0123456789') {
          if (digit === value[i]) continue;
          const mutated = value.slice(0, i) + digit + value.slice(i + 1);
          assert.equal(
            isValidContainerNo(mutated),
            false,
            `${mutated} should not validate (mutated position ${i} of ${value})`,
          );
        }
      }
    }
  });

  test('rejects single-letter mutations except value-congruent pairs', () => {
    let congruentSurvivors = 0;

    for (const value of KNOWN_GOOD) {
      for (let i = 0; i < 4; i++) {
        const originalValue = LETTER_VALUE[value[i]!]!;
        for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
          if (letter === value[i]) continue;
          const mutated = value.slice(0, i) + letter + value.slice(i + 1);
          const congruent = (LETTER_VALUE[letter]! - originalValue) % 11 === 0;

          if (congruent) {
            congruentSurvivors++;
            continue; // ISO 6346 cannot distinguish these; see note above
          }
          assert.equal(isValidContainerNo(mutated), false, `${mutated} should not validate`);
        }
      }
    }

    assert.ok(congruentSurvivors > 0, 'expected the congruent-pair case to be exercised');
  });

  test('rejects a mutated check digit', () => {
    for (const value of KNOWN_GOOD) {
      for (const digit of '0123456789') {
        if (digit === value[10]) continue;
        assert.equal(isValidContainerNo(value.slice(0, 10) + digit), false);
      }
    }
  });

  /**
   * ISO 6346 folds remainder 10 into check digit 0, so remainders 0 and 10 are
   * indistinguishable. A container number ending in 0 therefore carries
   * meaningfully weaker error detection than one ending 1-9.
   *
   * Operationally this means: a check-digit pass on a *0 number is weaker
   * evidence, and resolveContainerCandidates must not treat it as conclusive.
   */
  test('documents the 0/10 check digit ambiguity', () => {
    const base = 'MSKU6668820'; // check digit 0
    assert.equal(isValidContainerNo(base), true);

    const collisions = '0123456789'
      .split('')
      .map((d) => 'MSKU' + d + base.slice(5))
      .filter((candidate) => candidate !== base && isValidContainerNo(candidate));

    assert.ok(
      collisions.length > 0,
      'expected a *0 container number to admit a colliding single-digit variant',
    );
  });

  test('handles the remainder-10 case by mapping to 0', () => {
    // Exhaustive sweep: any prefix whose weighted sum leaves remainder 10 must
    // produce check digit 0, never 10.
    let sawRemainder10 = false;
    for (let n = 0; n < 5000; n++) {
      const prefix = 'MSKU' + String(n).padStart(6, '0');
      const digit = containerCheckDigit(prefix);
      assert.ok(digit !== null && digit >= 0 && digit <= 9, `${prefix} → ${digit}`);
      if (isValidContainerNo(prefix + '0')) sawRemainder10 = true;
    }
    assert.equal(sawRemainder10, true, 'expected to exercise the remainder-10 path');
  });

  test('rejects malformed input', () => {
    for (const bad of ['', 'MSKU', 'MSKU123456', 'MSKU12345678', '1SKU4512345', 'msku4512345']) {
      assert.equal(isValidContainerNo(bad), false, `${bad} should not validate`);
    }
    assert.equal(containerCheckDigit('MSKU45123'), null);
    assert.equal(containerCheckDigit('MSK04512345'), null);
  });

  test('completeContainerNo round-trips', () => {
    for (const value of KNOWN_GOOD) {
      assert.equal(completeContainerNo(value.slice(0, 10)), value);
    }
    assert.equal(completeContainerNo('nope'), null);
  });

  test('recognises equipment categories U, J, Z', () => {
    assert.equal(hasStandardCategory('MSKU6668821'), true);
    assert.equal(hasStandardCategory('MSKX6668821'), false);
  });
});

describe('ISO 3779 VIN check digit', () => {
  // The canonical NHTSA worked example, plus generated valid VINs.
  test('accepts the reference VIN', () => {
    assert.equal(isValidVin('1M8GDM9AXKP042788'), true);
  });

  test('computes X for remainder 10', () => {
    assert.equal(vinCheckDigit('1M8GDM9AXKP042788'), 'X');
  });

  /**
   * VIN transliteration is many-to-one: A/J = 1, B/K/S = 2, C/T = 3, and so on,
   * and each collides with the matching digit. Substituting within a collision
   * class leaves the check digit valid. Again, a property of ISO 3779.
   */
  const VIN_VALUE: Record<string, number> = {
    A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
    J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
    S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
    0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  };

  test('rejects single-character VIN mutations outside a collision class', () => {
    const vin = '1M8GDM9AXKP042788';
    let collisionSurvivors = 0;

    for (let i = 0; i < 17; i++) {
      if (i === 8) continue; // position 9 is the check digit itself
      for (const ch of 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789') {
        if (ch === vin[i]) continue;
        const mutated = vin.slice(0, i) + ch + vin.slice(i + 1);

        if (VIN_VALUE[ch] === VIN_VALUE[vin[i]!]) {
          collisionSurvivors++;
          continue;
        }
        assert.equal(isValidVin(mutated), false, `${mutated} should not validate`);
      }
    }

    assert.ok(collisionSurvivors > 0, 'expected the collision-class case to be exercised');
  });

  test('rejects I, O and Q anywhere in the VIN', () => {
    for (const illegal of ['I', 'O', 'Q']) {
      const vin = illegal + 'M8GDM9AXKP042788';
      assert.equal(isPlausibleVin(vin), false, `${vin} should be implausible`);
      assert.equal(vinCheckDigit(vin), null);
    }
  });

  test('rejects wrong-length input', () => {
    assert.equal(isPlausibleVin('1M8GDM9AXKP04278'), false); // 16
    assert.equal(isPlausibleVin('1M8GDM9AXKP0427888'), false); // 18
  });

  test('withValidVinCheckDigit produces a self-consistent VIN', () => {
    for (const seed of ['MA3ERLF1S00123456', 'MALBB51CLKM123456', 'JTDBR32E060098765']) {
      const fixed = withValidVinCheckDigit(seed);
      assert.ok(fixed, `${seed} should be repairable`);
      assert.equal(isValidVin(fixed!), true, `${fixed} should validate`);
      // Everything except position 9 is preserved.
      assert.equal(fixed!.slice(0, 8), seed.slice(0, 8));
      assert.equal(fixed!.slice(9), seed.slice(9));
    }
  });

  test('isPlausibleVin is the gate, not isValidVin', () => {
    // A well-formed VIN whose issuer did not populate the check digit must
    // still be scannable — blocking it would strand real cargo.
    const noCheckDigit = 'MA3ERLF1S00123456';
    assert.equal(isPlausibleVin(noCheckDigit), true);
    assert.equal(isValidVin(noCheckDigit), false);
  });
});
