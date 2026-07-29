// In-memory fixed-window rate limiter.
//
// Task #12: the login form's magic-link request must not become a mail
// cannon — every submission for a KNOWN address sends a real Resend email,
// and the photographer's address is public on Instagram. This module is the
// generic counting primitive; `src/app/(marketing)/login/actions.ts` wires
// it to an address bucket and an IP bucket.
//
// Store: a plain `Map` kept in module scope, one per `createRateLimiter()`
// call. A single Next.js process serves this app today, so that is
// genuinely sufficient — every request lands on the same process, so the
// same `Map` sees every count. It stops being correct the moment there is a
// SECOND process sharing traffic for the same limiter (horizontal scaling,
// or two instances briefly overlapping during a rolling deploy): each
// process would keep its own independent counts, so the effective limit
// becomes N-per-process instead of N-total. If that ever happens, replace
// the `Map` with a shared store (Redis, or a Postgres table) behind the same
// `RateLimiter` interface — callers do not need to change.
//
// Expired buckets are only cleaned up lazily, when the SAME key is checked
// again after its window has passed. A key that is never revisited (e.g. an
// attacker who rotates through many distinct fake addresses) leaks its entry
// for the life of the process. That is an acceptable, bounded cost for this
// slice — each entry is a few bytes — but if unbounded cardinality ever
// becomes a real concern, add a periodic sweep.

export interface RateLimitResult {
  /** Whether this call is within the limit and should proceed. */
  allowed: boolean;
  /** Milliseconds until the window resets, only meaningful when `allowed` is false. */
  retryAfterMs: number;
}

export interface RateLimiterOptions {
  /** Maximum number of allowed calls per window, inclusive. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimiter {
  /**
   * Records one attempt for `key` and reports whether it is within the
   * limit. `now` is injectable for deterministic tests; defaults to the
   * real clock.
   */
  check(key: string, now?: number): RateLimitResult;

  /**
   * Clears every bucket, as if the limiter had just been created.
   *
   * Not used in production — the whole point there is that counts persist
   * across requests within the window. It exists for tests: a limiter
   * imported by application code (see src/lib/login-rate-limiters.ts) is a
   * module-scope singleton, so without an explicit reset every test in a
   * file would silently share one budget with every other test that came
   * before it. See actions.test.ts's top-level `beforeEach` for where this
   * is called, and its header comment for what stayed hidden before it was.
   */
  reset(): void;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Extracts the real client IP from `X-Forwarded-For`.
 *
 * This app sits behind Cloudflare -> Caddy -> Next.js. Caddy's config
 * (`infra/caddy/Caddyfile`) sets `X-Forwarded-For` to Cloudflare's
 * `CF-Connecting-IP`, overwriting whatever the TCP peer would otherwise
 * supply — so in production this header holds exactly one real client IP,
 * not an appended chain. Next's own `request.ip` / connection address is
 * always Caddy's loopback address (127.0.0.1), because Caddy is the actual
 * TCP peer for every request; using it would throttle every visitor as one
 * shared bucket, which defeats the point of a per-IP cap.
 *
 * Falls back to a fixed sentinel when the header is missing — local `bun
 * run dev` with no reverse proxy in front, or a request that reaches Next.js
 * some other way. Every such request then shares one bucket, which is an
 * acceptable dev-only default, not a production guarantee.
 */
export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (!forwardedFor) return "unknown";
  // Caddy's `header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}`
  // (no `+`/`-` prefix) SETS the header, it does not append — so today this
  // is always a single, trusted value, and taking the first (only) entry is
  // correct. Do NOT reuse this exact logic if a future proxy hop ever starts
  // APPENDING instead of overwriting: in an appended `X-Forwarded-For`
  // chain, the leftmost entry is the client-supplied, spoofable one — the
  // trusted hop closest to this server is the RIGHTMOST entry. Splitting
  // and taking `[0]` would silently start trusting attacker-controlled
  // input at that point.
  return forwardedFor.split(",")[0]?.trim() || "unknown";
}

/** Creates an isolated limiter with its own store — never shared across instances. */
export function createRateLimiter({ limit, windowMs }: RateLimiterOptions): RateLimiter {
  const store = new Map<string, Bucket>();

  return {
    check(key, now = Date.now()) {
      const bucket = store.get(key);

      if (!bucket || bucket.resetAt <= now) {
        // First call in a fresh window (or the previous window already
        // expired): start a new one-wide bucket.
        store.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }

      if (bucket.count < limit) {
        bucket.count += 1;
        return { allowed: true, retryAfterMs: 0 };
      }

      // At or past the limit: the request AT the limit was allowed above
      // (count incremented up to `limit`); this is the one PAST it.
      return { allowed: false, retryAfterMs: bucket.resetAt - now };
    },
    reset() {
      store.clear();
    },
  };
}
