import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import { requestMagicLink } from "./actions";
import { EMAIL_LIMIT, IP_LIMIT, emailLimiter, ipLimiter } from "@/lib/login-rate-limiters";

const signInMock = vi.fn();
const cookieDeleteMock = vi.fn();
const mockRequestIp = "203.0.113.7";

// The action normalizes its own response cookies (see src/lib/auth-cookies.ts)
// and reads the caller's IP for rate limiting (see src/lib/rate-limit.ts). The
// real `next/headers` only works inside a Next.js request, so stand in for the
// response cookie jar and the request header set alike. Every test in this
// file shares one IP on purpose — see the top-level `beforeEach` below for why
// that's safe.
vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: cookieDeleteMock }),
  headers: async () => new Headers({ "x-forwarded-for": mockRequestIp }),
}));

// src/auth.ts's DB/env wiring is irrelevant here — mock the module boundary
// so this stays a fast, deterministic unit test of the action's own logic
// (validation + AuthError handling), not an integration test of NextAuth.
vi.mock("@/auth", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));

// next-auth's real barrel unconditionally imports next/server, next/headers,
// etc., which don't resolve outside an actual Next.js runtime — importing it
// (even transitively, via actions.ts) breaks under Vitest. Stub just the one
// export this test and actions.ts both need; both resolve to this same
// mocked module, so `instanceof AuthError` still holds.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

beforeAll(() => {
  // Read lazily inside clearAuthCallbackUrlCookie(), never at module scope.
  vi.stubEnv("AUTH_SECRET", "test-secret-at-least-32-characters-long");
  vi.stubEnv("AUTH_URL", "http://localhost:3300");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  cookieDeleteMock.mockReset();

  // `emailLimiter` and `ipLimiter` (src/lib/login-rate-limiters.ts) are
  // module-scope singletons — the same object is shared by every test in
  // this file, exactly as it is by every request in production. Without
  // this reset, tests would silently share one rate-limit budget: an
  // ordinary new test reusing "client@example.com" could push an unrelated,
  // earlier-declared test's call past the limit and make `signIn` stop
  // being invoked for it — not with a "rate limited" error, but with the
  // SAME successful-looking `{ status: "sent" }` this slice deliberately
  // returns on throttle. That is silent, and specifically the failure mode
  // this rate limiter must never have: a passing test suite that no longer
  // actually exercises the anti-enumeration branches it claims to (see the
  // "rate limiter reset" describe block at the bottom of this file, which
  // proves this reset is load-bearing).
  emailLimiter.reset();
  ipLimiter.reset();
});

function formDataWith(email: unknown) {
  const data = new FormData();
  if (typeof email === "string") data.set("email", email);
  return data;
}

