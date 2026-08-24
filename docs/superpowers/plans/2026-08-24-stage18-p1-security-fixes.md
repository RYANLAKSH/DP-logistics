# Stage 18 — P1 Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P1 application-security findings — no login rate limiting, and organization-wide document/reconciliation read access for field officers — without touching auth architecture, the vehicle/container safety rule, or anything outside these two findings.

**Architecture:** (1) A small in-memory, dependency-free sliding-window limiter keyed independently by client IP and by normalized login identifier, wired into `POST /v1/auth/login` before password verification. (2) A new `requireBroadReadAccess` middleware (supervisor/admin by rank, or `auditor` by explicit check — mirroring the existing `atLeast`/`auditor` split documented in `auth.ts`) applied to document and reconciliation list/detail GET routes that have no field-officer use case (confirmed by exploring the mobile client and every existing test). One route — `GET /v1/reconciliations/:id/evidence` — has a proven, tested field-officer use case (checking their own submitted evidence) and instead gets a location-scoped check reusing the existing `user_locations` model.

**Tech Stack:** Node.js 26 (`--experimental-strip-types`), Express 4, `node:test`, SQLite via `node:sqlite` (`DatabaseSync`), Zod.

**Spec:** The Stage 18 task brief (operating rules + two P1 findings), given directly in the conversation — no separate spec file. Key facts gathered during research (do not re-derive):
- `packages/api/src/server.ts` — the whole HTTP surface, `createServer(db)`.
- `packages/api/src/lib/auth.ts` — `Role`, `RANK`, `atLeast()`; `auditor` shares rank 1 with `field_officer` and must be checked explicitly, never via `atLeast`.
- `packages/api/src/lib/db.ts` — schema. `reconciliations` has no `location_id` directly but joins to `scan_sessions.location_id`. `documents.location_id` is nullable and often unset in practice. `user_locations(user_id, location_id)` is the existing officer-scoping table, already used by `assertLocationAccess` in server.ts and by `/v1/sync/reports`.
- Mobile app (`packages/mobile/src/lib/api.ts`) calls exactly 6 endpoints and **none** of the 8 document/reconciliation GET routes. Confirmed via full-repo search.
- `docs/architecture.md:161`, `docs/security.md:152`: `auditor` is documented as read-only across *everything* — this must not be weakened.
- Existing tests already prove one legitimate field-officer read path that must keep working: `evidence.test.ts` — the officer who submitted a scan reads `GET /v1/reconciliations/:id/evidence` for their own reconciliation and expects `200`.
- No existing test exercises `GET /v1/reconciliations` (list) or `GET /v1/reconciliations/:id` with the officer role — free to restrict.
- `documents.test.ts` only ever uses `officerToken` against `/v1/sync/reports`, `POST /v1/documents` (expects 403), and `POST /v1/sync/scans` — never against any document GET route — free to restrict.
- Baseline: 257/257 tests passing before this change (`npm test` in `packages/api`).

## Global Constraints

- Code-only. Do not deploy, SSH into the VPS, touch `/etc/dp-logistics/api.env`, switch branches, or run backups/SMTP config.
- Do not introduce Redis or other external infra for rate limiting — in-memory only.
- Do not change the auth architecture (JWT/refresh design), the vehicle/container safety rule (`@dp/shared-rules`), or weaken any existing authorization.
- Do not remove or weaken existing tests. All 257 existing tests must keep passing.
- Keep the diff scoped to exactly these two findings — no unrelated refactors.
- Rate limiter constants must be explicit, named, and easy to audit (no magic numbers).
- Rate limiter must protect on both IP and normalized identifier independently, must not leak account existence, must return 429 with `Retry-After`, and must not grow memory without bound.

---

### Task 1: Login rate limiter module

**Files:**
- Create: `packages/api/src/lib/rateLimit.ts`
- Test: `packages/api/src/__tests__/rateLimit.test.ts`

