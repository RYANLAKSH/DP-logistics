/**
 * Evidence image preparation: compress, measure, hash.
 *
 * The hash is computed on the device BEFORE upload and sent with the scan
 * metadata. The server then checks the bytes that actually arrive against it.
 * That ordering is the whole point — a hash computed after the fact would only
 * ever describe whatever was uploaded, and would prove nothing.
 *
 * Compression matters more than it looks: officers work a full shift on one
 * charge over a weak connection, and a 4 MB original per scan is what turns a
 * day's evidence into a queue that never drains.
 */

import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';

import { base64ToBytes, bytesToHex } from './imageCodec.ts';

/** Long edge, in pixels. Comfortably enough to re-read a plate by eye. */
export const TARGET_LONG_EDGE = 1600;

/** JPEG quality. Above ~0.85 the file grows fast for no legibility gain. */
export const JPEG_QUALITY = 0.8;

export const EVIDENCE_CONTENT_TYPE = 'image/jpeg';

export interface PreparedImage {
  /** Local file URI of the compressed image — this is what gets uploaded. */
  uri: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

/**
 * Compresses a captured photo and hashes the result.
 *
 * Hashing happens on the FINAL bytes, after compression. Hashing the original
 * would guarantee a mismatch on every upload.
 */
export async function prepareEvidenceImage(sourceUri: string): Promise<PreparedImage> {
  const compressed = await ImageManipulator.manipulateAsync(
    sourceUri,
    [{ resize: { width: TARGET_LONG_EDGE } }],
    { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG },
  );

  const info = await FileSystem.getInfoAsync(compressed.uri, { size: true });
  if (!info.exists) throw new Error('compressed image is missing');

  const base64 = await FileSystem.readAsStringAsync(compressed.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const bytes = base64ToBytes(base64);
  const digestBytes = new Uint8Array(bytes);
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    digestBytes,
  );
  return {
    uri: compressed.uri,
    sha256: bytesToHex(digest),
    // Trust the decoded length over the filesystem's report; it is what the
    // server will actually count.
    bytes: bytes.length,
    contentType: EVIDENCE_CONTENT_TYPE,
  };
}

/** Removes a local evidence file once the server has verified its copy. */
export async function discardLocalImage(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // A leftover file is harmless; failing a verified upload over it is not.
  }
}
