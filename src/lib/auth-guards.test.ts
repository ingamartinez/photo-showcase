import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { NextResponse } from "next/server";
import { requireAdmin, requireApiSession, requireSession } from "./auth-guards";

// `import "server-only"` only resolves inside a real Next.js bundle (webpack
// aliases it away); Vitest never does, so it must be stubbed for anything
// that imports this module — see the removal experiment in the task report
// for what happens if this mock is dropped along with the guard's own logic.
vi.mock("server-only", () => ({}));

// `@/auth`'s `auth()` hits the real Auth.js pipeline (DB session lookup) —
// mock the module boundary so these stay fast, deterministic tests of THIS
// module's own decisions (redirect vs 403 vs pass-through), not an
// integration test of NextAuth. `redirect()` and `forbidden()` themselves are
// intentionally NOT mocked below: this suite asserts against the real
// `next/navigation` implementations, so a test only passes if this module
// actually calls them, not merely because a mock was configured to resolve.
const authMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));

// `forbidden()` throws "forbidden() is experimental..." unless this flag is
// set — in production it's a build-time constant baked in by
// `next.config.ts`'s `experimental.authInterrupts: true` (see
// `next/dist/build/define-env.js`), but Vitest never runs Next's build step,
// so the real runtime env var has to be stubbed here to exercise the same
// code path production actually takes.
beforeEach(() => {
  authMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("requireSession", () => {
  it("returns the session as-is when signed in", async () => {
    const session = sessionFor("client");
    authMock.mockResolvedValue(session);

    await expect(requireSession()).resolves.toBe(session);
  });

  // The redirect digest format (`NEXT_REDIRECT;<type>;<url>;<status>;`) is
  // produced by the real `redirect()` from `next/navigation` — see
  // `getRedirectError` in `next/dist/client/components/redirect.js`. Asserting
  // on it directly, rather than on a mock call, is what makes this fail if
  // the redirect is ever accidentally removed, swapped for a different
  // destination, or replaced with something that merely LOOKS like a
  // redirect in a mock.
  it("redirects to /login when there is no session", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireSession()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  // Database sessions exist so revocation is immediate: `auth()` must be
  // re-read on every call, never cached across invocations within the same
  // guard. This is the property that makes "the same cookie stops granting
  // access after sign-out" true — sign-out (src/lib/auth-actions.ts) deletes
  // the session ROW; this guard has no cache to invalidate because it never
  // trusts anything but the freshest read.
  it("re-reads auth() on every call instead of caching a prior result", async () => {
    const session = sessionFor("client");

    authMock.mockResolvedValueOnce(session);
    await expect(requireSession()).resolves.toBe(session);

    // Simulates the session row having been deleted between these two calls
    // (exactly what sign-out does) — if this guard cached its first answer,
    // this second call would wrongly resolve instead of redirecting.
    authMock.mockResolvedValueOnce(null);
    await expect(requireSession()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });

    expect(authMock).toHaveBeenCalledTimes(2);
  });
});

describe("requireApiSession", () => {
  it("returns the session as-is when signed in", async () => {
    const session = sessionFor("client");
    authMock.mockResolvedValue(session);

    await expect(requireApiSession()).resolves.toBe(session);
  });

  // The acceptance criterion this proves: an unauthenticated Route Handler
  // request gets a real 401 with a JSON body — a client `fetch()` can
  // `.json()` the response instead of choking on a redirect's HTML target.
  // Asserting on the actual `NextResponse` (status, header, body), not on a
  // mock, is what makes this fail if the 401 path is ever swapped back for
  // `redirect()` or dropped entirely — see the task report's removal
  // experiment for what breaks, and how, when each check below is deleted.
  it("returns a 401 JSON response, not a redirect, when there is no session", async () => {
    authMock.mockResolvedValue(null);

    const result = await requireApiSession();

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(401);
    // A `Location` header is what a redirect uses to tell the browser where
    // to go next; a JSON API caller has no browser navigation to follow, so
    // this guard must never set one on the unauthenticated response.
    expect(response.headers.get("Location")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  // Same freshness contract as `requireSession()`: a session row deleted by
  // sign-out between two calls must flip the second call from "signed in"
  // to the 401 response, never to a cached prior answer.
  it("re-reads auth() on every call instead of caching a prior result", async () => {
    const session = sessionFor("client");

    authMock.mockResolvedValueOnce(session);
    await expect(requireApiSession()).resolves.toBe(session);

    authMock.mockResolvedValueOnce(null);
    const result = await requireApiSession();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);

    expect(authMock).toHaveBeenCalledTimes(2);
  });
});

describe("requireAdmin", () => {
  it("returns the session for an admin", async () => {
    const session = sessionFor("admin");
    authMock.mockResolvedValue(session);

    await expect(requireAdmin()).resolves.toBe(session);
  });

  // The acceptance criterion this proves: a signed-in CLIENT hitting an
  // admin-only surface is refused with a real 403 — not merely hidden from
  // the nav. Calling the guard directly, the same way a route handler or
  // Server Component would, is what "requesting the URL directly" means at
  // the unit level: nothing here renders or inspects any markup.
  it("refuses a signed-in CLIENT with a 403, not a redirect", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(requireAdmin()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  it("redirects to /login (not 403) when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(requireAdmin()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  it("never trusts a role reported by anything other than auth()'s own return value", () => {
    // There is no argument, header, or cookie this function reads a role
    // from — `requireAdmin` takes no input at all. This test exists as a
    // guard against a future edit that adds one (e.g. an `expectedRole`
    // parameter fed by a client-controlled value): the only session object
    // it can possibly act on is whatever `auth()` resolves to.
    expect(requireAdmin).toHaveLength(0);
  });
});
