/**
 * POST /v1/auth/login over the real HTTP surface, exercising the rate limiter
 * as a client actually would. Window-expiry and multi-key-independence are
 * covered at the unit level (rateLimit.test.ts) with synthetic timestamps —
 * these tests only need to prove the wiring: the route actually calls the
 * limiter, returns 429 with Retry-After, and never reveals account existence.
 *
 * Each test gets its own server (and therefore its own rate-limiter instance,
 * since createServer() builds a fresh one). All requests in this file come
 * from the same loopback address, so sharing one server across tests would
 * mean one test's login attempts eat into another's IP budget — exactly the
 * kind of cross-test contamination a real shared-IP budget is supposed to
 * apply to real traffic, not to unrelated test cases.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { openDb, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD } from '../lib/seed.ts';
import { createServer } from '../server.ts';
import { LOGIN_IDENTIFIER_MAX_ATTEMPTS } from '../lib/rateLimit.ts';

async function withServer(fn: (login: (email: string, password: string) => Promise<{
  status: number;
  retryAfter: string | null;
  json: any;
}>) => Promise<void>) {
  process.env.JWT_SECRET = 'login-rate-limit-test-secret';
  const db: Db = openDb(':memory:');
  seed(db);

  const server: Server = await new Promise((resolve) => {
    const s = createServer(db).listen(0, () => resolve(s));
  });
  const address = server.address();
  const baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;

  const login = async (email: string, password: string) => {
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
  };

  try {
    await fn(login);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

describe('login rate limiting', () => {
  test('a legitimate officer can still log in normally', async () => {
    await withServer(async (login) => {
      const result = await login('officer@dp-logistics.example', SEED_PASSWORD);
      assert.equal(result.status, 200);
      assert.ok(result.json.accessToken);
    });
  });

  test('repeated wrong-password attempts for one identifier are throttled and return 429', async () => {
    await withServer(async (login) => {
      const email = 'throttle-target@dp-logistics.example';
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
  });

  test('rotating the identifier alone cannot outrun the IP budget', async () => {
    await withServer(async (login) => {
      // A fresh, distinct email on every attempt — only the client IP (the
      // test's own loopback address) stays constant.
      let sawThrottle = false;
      for (let i = 0; i < 40; i++) {
        const result = await login(`spray-${i}@dp-logistics.example`, 'wrong');
        if (result.status === 429) { sawThrottle = true; break; }
        assert.equal(result.status, 401);
      }
      assert.ok(sawThrottle, 'spraying distinct identifiers from one IP must eventually be throttled');
    });
  });

  test('throttling does not reveal whether the account exists', async () => {
    await withServer(async (login) => {
      const unknownEmail = 'no-such-account@dp-logistics.example';
      let unknownResult;
      for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3; i++) {
        unknownResult = await login(unknownEmail, 'wrong');
        if (unknownResult.status === 429) break;
      }
      assert.equal(unknownResult!.status, 429);
      assert.equal(unknownResult!.json.error.code, 'TOO_MANY_ATTEMPTS');

      await withServer(async (login2) => {
        const knownEmail = 'admin@dp-logistics.example';
        let knownResult;
        for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS + 3; i++) {
          knownResult = await login2(knownEmail, 'wrong');
          if (knownResult.status === 429) break;
        }
        // Both an unknown account and a known one, hammered the same way,
        // must end up throttled with byte-identical error bodies.
        assert.equal(knownResult!.status, 429);
        assert.deepEqual(knownResult!.json, unknownResult!.json);
      });
    });
  });

  test('a successful login is still possible right after a couple of failed attempts', async () => {
    await withServer(async (login) => {
      const email = 'supervisor@dp-logistics.example';
      await login(email, 'wrong-once');
      await login(email, 'wrong-twice');

      const result = await login(email, SEED_PASSWORD);
      assert.equal(result.status, 200, 'a couple of typos must not lock out the real password');
    });
  });

  test('a successful login does not create a denial-of-service for the next login', async () => {
    await withServer(async (login) => {
      const email = 'officer@dp-logistics.example';
      for (let i = 0; i < LOGIN_IDENTIFIER_MAX_ATTEMPTS - 1; i++) {
        const result = await login(email, SEED_PASSWORD);
        assert.equal(result.status, 200, 'repeated successful logins must not exhaust the budget');
      }
    });
  });
});