describe("requestMagicLink", () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  it("rejects an invalid address without ever calling signIn", async () => {
    const result = await requestMagicLink({ status: "idle" }, formDataWith("not-an-email"));

    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("rejects a missing address without ever calling signIn", async () => {
    const result = await requestMagicLink({ status: "idle" }, formDataWith(undefined));

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("returns the confirmation state for a known address", async () => {
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");

    const result = await requestMagicLink({ status: "idle" }, formDataWith("client@example.com"));

    expect(result).toEqual({ status: "sent" });
    expect(signInMock).toHaveBeenCalledWith("resend", {
      email: "client@example.com",
      redirect: false,
      redirectTo: "/login/redirect",
    });
  });

  // Task #17's fix for #9's round-2 review note: without an explicit
  // `redirectTo`, `signIn()`'s `redirect: false` path still falls back to
  // the `Referer` header (see `next-auth/lib/actions.js`), so the magic
  // link's baked-in `callbackUrl` would resolve to wherever this action
  // happened to be called from — `/login` in practice, bouncing a
  // successful login right back to the entrance. Asserted as its own test,
  // separate from the equality check above, so it fails with a readable
  // message if `redirectTo` is ever dropped instead of silently passing a
  // now-vacuous object match.
  it("passes an explicit redirectTo so a successful login lands on the post-login dispatcher, not back on /login", async () => {
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");

    await requestMagicLink({ status: "idle" }, formDataWith("client@example.com"));

    const [, options] = signInMock.mock.calls[0] as [string, { redirectTo?: string }];
    expect(options.redirectTo).toBe("/login/redirect");
  });

  // Task #87's acceptance criterion, asserted directly rather than by
  // inspection: the redirect target must not depend on WHICH address is
  // signing in. If this action looked up the address's role here to pick a
  // role-specific `redirectTo` (the "obvious fix" the task's own trap warns
  // against), an admin address and a client address would produce different
  // values below and this test would catch it — the role dispatch belongs
  // to src/app/(marketing)/login/redirect/page.tsx, which only runs AFTER a
  // session exists, not to this pre-authentication request path.
  it("passes the SAME redirectTo for every address, admin-looking or client-looking alike", async () => {
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");

    await requestMagicLink({ status: "idle" }, formDataWith("admin@example.com"));
    const [, adminOptions] = signInMock.mock.calls[0] as [string, { redirectTo?: string }];

    signInMock.mockClear();
    await requestMagicLink({ status: "idle" }, formDataWith("client@example.com"));
    const [, clientOptions] = signInMock.mock.calls[0] as [string, { redirectTo?: string }];

    expect(adminOptions.redirectTo).toBe(clientOptions.redirectTo);
    expect(adminOptions.redirectTo).toBe("/login/redirect");
  });

  it("swallows the AuthError thrown for an unknown address and returns the SAME confirmation state", async () => {
    signInMock.mockRejectedValue(new AuthError("AccessDenied"));

    const result = await requestMagicLink({ status: "idle" }, formDataWith("ghost@example.com"));

    // This is the anti-enumeration guarantee: identical output whether the
    // signIn callback in src/auth.ts accepted or refused the address.
    expect(result).toEqual({ status: "sent" });
  });

  it("rethrows errors that are not an AuthError", async () => {
    signInMock.mockRejectedValue(new Error("network down"));

    await expect(
      requestMagicLink({ status: "idle" }, formDataWith("client@example.com")),
    ).rejects.toThrow("network down");
  });
});

describe("requestMagicLink anti-enumeration response headers", () => {
  // Identical wording and identical latency still leak if the HTTP headers
  // differ. Auth.js sets its callback-url cookie only when the address is
  // accepted — on refusal `sendToken()` throws before the cookie list is
  // returned — so a known address answers with a Set-Cookie and an unknown one
  // with none. Perfectly readable with curl; `httpOnly` protects nothing here.
  //
  // These assertions are deliberately exact rather than "both are equal":
  // if the normalization were deleted outright, both paths would emit nothing
  // and an equality-only test would still pass.
  const expectedClear = [
    {
      name: "authjs.callback-url",
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
    },
  ];

  beforeEach(() => {
    signInMock.mockReset();
  });

  it("clears the Auth.js callback-url cookie for a known address", async () => {
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");

    await requestMagicLink({ status: "idle" }, formDataWith("client@example.com"));

    expect(cookieDeleteMock.mock.calls).toEqual([expectedClear]);
  });

  it("clears the SAME cookie, the SAME way, for an unknown address", async () => {
    signInMock.mockRejectedValue(new AuthError("AccessDenied"));

    await requestMagicLink({ status: "idle" }, formDataWith("ghost@example.com"));

    expect(cookieDeleteMock.mock.calls).toEqual([expectedClear]);
  });

  it("clears it even when signIn fails for an unrelated reason", async () => {
    // Otherwise "the mail provider is down" would become its own oracle: the
    // rethrown failure would be the only response without the header.
    signInMock.mockRejectedValue(new Error("network down"));

    await expect(
      requestMagicLink({ status: "idle" }, formDataWith("client@example.com")),
    ).rejects.toThrow("network down");
    expect(cookieDeleteMock.mock.calls).toEqual([expectedClear]);
  });
});

describe("requestMagicLink anti-enumeration timing floor", () => {
  // Same wording is not enough — a known address that waits on a real
  // Resend round trip and an unknown one rejected in a few ms by the signIn
  // callback would otherwise be trivially distinguishable by response time
  // alone. Fake timers let us prove the floor without a real 700ms sleep per
  // test.
  beforeEach(() => {
    signInMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds the response for the floor even when signIn resolves instantly", async () => {
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");
    let resolved = false;
    const pending = requestMagicLink({ status: "idle" }, formDataWith("client@example.com")).then(
      (result) => {
        resolved = true;
        return result;
      },
    );

    await vi.advanceTimersByTimeAsync(650);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "sent" });
    expect(resolved).toBe(true);
  });

  it("holds the response for the SAME floor when the address is unknown (swallowed AuthError)", async () => {
    signInMock.mockRejectedValue(new AuthError("AccessDenied"));
    let resolved = false;
    const pending = requestMagicLink({ status: "idle" }, formDataWith("ghost@example.com")).then(
      (result) => {
        resolved = true;
        return result;
      },
    );

    await vi.advanceTimersByTimeAsync(650);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ status: "sent" });
    expect(resolved).toBe(true);
  });

  it("does not delay a client-side validation error", async () => {
    // There's nothing to hide here — the request never reaches signIn, so
    // there's no known/unknown timing signal to normalize.
    const result = await requestMagicLink({ status: "idle" }, formDataWith("not-an-email"));

    expect(result.status).toBe("error");
    expect(signInMock).not.toHaveBeenCalled();
  });
});

