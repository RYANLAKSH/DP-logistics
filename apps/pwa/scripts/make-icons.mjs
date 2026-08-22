// Generates the PWA icons as real PNGs with no image dependencies.
// A dark plate with a light container outline and a check mark.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

// Brand palette, from the RYLA mark.
const BG = [27, 49, 73]      // #1B3149 navy
const FG = [245, 130, 32]    // #F58220 orange accent
const LINE = [255, 255, 255] // wordmark

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
  // A bold R with the orange accent slash beneath it — the RYLA mark reduced
  // to what still reads at 192 pixels on a home screen.
  const px = (x, y) => {
    const u = x / size, v = y / size

    // R: stem, bowl, counter, leg.
    const inStem = u >= 0.20 && u <= 0.34 && v >= 0.25 && v <= 0.75
    const inBowl = u > 0.34 && u <= 0.68 && v >= 0.25 && v <= 0.50
    const inCounter = u > 0.34 && u <= 0.60 && v > 0.335 && v <= 0.415
    // Leg: a diagonal band from the bowl down to the baseline.
    const legT = (v - 0.50) / 0.25
    const legX = 0.40 + legT * 0.24
    const inLeg = v > 0.50 && v <= 0.75 && Math.abs(u - legX) < 0.075

    if ((inStem || (inBowl && !inCounter) || inLeg)) return LINE

    // The accent, bottom right.
    const ax = u - 0.66, ay = v - 0.78
    if (ay > -0.10 && ay < 0.10 && Math.abs(ax + ay * 0.55) < 0.075) return FG

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
