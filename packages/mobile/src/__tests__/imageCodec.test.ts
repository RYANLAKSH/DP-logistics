/**
 * Tests for the pure half of image preparation.
 *
 * base64ToBytes has to be exactly right: the device hashes its output and the
 * server hashes the bytes it receives. A decoder that is subtly wrong would make
 * every single upload fail verification, and it would look like a network
 * problem rather than a decoding one.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

import { base64ToBytes, bytesToHex } from '../lib/imageCodec.ts';

describe('base64ToBytes', () => {
  test('matches Node for every input length up to 512 bytes', () => {
    // Padding handling is where hand-rolled decoders go wrong, so sweep every
    // length modulo 3 rather than spot-checking.
    for (let length = 0; length <= 512; length++) {
      const expected = randomBytes(length);
      const decoded = base64ToBytes(expected.toString('base64'));

      assert.equal(decoded.length, expected.length, `length ${length}`);
      assert.deepEqual(Buffer.from(decoded), expected, `payload at length ${length}`);
    }
  });

  test('produces the same SHA-256 as hashing the original bytes', () => {
    // This is the property the whole upload path depends on.
    for (const length of [1, 2, 3, 100, 1023, 4096]) {
      const original = randomBytes(length);
      const decoded = base64ToBytes(original.toString('base64'));

      assert.equal(
        bytesToHex(new Uint8Array(createHash('sha256').update(decoded).digest())),
        createHash('sha256').update(original).digest('hex'),
        `hash mismatch at length ${length}`,
      );
    }
  });

  test('handles the full byte range, including nulls and high bytes', () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    assert.deepEqual(Buffer.from(base64ToBytes(all.toString('base64'))), all);
  });

  test('tolerates embedded newlines, as file readers sometimes emit', () => {
    const original = randomBytes(300);
    const wrapped = original.toString('base64').replace(/(.{40})/g, '$1\n');

    assert.deepEqual(Buffer.from(base64ToBytes(wrapped)), original);
  });

  test('decodes both padding cases correctly', () => {
    assert.deepEqual(Buffer.from(base64ToBytes('QQ==')), Buffer.from('A'));   // 2 pad
    assert.deepEqual(Buffer.from(base64ToBytes('QUI=')), Buffer.from('AB'));  // 1 pad
    assert.deepEqual(Buffer.from(base64ToBytes('QUJD')), Buffer.from('ABC')); // none
  });

  test('rejects input that is not base64 rather than returning wrong bytes', () => {
    // Silently decoding rubbish would surface later as an unexplained hash
    // mismatch, which is far harder to diagnose than a throw here.
    assert.throws(() => base64ToBytes('!!!!'), /invalid base64/);
  });

  test('returns an empty array for empty input', () => {
    assert.equal(base64ToBytes('').length, 0);
  });
});

describe('bytesToHex', () => {
  test('matches Node hex encoding', () => {
    const bytes = randomBytes(64);
    assert.equal(bytesToHex(new Uint8Array(bytes)), bytes.toString('hex'));
  });

  test('zero-pads single-digit bytes', () => {
    assert.equal(bytesToHex(new Uint8Array([0, 1, 15, 16, 255])), '00010f10ff');
  });

  test('accepts an ArrayBuffer, as returned by expo-crypto digest', () => {
    const bytes = randomBytes(32);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    assert.equal(bytesToHex(arrayBuffer as ArrayBuffer), bytes.toString('hex'));
  });

  test('produces the lowercase form the API compares against', () => {
    const hex = bytesToHex(new Uint8Array([0xab, 0xcd, 0xef]));
    assert.equal(hex, 'abcdef');
    assert.equal(hex, hex.toLowerCase());
  });
});
