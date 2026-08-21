# 03 — User Roles and Permissions

## 1. Roles

Four roles. Adding a fifth should require an argument, because every role multiplies the
RLS policy surface that has to be tested.

| Role | Who they are | Primary surface |
|---|---|---|
| `driver` | Moves vehicles from the yard into containers. Phone in hand, gloves on, outdoors. | Driver PWA shell |
| `supervisor` | Runs a yard shift. Handles anything the driver is blocked on. | Live board + exception queue |
| `admin` | Operations back office. Owns manifests, users, yards, notification recipients. | Admin routes |
| `auditor` | Compliance or a customer's representative. Reads everything, writes nothing. | Audit search + export |

A user has exactly one role and belongs to exactly one organization. A user is assigned to
one or more yards; `admin` and `auditor` may be assigned org-wide.

**Roles are not hierarchical in the code.** A supervisor is not "a driver with extras" — a
supervisor cannot complete a movement, because the person verifying an exception must not
be the person who caused it. If a supervisor genuinely needs to drive, they get a second
account with the `driver` role. That is a deliberate friction, and §12 explains why the
separation matters for overrides.

## 2. Permission matrix

`—` = no access at all, not "hidden in the UI".

| Capability | driver | supervisor | admin | auditor |
|---|---|---|---|---|
| **Manifests** |
| View active manifest for assigned yards | own tasks only | ✓ | ✓ | ✓ |
| View superseded manifest versions | — | ✓ | ✓ | ✓ |
| Upload / preview manifest | — | — | ✓ | — |
| Commit manifest | — | — | ✓ | — |
| Cancel a manifest | — | — | ✓ | — |
| **Movements** |
| See own assigned tasks | ✓ | ✓ (all in yard) | ✓ | ✓ |
| Start a movement (claim a task) | ✓ | — | — | — |
| Upload scan evidence | ✓ (own movement) | — | — | — |
| Complete a movement | ✓ via RPC only | — | — | — |
| Set movement status directly | — | — | — | — |
| View another driver's movement | — | ✓ (own yards) | ✓ | ✓ |
| **Exceptions** |
| Raise an exception | ✓ | ✓ | ✓ | — |
| View exception queue | own only | ✓ (own yards) | ✓ | ✓ |
| Acknowledge / assign | — | ✓ | ✓ | — |
| Resolve | — | ✓ | ✓ | — |
| **Overrides** |
| Request an override | ✓ | — | — | — |
| Approve an override | — | ✓ | ✓ | — |
| **Evidence** |
| View own scan images | ✓ | ✓ (own yards) | ✓ | ✓ |
| Download original image | — | ✓ | ✓ | ✓ |
| **Administration** |
| Manage users and role assignment | — | — | ✓ | — |
| Manage yards | — | — | ✓ | — |
| Manage notification recipients | — | — | ✓ | — |
| Approve a new device | — | ✓ (own yards) | ✓ | — |
| **Audit** |
| Read audit events | — | own yards | ✓ | ✓ |
| Export audit records | — | — | ✓ | ✓ |
| Delete or amend any record | — | — | — | — |

Note the last row. Nobody can delete or amend a record, including the admin. Corrections
are new rows. See §13.

## 3. Where each rule is enforced

Every capability above is enforced in **at least** the database. The UI layer is convenience.

```
Layer                        Enforces                          If bypassed
─────────────────────────────────────────────────────────────────────────────────
React route guard            which screen renders              user sees an empty
                                                               screen; no data leaks
TanStack Query / loader      what is requested                 request is made and
                                                               returns nothing
RLS policy on each table     what rows are readable/writable   ← THE boundary
verify_movement() RPC        outcome decisions, state moves    cannot be bypassed
Column grants                which columns are writable        cannot be bypassed
Storage policy per path      which objects are readable        cannot be bypassed
```

The test for whether authorization is designed correctly: **delete every route guard from
the front end and the system is still secure.** A driver who hand-crafts a `supabase-js`
call from the browser console gets rows back only if RLS lets them. If any part of this
matrix is enforced only by a `<RequireRole>` component, that part is not enforced.

## 4. How the role reaches Postgres

The naive approach — an RLS policy that does `SELECT role FROM profiles WHERE id =
auth.uid()` — works, but it runs a subquery per row on every policy check and it creates
recursive-policy problems the moment `profiles` itself is RLS-protected.

Instead, use Supabase's **Custom Access Token Hook** (an Edge Function or a plpgsql hook
registered with GoTrue) to inject claims into the JWT at issue time:

```jsonc
{
  "sub": "…",              // auth.uid()
  "app_metadata": {
    "org_id":  "…",
    "role":    "driver",
    "yard_ids": ["…", "…"]
  }
}
```

Policies then read `auth.jwt() -> 'app_metadata' ->> 'role'` — no subquery, no recursion.

Two consequences that must be designed for, not discovered:

1. **Claims are stale until the token refreshes.** Revoking a yard assignment or changing a
   role does not take effect until the access token expires. Set the access token TTL to 15
   minutes and, for immediate revocation (a dismissed employee), the admin action must also
   call `auth.admin.signOut(user_id)` to kill the refresh token. Design the admin UI so that
   is automatic, not a checkbox someone forgets.
2. **`yard_ids` in a claim has a size limit.** Fine for a driver with two yards; not fine
   for an org-wide auditor with two hundred. So: drivers and supervisors carry `yard_ids`;
   `admin` and `auditor` carry an `org_id` and are scoped by that alone, with no yard list.

Session lengths, chosen for the environment rather than by habit:

| Role | Access token | Refresh token | Reasoning |
|---|---|---|---|
| driver | 15 min | 30 days | Re-authenticating at a ramp in the rain is how you lose adoption |
| supervisor | 15 min | 7 days | Shared-ish devices in an office |
| admin | 15 min | 12 hours | Has the most destructive capabilities |
| auditor | 15 min | 12 hours | Often an external party |

## 5. Device binding

A driver account is bound to devices. On first login from an unknown device the session is
created but restricted: the driver can see tasks and cannot complete movements until a
supervisor approves the device from their own session. It appears in the supervisor's queue
in realtime.

This closes a specific hole: a driver who shares credentials so a colleague can "just
complete the last one" from their own phone. It costs a supervisor one tap when a driver
gets a new phone, which is rare, and it is the cheapest anti-collusion control available in
a web app.

The device identifier is a UUID generated on first run and stored in IndexedDB. It is not a
hardware identifier — the browser does not offer one, and it is not trying to be
unforgeable. It is trying to make credential sharing visible, which it does: two devices
appearing for one driver in one shift is a signal on the supervisor board.

## 6. Onboarding and the invite flow

No self-registration. Ever. An admin creates a user with an email and a role and Supabase
Auth sends an invite; the user sets a password on first login. Public sign-up is disabled in
the Auth settings, and this must be verified in staging — a Supabase project with open
sign-up plus a permissive `profiles` insert policy is the single most common way these
systems are breached.

For drivers who do not use email reliably, phone OTP is the alternative. Same rule: the
admin creates the user; the driver never self-registers.
