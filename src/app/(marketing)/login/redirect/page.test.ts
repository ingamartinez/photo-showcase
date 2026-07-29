import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import LoginRedirectPage from "./page";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/lib/auth-guards.test.ts and src/app/dashboard/page.test.ts:
// mock only `@/auth`'s `auth()`, leave `redirect()` from `next/navigation`
// real, so this only passes if the page actually calls it — not merely
// because a mock was configured to resolve.
const authMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("LoginRedirectPage", () => {
  // Task #87's core acceptance criterion: a client landing here after a
  // successful magic-link click ends up on THEIR OWN area, not on the admin
  // panel that would refuse them.
  it("sends a CLIENT session to /galleries", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(LoginRedirectPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/galleries;307;",
    });
  });

  // The other half: an admin's own login must keep landing on /dashboard —
  // this fix must not regress the admin path while fixing the client one.
  it("sends an ADMIN session to /dashboard", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(LoginRedirectPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/dashboard;307;",
    });
  });

  // No session at all (route hit directly, or a stale/consumed link):
  // treated like any other guarded page, not a special case.
  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(LoginRedirectPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});
