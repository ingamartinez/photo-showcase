import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import GalleriesLayout from "./layout";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/layout.test.ts: mock `@/auth`'s
// `auth()`/`signOut()` so requireSession()'s real redirect() logic runs
// against a fake session, without pulling in the real Auth.js pipeline.
const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: (...args: unknown[]) => authMock(...args),
  signOut: vi.fn(),
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

describe("GalleriesLayout", () => {
  // Unlike src/app/dashboard/layout.tsx (requireAdmin), this layout must
  // let BOTH roles through — /galleries is the client-facing surface, and
  // an admin may also reach a gallery page to preview it (see
  // src/app/galleries/[publicSlug]/page.tsx's own ownership comment).
  it("resolves for a signed-in client", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(GalleriesLayout({ children: null })).resolves.toBeTruthy();
  });

  it("resolves for a signed-in admin too", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(GalleriesLayout({ children: null })).resolves.toBeTruthy();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(GalleriesLayout({ children: null })).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
  });
});
