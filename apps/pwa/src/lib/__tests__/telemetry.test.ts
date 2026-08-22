import { describe, expect, it } from 'vitest'
import { scrubPath } from '../telemetry'

/**
 * An error report must not become a second, unaudited copy of the manifest.
 *
 * The route pattern says what broke. The identifiers in it say which vehicle
 * went where, which is exactly the information the audit log exists to hold
 * under access control — and an error sink has none.
 */
describe('what leaves the device in an error report', () => {
  it('keeps the route and drops the assignment id', () => {
    expect(scrubPath('/driver/pickup/8f2c1a90-1111-4222-8333-444455556666/scan/chassis'))
      .toBe('/driver/pickup/:id/scan/chassis')
  })

  it('drops a container number', () => {
    expect(scrubPath('/manager/container/TRHU8755445')).toBe('/manager/container/:id')
  })

  it('drops a chassis number', () => {
    expect(scrubPath('/manager/vehicle/MAT752389T7R20588')).toBe('/manager/vehicle/:id')
  })

  it('drops the short ids the mock and the RPCs hand out', () => {
    expect(scrubPath('/manager/manifests/import/imp-4f9a2b1c'))
      .toBe('/manager/manifests/import/:id')
  })

  it('redacts an id shape nobody anticipated', () => {
    // The point of an allowlist: this is not a format the code knows about,
    // and it is removed anyway.
    expect(scrubPath('/manager/thing/WHATEVER_2027_FORMAT.9'))
      .toBe('/manager/thing/:id')
  })

  it('keeps the error pages, which are routes rather than records', () => {
    expect(scrubPath('/403')).toBe('/403')
  })

  it('leaves a route with nothing identifying in it alone', () => {
    expect(scrubPath('/manager/exceptions')).toBe('/manager/exceptions')
    expect(scrubPath('/driver/sync')).toBe('/driver/sync')
  })

  it('handles the hash routing the hosted demo uses', () => {
    expect(scrubPath('/#/driver/pickup/a-man-x7/result'))
      .toBe('/#/driver/pickup/:id/result')
  })

  it('keeps multi-word route segments', () => {
    expect(scrubPath('/manager/shift-report')).toBe('/manager/shift-report')
  })
})
