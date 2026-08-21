import { describe, expect, it, vi } from 'vitest'
import { SupabaseDataSource, toVerificationResult } from '../SupabaseDataSource'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Tests the adapter, not Supabase.
 *
 * What matters here is the contract at the boundary: which arguments the RPC is
 * given, and how its response is mapped. The security of the operation is
 * asserted in supabase/tests, against a real database.
 */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const rpc = vi.fn()
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: 'u1' } } } }),
      signInWithPassword: vi.fn().mockResolvedValue({ error: null }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
    },
    rpc,
    from: vi.fn(),
    ...overrides,
  }
  return { client: client as unknown as SupabaseClient, rpc }
}

describe('verifyMovement', () => {
  it('sends only what was scanned — never the expected values or an outcome', async () => {
    const { client, rpc } = fakeClient()
    rpc.mockResolvedValue({ data: { outcome: 'MATCH', status: 'COMPLETED' }, error: null })
    const ds = new SupabaseDataSource(client)

    await ds.verifyMovement({
      assignmentId: 'a1',
      scannedContainerNo: 'CULVNSA2601795',
      scannedChassisNo: 'MAT752389T7R19810',
      movementId: 'mv1',
    })

    const [fn, args] = rpc.mock.calls[0]!
    expect(fn).toBe('verify_movement')
    expect(args).toEqual({
      p_movement_id: 'mv1',
      p_assignment_id: 'a1',
      p_scanned_container_no: 'CULVNSA2601795',
      p_scanned_chassis_no: 'MAT752389T7R19810',
      p_container_attempt_id: null,
      p_chassis_attempt_id: null,
      p_commit: true,
    })

    // The security property, asserted directly: a client that could send an
    // expected value or an outcome could make any scan pass. Attempt ids are
    // references to rows the server itself wrote, not values it will trust.
    const keys = Object.keys(args as object)
    expect(keys.some((k) => k.includes('expected'))).toBe(false)
    expect(keys.some((k) => k.includes('outcome'))).toBe(false)
    expect(keys.some((k) => k.includes('status'))).toBe(false)
  })

  it('defaults to committing, and passes a check through explicitly', async () => {
    const { client, rpc } = fakeClient()
    rpc.mockResolvedValue({ data: { outcome: 'MATCH', status: 'COMPLETED' }, error: null })
    const ds = new SupabaseDataSource(client)
    const base = {
      assignmentId: 'a1', scannedContainerNo: 'C', scannedChassisNo: 'H', movementId: 'm',
    }

    await ds.verifyMovement(base)
    expect(rpc.mock.calls[0]![1].p_commit).toBe(true)

    await ds.verifyMovement({ ...base, commit: false })
    expect(rpc.mock.calls[1]![1].p_commit).toBe(false)
  })

  it('passes the client-generated movement id through as the idempotency key', async () => {
    const { client, rpc } = fakeClient()
    rpc.mockResolvedValue({ data: { outcome: 'MATCH', status: 'COMPLETED' }, error: null })
    const ds = new SupabaseDataSource(client)
    const input = {
      assignmentId: 'a1', scannedContainerNo: 'C', scannedChassisNo: 'H', movementId: 'stable-id',
    }
    await ds.verifyMovement(input)
    await ds.verifyMovement(input)
    expect(rpc.mock.calls[0]![1].p_movement_id).toBe('stable-id')
    expect(rpc.mock.calls[1]![1].p_movement_id).toBe('stable-id')
  })
})

describe('toVerificationResult', () => {
  it('maps a completed movement', () => {
    const r = toVerificationResult({
      outcome: 'MATCH', status: 'COMPLETED', movement_id: 'm1',
      container_no: 'CULVNSA2601795', chassis_no: 'MAT752389T7R19810',
      container_filled: 1, container_capacity: 2,
    })
    expect(r).toMatchObject({
      outcome: 'MATCH', status: 'COMPLETED', movementId: 'm1',
      containerFilled: 1, containerCapacity: 2,
    })
  })

  it('maps a block, including which container the vehicle really belongs to', () => {
    const r = toVerificationResult({
      outcome: 'WRONG_VEHICLE', status: 'BLOCKED', exception_id: 'x1',
      expected_container_no: 'CULVNSA2601796', expected_chassis_no: 'MAT111222A1B00001',
      scanned_container_no: 'CULVNSA2601796', scanned_chassis_no: 'MAT752389T7R19810',
      detail: { scanned_vehicle_belongs_to_container: 'CULVNSA2601795', bay_position: 'Bay C' },
    })
    expect(r.outcome).toBe('WRONG_VEHICLE')
    expect(r.status).toBe('BLOCKED')
    expect(r.movementId).toBeUndefined()
    expect(r.scannedVehicleBelongsToContainer).toBe('CULVNSA2601795')
    expect(r.bayPosition).toBe('Bay C')
  })

  it('treats any status that is not COMPLETED as blocked', () => {
    expect(toVerificationResult({ outcome: 'CONTAINER_FULL', status: 'BLOCKED' }).status)
      .toBe('BLOCKED')
    expect(toVerificationResult({ outcome: 'REPLAY_CONFLICT', status: 'anything' }).status)
      .toBe('BLOCKED')
  })
})

describe('signIn', () => {
  it('refuses an identity that has no active profile, and clears the session', async () => {
    const { client, rpc } = fakeClient()
    rpc.mockResolvedValue({ data: null, error: null })   // me() returns null
    const ds = new SupabaseDataSource(client)

    await expect(ds.signIn('nobody@dp.test', 'pw')).rejects.toThrow(/not set up/i)
    expect(client.auth.signOut).toHaveBeenCalled()
  })

  it('returns the profile that me() reports', async () => {
    const { client, rpc } = fakeClient()
    rpc.mockResolvedValue({
      data: {
        id: 'u1', orgId: 'o1', role: 'DRIVER', fullName: 'Dev Driver',
        employeeNo: 'E-107', yards: [{ id: 'y1', code: 'NSA', name: 'Nhava Sheva' }],
      },
      error: null,
    })
    const ds = new SupabaseDataSource(client)
    const p = await ds.signIn('driver@dp.test', 'pw')
    expect(p).toMatchObject({ id: 'u1', role: 'DRIVER', yardIds: ['y1'] })
  })

  it('reports no profile when there is no session', async () => {
    const { client } = fakeClient({
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
        onAuthStateChange: vi.fn().mockReturnValue({
          data: { subscription: { unsubscribe: vi.fn() } },
        }),
      },
    })
    const ds = new SupabaseDataSource(client)
    expect(await ds.currentProfile()).toBeNull()
  })
})
