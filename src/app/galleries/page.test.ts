import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import ClientGalleriesPage from "./page";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/galleries/[publicSlug]/page.test.ts: mock only
// `@/auth`'s `auth()`, leave `redirect()`/`forbidden()` from `next/navigation`
// real, so this only passes if the page actually calls requireSession().
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// The query itself is covered by src/lib/galleries.test.ts — this file only
// needs SOME resolved value so the page can render past the guard, and to
// assert WHAT id it was called with (this task's core acceptance criterion).
const getGalleriesForClientMock = vi.fn();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleriesForClient: (...args: unknown[]) => getGalleriesForClientMock(...args),
  };
});

beforeEach(() => {
  authMock.mockReset();
  getGalleriesForClientMock.mockReset();
  getGalleriesForClientMock.mockResolvedValue([]);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client", userId = "user-1"): Session {
  return {
    user: { id: userId, role, name: "Alejo", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("ClientGalleriesPage", () => {
  it("resolves for a signed-in client", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();
  });

  // Unlike /dashboard/galleries, this route is NOT admin-only — an admin
  // signing in also lands somewhere via this same client area.
  it("also resolves for a signed-in admin, instead of refusing with a 403", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(ClientGalleriesPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(getGalleriesForClientMock).not.toHaveBeenCalled();
  });

  // This task's headline security acceptance criterion: the query is driven
  // by the SESSION's own user id — there is no URL param or form field on
  // this route an id could otherwise come from.
  it("queries getGalleriesForClient with the session's own user id", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));

    await ClientGalleriesPage();

    expect(getGalleriesForClientMock).toHaveBeenCalledWith("client-a");
  });

  it("queries with the ADMIN's own user id when an admin visits, never a wildcard/all-clients call", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));

    await ClientGalleriesPage();

    expect(getGalleriesForClientMock).toHaveBeenCalledWith("admin-1");
    expect(getGalleriesForClientMock).toHaveBeenCalledTimes(1);
  });
});
