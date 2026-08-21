import { describe, expect, it } from 'vitest'
import { CsvTooLargeError, detectDelimiter, parseCsv, parseDelimited } from '../csv.ts'

describe('parseCsv', () => {
  it('parses a plain file', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('strips the UTF-8 BOM Excel writes', () => {
    // Without this the first header never matches and every mapping fails.
    expect(parseCsv('﻿Container,Chassis\nA,B')[0]).toEqual(['Container', 'Chassis'])
  })

  it('handles CRLF and a trailing newline without a phantom row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']])
  })

  it('handles escaped quotes', () => {
    expect(parseCsv('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('handles a newline inside a quoted field', () => {
    expect(parseCsv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']])
  })

  it('preserves empty fields rather than collapsing them', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
  })

  it('refuses a file that is absurdly large', () => {
    const huge = Array.from({ length: 20 }, () => 'a,b').join('\n')
    expect(() => parseCsv(huge, { maxRows: 5 })).toThrow(CsvTooLargeError)
  })
})

describe('detectDelimiter', () => {
  it('finds semicolons and tabs, which European exports use', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\tc')).toBe('\t')
    expect(detectDelimiter('a,b,c')).toBe(',')
  })

  it('defaults to comma for a single column', () => {
    expect(detectDelimiter('Container')).toBe(',')
  })
})

describe('parseDelimited', () => {
  it('parses semicolon files without breaking quoted commas', () => {
    expect(parseDelimited('a;"b,c";d')).toEqual([['a', 'b,c', 'd']])
  })
})
