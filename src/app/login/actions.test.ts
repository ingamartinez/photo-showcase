import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import { requestMagicLink } from "./actions";

const signInMock = vi.fn();
const cookieDeleteMock = vi.fn();

// The action normalizes its own response cookies (see src/lib/auth-cookies.ts).
// The real `next/headers` only works inside a Next.js request, so stand in for
// the response cookie jar and record what the action does to it.
vi.mock("next/headers", () => ({
  cookies: async () => ({ delete: cookieDeleteMock }),
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
    });
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
