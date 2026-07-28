import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import ClientsPage from "./page";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/clients.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/page.test.ts: mock only `@/auth`'s
// `auth()`, leave `redirect()`/`forbidden()` from `next/navigation` real, so
// this only passes if the page actually calls requireAdmin().
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// The query itself is covered by src/lib/clients.test.ts — this file only
// needs SOME resolved value so the page can render past the guard.
const getClientsWithGalleryCountMock = vi.fn();
vi.mock("@/lib/clients", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clients")>("@/lib/clients");
  return {
    ...actual,
    getClientsWithGalleryCount: (...args: unknown[]) => getClientsWithGalleryCountMock(...args),
  };
});

beforeEach(() => {
  authMock.mockReset();
  getClientsWithGalleryCountMock.mockReset();
  getClientsWithGalleryCountMock.mockResolvedValue([]);
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, name: "Alejo", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("ClientsPage", () => {
  it("resolves for an admin session instead of throwing", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(ClientsPage()).resolves.toBeTruthy();
  });

  // The acceptance criterion this proves at the route level: a signed-in
  // CLIENT is refused with a real 403 when the route is requested directly.
  it("refuses a signed-in CLIENT with a 403 when the route is requested directly", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(ClientsPage()).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(ClientsPage()).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });

  it("never queries the client list before the admin check passes", async () => {
    authMock.mockResolvedValue(null);

    await expect(ClientsPage()).rejects.toMatchObject({ digest: expect.any(String) });
    expect(getClientsWithGalleryCountMock).not.toHaveBeenCalled();
  });
});
