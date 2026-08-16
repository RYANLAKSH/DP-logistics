import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reconcile, isContainerComplete } from '../reconcile.ts';
import type { PickupReportLine } from '../types.ts';

/**
 * Fixture: one 40ft container carrying four Swifts, a second carrying two
 * Cretas. Mirrors the shape of a real car-export pickup report.
 */
const line = (
  lineNo: number,
  containerNo: string,
  vin: string,
  extra: Partial<PickupReportLine> = {},
): PickupReportLine => ({
  id: `line-${lineNo}`,
  reportId: 'rpt-1',
  lineNo,
  containerNo,
  vin,
  make: 'Maruti Suzuki',
  model: 'Swift',
  colour: 'Pearl Arctic White',
  loadPosition: ((lineNo - 1) % 4) + 1,
  ...extra,
});

const C1 = 'TGHU7391218';
const C2 = 'HLXU8177632';

const LINES: PickupReportLine[] = [
  line(1, C1, 'MA3EJKD1S00100001'),
  line(2, C1, 'MA3EJKD1S00100002'),
  line(3, C1, 'MA3EJKD1S00100003'),
  line(4, C1, 'MA3EJKD1S00100004'),
  line(5, C2, 'MALBB51CLKM200001', { make: 'Hyundai', model: 'Creta' }),
  line(6, C2, 'MALBB51CLKM200002', { make: 'Hyundai', model: 'Creta' }),
];

const NOW = new Date('2026-08-16T09:00:00Z');
const VALID_TO = new Date('2026-08-20T23:59:59Z');

const base = { lines: LINES, now: NOW, reportValidTo: VALID_TO };

describe('reconcile — outcome table', () => {
  test('row 4: VIN assigned to the scanned container → MATCH', () => {
    const result = reconcile({ ...base, containerNo: C1, vin: 'MA3EJKD1S00100001' });

    assert.equal(result.outcome, 'MATCH');
    assert.equal(result.reasonCode, 'EXACT');
    assert.equal(result.severity, 'pass');
    assert.equal(result.matchConfidence, 1);
    assert.equal(result.matchedLine?.id, 'line-1');
    assert.deepEqual(result.progress, {
      loaded: 1,
      expected: 4,
      remainingVins: ['MA3EJKD1S00100002', 'MA3EJKD1S00100003', 'MA3EJKD1S00100004'],
    });
  });

  test('row 5: VIN belongs to a different container → WRONG_CONTAINER', () => {
    // The failure this whole system exists to catch.
    const result = reconcile({ ...base, containerNo: C1, vin: 'MALBB51CLKM200001' });

    assert.equal(result.outcome, 'WRONG_CONTAINER');
    assert.equal(result.reasonCode, 'WRONG_VEHICLE');
    assert.equal(result.severity, 'block');
    assert.equal(result.expectedLine?.containerNo, C2);
    assert.match(result.detail!, /assigned to container HLXU8177632, not TGHU7391218/);
  });

  test('row 3: container absent from the report → CONTAINER_NOT_IN_REPORT', () => {
    const result = reconcile({ ...base, containerNo: 'MSKU1000016', vin: 'MA3EJKD1S00100001' });

    assert.equal(result.outcome, 'CONTAINER_NOT_IN_REPORT');
    assert.equal(result.severity, 'block');
  });

  test('row 7: VIN absent from the report → VIN_NOT_IN_REPORT', () => {
    const result = reconcile({ ...base, containerNo: C1, vin: 'MA3EJKD1S00999999' });

    assert.equal(result.outcome, 'VIN_NOT_IN_REPORT');
    assert.equal(result.severity, 'block');
    // The officer needs to know what IS still expected.
    assert.match(result.detail!, /still expects/);
  });

  test('row 2: VIN already loaded → DUPLICATE_VIN', () => {
    const result = reconcile({
      ...base,
      containerNo: C1,
      vin: 'MA3EJKD1S00100001',
      loadedVins: ['MA3EJKD1S00100001'],
    });

    assert.equal(result.outcome, 'DUPLICATE_VIN');
    assert.equal(result.severity, 'block');
  });

  test('row 6: container at full complement, unknown VIN → CONTAINER_FULL', () => {
    const result = reconcile({
      ...base,
      containerNo: C2,
      vin: 'MA3EJKD1S00999999',
      loadedVins: ['MALBB51CLKM200001', 'MALBB51CLKM200002'],
    });

    assert.equal(result.outcome, 'CONTAINER_FULL');
    assert.equal(result.severity, 'block');
  });

  test('row 1: expired report → EXPIRED_REPORT', () => {
    const result = reconcile({
      ...base,
      containerNo: C1,
      vin: 'MA3EJKD1S00100001',
      now: new Date('2026-08-25T09:00:00Z'),
    });

    assert.equal(result.outcome, 'EXPIRED_REPORT');
    assert.equal(result.severity, 'block');
  });

  test('row 0: incomplete pair → PENDING', () => {
    assert.equal(reconcile({ ...base, containerNo: '', vin: 'MA3EJKD1S00100001' }).outcome, 'PENDING');
    assert.equal(reconcile({ ...base, containerNo: C1, vin: '' }).outcome, 'PENDING');
    // Each prompts for the scan that is actually missing.
    assert.match(reconcile({ ...base, containerNo: '', vin: 'X' }).message, /container/i);
    assert.match(reconcile({ ...base, containerNo: C1, vin: '' }).message, /VIN/i);
  });
});

