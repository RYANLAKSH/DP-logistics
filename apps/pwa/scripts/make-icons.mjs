// Generates the PWA icons as real PNGs with no image dependencies.
// A dark plate with a light container outline and a check mark.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const BG = [11, 18, 32]
const FG = [56, 217, 169]
const LINE = [233, 238, 245]

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = c ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function png(size, path) {
  const px = (x, y) => {
    const u = x / size, v = y / size
    // container body
    const inBody = u > 0.16 && u < 0.84 && v > 0.30 && v < 0.72
    const border = inBody && (u < 0.19 || u > 0.81 || v < 0.33 || v > 0.69)
    // corrugation ribs
    const rib = inBody && !border && Math.floor((u - 0.19) * 26) % 3 === 0
    // check mark
    const cx = u - 0.50, cy = v - 0.52
    const check =
      (Math.abs(cy - (-0.9 * cx)) < 0.035 && cx > -0.02 && cx < 0.16) ||
      (Math.abs(cy - (1.1 * cx)) < 0.035 && cx > -0.14 && cx < -0.01)
    if (check) return FG
    if (border) return LINE
    if (rib) return [30, 41, 59]
    if (inBody) return [17, 26, 43]
    return BG
  }

  const raw = Buffer.alloc(size * (size * 3 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = px(x, y)
      raw[o++] = r; raw[o++] = g; raw[o++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]))
}

png(192, 'public/icon-192.png')
png(512, 'public/icon-512.png')
console.log('icons written')
