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
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly maxTrackedKeys: number;

  constructor(windowMs: number, maxAttempts: number, maxTrackedKeys: number = RATE_LIMIT_MAX_TRACKED_KEYS) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.maxTrackedKeys = maxTrackedKeys;
  }

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
