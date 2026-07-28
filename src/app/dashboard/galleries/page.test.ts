import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import GalleriesPage from "./page";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts,
// src/lib/galleries.ts, src/lib/clients.ts and src/lib/packages.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/clients/page.test.ts: mock only
// `@/auth`'s `auth()`, leave `redirect()`/`forbidden()` from `next/navigation`
// real, so this only passes if the page actually calls requireAdmin().
// `signIn` is listed too — this page renders <GalleryForm>, which imports
// `createGallery` from ./actions, which (task #21) now imports `signIn`
// from this same module.
const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signIn: vi.fn(),
}));

// This page renders <GalleryForm>, which imports `createGallery` from
// ./actions, which (task #21) now imports `AuthError` from "next-auth" too.
// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) at module scope, which fails to resolve
// under Vitest — mocked wholesale for the same reason as
// src/app/(marketing)/login/actions.test.ts.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

// The queries themselves are covered by src/lib/galleries.test.ts,
// src/lib/clients.test.ts and src/lib/packages.test.ts — this file only
// needs SOME resolved values so the page can render past the guard.
const getGalleriesWithDetailsMock = vi.fn();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleriesWithDetails: (...args: unknown[]) => getGalleriesWithDetailsMock(...args),
  };
});

const getClientsForPickerMock = vi.fn();
vi.mock("@/lib/clients", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients")>("@/lib/clients");
  return {
    ...actual,
    getClientsForPicker: (...args: unknown[]) => getClientsForPickerMock(...args),
  };
});

const getActivePackagesMock = vi.fn();
vi.mock("@/lib/packages", async () => {
  const actual = await vi.importActual<typeof import("@/lib/packages")>("@/lib/packages");
  return {
    ...actual,
    getActivePackages: (...args: unknown[]) => getActivePackagesMock(...args),
  };
});

beforeEach(() => {
  authMock.mockReset();
  getGalleriesWithDetailsMock.mockReset();
  getGalleriesWithDetailsMock.mockResolvedValue([]);
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([]);
  getActivePackagesMock.mockReset();
  getActivePackagesMock.mockResolvedValue([]);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, name: "Alejo", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("GalleriesPage", () => {
  it("resolves for an admin session instead of throwing", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(GalleriesPage()).resolves.toBeTruthy();
  });

  // The acceptance criterion this proves at the route level: a signed-in
  // CLIENT is refused with a real 403 when the route is requested directly.
  it("refuses a signed-in CLIENT with a 403 when the route is requested directly", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(GalleriesPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(GalleriesPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  it("never queries galleries, clients or packages before the admin check passes", async () => {
    authMock.mockResolvedValue(null);

    await expect(GalleriesPage()).rejects.toMatchObject({ digest: expect.any(String) });
    expect(getGalleriesWithDetailsMock).not.toHaveBeenCalled();
    expect(getClientsForPickerMock).not.toHaveBeenCalled();
    expect(getActivePackagesMock).not.toHaveBeenCalled();
  });
});
