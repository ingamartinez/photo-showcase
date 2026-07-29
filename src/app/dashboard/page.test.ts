import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import DashboardPage from "./page";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/lib/auth-guards.test.ts: mock only `@/auth`'s
// `auth()`, leave `redirect()`/`forbidden()` from `next/navigation` real so
// this only passes if requireAdmin() actually calls them.
const authMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
}));

// `getPendingSelectionCount()` (task #75) reads the database — mocked here
// the same way `dashboard/galleries/page.test.ts` mocks `@/lib/galleries`
// (importActual + override only what this page calls), so the real
// `formatPendingSelectionCount()` still runs.
const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getPendingSelectionCount: () => getPendingSelectionCountMock(),
  };
});

beforeEach(() => {
  authMock.mockReset();
  getPendingSelectionCountMock.mockReset();
  getPendingSelectionCountMock.mockResolvedValue(0);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, name: "Alejo", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("DashboardPage", () => {
  // Acceptance criterion: /dashboard requires an admin session. Calling the
  // page's own default export directly — the same function Next calls to
  // handle a request for the route — is what "requesting the URL directly"
  // means at this level: nothing here renders or inspects any markup.
  it("resolves for an admin session instead of throwing", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(DashboardPage()).resolves.toBeTruthy();
  });

  // The other half of the acceptance criterion: a signed-in CLIENT is
  // refused with a real 403 when the page itself is invoked — not merely
  // absent from a nav menu.
  it("refuses a signed-in CLIENT with a 403 when the route is requested directly", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(DashboardPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(DashboardPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  it("never queries the pending-selection count before the admin check passes", async () => {
    authMock.mockResolvedValue(null);

    await expect(DashboardPage()).rejects.toMatchObject({ digest: expect.any(String) });
    expect(getPendingSelectionCountMock).not.toHaveBeenCalled();
  });
});