describe('reconcile — rule ordering is part of the contract', () => {
  test('expiry outranks a duplicate VIN', () => {
    const result = reconcile({
      ...base,
      containerNo: C1,
      vin: 'MA3EJKD1S00100001',
      loadedVins: ['MA3EJKD1S00100001'],
      now: new Date('2026-08-25T09:00:00Z'),
    });
    assert.equal(result.outcome, 'EXPIRED_REPORT');
  });

  test('duplicate VIN outranks an unknown container', () => {
    const result = reconcile({
      ...base,
      containerNo: 'MSKU1000016',
      vin: 'MA3EJKD1S00100001',
      loadedVins: ['MA3EJKD1S00100001'],
    });
    assert.equal(result.outcome, 'DUPLICATE_VIN');
  });

  test('unknown container outranks wrong-container', () => {
    // Both conditions hold; the container check must win, because "this
    // container is not on the report" is the more actionable instruction.
    const result = reconcile({ ...base, containerNo: 'MSKU1000016', vin: 'MALBB51CLKM200001' });
    assert.equal(result.outcome, 'CONTAINER_NOT_IN_REPORT');
  });
});

describe('reconcile — input tolerance', () => {
  test('normalizes separators and case on both identifiers', () => {
    const result = reconcile({
      ...base,
      containerNo: ' tghu 739121-8 ',
      vin: 'ma3ejkd1s00-100001',
    });
    assert.equal(result.outcome, 'MATCH');
  });

  test('resolves I and O misreads in the VIN', () => {
    // OCR read 1 as I and 0 as O; both are illegal in a VIN, so the
    // substitution is unambiguous.
    const result = reconcile({ ...base, containerNo: C1, vin: 'MA3EJKDIS0O1OOOO1' });
    assert.equal(result.outcome, 'MATCH');
    assert.equal(result.reasonCode, 'EXACT');
  });
});

describe('reconcile — fuzzy VIN matching', () => {
  test('accepts a single-character misread as a fuzzy match', () => {
    const result = reconcile({ ...base, containerNo: C1, vin: 'MA3EJKD1S00100081' });

    assert.equal(result.outcome, 'MATCH');
    assert.equal(result.reasonCode, 'FUZZY_VIN');
    assert.ok(result.matchConfidence < 1);
    // The officer must be told the read was corrected.
    assert.match(result.detail!, /confirm the label/i);
  });

  test('refuses to auto-resolve an ambiguous fuzzy match', () => {
    // Equidistant from two real vehicles — guessing would load the wrong car.
    const ambiguous = [
      line(1, C1, 'MA3EJKD1S00100001'),
      line(2, C1, 'MA3EJKD1S00100002'),
    ];
    const result = reconcile({
      ...base,
      lines: ambiguous,
      containerNo: C1,
      vin: 'MA3EJKD1S0010000X',
    });

    assert.notEqual(result.outcome, 'MATCH');
  });

  test('a far-off read is not force-fitted to any line', () => {
    const result = reconcile({ ...base, containerNo: C1, vin: 'JTDBR32E600098765' });
    assert.equal(result.outcome, 'VIN_NOT_IN_REPORT');
  });

  test('fuzzy matching still detects the wrong container', () => {
    // One character off a Creta VIN, scanned at the Swift container.
    const result = reconcile({ ...base, containerNo: C1, vin: 'MALBB51CLKM200081' });
    assert.equal(result.outcome, 'WRONG_CONTAINER');
    assert.equal(result.expectedLine?.containerNo, C2);
  });
});

describe('isContainerComplete', () => {
  test('false until every assigned vehicle is aboard', () => {
    assert.equal(isContainerComplete(C2, LINES, ['MALBB51CLKM200001']), false);
    assert.equal(
      isContainerComplete(C2, LINES, ['MALBB51CLKM200001', 'MALBB51CLKM200002']),
      true,
    );
  });

  test('false for a container with no assigned lines', () => {
    assert.equal(isContainerComplete('MSKU1000016', LINES, []), false);
  });
});
