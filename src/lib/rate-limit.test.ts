import { describe, expect, it } from "vitest";
import { createRateLimiter, getClientIp } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows calls up to the limit, then blocks the next one (the boundary)", () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000 });

    expect(limiter.check("a").allowed).toBe(true); // 1st
    expect(limiter.check("a").allowed).toBe(true); // 2nd
    expect(limiter.check("a").allowed).toBe(true); // 3rd — AT the limit, still allowed
    const fourth = limiter.check("a"); // 4th — PAST the limit, blocked
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("keeps separate counts per key", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true); // different key, own bucket
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(false);
  });

  it("resets the count once the window has elapsed", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    const start = 1_000_000;

    expect(limiter.check("a", start).allowed).toBe(true);
    expect(limiter.check("a", start + 500).allowed).toBe(false); // still inside the window

    // Exactly at resetAt (start + windowMs): the window has elapsed, so this
    // starts a fresh bucket rather than being blocked.
    expect(limiter.check("a", start + 1000).allowed).toBe(true);
  });

  it("reports retryAfterMs as the time remaining until the window resets", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    const start = 1_000_000;

    limiter.check("a", start);
    const blocked = limiter.check("a", start + 300);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(700);
  });

  it("does not let one limiter instance's counts leak into another", () => {
    const limiterOne = createRateLimiter({ limit: 1, windowMs: 1000 });
    const limiterTwo = createRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiterOne.check("a").allowed).toBe(true);
    expect(limiterOne.check("a").allowed).toBe(false);
    // Independent store: same key, but a fresh limiter's own bucket.
    expect(limiterTwo.check("a").allowed).toBe(true);
  });

  it("reset() clears every bucket, restoring the full budget for every key", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });

    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false); // both exhausted
    expect(limiter.check("b").allowed).toBe(false);

    limiter.reset();

    expect(limiter.check("a").allowed).toBe(true); // fresh budget again
    expect(limiter.check("b").allowed).toBe(true);
  });
});

describe("getClientIp", () => {
  it("reads the value Caddy sets from Cloudflare's CF-Connecting-IP", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("takes the first entry if the header is ever a chain", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(getClientIp(headers)).toBe("203.0.113.7");
  });

  it("falls back to a sentinel when the header is missing (e.g. local dev)", () => {
    const headers = new Headers();
    expect(getClientIp(headers)).toBe("unknown");
  });
});
