/**
 * getJwtSecret() must fail closed, unconditionally — no environment, and no
 * value of NODE_ENV in particular, may cause it to hand back a secret it
 * didn't read from JWT_SECRET. This is the regression test for that
 * property; see auth.ts's own comment on getJwtSecret for the history.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getJwtSecret, signAccessToken, verifyAccessToken, type AuthUser } from '../lib/auth.ts';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  delete process.env.JWT_SECRET;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;

  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

const user: AuthUser = {
  id: 'user-1', orgId: 'org-1', email: 'officer@dp-logistics.example',
  fullName: 'Test Officer', role: 'field_officer',
};

describe('getJwtSecret — fail-closed behaviour', () => {
  test('missing JWT_SECRET throws, in every NODE_ENV — never a hardcoded fallback', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'staging', 'production', 'PRODUCTION', '']) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      assert.throws(
        () => getJwtSecret(),
        /JWT_SECRET is not set/,
        `expected getJwtSecret() to throw with NODE_ENV=${JSON.stringify(nodeEnv)}`,
      );
    }
  });

  test('empty JWT_SECRET throws, regardless of NODE_ENV', () => {
    process.env.JWT_SECRET = '';
    assert.throws(() => getJwtSecret(), /JWT_SECRET is not set/);

    process.env.NODE_ENV = 'development';
    assert.throws(() => getJwtSecret(), /JWT_SECRET is not set/);
  });

  test('whitespace-only JWT_SECRET is treated as empty', () => {
    process.env.JWT_SECRET = '   ';
    assert.throws(() => getJwtSecret(), /JWT_SECRET is not set/);
  });

  test('no hardcoded secret string can ever be returned', () => {
    // The old fallback value must never come back from this function, under
    // any environment configuration — the only way to get a secret out of
    // it is to actually set one.
    for (const nodeEnv of [undefined, 'development', 'production']) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      assert.throws(() => getJwtSecret());
    }
  });

  test('a real, non-empty JWT_SECRET is accepted and returned verbatim (trimmed)', () => {
    process.env.JWT_SECRET = 'a-real-configured-secret';
    assert.equal(getJwtSecret(), 'a-real-configured-secret');
  });

  test('NODE_ENV plays no role once a real secret is set', () => {
    process.env.JWT_SECRET = 'a-real-configured-secret';
    for (const nodeEnv of [undefined, 'development', 'production', 'anything-else']) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;

      assert.equal(getJwtSecret(), 'a-real-configured-secret');
    }
  });
});

describe('signAccessToken / verifyAccessToken — behaviour preserved under the fix', () => {
  test('signing throws when no secret is configured — no token is ever issued', () => {
    assert.throws(() => signAccessToken(user));
  });

  test('with a configured secret, claims, expiry and device binding round-trip unchanged', () => {
    process.env.JWT_SECRET = 'a-real-configured-secret';

    const token = signAccessToken(user, 'device-row-42');
    const claims = verifyAccessToken(token);

    assert.ok(claims);
    assert.equal(claims!.sub, user.id);
    assert.equal(claims!.org, user.orgId);
    assert.equal(claims!.role, user.role);
    assert.equal(claims!.did, 'device-row-42');
  });

  test('a token signed under one secret does not verify under another', () => {
    process.env.JWT_SECRET = 'secret-a';
    const token = signAccessToken(user);

    process.env.JWT_SECRET = 'secret-b';
    assert.equal(verifyAccessToken(token), null);
  });

  test('verification fails closed (returns null, does not throw) when no secret is configured', () => {
    process.env.JWT_SECRET = 'a-real-configured-secret';
    const token = signAccessToken(user);

    delete process.env.JWT_SECRET;
    // verifyAccessToken wraps jwt.verify in try/catch; getJwtSecret's throw
    // is caught there and surfaces as an unverifiable token, not a crash.
    assert.equal(verifyAccessToken(token), null);
  });
});
