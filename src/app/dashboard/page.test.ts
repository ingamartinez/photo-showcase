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

// `getPendingSelectionCount()` (task #75) and `getGalleryCount()` (task #88)
// read the database — mocked here the same way
// `dashboard/galleries/page.test.ts` mocks `@/lib/galleries` (importActual +
// override only what this page calls), so the real `formatPendingSelectionCount()`
// still runs. `formatStudioGalleryCount()` doesn't need this treatment at
// all (task #49/#90) — it lives in `@/lib/format`, a module this file never
// mocks.
const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
const getGalleryCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getPendingSelectionCount: () => getPendingSelectionCountMock(),
    getGalleryCount: () => getGalleryCountMock(),
  };
});

// `getClientCount()` (task #88) — same treatment.
const getClientCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/clients", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients")>("@/lib/clients");
  return {
    ...actual,
    getClientCount: () => getClientCountMock(),
  };
});

beforeEach(() => {
  authMock.mockReset();
  getPendingSelectionCountMock.mockReset();
  getPendingSelectionCountMock.mockResolvedValue(0);
  getClientCountMock.mockReset();
  getClientCountMock.mockResolvedValue(0);
  getGalleryCountMock.mockReset();
  getGalleryCountMock.mockResolvedValue(0);
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

  it("never queries the pending-selection, client or gallery counts before the admin check passes", async () => {
    authMock.mockResolvedValue(null);

    await expect(DashboardPage()).rejects.toMatchObject({ digest: expect.any(String) });
    expect(getPendingSelectionCountMock).not.toHaveBeenCalled();
    expect(getClientCountMock).not.toHaveBeenCalled();
    expect(getGalleryCountMock).not.toHaveBeenCalled();
  });

  // Task #88's core acceptance criterion: the page must actually call the
  // client/gallery count queries, not hardcode them. Asserting the mocks were
  // invoked catches a page that never queries at all; the chrome test
  // (page.chrome.test.tsx) is what proves the rendered numbers actually come
  // from those results rather than a constant baked into the markup.
  it("queries both the client count and the gallery count for an admin session", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
    getClientCountMock.mockResolvedValue(2);
    getGalleryCountMock.mockResolvedValue(2);

    await DashboardPage();

    expect(getClientCountMock).toHaveBeenCalledTimes(1);
    expect(getGalleryCountMock).toHaveBeenCalledTimes(1);
  });
});
