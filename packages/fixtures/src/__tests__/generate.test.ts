import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isValidContainerNo, isValidVin, reconcile } from '@dp/shared-rules';
import { generateReport, toCsv, assertFixtureIntegrity } from '../generate.ts';

describe('fixture generator', () => {
  const report = generateReport({ containers: 5, vehiclesPerContainer: 4 });

  test('every container number satisfies ISO 6346', () => {
    for (const line of report.lines) {
      assert.ok(isValidContainerNo(line.containerNo), `${line.containerNo} failed`);
    }
  });

  test('every VIN satisfies ISO 3779', () => {
    for (const line of report.lines) {
      assert.ok(isValidVin(line.vin), `${line.vin} failed`);
    }
  });

  test('assertFixtureIntegrity agrees', () => {
    assert.doesNotThrow(() => assertFixtureIntegrity(report));
  });

  test('VINs are unique — a duplicate would corrupt every reconciliation test', () => {
    const vins = report.lines.map((line) => line.vin);
    assert.equal(new Set(vins).size, vins.length);
  });

  test('produces the requested shape', () => {
    assert.equal(report.lines.length, 20);
    assert.equal(new Set(report.lines.map((l) => l.containerNo)).size, 5);
  });

  test('is deterministic for a given seed', () => {
    const a = generateReport({ seed: 42 });
    const b = generateReport({ seed: 42 });
    assert.deepEqual(a, b);
  });

  test('differs across seeds', () => {
    const a = generateReport({ seed: 1 });
    const b = generateReport({ seed: 2 });
    assert.notDeepEqual(a.lines[0], b.lines[0]);
  });
});

describe('fixture data drives the engine correctly', () => {
  const report = generateReport({ containers: 3, vehiclesPerContainer: 4 });
  const lines = report.lines.map((line) => ({
    id: `line-${line.lineNo}`,
    reportId: report.referenceNo,
    lineNo: line.lineNo,
    containerNo: line.containerNo,
    vin: line.vin,
    make: line.make,
    model: line.model,
    loadPosition: line.loadPosition,
  }));

  test('every booked pairing reconciles to MATCH', () => {
    for (const line of lines) {
      const result = reconcile({ containerNo: line.containerNo, vin: line.vin, lines });
      assert.equal(result.outcome, 'MATCH', `${line.vin} into ${line.containerNo}`);
      assert.equal(result.reasonCode, 'EXACT');
    }
  });

  test('every cross-container pairing is caught', () => {
    const [first, second] = [...new Set(lines.map((l) => l.containerNo))];
    const strays = lines.filter((l) => l.containerNo === second);

    for (const stray of strays) {
      const result = reconcile({ containerNo: first!, vin: stray.vin, lines });
      assert.equal(result.outcome, 'WRONG_CONTAINER', `${stray.vin} at ${first}`);
      assert.equal(result.expectedLine?.containerNo, second);
    }
  });
});

describe('CSV serialization', () => {
  const report = generateReport({ containers: 2, vehiclesPerContainer: 4 });
  const csv = toCsv(report);

  test('carries the preamble the ingest pipeline must skip', () => {
    assert.match(csv, /^Pickup Report,/);
    assert.match(csv, /Delivery Order,DO-/);
  });

  test('has one data row per vehicle plus a header', () => {
    const lines = csv.trimEnd().split('\n');
    const headerIndex = lines.findIndex((line) => line.startsWith('Sr No,'));
    assert.ok(headerIndex > 0, 'header row not found');
    assert.equal(lines.length - headerIndex - 1, report.lines.length);
  });

  test('quotes values containing commas', () => {
    // Variant names like "SX(O)" are safe, but colours and models may not be.
    for (const line of csv.split('\n')) {
      const unquotedCommas = line.replace(/"[^"]*"/g, '').split(',').length - 1;
      assert.ok(unquotedCommas <= 9, `row has too many unquoted fields: ${line}`);
    }
  });
});
