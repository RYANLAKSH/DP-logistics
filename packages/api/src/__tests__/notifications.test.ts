/**
 * Server-side rate limiting on outbound reconciliation notification email.
 *
 * A bad pickup-report import (or a scripted client hitting /v1/sync/scans
 * directly) can produce many reconciliation events in a short window. This
 * proves that low-priority events get batched into a cooldown per
 * (org, location, event type) rather than sent one-for-one, that
 * high-priority events are never subject to it, that the isolation
 * boundaries hold, and that the resulting DB state stays auditable.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Transporter } from 'nodemailer';

import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { seed, type SeedResult } from '../lib/seed.ts';
import {
  sendNotification, setTransport, BATCH_WINDOW_MINUTES, type EventType,
} from '../lib/notifications.ts';

let db: Db;
let fixture: SeedResult;
let officerId: string;
let sentCount = 0;

// A fresh database per test, not once for the file: these tests deliberately
// reuse the same (org, location, event type) keys across tests to prove
// isolation *within* a test, and the cooldown is wall-clock-windowed — a
// shared database would let one test's real send leave a later test's
// identical key still "recently sent" minutes later, which is a test
// ordering hazard, not the property under test.
beforeEach(() => {
  db = openDb(':memory:');
  fixture = seed(db);
  officerId = String(
    (db.prepare(`SELECT id FROM users WHERE role = 'field_officer'`).get() as { id: string }).id,
  );

  sentCount = 0;
  setTransport({
    sendMail: async () => {
      sentCount++;
      return { messageId: `test-${sentCount}` };
    },
  } as unknown as Transporter);
});

/** Registers one active recipient for an event type, at a location or org-wide. */
function addRecipient(orgId: string, eventType: EventType, email: string, locationId?: string | null): void {
  db.prepare(
    `INSERT INTO notification_recipients (id, org_id, event_type, location_id, email, is_active)
     VALUES (?,?,?,?,?,1)`,
  ).run(newId(), orgId, eventType, locationId ?? null, email);
}

/**
 * A minimal, valid scan_session + reconciliation pair so sendNotification's
 * cooldown lookup (which joins through reconciliation_id) has something real
 * to join against — exactly the shape the real reconciliation flow produces.
 */
