import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import DashboardLayout from "./layout";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Mock the module boundary the same way src/lib/auth-guards.test.ts and
// src/lib/auth-actions.test.ts do: `auth()` for requireAdmin(), `signOut()`
// so the layout's `import { signOutAction } from "@/lib/auth-actions"` chain
// (auth-actions.ts imports `signOut` from "@/auth") resolves without pulling
// in the real Auth.js pipeline. `redirect()`/`forbidden()` from
// `next/navigation` are intentionally left real, same reasoning as the guard
// suite: this only passes if the layout actually calls requireAdmin().
const authMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signOut: vi.fn(),
}));

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

describe("DashboardLayout", () => {
  // Defense-in-depth check: the layout guard must not throw for an admin —
  // proves it isn't accidentally refusing everyone, which would mask the
  // client-refusal test below as a false positive.
  it("resolves for an admin session instead of throwing", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(DashboardLayout({ children: null })).resolves.toBeTruthy();
  });

  // The layout is explicitly documented as defense in depth, NOT the only
  // check (see the header comment in layout.tsx and in
  // src/lib/auth-guards.ts) — but it still must refuse a signed-in CLIENT on
  // its own, the same way every page under it does.
  it("refuses a signed-in CLIENT with a 403, the same way the page itself does", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(DashboardLayout({ children: null })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(DashboardLayout({ children: null })).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});
