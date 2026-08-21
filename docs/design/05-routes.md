# 05 — Application Routes

One React Router data-router tree. Role determines which subtree a user is redirected into
after login; RLS determines what any of them can actually load (§03 §08).

## 1. Route map

```
/                                → redirect by role: driver → /drive, supervisor → /board,
                                   admin → /admin, auditor → /audit
/login                           public
/login/set-password              public, invite/recovery token
/offline                         service-worker fallback for an uncached navigation
/unsupported                     no camera / no getUserMedia / browser too old
/403                             authenticated but not permitted

DRIVER  (role: driver)
/drive                           today: yard, active manifest, progress, next task
/drive/tasks                     full task list for the shift, filterable
/drive/task/:assignmentId        task detail — expected container + chassis, before camera
/drive/task/:assignmentId/scan/container    camera + OCR
/drive/task/:assignmentId/scan/vehicle      camera + OCR
/drive/task/:assignmentId/review            both captures, confirm and submit
/drive/task/:assignmentId/result            verdict (verified / blocked / provisional)
/drive/task/:assignmentId/exception         raise an exception
/drive/history                   the driver's own completed movements, this shift
/drive/sync                      outbox: queued items, retry, storage used

SUPERVISOR  (role: supervisor)
/board                           live tiles per yard + activity feed
/board/:yardId                   one yard: containers, fill state, in-progress movements
/exceptions                      live queue, filterable by type and age
/exceptions/:exceptionId         full detail: evidence, expected vs scanned, actions
/movements                       all movements for the supervisor's yards
/movements/:movementId           movement detail + evidence + audit timeline
/devices                         pending device approvals
/shift-report                    end-of-shift completeness sweep (partially filled containers)

ADMIN  (role: admin)
/admin                           overview
/admin/manifests                 list, by yard and date, with version history
/admin/manifests/upload          file drop → column mapping
/admin/manifests/import/:importId/preview    validation results; commit happens here
/admin/manifests/:manifestId     committed manifest, its versions, its assignments
/admin/users                     list, invite, role, yard assignment, deactivate
/admin/users/:userId
/admin/yards
/admin/recipients                notification recipient lists per yard and event type
/admin/settings                  org settings, retention, OCR thresholds

AUDITOR  (role: auditor)
/audit                           search: chassis, container, date, driver, outcome
/audit/movement/:movementId      full immutable record + evidence + hash verification
/audit/container/:containerNo    everything that ever happened to this container
/audit/vehicle/:chassisNo        everything that ever happened to this vehicle
/audit/export                    request an export; produces a signed bundle

SHARED (any authenticated role, content varies by permission)
/me                              profile, device, sign out
/me/device                       this device's id, binding status
```

## 2. Route guards, and what they are for

```tsx
// Shape only — the point is what it does NOT do.
<Route element={<RequireAuth />}>
  <Route element={<RequireRole allow={['driver']} />}>
    <Route path="/drive/*" ... />
  </Route>
</Route>
```

A guard decides **which screen renders**. It does not decide **which data returns**. If
`RequireRole` were deleted, a driver navigating to `/admin/users` would get the admin screen
shell rendering an empty table, because the underlying `select` returns zero rows under
RLS. That is the correct failure mode and it is the acceptance test for the guard design.

Guards must therefore never be the only thing standing between a user and data — and
equally, a guard must never be *needed* for correctness. Both directions matter.

## 3. What each screen may assume

| Route | Data source | Offline | Notes |
|---|---|---|---|
| `/drive`, `/drive/tasks`, `/drive/task/:id` | IndexedDB cache, revalidated from Postgres | **Full** | Must render with zero network |
| `/drive/task/:id/scan/*` | Local only | **Full** | OCR model cached by the service worker on install |
| `/drive/task/:id/review` | Local | **Full** | Advisory verdict from cached manifest |
| `/drive/task/:id/result` | RPC response, or local advisory | **Degraded** | Offline shows `PROVISIONAL — awaiting server` (§10) |
| `/drive/sync` | IndexedDB | **Full** | Deliberately reachable offline; it is the offline screen |
| `/board*`, `/exceptions*` | Postgres + Realtime | **No** | A stale board is worse than an absent one. Show a disconnected state |
| `/movements/:id`, `/audit/*` | Postgres + Storage signed URLs | **No** | Evidence is never cached on a device |
| `/admin/*` | Postgres | **No** | Admin work needs connectivity by definition |

The rule behind the table: **operational screens cache, supervisory screens do not.** A
driver acting on a five-minute-old task list is fine. A supervisor acting on a five-minute-
old exception queue is dangerous, because they may believe a truck has been stopped when it
has not.

## 4. Deep links and the scan flow

The scan flow is stateful — two captures, then a review — and the naive implementation puts
that state in a React context that a refresh destroys. Instead:

- Each capture is persisted to IndexedDB as it is taken, keyed by `assignmentId`.
- The scan routes are resumable: landing on `/drive/task/:id/review` after a browser kill
  restores both captures.
- `assignmentId` in the URL means a supervisor can send a driver a link to a specific task.

This matters more than it sounds. Phone browsers evict backgrounded tabs aggressively, and
a driver who takes a phone call between the two scans must not lose the first one.

## 5. Code splitting

Split at the role-shell boundary and at the two heavy features:

| Chunk | Loaded for | Roughly |
|---|---|---|
| `shell` | everyone | React, Router, Supabase client, design system |
| `drive` | drivers | Task flow, camera |
| `ocr` | drivers, lazily on first scan | `tesseract.js` + language data — the largest asset by far |
| `board` | supervisors | Realtime board, exception queue |
| `admin` | admins | XLSX preview grid, mapping UI |
| `audit` | auditors, admins | Search, timeline, export |

The `ocr` chunk is precached by the service worker on install for drivers only — it is
useless to the other roles and it is big enough that shipping it to everyone is a visible
cost on a yard phone.
