/**
 * Authentication: password hashing, JWT access tokens, rotating refresh tokens.
 *
 * Access tokens are short (15 min) and refresh tokens long (30 days) on
 * purpose — an officer must never be re-authenticating at a gate, but a stolen
 * access token must expire fast.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { type Db, newId, nowIso } from './db.ts';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

export type Role = 'field_officer' | 'supervisor' | 'admin' | 'auditor';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  fullName: string;
  role: Role;
}

export interface AccessClaims {
  sub: string;
  org: string;
  role: Role;
  /** devices.id — present only when the login that minted this token carried a deviceId. */
  did?: string;
}

/* ------------------------------------------------------------------ *
 * Passwords
 * ------------------------------------------------------------------ */

const SCRYPT_KEYLEN = 64;

/**
 * scrypt via node:crypto — no native dependency, and memory-hard.
 * Production should move to argon2id; the stored format is prefixed so both
 * can coexist during a migration.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expectedBuf = Buffer.from(expected, 'hex');

  // Length check first: timingSafeEqual throws on a length mismatch.
  if (derived.length !== expectedBuf.length) return false;
  return timingSafeEqual(derived, expectedBuf);
}

/* ------------------------------------------------------------------ *
 * Access tokens
 * ------------------------------------------------------------------ */

/**
 * Fails closed, in every environment, with no fallback.
 *
 * Gating this on NODE_ENV === 'production' was the bug: an unset, misspelled,
 * or otherwise non-'production' NODE_ENV silently accepted a hardcoded,
 * source-controlled secret ('dev-only-insecure-secret') — predictable by
 * anyone who reads this file, in whatever environment actually ran with it.
 * A real secret is required unconditionally instead. Local development sets
 * its own JWT_SECRET (any non-empty value); there is no environment where
 * this function will hand back a secret it didn't read from the process.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to sign or verify tokens without a configured secret.',
    );
  }
  return secret;
}

export function signAccessToken(user: AuthUser, deviceRowId?: string): string {
  const claims: AccessClaims = { sub: user.id, org: user.orgId, role: user.role };
  if (deviceRowId) claims.did = deviceRowId;
  return jwt.sign(claims, getJwtSecret(), { expiresIn: ACCESS_TTL_SECONDS });
}

export function verifyAccessToken(token: string): AccessClaims | null {
  try {
    return jwt.verify(token, getJwtSecret()) as AccessClaims;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Refresh tokens — stored hashed, rotated on every use
 * ------------------------------------------------------------------ */

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function issueRefreshToken(db: Db, userId: string, deviceRowId?: string | null): string {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();

  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at, device_row_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(newId(), userId, hashToken(token), expiresAt, nowIso(), deviceRowId ?? null);

  return token;
}

/**
 * Consumes a refresh token and issues a replacement.
 *
 * Rotation is unconditional: a refresh token is single-use, so a replayed one
 * is evidence of theft rather than a benign retry.
 *
 * A refresh token minted for a device that has since been revoked (or never
 * approved) must not be allowed to mint a fresh access token — otherwise a
 * rejected device could simply outlive its 15-minute access token instead of
 * being cut off, via the refresh path alone.
 */
export function rotateRefreshToken(
  db: Db,
  token: string,
): { userId: string; refreshToken: string; deviceRowId: string | null } | null {
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at, device_row_id
         FROM refresh_tokens WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null; device_row_id: string | null }
    | undefined;

  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  if (row.device_row_id) {
    const device = db
      .prepare('SELECT approved_at, revoked_at FROM devices WHERE id = ?')
      .get(row.device_row_id) as { approved_at: string | null; revoked_at: string | null } | undefined;
    if (!device || device.revoked_at || !device.approved_at) return null;
  }

  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
  return {
    userId: row.user_id,
    refreshToken: issueRefreshToken(db, row.user_id, row.device_row_id),
    deviceRowId: row.device_row_id,
  };
}

export function revokeRefreshToken(db: Db, token: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(nowIso(), hashToken(token));
}

/* ------------------------------------------------------------------ *
 * Role checks
 * ------------------------------------------------------------------ */

const RANK: Record<Role, number> = {
  field_officer: 1,
  auditor: 1,
  supervisor: 2,
  admin: 3,
};

/**
 * Note this is a rank comparison, so it is only meaningful within the
 * officer → supervisor → admin chain. `auditor` is a sibling of field_officer
 * with read-only reach, never an escalation path — route auditor access through
 * an explicit role check, not through this helper.
 */
export const atLeast = (role: Role, required: Role): boolean => RANK[role] >= RANK[required];
