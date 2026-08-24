# API Surface

REST + JSON. `Authorization: Bearer <access_token>` on everything except auth endpoints.
All mutating endpoints accept an `Idempotency-Key` header; the mobile client always sends
one, because it retries.

## Auth

```
POST   /auth/login              { email, password, device_id, platform, app_version }
                                → { access_token, refresh_token, user }
POST   /auth/refresh            { refresh_token } → new pair (rotating; old one revoked)
POST   /auth/logout             revokes the refresh token
GET    /auth/me                 → user, role, assigned locations
POST   /auth/change-password
```

Access token 15 min, refresh 30 days. `device_id` is optional and, when supplied, is
recorded purely for audit bookkeeping (which client instance a session came from) — there
is no approval step and no device state can block a login or a request. DP Logistics is a
web application; a browser is not a separately-approved security principal.

## Mobile — sync

The endpoints the app lives on. Both are designed to be called on app open and on network
recovery.

```
GET  /sync/reports?since=<iso8601>
     → active pickup reports + lines for the officer's assigned locations,
       valid within the next 7 days. Includes report id + version.
       Deltas only when `since` is supplied.

POST /sync/scans
     Batch upload of queued sessions. Idempotent on client-generated session id.
     {
       sessions: [{
         id, location_id, started_at, app_version,
         scans: [{
           id, scan_type, image_sha256, ocr_raw_text, ocr_candidates,
           ocr_confidence, detected_value, final_value, was_manual_entry,
           check_digit_ok, gps_lat, gps_lng, gps_accuracy_m, captured_at
         }],
         device_outcome: 'MATCH' | 'MISMATCH' | ...
       }]
     }
     → per-session: { id, status, outcome, reason_code, outcome_differs,
                      upload_urls: { <scan_id>: <presigned PUT url> } }
```

Images upload **directly to S3** via the returned presigned URLs — never through the API.
Metadata first, bytes second: the reconciliation completes and the email fires without
waiting on image transfer, and a poor connection degrades evidence upload rather than the
verdict.

```
POST /sync/scans/:scanId/image-uploaded   { sha256 }
     Server verifies the object exists and the hash matches what was declared.
```

## Reconciliation

```
GET  /reconciliations?from&to&outcome&location_id&officer_id&page
GET  /reconciliations/:id            → full detail + presigned evidence URLs
POST /reconciliations/:id/override   { reason_code, notes }   [supervisor|admin]
                                     → new record, supersedes the original
GET  /reconciliations/:id/evidence   → presigned GETs, 7-day expiry, access logged
```

## Admin — pickup reports

Three-step ingest. Nothing goes live without an explicit commit.

```
POST /admin/reports/upload        multipart: file, delivery_order_id, location_id,
                                             reference_no, valid_from, valid_to
                                  → { upload_id, detected_format, detected_columns,
                                      suggested_mapping, sample_rows }

POST /admin/reports/:uploadId/preview
                                  { mapping: { container_no: 'Column C', ... },
                                    save_mapping_as_template: true }
                                  → { valid_count, rejected_count,
                                      rows: [{ line_no, parsed, errors[] }] }

POST /admin/reports/:uploadId/commit
                                  { supersedes_report_id? }
                                  → { report_id, version, line_count }
```

```
GET    /admin/reports?status&delivery_order_id&location_id
GET    /admin/reports/:id/lines
POST   /admin/reports/:id/cancel        { reason }
GET    /admin/mapping-templates         saved per DO; auto-applied on next upload
```

Rejection reasons returned by `/preview` — surface these per row in the UI:
`INVALID_CONTAINER_CHECK_DIGIT`, `MALFORMED_CONTAINER_NO`, `DUPLICATE_CONTAINER_IN_FILE`,
`MISSING_REQUIRED_COLUMN`, `UNPARSEABLE_DATE`, `DATE_OUT_OF_VALIDITY_WINDOW`.

## Admin — users, notifications

```
GET/POST/PATCH  /admin/users
POST            /admin/users/:id/deactivate
POST            /admin/users/:id/locations       { location_ids[] }

GET/POST/DELETE /admin/notification-recipients
POST            /admin/notification-recipients/test   sends a sample to verify delivery
GET             /admin/notifications?status&from&to   delivery log
POST            /admin/notifications/:id/resend
```

## Admin — dashboard

```
GET /admin/dashboard/summary?from&to
    → { total, match, mismatch, exceptions, override_rate,
        ocr_accuracy, avg_scan_to_verdict_ms, offline_share }

GET /admin/dashboard/exceptions        open items needing action, oldest first
GET /admin/dashboard/live              SSE stream of reconciliations as they land
```

`ocr_accuracy` = share of scans where `detected_value === final_value`. Watch it per
`scan_type` — container and chassis will diverge sharply, and that gap tells you where to
spend engineering effort.

## Webhooks (inbound)

```
POST /webhooks/email/:provider    SES/SendGrid delivery, bounce, complaint
                                  → updates notifications.status
```

## Conventions

- Errors: `{ error: { code, message, details? } }` with a stable machine-readable `code`.
- Pagination: cursor-based (`?cursor=&limit=`). Offset pagination on the reconciliation
  table will hurt once it's large.
- Rate limits: 5/min on login per IP+email; 60/min on sync endpoints per device.
- Versioning: `/v1` prefix. The mobile app can lag the server by weeks — field devices
  don't update on your schedule — so never break `/sync/*` without a version bump.
- Every response carries a `request_id`; log it on the device too so a support call can be
  traced end to end.
