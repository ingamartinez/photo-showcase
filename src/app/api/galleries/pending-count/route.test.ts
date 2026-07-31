import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "next-auth";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts) only
// resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// This route's only real job besides the guard is "call the one function
// that derives the count and hand it back" — no query of its own to fake, so
// `@/lib/galleries` is mocked wholesale rather than routed through a fake
// `@/lib/db` the way a route with its own query would need.
const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", () => ({
  getPendingSelectionCount: () => getPendingSelectionCountMock(),
}));

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function clientSession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "a@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function request(): NextRequest {
  return new NextRequest("http://localhost:3300/api/galleries/pending-count");
}

beforeEach(() => {
  authMock.mockReset();
  getPendingSelectionCountMock.mockReset();
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

describe("GET /api/galleries/pending-count", () => {
  it("returns 401 JSON, not a redirect, for an unauthenticated request", async () => {
    authMock.mockResolvedValue(null);
    const { GET } = await import("./route");

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(getPendingSelectionCountMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in CLIENT with a 403 — this is studio-wide data, not one gallery's", async () => {
    authMock.mockResolvedValue(clientSession());
    const { GET } = await import("./route");

    await expect(GET(request(), { params: Promise.resolve({}) })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(getPendingSelectionCountMock).not.toHaveBeenCalled();
  });

  it("hands back whatever getPendingSelectionCount() returns, unmodified", async () => {
    authMock.mockResolvedValue(adminSession());
    getPendingSelectionCountMock.mockResolvedValue(3);
    const { GET } = await import("./route");

    const response = await GET(request(), { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ count: 3 });
  });

  it("returns 0 plainly rather than omitting the field — an absent badge still needs a real number", async () => {
    authMock.mockResolvedValue(adminSession());
    getPendingSelectionCountMock.mockResolvedValue(0);
    const { GET } = await import("./route");

    const response = await GET(request(), { params: Promise.resolve({}) });

    await expect(response.json()).resolves.toEqual({ count: 0 });
  });
});
