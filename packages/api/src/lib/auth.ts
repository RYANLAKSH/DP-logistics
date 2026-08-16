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

export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;

  if (process.env.NODE_ENV === 'production') {
    // Refusing to boot is the correct behaviour: a generated secret would
    // silently invalidate every token on restart and, worse, would be
    // predictable if this ever ran with a fixed fallback.
    throw new Error('JWT_SECRET must be set in production');
  }
  return 'dev-only-insecure-secret';
}

export function signAccessToken(user: AuthUser): string {
  const claims: AccessClaims = { sub: user.id, org: user.orgId, role: user.role };
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

export function issueRefreshToken(db: Db, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();

  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(newId(), userId, hashToken(token), expiresAt, nowIso());

  return token;
}

/**
 * Consumes a refresh token and issues a replacement.
 *
 * Rotation is unconditional: a refresh token is single-use, so a replayed one
 * is evidence of theft rather than a benign retry.
 */
export function rotateRefreshToken(
  db: Db,
  token: string,
): { userId: string; refreshToken: string } | null {
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;

  if (!row || row.revoked_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { userId: row.user_id, refreshToken: issueRefreshToken(db, row.user_id) };
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