**Interfaces:**
- Produces: `SlidingWindowLimiter` class with `check(key: string, at?: number): { allowed: boolean; retryAfterSeconds: number }` and `reset(key: string): void`.
- Produces: `createLoginRateLimiter(): LoginRateLimiter` where `LoginRateLimiter` has `checkIp(ip: string, at?: number)`, `checkIdentifier(identifier: string, at?: number)` (same return shape as `check`), and `recordSuccess(identifier: string): void`.
- Produces: exported constants `LOGIN_IP_WINDOW_MS`, `LOGIN_IP_MAX_ATTEMPTS`, `LOGIN_IDENTIFIER_WINDOW_MS`, `LOGIN_IDENTIFIER_MAX_ATTEMPTS`, `RATE_LIMIT_MAX_TRACKED_KEYS`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/api/src/__tests__/rateLimit.test.ts`:

```ts
/**
 * The login rate limiter is pure, in-memory logic with an injectable clock —
 * these tests drive it with synthetic timestamps so window expiry can be
 * proven without waiting on real time.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SlidingWindowLimiter,
  createLoginRateLimiter,
  LOGIN_IP_MAX_ATTEMPTS,
  LOGIN_IP_WINDOW_MS,
  LOGIN_IDENTIFIER_MAX_ATTEMPTS,
  LOGIN_IDENTIFIER_WINDOW_MS,
} from '../lib/rateLimit.ts';

describe('SlidingWindowLimiter', () => {
  test('allows attempts under the limit and blocks the one that exceeds it', () => {
    const limiter = new SlidingWindowLimiter(1000, 3);
    const t = 0;
    assert.equal(limiter.check('a', t).allowed, true);
    assert.equal(limiter.check('a', t + 1).allowed, true);
    assert.equal(limiter.check('a', t + 2).allowed, true);
    const fourth = limiter.check('a', t + 3);
    assert.equal(fourth.allowed, false);
    assert.ok(fourth.retryAfterSeconds > 0);
  });

  test('different keys have independent budgets', () => {
    const limiter = new SlidingWindowLimiter(1000, 1);
    assert.equal(limiter.check('a', 0).allowed, true);
    assert.equal(limiter.check('b', 0).allowed, true, 'key b must not share key a\'s budget');
    assert.equal(limiter.check('a', 1).allowed, false, 'key a is now over budget');
  });

  test('the window slides: an attempt older than the window no longer counts', () => {
    const limiter = new SlidingWindowLimiter(1000, 2);
    assert.equal(limiter.check('a', 0).allowed, true);
    assert.equal(limiter.check('a', 100).allowed, true);
    assert.equal(limiter.check('a', 200).allowed, false, 'still within the window, over budget');
    // The first attempt (t=0) has now aged out of a 1000ms window at t=1001.
    assert.equal(limiter.check('a', 1001).allowed, true, 'oldest attempt should have expired');
  });

  test('reset clears a key\'s recorded attempts', () => {
    const limiter = new SlidingWindowLimiter(1000, 1);
    assert.equal(limiter.check('a', 0).allowed, true);
    assert.equal(limiter.check('a', 1).allowed, false);
    limiter.reset('a');
    assert.equal(limiter.check('a', 2).allowed, true, 'after reset the budget must be fresh');
  });

  test('never tracks more than the configured number of keys', () => {
    const limiter = new SlidingWindowLimiter(60_000, 100, 5);
    for (let i = 0; i < 50; i++) {
      limiter.check(`key-${i}`, i);
    }
    assert.ok(limiter.trackedKeyCount() <= 5, 'tracked key count must be bounded');
  });
});

describe('createLoginRateLimiter — compound IP + identifier protection', () => {
  test('repeated failed attempts from one IP are throttled', () => {
    const limiter = createLoginRateLimiter();
    let blocked = false;
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS + 1; i++) {
      const result = limiter.checkIp('1.2.3.4', i);
      if (!result.allowed) { blocked = true; break; }
    }
    assert.ok(blocked, 'the IP limiter must eventually block a hammering IP');
  });

  test('repeated attempts for one identifier are throttled', () => {
    const limiter = createLoginRateLimiter();
    let blocked = false;
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 1; i++) {
      const result = limiter.checkIdentifier('victim@example.com', i);
      if (!result.allowed) { blocked = true; break; }
    }
    assert.ok(blocked, 'the identifier limiter must eventually block repeated guesses');
  });

  test('rotating IP alone cannot bypass identifier protection', () => {
    const limiter = createLoginRateLimiter();
    let blocked = false;
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 5; i++) {
      // A fresh IP on every attempt — only the identifier is held constant.
      const result = limiter.checkIdentifier('victim@example.com', i);
      if (!result.allowed) { blocked = true; break; }
    }
    assert.ok(blocked, 'the identifier budget must exhaust regardless of the attacker\'s IP churn');
  });

  test('rotating identifier alone cannot bypass IP protection', () => {
    const limiter = createLoginRateLimiter();
    let blocked = false;
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS + 5; i++) {
      // A fresh identifier on every attempt — only the IP is held constant.
      const result = limiter.checkIp('9.9.9.9', i);
      if (!result.allowed) { blocked = true; break; }
    }
    assert.ok(blocked, 'the IP budget must exhaust regardless of which account is being tried');
  });

  test('a successful login resets the identifier budget so later logins are not accidentally denied', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS - 1; i++) {
      assert.equal(limiter.checkIdentifier('officer@dp-logistics.example', i).allowed, true);
    }
    limiter.recordSuccess('officer@dp-logistics.example');
    // Immediately after success, the officer must still be able to log in
    // again without inheriting the near-exhausted budget from before.
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS - 1; i++) {
      assert.equal(
        limiter.checkIdentifier('officer@dp-logistics.example', 1000 + i).allowed,
        true,
        'the reset budget must not be pre-exhausted',
      );
    }
  });

  test('limiter state expires: an identifier can retry once its window has fully elapsed', () => {
    const limiter = createLoginRateLimiter();
    for (let i = 0; i <= LOGIN_IDENTIFIER_MAX_ATTEMPTS; i++) {
      limiter.checkIdentifier('retry@example.com', i);
    }
    assert.equal(
      limiter.checkIdentifier('retry@example.com', LOGIN_IDENTIFIER_MAX_ATTEMPTS).allowed,
      false,
    );
    assert.equal(
      limiter.checkIdentifier('retry@example.com', LOGIN_IDENTIFIER_WINDOW_MS + 1).allowed,
      true,
      'once the window has fully elapsed the identifier must be usable again',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/rateLimit.test.ts`
Expected: FAIL — `Cannot find module '../lib/rateLimit.ts'`

- [ ] **Step 3: Implement the limiter**

Create `packages/api/src/lib/rateLimit.ts`:

```ts
/**
 * In-memory login rate limiting.
 *
 * No Redis, no external store — this is a single-process pilot deployment, and
 * an in-memory sliding window is the simplest thing that is still correct and
 * auditable. It resets on process restart, which is an acceptable trade at
 * this scale (a restart is already an unusual event worth noticing).
 *
 * Every constant below is named and used exactly once, so the whole policy can
 * be read off this file without hunting through server.ts.
 */