function fakeReconciliation(orgId: string, locationId: string): string {
  const sessionId = newId();
  db.prepare(
    `INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(sessionId, orgId, officerId, locationId, nowIso(), nowIso());

  const reconciliationId = newId();
  db.prepare(
    `INSERT INTO reconciliations
       (id, org_id, session_id, container_no, vin, outcome, reason_code, severity,
        officer_id, message, reconciled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(reconciliationId, orgId, sessionId, 'MSKU1234567', '1HGCM82633A123456',
        'MATCH', 'OK', 'info', officerId, 'test event', nowIso());

  return reconciliationId;
}

async function fireEvent(
  orgId: string, locationId: string, eventType: EventType,
): Promise<{ id: string; status: string }> {
  const reconciliationId = fakeReconciliation(orgId, locationId);
  return sendNotification(db, orgId, {
    eventType, reconciliationId, subject: `subject ${eventType}`, body: 'body',
  }, locationId);
}

describe('notification rate limiting', () => {
  test('Test 1 — repeated low-priority events to the same org/recipient/type are batched, not sent one-for-one', async () => {
    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'MATCH', 'ops-t1@dp-logistics.example', locationId);

    const results = [];
    for (let i = 0; i < 5; i++) results.push(await fireEvent(orgId, locationId, 'MATCH'));

    assert.equal(results[0]!.status, 'sent');
    for (let i = 1; i < 5; i++) assert.equal(results[i]!.status, 'batched');
    assert.equal(sentCount, 1, 'only the first of 5 MATCH events should have actually sent mail');

    const rows = db.prepare(
      `SELECT status, COUNT(*) AS n FROM notifications WHERE event_type = 'MATCH' GROUP BY status`,
    ).all() as { status: string; n: number }[];
    assert.equal(rows.find((r) => r.status === 'sent')?.n, 1);
    assert.equal(rows.find((r) => r.status === 'batched')?.n, 4);
  });

  test('Test 2 — recipient isolation: a different recipient at a different location is unaffected', async () => {
    const orgId = fixture.orgId;

    // A second location in the same org, with its own recipient.
    const otherLocationId = newId();
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
      .run(otherLocationId, orgId, 'OTHERLOC', 'Other Location');
    addRecipient(orgId, 'MATCH', 'ops-a@dp-logistics.example', fixture.locationId);
    addRecipient(orgId, 'MATCH', 'ops-b@dp-logistics.example', otherLocationId);

    // Flood location A into its cooldown.
    await fireEvent(orgId, fixture.locationId, 'MATCH');
    const suppressedAtA = await fireEvent(orgId, fixture.locationId, 'MATCH');
    assert.equal(suppressedAtA.status, 'batched');

    // Location B, same org, same event type, different recipient — must still send.
    const atB = await fireEvent(orgId, otherLocationId, 'MATCH');
    assert.equal(atB.status, 'sent');
  });

  test('Test 3 — organization isolation: one org in cooldown does not suppress another org', async () => {
    const orgAId = fixture.orgId;

    const orgBId = newId();
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
      .run(orgBId, 'Other Org', nowIso());
    const orgBLocationId = newId();
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
      .run(orgBLocationId, orgBId, 'OTHERORG', 'Other Org Location');

    addRecipient(orgAId, 'MATCH', 'ops-orga@dp-logistics.example', fixture.locationId);
    addRecipient(orgBId, 'MATCH', 'ops-orgb@dp-logistics.example', orgBLocationId);

    await fireEvent(orgAId, fixture.locationId, 'MATCH');
    const suppressedInA = await fireEvent(orgAId, fixture.locationId, 'MATCH');
    assert.equal(suppressedInA.status, 'batched');

    const inOrgB = await fireEvent(orgBId, orgBLocationId, 'MATCH');
    assert.equal(inOrgB.status, 'sent');
  });

  test('Test 4 — event-type isolation: MATCH cooldown does not suppress CONTAINER_NOT_IN_REPORT', async () => {
    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'MATCH', 'ops-t4@dp-logistics.example', locationId);
    addRecipient(orgId, 'CONTAINER_NOT_IN_REPORT', 'ops-t4@dp-logistics.example', locationId);

    await fireEvent(orgId, locationId, 'MATCH');
    const suppressedMatch = await fireEvent(orgId, locationId, 'MATCH');
    assert.equal(suppressedMatch.status, 'batched');

    // A different, independently-tracked low-priority event type must still send.
    const otherType = await fireEvent(orgId, locationId, 'CONTAINER_NOT_IN_REPORT');
    assert.equal(otherType.status, 'sent');
  });

  test('Test 5 — a high-priority event sends immediately even while the low-priority window is active', async () => {
    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'MATCH', 'ops-t5@dp-logistics.example', locationId);
    addRecipient(orgId, 'WRONG_CONTAINER', 'supervisor-t5@dp-logistics.example', locationId);

    await fireEvent(orgId, locationId, 'MATCH');
    const suppressedMatch = await fireEvent(orgId, locationId, 'MATCH');
    assert.equal(suppressedMatch.status, 'batched');

    // High-priority, same org/location, same active low-priority storm — must not be delayed.
    const first = await fireEvent(orgId, locationId, 'WRONG_CONTAINER');
    assert.equal(first.status, 'sent');
    const second = await fireEvent(orgId, locationId, 'WRONG_CONTAINER');
    assert.equal(second.status, 'sent', 'high-priority events are never subject to the cooldown, even repeated');
    assert.equal(sentCount, 3, '1 MATCH + 2 WRONG_CONTAINER actually sent');
  });

  test('Test 6 — a lone, non-repeated event still sends exactly as before', async () => {
    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'VIN_NOT_IN_REPORT', 'ops-t6@dp-logistics.example', locationId);

    const result = await fireEvent(orgId, locationId, 'VIN_NOT_IN_REPORT');
    assert.equal(result.status, 'sent');
    assert.equal(sentCount, 1);
  });

  test('Test 7 — a real delivery failure is recorded as failed, never confused with batched', async () => {
    setTransport({
      sendMail: async () => { throw new Error('SMTP connection refused'); },
    } as unknown as Transporter);

    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'CONTAINER_NOT_IN_REPORT', 'ops-t7@dp-logistics.example', locationId);

    const result = await fireEvent(orgId, locationId, 'CONTAINER_NOT_IN_REPORT');
    assert.equal(result.status, 'failed');

    const row = db.prepare(
      `SELECT status, error FROM notifications WHERE id = ?`,
    ).get(result.id) as { status: string; error: string };
    assert.equal(row.status, 'failed');
    assert.match(row.error, /SMTP connection refused/);

    // A failure still opens the cooldown (an attempt was made) — the very
    // next same-key event is batched, not sent again into a broken transport.
    const next = await fireEvent(orgId, locationId, 'CONTAINER_NOT_IN_REPORT');
    assert.equal(next.status, 'batched');
  });

  test('Test 8 — a batched notification remains fully auditable via the existing notifications table', async () => {
    const orgId = fixture.orgId;
    const locationId = fixture.locationId;
    addRecipient(orgId, 'MATCH', 'ops-t8@dp-logistics.example', locationId);

    await fireEvent(orgId, locationId, 'MATCH');
    const batched = await fireEvent(orgId, locationId, 'MATCH');
    assert.equal(batched.status, 'batched');

    // Exactly what /v1/admin/notifications exposes: SELECT * ... no status filter.
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(batched.id) as Record<string, unknown>;
    assert.equal(row.status, 'batched');
    assert.equal(row.event_type, 'MATCH');
    assert.ok(row.recipients, 'recipients are preserved, not discarded, on a batched row');
    assert.equal(row.sent_at, null, 'a batched row was never actually sent');
    assert.ok(row.queued_at, 'the event is still timestamped and traceable');
  });

  test('sanity: the configured cooldown window matches the documented figure', () => {
    assert.equal(BATCH_WINDOW_MINUTES, 15);
  });
});
