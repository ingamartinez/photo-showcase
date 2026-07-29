// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/layout.chrome.test.tsx: jsdom cannot
// resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts even with `vi.mock("server-only", ...)`, so
// `@/lib/auth-guards` is mocked wholesale here rather than mocking `@/auth`
// and letting the real `requireSession()` run (already proven for real in
// layout.test.ts under the node environment).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import GalleriesLayout from "./layout";

const requireSessionMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({
  requireSession: () => requireSessionMock(),
}));

vi.mock("@/auth", () => ({
  signOut: vi.fn(),
}));

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue({
    user: { id: "client-1", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
});

afterEach(() => {
  cleanup();
});

describe("GalleriesLayout chrome", () => {
  it("does not render the public site's marketing header/footer or the dashboard nav", async () => {
    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    // "Reservar" (SiteHeader) and the dashboard's own "Clientes" nav item
    // exist nowhere else in the app — their absence is what proves neither
    // chrome leaked in.
    expect(screen.queryByText("Reservar")).toBeNull();
    expect(screen.queryByText("Clientes")).toBeNull();

    expect(screen.getByText("Cerrar sesión")).toBeDefined();
    expect(screen.getByText("ana@example.com")).toBeDefined();
    expect(screen.getByText("contenido")).toBeDefined();
  });

  // #96: the logo used to be a hardcoded `Link href="/galleries"`, which
  // drops an admin previewing a gallery on the ownership-scoped client
  // index — empty for them, since `getGalleriesForClient()` never bypasses
  // for admins. Pin the actual href per role, not just that a link renders.
  it("points the logo at /galleries for a signed-in client", async () => {
    requireSessionMock.mockResolvedValue({
      user: { id: "client-1", role: "client", email: "ana@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session);

    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    const logo = screen.getByRole("link", { name: "Alejo Frames" });
    expect(logo.getAttribute("href")).toBe("/galleries");
  });

  it("points the logo at /dashboard for a signed-in admin previewing a gallery", async () => {
    requireSessionMock.mockResolvedValue({
      user: { id: "admin-1", role: "admin", email: "alejo@example.com" },
      expires: "2099-01-01T00:00:00.000Z",
    } as Session);

    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    const logo = screen.getByRole("link", { name: "Alejo Frames" });
    expect(logo.getAttribute("href")).toBe("/dashboard");
  });
});
