/**
 * Just enough ZIP to open a spreadsheet in the browser.
 *
 * An .xlsx is a ZIP of XML. The alternative to these ~90 lines is a 400 KB
 * dependency, and the one everyone reaches for carries prototype-pollution and
 * ReDoS advisories on npm — which is why the server path loads it from its own
 * CDN instead. Neither is available to a page that must be a single file, so
 * the browser's own inflate does the work.
 *
 * Deliberately narrow: it reads the central directory, and it handles the two
 * compression methods a spreadsheet actually uses — stored and deflate.
 * Anything else is an error rather than a guess.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50

export interface ZipEntry {
  name: string
  offset: number
  compressedSize: number
  uncompressedSize: number
  method: number
}

export function readCentralDirectory(buf: DataView): Map<string, ZipEntry> {
  // The end-of-central-directory record is last, but a trailing comment can
  // push it back by up to 64 KB, so it is searched for rather than assumed.
  let eocd = -1
  const min = Math.max(0, buf.byteLength - 65_557)
  for (let i = buf.byteLength - 22; i >= min; i--) {
    if (buf.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('That file is not a spreadsheet: no ZIP directory in it.')

  const count = buf.getUint16(eocd + 10, true)
  let p = buf.getUint32(eocd + 16, true)

  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (buf.getUint32(p, true) !== CENTRAL_SIGNATURE) break
    const method = buf.getUint16(p + 10, true)
    const compressedSize = buf.getUint32(p + 20, true)
    const uncompressedSize = buf.getUint32(p + 24, true)
    const nameLen = buf.getUint16(p + 28, true)
    const extraLen = buf.getUint16(p + 30, true)
    const commentLen = buf.getUint16(p + 32, true)
    const offset = buf.getUint32(p + 42, true)
    const name = decoder.decode(
      new Uint8Array(buf.buffer, buf.byteOffset + p + 46, nameLen))
    entries.set(name, { name, offset, compressedSize, uncompressedSize, method })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export async function readEntry(
  bytes: Uint8Array, buf: DataView, entry: ZipEntry,
): Promise<string> {
  // The local header repeats the name and extra lengths, and the extra field
  // is routinely a different length from the central one — so the data offset
  // has to be read from the local header, not computed from the central.
  const local = entry.offset
  const nameLen = buf.getUint16(local + 26, true)
  const extraLen = buf.getUint16(local + 28, true)
  const start = local + 30 + nameLen + extraLen
  const raw = bytes.subarray(start, start + entry.compressedSize)

  if (entry.method === 0) return new TextDecoder().decode(raw)
  if (entry.method !== 8) {
    throw new Error(`That spreadsheet uses an unsupported compression method (${entry.method}).`)
  }

  // Built from a ReadableStream rather than a Blob, and drained by hand rather
  // than through Response: both of those exist in every browser but only
  // partially under jsdom, and a reader that cannot be unit-tested is a reader
  // whose first real test is a manager's morning.
  // Copied into its own buffer before it is handed over. The subarray above
  // is a view onto the whole file, and a decompressor is entitled to keep the
  // buffer it was given.
  const chunk = new Uint8Array(raw.length)
  chunk.set(raw)

  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(chunk)
      controller.close()
    },
  })
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'))

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }

  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder().decode(out)
}
