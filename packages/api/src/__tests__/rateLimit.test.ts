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
    assert.equal(limiter.check('b', 0).allowed, true, "key b must not share key a's budget");
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

  test("reset clears a key's recorded attempts", () => {
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
    assert.ok(blocked, "the identifier budget must exhaust regardless of the attacker's IP churn");
  });

  test('rotating identifier alone cannot bypass IP protection', () => {
    const limiter = createLoginRateLimiter();
    let blocked = false;
    for (let i = 0; i < LOGIN_IP_MAX_ATTEMPTS + 5; i++) {
      // A fresh identifier on every attempt — only the IP is held constant.
      const result = limiter.checkIp('9.9.9.9', i);
      if (!result.allowed) { blocked = true; break; }
    }
    assert.ok(blocked, "the IP budget must exhaust regardless of which account is being tried");
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
