/**
 * Seeds a working org: users across every role, two locations, notification
 * recipients, and the dummy pickup report committed through the real ingest
 * pipeline — not inserted directly, so the seed exercises the same validation
 * an admin upload would.
 */

import { generateReport, toCsv } from '@dp/fixtures';

import { type Db, newId, nowIso } from './db.ts';
import { hashPassword } from './auth.ts';
import { previewCsv, commitReport } from '../modules/ingest.ts';

export interface SeedResult {
  orgId: string;
  locationId: string;
  reportId: string;
  lineCount: number;
  rejectedCount: number;
  users: { email: string; password: string; role: string }[];
}

export const SEED_PASSWORD = 'FieldOfficer#2026';

export function seed(db: Db): SeedResult {
  const orgId = newId();
  db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
    .run(orgId, 'DP Logistics', nowIso());

  const locationId = newId();
  const secondLocationId = newId();
  db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
    .run(locationId, orgId, 'INMUN', 'Mundra Port');
  db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
    .run(secondLocationId, orgId, 'INNSA', 'Nhava Sheva');

  const people = [
    { email: 'officer@dp-logistics.example', role: 'field_officer', name: 'Ramesh Patel' },
    { email: 'supervisor@dp-logistics.example', role: 'supervisor', name: 'Anjali Nair' },
    { email: 'admin@dp-logistics.example', role: 'admin', name: 'Vikram Shah' },
    { email: 'auditor@dp-logistics.example', role: 'auditor', name: 'Meera Iyer' },
  ] as const;

  const users: SeedResult['users'] = [];
  let adminId = '';

  for (const person of people) {
    const id = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(id, orgId, person.email, hashPassword(SEED_PASSWORD), person.name, person.role, nowIso());

    db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)')
      .run(id, locationId);

    if (person.role === 'admin') adminId = id;
    users.push({ email: person.email, password: SEED_PASSWORD, role: person.role });
  }

  // Recipients per event. Mismatches page a supervisor; matches go to ops.
  const recipients: [string, string, string | null][] = [
    ['MATCH', 'ops@dp-logistics.example', null],
    ['CONTAINER_COMPLETE', 'ops@dp-logistics.example', null],
    ['CONTAINER_COMPLETE', 'documentation@dp-logistics.example', null],
    ['WRONG_CONTAINER', 'supervisor@dp-logistics.example', null],
    ['WRONG_CONTAINER', 'ops@dp-logistics.example', null],
    ['VIN_NOT_IN_REPORT', 'ops@dp-logistics.example', null],
    ['CONTAINER_NOT_IN_REPORT', 'ops@dp-logistics.example', null],
    ['DUPLICATE_VIN', 'supervisor@dp-logistics.example', null],
    ['CONTAINER_FULL', 'supervisor@dp-logistics.example', null],
    ['EXPIRED_REPORT', 'admin@dp-logistics.example', null],
    ['OVERRIDE_APPLIED', 'admin@dp-logistics.example', null],
    ['OVERRIDE_APPLIED', 'auditor@dp-logistics.example', null],
  ];

  for (const [eventType, email, location] of recipients) {
    db.prepare(
      `INSERT INTO notification_recipients (id, org_id, event_type, location_id, email)
       VALUES (?,?,?,?,?)`,
    ).run(newId(), orgId, eventType, location, email);
  }

  /*
   * Documents a container must have before it can be dispatched.
   *
   * This set is the common denominator for a containerised vehicle export out of
   * India; it is configurable per org because the real list varies by lane and
   * by customer.
   */
  for (const docType of [
    'PICKUP_LIST',
    'DELIVERY_ORDER',
    'COMMERCIAL_INVOICE',
    'PACKING_LIST',
    'SHIPPING_BILL',
    'LEO',
  ]) {
    db.prepare(
      `INSERT INTO document_requirements (id, org_id, doc_type, required_at)
       VALUES (?,?,?,'before_dispatch')`,
    ).run(newId(), orgId, docType);
  }

  /*
   * Commit the dummy report through the real pipeline.
   *
   * The validity window is relative to today, not a fixed pair of dates. A
   * hardcoded window silently expires as the calendar moves past it, and then
   * every seeded reconciliation returns EXPIRED_REPORT — which looks like a
   * broken engine rather than stale fixtures.
   */
  const day = (offset: number): string =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const report = generateReport({
    containers: 6,
    vehiclesPerContainer: 4,
    validFrom: day(-2),
    validTo: day(5),
  });
  const preview = previewCsv(toCsv(report));

  const committed = commitReport(db, preview, {
    orgId,
    locationId,
    uploadedBy: adminId,
    referenceNo: report.referenceNo,
    deliveryOrder: report.deliveryOrder,
    validFrom: report.validFrom,
    validTo: report.validTo,
    sourceFileName: 'pickup-report.csv',
  });

  return {
    orgId,
    locationId,
    reportId: committed.reportId,
    lineCount: committed.lineCount,
    rejectedCount: preview.rejectedCount,
    users,
  };
}
