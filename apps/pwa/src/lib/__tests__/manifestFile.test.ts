import { describe, expect, it } from 'vitest'
import { kindFromBytes, MANIFEST_ACCEPT } from '../manifestFile'

const bytes = (...n: number[]) => new Uint8Array(n)
const text = (s: string) => new TextEncoder().encode(s)

describe('recognising a manifest by its content', () => {
  it('knows an xlsx by its ZIP header, whatever it is called', () => {
    // Drive hands this over as "document" with no extension at all.
    expect(kindFromBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), 'document')).toBe('xlsx')
  })

  it('knows the old binary xls, so it can say what to do about it', () => {
    expect(kindFromBytes(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))).toBe('xls')
  })

  it('treats a nameless text file as CSV', () => {
    expect(kindFromBytes(text('Container,Chassis\nTRHU8755445,MAT752389T7R20588'), ''))
      .toBe('csv')
  })

  it('reads the customer\'s real header block as CSV', () => {
    expect(kindFromBytes(text('TATA MOTORS CULVNSA2601795 20x40,,,,,\nSR,CHASSIS NO'), 'x'))
      .toBe('csv')
  })

  it('refuses a photograph rather than parsing it as a manifest', () => {
    // A phone's share sheet puts photos first, so this is a real mis-tap.
    expect(kindFromBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), 'photo.jpg'))
      .toBe('unknown')
  })

  it('keeps the separators a CSV is actually made of', () => {
    // Tabs and CRLF are structure, not corruption. Counting them as binary
    // would reject every file exported by Excel on Windows.
    const csv = new TextEncoder().encode('a\tb\r\nTRHU8755445\tMAT752389T7R20588\r\n')
    expect(kindFromBytes(csv, 'list.txt')).toBe('csv')
  })
})

describe('what the picker offers', () => {
  it('lists media types as well as extensions', () => {
    // Extensions alone leave cloud-stored files greyed out on a phone, which
    // is indistinguishable from the app being broken.
    expect(MANIFEST_ACCEPT).toContain('.xlsx')
    expect(MANIFEST_ACCEPT).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(MANIFEST_ACCEPT).toContain('text/csv')
  })
})