/** How long a failed attempt counts against an IP's budget. */
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed per IP per window. Generous — a shared gate device or
 *  office NAT can see several officers logging in close together. */
export const LOGIN_IP_MAX_ATTEMPTS = 20;

/** How long a failed attempt counts against one login identifier's budget. */
export const LOGIN_IDENTIFIER_WINDOW_MS = 15 * 60 * 1000;
/** Attempts allowed per normalized identifier per window. Tight — this is the
 *  per-account brute-force budget, and a real user rarely needs more than a
 *  couple of retries for a mistyped password. */
export const LOGIN_IDENTIFIER_MAX_ATTEMPTS = 5;

/** Hard cap on distinct keys tracked at once, so an attacker spraying unique
 *  IPs or identifiers cannot grow the process's memory without bound. Oldest
 *  key is evicted once this is exceeded. */
export const RATE_LIMIT_MAX_TRACKED_KEYS = 20_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Sliding-window counter keyed by an arbitrary string.
 *
 * Each key's own attempt timestamps are pruned to the current window on every
 * check, so a key's memory is bounded by `maxAttempts` regardless of how many
 * times it is hit. The clock is injectable (`at`) so tests can drive window
 * expiry deterministically instead of waiting on real time.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly windowMs: number,
    private readonly maxAttempts: number,
    private readonly maxTrackedKeys: number = RATE_LIMIT_MAX_TRACKED_KEYS,
  ) {}

  /** Records an attempt for `key` and reports whether it is within budget. */
  check(key: string, at: number = Date.now()): RateLimitResult {
    this.sweep(at);

    const existing = this.buckets.get(key) ?? [];
    const withinWindow = existing.filter((timestamp) => at - timestamp < this.windowMs);

    if (withinWindow.length >= this.maxAttempts) {
      const oldest = withinWindow[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((this.windowMs - (at - oldest)) / 1000));
      this.buckets.set(key, withinWindow);
      return { allowed: false, retryAfterSeconds };
    }

    withinWindow.push(at);
    this.buckets.set(key, withinWindow);
    if (!existing.length) this.evictIfOverCapacity();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Clears a key's recorded attempts — used after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Test/observability hook: how many distinct keys are currently tracked. */
  trackedKeyCount(): number {
    return this.buckets.size;
  }

  /** Drops fully-expired keys. Runs at most once per window to keep the cost
   *  off the hot path — a key with live attempts is already bounded by
   *  maxAttempts regardless of this running. */
  private sweep(at: number): void {
    if (at - this.lastSweep < this.windowMs) return;
    this.lastSweep = at;
    for (const [key, timestamps] of this.buckets) {
      const alive = timestamps.filter((timestamp) => at - timestamp < this.windowMs);
      if (alive.length === 0) this.buckets.delete(key);
      else this.buckets.set(key, alive);
    }
  }

  private evictIfOverCapacity(): void {
    while (this.buckets.size > this.maxTrackedKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}

export interface LoginRateLimiter {
  checkIp(ip: string, at?: number): RateLimitResult;
  checkIdentifier(identifier: string, at?: number): RateLimitResult;
  /** Clears the identifier's budget after a real, successful login so normal
   *  day-to-day use never accumulates toward the brute-force threshold. The
   *  IP budget is deliberately NOT reset here — resetting it on any success
   *  would let an attacker who owns one valid account (or sprays for one)
   *  keep refilling their IP's budget while still guessing other accounts;
   *  the per-identifier limiter is what actually stops that. */
  recordSuccess(identifier: string): void;
}

/** One limiter instance per server — holds all in-memory state for the login route. */
export function createLoginRateLimiter(): LoginRateLimiter {
  const byIp = new SlidingWindowLimiter(LOGIN_IP_WINDOW_MS, LOGIN_IP_MAX_ATTEMPTS);
  const byIdentifier = new SlidingWindowLimiter(LOGIN_IDENTIFIER_WINDOW_MS, LOGIN_IDENTIFIER_MAX_ATTEMPTS);

  return {
    checkIp: (ip, at) => byIp.check(ip, at),
    checkIdentifier: (identifier, at) => byIdentifier.check(identifier, at),
    recordSuccess: (identifier) => byIdentifier.reset(identifier),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/rateLimit.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/lib/rateLimit.ts packages/api/src/__tests__/rateLimit.test.ts
git commit -m "feat: add in-memory sliding-window rate limiter for login"
```

---

### Task 2: Wire the rate limiter into POST /v1/auth/login

**Files:**
- Modify: `packages/api/src/server.ts` (import, instantiate in `createServer`, wire into the login handler)
- Test: `packages/api/src/__tests__/loginRateLimit.test.ts` (new, HTTP-level)

**Interfaces:**
- Consumes: `createLoginRateLimiter`, `LOGIN_IDENTIFIER_MAX_ATTEMPTS` from `./lib/rateLimit.ts` (Task 1).
- Produces: nothing new consumed by later tasks — this closes out Finding 1.

- [ ] **Step 1: Write the failing HTTP-level tests**

Create `packages/api/src/__tests__/loginRateLimit.test.ts`:

```ts
/**
 * POST /v1/auth/login over the real HTTP surface, exercising the rate limiter
 * as a client actually would. Window-expiry and multi-key-independence are
 * covered at the unit level (rateLimit.test.ts) with synthetic timestamps —
 * these tests only need to prove the wiring: the route actually calls the
 * limiter, returns 429 with Retry-After, and never reveals account existence.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { openDb, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { createServer } from '../server.ts';
import { LOGIN_IDENTIFIER_MAX_ATTEMPTS } from '../lib/rateLimit.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;

before(async () => {
  process.env.JWT_SECRET = 'login-rate-limit-test-secret';
  db = openDb(':memory:');
  fixture = seed(db);

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => {
  server?.close();
  db?.close();
});

async function login(email: string, password: string) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    json: text ? JSON.parse(text) : null,
  };
}

describe('login rate limiting', () => {
  test('a legitimate officer can still log in normally', async () => {
    const result = await login('officer@dp-logistics.example', SEED_PASSWORD);
    assert.equal(result.status, 200);
    assert.ok(result.json.accessToken);
  });

  test('repeated wrong-password attempts for one identifier are throttled and return 429', async () => {
    const email = `throttle-target-${fixture.orgId}@dp-logistics.example`;
    let sawThrottle = false;

    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3; i++) {
      const result = await login(email, 'definitely-wrong');
      if (result.status === 429) {
        sawThrottle = true;
        assert.ok(result.retryAfter, 'a 429 must carry a Retry-After header');
        assert.ok(Number(result.retryAfter) > 0);
        assert.equal(result.json.error.code, 'TOO_MANY_ATTEMPTS');
        break;
      }
      assert.equal(result.status, 401, 'until throttled, a bad password is a plain 401');
    }

    assert.ok(sawThrottle, `expected a 429 within ${LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3} attempts`);
  });

  test('throttling does not reveal whether the account exists', async () => {
    const unknownEmail = 'no-such-account@dp-logistics.example';
    const knownEmail = 'admin@dp-logistics.example';

    let unknownResult, knownResult;
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3; i++) {
      unknownResult = await login(unknownEmail, 'wrong');
      if (unknownResult.status === 429) break;
    }
    for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3; i++) {
      knownResult = await login(knownEmail, 'wrong');
      if (knownResult.status === 429) break;
    }

    // Both an unknown account and a known one, hammered the same way, must
    // end up throttled with byte-identical error bodies.
    assert.equal(unknownResult!.status, 429);
    assert.equal(knownResult!.status, 429);
    assert.deepEqual(unknownResult!.json, knownResult!.json);
  });

  test('a successful login is still possible right after a couple of failed attempts', async () => {
    const email = 'supervisor@dp-logistics.example';
    await login(email, 'wrong-once');
    await login(email, 'wrong-twice');

    const result = await login(email, SEED_PASSWORD);
    assert.equal(result.status, 200, 'a couple of typos must not lock out the real password');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/loginRateLimit.test.ts`
Expected: FAIL — no 429 is ever produced (the throttle test times out its loop without seeing one; `LOGIN_IDENTIFIER_MAX_ATTEMPTS` import will resolve since Task 1 landed, but the route doesn't use it yet).

- [ ] **Step 3: Wire the limiter into server.ts**

In `packages/api/src/server.ts`, add the import near the other `./lib/*` imports (after the `auth.ts` import block):

```ts
import { createLoginRateLimiter } from './lib/rateLimit.ts';
```

Inside `createServer(db)`, right after `const app = express();`, add:

```ts
  // One limiter per server instance — see lib/rateLimit.ts for the policy.
  const loginRateLimiter = createLoginRateLimiter();
```

Replace the body of the `/v1/auth/login` handler (currently starting at `app.post('/v1/auth/login', (req, res) => {`) with:

```ts
  app.post('/v1/auth/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Bad login payload');

    const { email, password, deviceId, platform, appVersion } = parsed.data;
    const normalizedEmail = email.trim().toLowerCase();
    // req.ip is Express's own view of the socket's remote address — the app
    // never sets `trust proxy`, so this cannot be spoofed via X-Forwarded-For
    // or any other client-supplied header.
    const clientIp = req.ip ?? 'unknown';

    const ipLimit = loginRateLimiter.checkIp(clientIp);
    if (!ipLimit.allowed) {
      res.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.');
    }

    const identifierLimit = loginRateLimiter.checkIdentifier(normalizedEmail);
    if (!identifierLimit.allowed) {
      res.set('Retry-After', String(identifierLimit.retryAfterSeconds));
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.');
    }

    const row = db
      .prepare('SELECT * FROM users WHERE email = ? AND is_active = 1')
      .get(normalizedEmail) as Record<string, unknown> | undefined;

    // Same response for unknown user and wrong password — no account enumeration.
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    // A real login succeeded — clear this identifier's failed-attempt budget
    // so ordinary day-to-day use (occasional typo, then the right password)
    // never accumulates toward the brute-force threshold.
    loginRateLimiter.recordSuccess(normalizedEmail);

    const user: AuthUser = {
      id: String(row.id),
      orgId: String(row.org_id),
      email: String(row.email),
      fullName: String(row.full_name),
      role: String(row.role) as Role,
    };

    // Device approval is no longer an access gate (Stage 11 — DP Logistics is
    // web-first, and a browser is not a separately-approved security
    // principal). When a client supplies a deviceId this still records/updates
    // a devices row purely as bookkeeping — it links scan_sessions and
    // refresh_tokens back to the client instance that produced them for
    // audit purposes — but nothing about that row's state can block a login.
    let deviceRowId: string | undefined;
    if (deviceId) {
      const existing = db
        .prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ?')
        .get(user.id, deviceId) as { id: string } | undefined;

      if (existing) {
        db.prepare('UPDATE devices SET last_seen_at = ?, app_version = ? WHERE id = ?')
          .run(nowIso(), appVersion ?? null, existing.id);
        deviceRowId = existing.id;
      } else {
        deviceRowId = newId();
        db.prepare(
          `INSERT INTO devices (id, user_id, device_id, platform, app_version, last_seen_at, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(deviceRowId, user.id, deviceId, platform ?? null, appVersion ?? null, nowIso(), nowIso());
      }
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

    const locations = db
      .prepare(
        `SELECT l.id, l.code, l.name FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
          WHERE ul.user_id = ?`,
      )
      .all(user.id);

    res.json({
      accessToken: signAccessToken(user, deviceRowId),
      refreshToken: issueRefreshToken(db, user.id, deviceRowId),
      expiresIn: ACCESS_TTL_SECONDS,
      user,
      locations,
    });
  });
```

Note the only behavioral changes from the current code: `email.toLowerCase()` becomes `email.trim().toLowerCase()` for the DB lookup (a strict widening — trims whitespace zod's `.email()` already tolerates at the edges) and the two new throttle checks plus the `recordSuccess` call. Everything else is byte-identical to the existing handler.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/loginRateLimit.test.ts src/__tests__/rateLimit.test.ts src/__tests__/auth.test.ts src/__tests__/e2e.test.ts`
Expected: PASS — all green, including the pre-existing `auth.test.ts` and `e2e.test.ts` (which exercise login repeatedly and must not be newly throttled by normal test traffic; if `e2e.test.ts` logs in as the same identifier many times across its `describe` blocks and trips the 5-per-15-minute identifier budget, that is a real signal to re-examine — check the failure before assuming the test is wrong).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/server.ts packages/api/src/__tests__/loginRateLimit.test.ts
git commit -m "fix: rate limit POST /v1/auth/login by IP and identifier"
```

---

### Task 3: Restrict organization-wide document/reconciliation reads to supervisor/admin/auditor

**Files:**
- Modify: `packages/api/src/server.ts` (new `requireBroadReadAccess` middleware; apply to 7 routes)
- Test: `packages/api/src/__tests__/readAuthorization.test.ts` (new)

**Interfaces:**
- Consumes: `atLeast`, `Role` from `./lib/auth.ts` (already imported in server.ts).
- Produces: `requireBroadReadAccess` middleware, used again by Task 4 is NOT needed (Task 4 uses a different, location-scoped check) — no cross-task interface beyond this file.

Routes gated by `requireBroadReadAccess` (confirmed via mobile-client and test-suite search to have zero field-officer use case):
1. `GET /v1/documents` (server.ts, list route)
2. `GET /v1/documents/:id/view`
3. `GET /v1/documents/for/:entityType/:entityId`
4. `GET /v1/documents/:id/ocr`
5. `GET /v1/containers/:containerNo/dossier`
6. `GET /v1/reconciliations` (list)
7. `GET /v1/reconciliations/:id`

NOT touched: `GET /v1/reconciliations/:id/evidence` (Task 4 — has a real field-officer use case), all POST/write routes (already correctly gated), `GET /v1/admin/dashboard/summary` and `GET /v1/admin/notifications` (pre-existing `require('supervisor')` gates that also block auditor — a separate, undocumented gap not in scope for this stage; leave as-is).

- [ ] **Step 1: Write the failing authorization tests**

Create `packages/api/src/__tests__/readAuthorization.test.ts`:

```ts
/**
 * P1 fix: a field officer must not have organization-wide read access to
 * trade documents and reconciliation history. Mobile app (packages/mobile)
 * never calls any of these routes — an officer's whole legitimate surface is
 * scan sync, evidence upload, and (per Task 4) their own submitted evidence.
 * supervisor/admin/auditor keep full read access, matching docs/security.md's
 * "auditors read everything and change nothing".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { hashPassword } from '../lib/auth.ts';
import { createServer } from '../server.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;
let officerToken: string;
let supervisorToken: string;
let adminToken: string;
let auditorToken: string;
let containerNo: string;

before(async () => {
  process.env.JWT_SECRET = 'read-authz-test-secret';
  db = openDb(':memory:');
  fixture = seed(db);

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;

  const login = async (email: string) =>
    (await api('POST', '/v1/auth/login', { email, password: SEED_PASSWORD })).json.accessToken;

  officerToken = await login('officer@dp-logistics.example');
  supervisorToken = await login('supervisor@dp-logistics.example');
  adminToken = await login('admin@dp-logistics.example');
  auditorToken = await login('auditor@dp-logistics.example');

  const lines = (await api('GET', `/v1/sync/reports?locationId=${fixture.locationId}`,
    undefined, officerToken)).json.lines;
  containerNo = lines[0].container_no;
});

after(() => {
  server?.close();
  db?.close();
});

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const READ_ROUTES: { name: string; path: () => string }[] = [
  { name: 'document list', path: () => '/v1/documents' },
  { name: 'documents for entity', path: () => `/v1/documents/for/container/${containerNo}` },
  { name: 'container dossier', path: () => `/v1/containers/${containerNo}/dossier` },
  { name: 'reconciliation list', path: () => '/v1/reconciliations' },
];

describe('organization-wide document/reconciliation reads', () => {
  for (const route of READ_ROUTES) {
    test(`field officer cannot access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, officerToken);
      assert.equal(result.status, 403, `${route.name} must be forbidden to a field officer`);
    });

    test(`supervisor can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, supervisorToken);
      assert.equal(result.status, 200, `${route.name} must remain reachable to a supervisor`);
    });

    test(`admin can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, adminToken);
      assert.equal(result.status, 200, `${route.name} must remain reachable to an admin`);
    });

    test(`auditor can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, auditorToken);
      assert.equal(result.status, 200,
        `${route.name} must remain reachable to an auditor — auditor is documented as read-only across everything`);
    });

    test(`unauthenticated requests to ${route.name} are rejected`, async () => {
      const result = await api('GET', route.path());
      assert.equal(result.status, 401);
    });
  }

  test('field officer cannot view a document by id', async () => {
    // No document exists yet for this fresh id — a 403 must still come back
    // before a 404 would, so the officer learns nothing about what exists.
    const result = await api('GET', `/v1/documents/${randomUUID()}/view`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test('field officer cannot read a document\'s OCR state', async () => {
    const result = await api('GET', `/v1/documents/${randomUUID()}/ocr`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test('field officer cannot read an individual reconciliation record', async () => {
    const result = await api('GET', `/v1/reconciliations/${randomUUID()}`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test('supervisor can read an individual reconciliation record after it exists', async () => {
    const sessionId = randomUUID();
    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: sessionId, locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: randomUUID(), scanType: 'container', finalValue: containerNo,
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: (await api(
              'GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, officerToken,
            )).json.lines.find((l: any) => l.container_no === containerNo).vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, officerToken);

    const recon = db.prepare(
      'SELECT id FROM reconciliations WHERE session_id = ?',
    ).get(sessionId) as { id: string } | undefined;
    assert.ok(recon, 'setup: a reconciliation must have been created');

    const result = await api('GET', `/v1/reconciliations/${recon!.id}`, undefined, supervisorToken);
    assert.equal(result.status, 200);
  });

  test('cross-organization isolation: a second org\'s admin cannot see this org\'s documents', async () => {
    const otherOrgId = newId();
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
      .run(otherOrgId, 'Other Org', nowIso());

    const otherAdminId = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(otherAdminId, otherOrgId, 'admin@other-org.example',
          hashPassword(SEED_PASSWORD), 'Other Org Admin', 'admin', nowIso());

    const otherAdminToken = (await api('POST', '/v1/auth/login', {
      email: 'admin@other-org.example', password: SEED_PASSWORD,
    })).json.accessToken;

    const list = await api('GET', '/v1/documents', undefined, otherAdminToken);
    assert.equal(list.status, 200);
    assert.equal(list.json.documents.length, 0, 'a fresh org must see none of this org\'s documents');

    const reconList = await api('GET', '/v1/reconciliations', undefined, otherAdminToken);
    assert.equal(reconList.status, 200);
    assert.equal(reconList.json.reconciliations.length, 0,
      'a fresh org must see none of this org\'s reconciliations');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/readAuthorization.test.ts`
Expected: FAIL — every "field officer cannot access ..." assertion fails because the routes currently return 200/other for any authenticated user.

- [ ] **Step 3: Add the middleware and apply it**

In `packages/api/src/server.ts`, immediately after the existing `require` middleware definition (which ends around the line `};` following `require = (role: Role) => ...`), add:

```ts
  /**
   * supervisor/admin by rank, OR auditor.
   *
   * `atLeast()` cannot express this on its own — auditor shares field_officer's
   * rank (see auth.ts's RANK table and its comment) precisely so that ordinary
   * rank checks never accidentally grant it supervisor/admin power. Broad,
   * organization-wide *reads* are the one place auditor is documented
   * (docs/architecture.md, docs/security.md) to have full reach even though it
   * outranks nothing, so that reach is granted here explicitly.
   */
  const requireBroadReadAccess = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Authentication required');
    if (req.user.role === 'auditor' || atLeast(req.user.role, 'supervisor')) return next();
    return fail(res, 403, 'FORBIDDEN', 'Requires supervisor, admin, or auditor');
  };
```

Then change exactly these 7 route registrations (adding `requireBroadReadAccess` right after `authenticate`, no other change to each line):

```ts
  app.get('/v1/documents', authenticate, requireBroadReadAccess, (req, res) => {
```

```ts
  app.get('/v1/documents/:id/view', authenticate, requireBroadReadAccess, wrap(async (req, res) => {
```

```ts
  app.get('/v1/documents/for/:entityType/:entityId', authenticate, requireBroadReadAccess, (req, res) => {
```

```ts
  app.get('/v1/documents/:id/ocr', authenticate, requireBroadReadAccess, (req, res) => {
```

```ts
  app.get('/v1/containers/:containerNo/dossier', authenticate, requireBroadReadAccess, (req, res) => {
```

```ts
  app.get('/v1/reconciliations', authenticate, requireBroadReadAccess, (req, res) => {
```

```ts
  app.get('/v1/reconciliations/:id', authenticate, requireBroadReadAccess, (req, res) => {
```

Do not touch `GET /v1/reconciliations/:id/evidence` — that is Task 4.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/readAuthorization.test.ts src/__tests__/documents.test.ts src/__tests__/ocr.test.ts src/__tests__/e2e.test.ts`
Expected: PASS. Pay particular attention to `documents.test.ts` and `e2e.test.ts` — they use `adminToken`/`supervisorToken` against these routes throughout and must be unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/server.ts packages/api/src/__tests__/readAuthorization.test.ts
git commit -m "fix: restrict document/reconciliation reads to supervisor, admin, and auditor"
```

---

### Task 4: Location-scope field-officer access to reconciliation evidence

**Files:**
- Modify: `packages/api/src/server.ts` (the `GET /v1/reconciliations/:id/evidence` handler only)
- Modify: `packages/api/src/__tests__/evidence.test.ts` (add cross-location denial test; existing same-location test at line 498 must keep passing unchanged)

**Interfaces:**
- Consumes: `atLeast` (already imported), `AuthUser` (already imported), the `db` closed over by `createServer`.
- Produces: nothing consumed elsewhere.

`GET /v1/reconciliations/:id/evidence` is the one document/reconciliation read route with a proven field-officer use case: `evidence.test.ts`'s existing `'viewing evidence'` suite logs in as `officer@dp-logistics.example`, submits scans at `fixture.locationId` (which that officer is assigned to via `seed()`), and reads back that reconciliation's evidence expecting `200`. The fix here is narrower than Task 3: an officer may read evidence only for reconciliations whose scan session happened at a location they're assigned to (the existing `user_locations` table — the same mechanism `assertLocationAccess` already uses for `/v1/sync/reports` and `/v1/sync/scans`). supervisor/admin/auditor keep unrestricted reach, same as Task 3.

- [ ] **Step 1: Write the failing test**

In `packages/api/src/__tests__/evidence.test.ts`, inside the existing `describe('viewing evidence', ...)` block (after the `'unauthenticated requests are refused'` test, before its closing `});`), add:

```ts
  test('a field officer at a different location cannot read this evidence', async () => {
    // A fresh org+location+officer who has never touched fixture.locationId.
    const otherLocationId = newId();
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
      .run(otherLocationId, fixture.orgId, 'INOTHER', 'Other Gate');

    const outsiderId = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(outsiderId, fixture.orgId, 'outsider@dp-logistics.example',
          hashPassword(SEED_PASSWORD), 'Outsider Officer', 'field_officer', nowIso());
    db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)')
      .run(outsiderId, otherLocationId);

    const outsiderLogin = await api('POST', '/v1/auth/login', {
      email: 'outsider@dp-logistics.example', password: SEED_PASSWORD,
    });
    const outsiderToken = outsiderLogin.json.accessToken;

    const result = await api(
      'GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, outsiderToken);
    assert.equal(result.status, 404,
      'an officer not assigned to this reconciliation\'s location must not be able to tell it exists');
  });

  test('a supervisor can read evidence for any location in the org', async () => {
    const supervisorLogin = await api('POST', '/v1/auth/login', {
      email: 'supervisor@dp-logistics.example', password: SEED_PASSWORD,
    });
    const result = await api(
      'GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, supervisorLogin.json.accessToken);
    assert.equal(result.status, 200);
  });
```

Add the needed imports at the top of `evidence.test.ts` (it currently imports `{ openDb, type Db }` from `../lib/db.ts` and does not import `newId`, `nowIso`, or `hashPassword`):

```ts
import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { hashPassword } from '../lib/auth.ts';
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/evidence.test.ts`
Expected: The new `'a field officer at a different location cannot read this evidence'` test FAILS (gets 200, not 404). The new supervisor test should already PASS (supervisor is unrestricted today) — that's fine, it's there as a regression guard for Step 3.

- [ ] **Step 3: Add the location-scoped check**

In `packages/api/src/server.ts`, replace the `GET /v1/reconciliations/:id/evidence` handler:

```ts
  /** Viewing links for a reconciliation's images. Every issue is logged. */
  app.get('/v1/reconciliations/:id/evidence', authenticate, wrap(async (req, res) => {
    const items = await evidenceForReconciliation(db, req.user!.orgId, String(req.params.id), {
      id: req.user!.id,
      ip: req.ip ?? null,
    });
    if (!items) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.json({ evidence: items });
  }));
```

with:

```ts
  /**
   * Field officers may read evidence only for reconciliations whose scan
   * session happened at a location they're assigned to — the same
   * user_locations check assertLocationAccess already applies to sync.
   * supervisor/admin/auditor read any reconciliation in the org.
   */
  const canReadReconciliationEvidence = (user: AuthUser, sessionLocationId: string | null): boolean => {
    if (!sessionLocationId) return false;
    if (user.role === 'auditor' || atLeast(user.role, 'supervisor')) return true;
    const row = db
      .prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?')
      .get(user.id, sessionLocationId);
    return Boolean(row);
  };

  /** Viewing links for a reconciliation's images. Every issue is logged. */
  app.get('/v1/reconciliations/:id/evidence', authenticate, wrap(async (req, res) => {
    const reconciliation = db
      .prepare(
        `SELECT ss.location_id FROM reconciliations r
           JOIN scan_sessions ss ON ss.id = r.session_id
          WHERE r.id = ? AND r.org_id = ?`,
      )
      .get(String(req.params.id), req.user!.orgId) as { location_id: string } | undefined;

    // Same 404 whether the reconciliation doesn't exist, belongs to another
    // org (already excluded by the WHERE clause above), or exists but this
    // officer isn't assigned to its location — a 403 there would confirm the
    // record exists at all, which is exactly the information an unauthorized
    // reader should not get.
    if (!reconciliation || !canReadReconciliationEvidence(req.user!, reconciliation.location_id)) {
      return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    }

    const items = await evidenceForReconciliation(db, req.user!.orgId, String(req.params.id), {
      id: req.user!.id,
      ip: req.ip ?? null,
    });
    if (!items) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.json({ evidence: items });
  }));
```

Place `canReadReconciliationEvidence` right before this route (it is only used here), not up near `assertLocationAccess`, to keep the diff local to the one route it fixes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/api && node --experimental-strip-types --test src/__tests__/evidence.test.ts src/__tests__/readAuthorization.test.ts`
Expected: PASS — including the pre-existing same-location officer tests (lines 497, 514, 525, 547, 552 in the original file) which must be completely unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/server.ts packages/api/src/__tests__/evidence.test.ts
git commit -m "fix: scope field-officer reconciliation-evidence reads to their assigned locations"
```

---

### Task 5: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the complete API test suite**

Run: `cd packages/api && npm test`
Expected: every test file passes; total test count is 257 (previous baseline) plus every test added in Tasks 1–4; zero failing; zero skipped beyond whatever was already skipped in the 257 baseline (check for any `.skip` in the diff — there should be none).

- [ ] **Step 2: API typecheck**

Run: `cd packages/api && npm run typecheck`
Expected: clean, no errors.

- [ ] **Step 3: Mobile typecheck**

Run: `cd packages/mobile && npm run typecheck`
Expected: clean, no errors. (No mobile source is touched by this plan — this just confirms nothing else in the workspace regressed, e.g. via a shared type change. There should be none, since only `packages/api` files are modified.)

- [ ] **Step 4: Whitespace hygiene**

Run: `git diff --check`
Expected: no output (clean).

- [ ] **Step 5: Final report**

Summarize for the user for the closing Stage 18 report — do not delete this checklist item, it is not a code step:
- Previous baseline (257) vs. new total, passing, failing, skipped.
- Every file changed and why.
- Every new test added, grouped by finding.
- Explicit confirmation no existing test was deleted, `.skip`ped, or weakened (e.g., diff each modified test file and confirm only additions).
- Anything considered but not changed (e.g., `GET /v1/admin/dashboard/summary` / `GET /v1/admin/notifications` blocking auditor — a real, separate gap, out of scope for Stage 18; the off-server-backups P1 — explicitly out of scope per the task brief).
- Final verdict: READY FOR REVIEW or BLOCKED, per the task brief's exact criteria.

Do not deploy. Do not push. Stop after this report.
