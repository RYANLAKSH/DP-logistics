/**
 * Base64 and hex codecs for evidence hashing.
 *
 * Deliberately free of any native dependency so it can be unit-tested on plain
 * node. That matters here more than usual: the device hashes this module's
 * output and the server hashes the bytes it receives, so a subtly wrong decoder
 * would fail every upload while looking like a network fault.
 */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Decodes base64 to bytes.
 *
 * Hand-rolled rather than relying on `atob`, which is present on Hermes but not
 * guaranteed across every React Native runtime this might ship on. It also has
 * to be exact: hashing the base64 TEXT instead of the decoded bytes would
 * produce a digest the server can never reproduce.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\r\n\s]/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const length = (clean.length / 4) * 3 - padding;

  const out = new Uint8Array(length);
  let outIndex = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const a = BASE64_LOOKUP[clean.charCodeAt(i)]!;
    const b = BASE64_LOOKUP[clean.charCodeAt(i + 1)]!;
    const c = BASE64_LOOKUP[clean.charCodeAt(i + 2)]!;
    const d = BASE64_LOOKUP[clean.charCodeAt(i + 3)]!;

    if (a < 0 || b < 0) throw new Error('invalid base64 input');

    const chunk = (a << 18) | (b << 12) | ((c < 0 ? 0 : c) << 6) | (d < 0 ? 0 : d);

    if (outIndex < length) out[outIndex++] = (chunk >> 16) & 0xff;
    if (outIndex < length) out[outIndex++] = (chunk >> 8) & 0xff;
    if (outIndex < length) out[outIndex++] = chunk & 0xff;
  }
  return out;
}

/** Lowercase hex, which is the form the API expects and compares against. */
export function bytesToHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

