import { beforeEach, describe, expect, it } from 'vitest'
import { MockDataSource } from '../MockDataSource'

/**
 * These assert the SHAPE of the verification contract the UI is built against
 * — not the security of it. The authority is `verify_movement()` in the
 * database, tested in supabase/tests/40_verification.sql. If these two ever
 * disagree about an outcome, the database is right.
 */
describe('MockDataSource.verifyMovement', () => {
  let ds: MockDataSource

  beforeEach(() => { ds = new MockDataSource() })

  async function firstPending() {
    const all = await ds.listMyAssignments()
    return all.find((a) => a.status === 'PENDING')!
  }

  it('verifies when both values match', async () => {
    const a = await firstPending()
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-1',
    })
    expect(r.outcome).toBe('MATCH')
    expect(r.status).toBe('COMPLETED')
    expect(r.containerFilled).toBe(a.containerFilled + 1)
  })

  it('normalises case and separators before comparing', async () => {
    const a = await firstPending()
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo.toLowerCase().replace(/(.{4})/, '$1 '),
      scannedChassisNo: `${a.chassisNo.toLowerCase()}`,
      movementId: 'mv-2',
    })
    expect(r.outcome).toBe('MATCH')
  })

  it('blocks a container that belongs to another vehicle', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING')!
    const other = all.find((x) => x.containerNo !== a.containerNo)!
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: other.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-3',
    })
    expect(r.outcome).toBe('WRONG_CONTAINER')
    expect(r.status).toBe('BLOCKED')
    expect(r.movementId).toBeUndefined()
  })

  it('blocks an unknown container distinctly from a misdirected one', async () => {
    const a = await firstPending()
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: 'CULVNSA0000000',
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-4',
    })
    expect(r.outcome).toBe('CONTAINER_NOT_ON_MANIFEST')
  })

  it('names the container a misdirected vehicle actually belongs to', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING')!
    const other = all.find(
      (x) => x.containerNo !== a.containerNo && x.status === 'PENDING',
    )!
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: other.chassisNo,
      movementId: 'mv-5',
    })
    expect(r.outcome).toBe('WRONG_VEHICLE')
    expect(r.scannedVehicleBelongsToContainer).toBe(other.containerNo)
  })

  it('blocks a chassis that is on no manifest line', async () => {
    const a = await firstPending()
    const r = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: 'MAT000000X0X00000',
      movementId: 'mv-6',
    })
    expect(r.outcome).toBe('CHASSIS_NOT_ON_MANIFEST')
  })

  it('refuses to complete the same assignment twice', async () => {
    const a = await firstPending()
    const input = {
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-7',
    }
    expect((await ds.verifyMovement(input)).outcome).toBe('MATCH')
    expect((await ds.verifyMovement(input)).outcome).toBe('ALREADY_COMPLETED')
  })

  it('raises an exception for every block', async () => {
    const a = await firstPending()
    const before = (await ds.listExceptions('yard-nsa')).length
    await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: 'CULVNSA0000000',
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-8',
    })
    expect((await ds.listExceptions('yard-nsa')).length).toBe(before + 1)
  })

  it('advances container fill for every vehicle in that container', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING')!
    await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'mv-9',
    })
    const after = await ds.listMyAssignments()
    const siblings = after.filter((x) => x.containerId === a.containerId)
    expect(siblings.every((s) => s.containerFilled === a.containerFilled + 1)).toBe(true)
  })
})

describe('sequential workflow', () => {
  let ds: MockDataSource
  beforeEach(() => { ds = new MockDataSource() })

  it('blocks a vehicle whose earlier slot is still open', async () => {
    const all = await ds.listMyAssignments()
    const slot1 = all.find((a) => a.status === 'PENDING' && a.sequenceNo === 1)!
    const slot2 = all.find(
      (a) => a.containerId === slot1.containerId && a.sequenceNo === 2,
    )!

    const r = await ds.verifyMovement({
      assignmentId: slot2.id,
      scannedContainerNo: slot2.containerNo,
      scannedChassisNo: slot2.chassisNo,
      movementId: 'seq-1',
    })
    expect(r.outcome).toBe('OUT_OF_SEQUENCE')
    expect(r.status).toBe('BLOCKED')
  })

  it('a check verifies without recording anything', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING' && x.sequenceNo === 1)!

    const check = await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'chk-1',
      commit: false,
    })
    expect(check.outcome).toBe('MATCH')
    expect(check.status).toBe('READY_TO_CONFIRM')
    expect(check.movementId).toBeUndefined()

    // Nothing changed: the task is still workable and no movement exists.
    const after = await ds.getAssignment(a.id)
    expect(after?.status).toBe('PENDING')
    expect(await ds.listMyMovements()).not.toContainEqual(
      expect.objectContaining({ id: 'chk-1' }),
    )
  })

  it('confirming after a check records exactly one movement', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING' && x.sequenceNo === 1)!
    const input = {
      assignmentId: a.id,
      scannedContainerNo: a.containerNo,
      scannedChassisNo: a.chassisNo,
      movementId: 'confirm-1',
    }
    await ds.verifyMovement({ ...input, commit: false })
    const committed = await ds.verifyMovement({ ...input, commit: true })

    expect(committed.status).toBe('COMPLETED')
    expect((await ds.getAssignment(a.id))?.status).toBe('COMPLETED')
    const movements = await ds.listMyMovements()
    expect(movements.filter((m) => m.id === 'confirm-1')).toHaveLength(1)
  })

  it('a blocked check still records the block', async () => {
    const all = await ds.listMyAssignments()
    const a = all.find((x) => x.status === 'PENDING' && x.sequenceNo === 1)!
    const before = (await ds.listExceptions('yard-nsa')).length

    await ds.verifyMovement({
      assignmentId: a.id,
      scannedContainerNo: 'CULVNSA0000000',
      scannedChassisNo: a.chassisNo,
      movementId: 'blk-1',
      commit: false,
    })
    expect((await ds.listExceptions('yard-nsa')).length).toBe(before + 1)
  })
})
