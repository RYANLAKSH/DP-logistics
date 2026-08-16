/**
 * Tests for the OCR interpretation layer.
 *
 * This is the part of the mobile app that carries real logic, and it has no
 * React Native dependency, so it runs under plain node. The screens are not
 * covered here — they need a device or emulator.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { interpret, MockOcrProvider } from '../lib/ocr.ts';

/** A realistic container door plate: the number plus type code and weights. */
const CONTAINER_PLATE = `
  TGHU 739121 8
  45G1
  MAX GROSS 32,500 KG
  TARE 3,750 KG
`;

/** A realistic B-pillar door jamb label. */
const DOOR_JAMB_LABEL = `
  MARUTI SUZUKI INDIA LIMITED
  MFD BY: GURUGRAM HARYANA
  DATE OF MFG 03/2026
  VIN MA3EJKD1S00100001
  GVW 1450 KG
  FRONT 185/65R15  REAR 185/65R15
`;

describe('container interpretation', () => {
  test('reads a clean plate and marks it exact', () => {
    const result = interpret(CONTAINER_PLATE, 'container');

    assert.equal(result.value, 'TGHU7391218');
    assert.equal(result.exact, true);
    assert.ok(result.confidence > 0.95);
    assert.equal(result.needsConfirmation, false);
  });

  test('keeps the raw text for the evidence record', () => {
    const result = interpret(CONTAINER_PLATE, 'container');
    assert.equal(result.rawText, CONTAINER_PLATE);
  });

  test('recovers a misread and flags it for confirmation', () => {
    // 7 read as T, 1 read as I — the check digit confirms the repair.
    const result = interpret('7GHU739I2I8 45G1', 'container');

    assert.equal(result.value, 'TGHU7391218');
    assert.equal(result.exact, false);
    assert.equal(result.needsConfirmation, true);
  });

  test('refuses to choose when two plates are in frame', () => {
    const result = interpret('TGHU7391218 and HLXU8177632', 'container');

    assert.equal(result.value, null);
    assert.equal(result.needsConfirmation, true);
    assert.equal(result.candidates.length, 2);
  });

  test('flags a check-digit-ambiguous number even when it validates', () => {
    // MSKU6668820 ends in 0 — the weaker 0/10 collision class.
    const result = interpret('MSKU6668820', 'container');

    assert.equal(result.value, 'MSKU6668820');
    assert.equal(result.exact, true);
    assert.equal(result.needsConfirmation, true, 'a *0 number must not auto-accept');
  });

  test('returns nothing usable from an unreadable plate', () => {
    const result = interpret('MAX GROSS 32,500 KG TARE 3,750 KG', 'container');
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  test('handles empty input without throwing', () => {
    assert.equal(interpret('', 'container').value, null);
    assert.equal(interpret('   ', 'container').value, null);
  });
});

describe('VIN interpretation', () => {
  test('reads the VIN off a door jamb label', () => {
    const result = interpret(DOOR_JAMB_LABEL, 'vin');
    assert.equal(result.value, 'MA3EJKD1S00100001');
  });

  test('always requires confirmation', () => {
    // A VIN has no dependable check digit outside North America, so a read is
    // never better than "correctly shaped".
    const result = interpret(DOOR_JAMB_LABEL, 'vin');
    assert.equal(result.needsConfirmation, true);
    assert.ok(result.confidence < 0.8);
  });

  test('normalizes the characters illegal in a VIN', () => {
    const result = interpret('VIN MA3EJKDIS0O1OOOO1', 'vin');
    assert.equal(result.value, 'MA3EJKD1S00100001');
  });

  test('does not invent a VIN from surrounding label text', () => {
    const result = interpret('GVW 1450 KG FRONT 185/65R15 REAR 185/65R15', 'vin');
    assert.equal(result.value, null);
  });
});

describe('MockOcrProvider', () => {
  test('replays queued label text so the flow runs without a native build', async () => {
    const provider = new MockOcrProvider();
    provider.queue(CONTAINER_PLATE, DOOR_JAMB_LABEL);

    const container = await provider.recognize('file://fake.jpg', 'container');
    assert.equal(container.value, 'TGHU7391218');

    const vin = await provider.recognize('file://fake.jpg', 'vin');
    assert.equal(vin.value, 'MA3EJKD1S00100001');
  });

  test('returns an empty read once the queue is drained', async () => {
    const provider = new MockOcrProvider();
    const result = await provider.recognize('file://fake.jpg', 'container');
    assert.equal(result.value, null);
  });
});