describe("requestMagicLink rate limiting", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");
  });

  // Every submission below carries the real 700ms anti-enumeration floor
  // (see actions.ts's MIN_RESPONSE_MS). Fake timers keep a multi-submission
  // test fast and deterministic instead of a real multi-second sleep — the
  // same technique the timing-floor describe block above already uses.
  async function submit(email: string) {
    const pending = requestMagicLink({ status: "idle" }, formDataWith(email));
    await vi.advanceTimersByTimeAsync(700);
    return pending;
  }

  it(`sends mail for the ${EMAIL_LIMIT}th request to one address but not the ${EMAIL_LIMIT + 1}th (the boundary)`, async () => {
    const email = "address-boundary@example.com";
    vi.useFakeTimers();

    try {
      for (let i = 0; i < EMAIL_LIMIT; i++) {
        expect(await submit(email)).toEqual({ status: "sent" });
      }
      expect(signInMock).toHaveBeenCalledTimes(EMAIL_LIMIT);

      signInMock.mockClear();
      const throttled = await submit(email);

      // Exceeding the limit stops sending mail...
      expect(signInMock).not.toHaveBeenCalled();
      // ...but the response is indistinguishable from an accepted one.
      expect(throttled).toEqual({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });

  it(`sends mail for the ${IP_LIMIT}th request from one IP but not the ${IP_LIMIT + 1}th, even for a brand-new address`, async () => {
    vi.useFakeTimers();

    try {
      for (let i = 0; i < IP_LIMIT; i++) {
        // A different address on every call: this proves the IP bucket, not
        // the (per-address) email bucket, is what eventually blocks — each
        // of these addresses is well within its own individual limit.
        expect(await submit(`ip-boundary-${i}@example.com`)).toEqual({ status: "sent" });
      }
      expect(signInMock).toHaveBeenCalledTimes(IP_LIMIT);

      signInMock.mockClear();
      const throttled = await submit(`ip-boundary-${IP_LIMIT}@example.com`);

      expect(signInMock).not.toHaveBeenCalled();
      expect(throttled).toEqual({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });

  // This is the sharpest edge of this slice: the rate limiter runs BEFORE
  // the Resend call, so a throttled request finishes signIn-free almost
  // instantly on its own. Skipping the timing floor on that path — an easy
  // mistake, an early `return` on throttle — would reopen exactly the
  // response-time oracle #9/#43 closed, just keyed off request count
  // instead of address existence.
  it("takes the SAME amount of time to respond whether accepted or throttled by the per-address limit", async () => {
    const email = "timing-boundary@example.com";
    vi.useFakeTimers();

    try {
      for (let i = 0; i < EMAIL_LIMIT; i++) {
        await submit(email);
      }

      signInMock.mockClear();
      let resolved = false;
      const throttled = requestMagicLink({ status: "idle" }, formDataWith(email)).then((result) => {
        resolved = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(650);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(await throttled).toEqual({ status: "sent" });
      expect(resolved).toBe(true);
      expect(signInMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes address case before bucketing, so varying case can't be used to dodge the per-address limit", async () => {
    const casings = ["Case@Example.com", "case@example.com", "CASE@EXAMPLE.COM"];
    vi.useFakeTimers();

    try {
      for (const email of casings) {
        expect(await submit(email)).toEqual({ status: "sent" });
      }
      expect(signInMock).toHaveBeenCalledTimes(EMAIL_LIMIT);

      signInMock.mockClear();
      const throttled = await submit("CaSe@ExAmPlE.CoM"); // yet another casing of the SAME address

      expect(signInMock).not.toHaveBeenCalled();
      expect(throttled).toEqual({ status: "sent" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("requestMagicLink rate limiter reset between tests", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInMock.mockResolvedValue("https://alejoframes.com/api/auth/verify-request");
  });

  // "client@example.com" is reused by several tests earlier in this file
  // (at least 3 real submissions to it above, on top of whatever else
  // shares this file's single mocked IP). Without the top-level
  // `beforeEach` resetting `emailLimiter`/`ipLimiter` before EVERY test,
  // this address's budget would already be exhausted by the time this test
  // runs — `signIn` would silently never be called, and this assertion
  // would fail. Delete that reset (or the `ipLimiter.reset()` call inside
  // it) to see this go red; that is the point of this test existing.
  it("starts with a full rate-limit budget, proving the top-level reset actually runs", async () => {
    const result = await requestMagicLink({ status: "idle" }, formDataWith("client@example.com"));

    expect(result).toEqual({ status: "sent" });
    expect(signInMock).toHaveBeenCalledTimes(1);
  });
});
