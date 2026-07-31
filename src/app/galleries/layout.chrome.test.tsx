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
    expect(screen.getByText("contenido")).toBeDefined();
  });

  // #142: the chrome is now design/system/client.html's `.siteheader`
  // (lines 100-111, markup 590-593), which has exactly two elements — the
  // wordmark and sign-out. The account email used to sit between them as
  // `hidden sm:inline`, i.e. never visible on the phone, which epic #140
  // declares the PRIMARY case for this surface. It is gone rather than
  // restyled, and this pins that: re-adding it is a mock change, not a
  // detail. Only the layout renders in this test (its child is a bare
  // `<div>contenido</div>`), so a match here could only come from the
  // chrome itself.
  it("does not surface the signed-in account's email in the chrome", async () => {
    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    expect(screen.queryByText("ana@example.com")).toBeNull();
  });

  // The mock's `.signout` is a borderless 12px text control, NOT the
  // marketing chrome's `uppercase tracking-[0.1em]` bordered button this
  // layout used to inherit (#142). Asserted on the class list because that
  // is the only place the distinction lives — both render the same text.
  it("renders sign-out as the mock's quiet text control, not the marketing button", async () => {
    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    const signOut = screen.getByRole("button", { name: "Cerrar sesión" });
    expect(signOut.className).not.toMatch(/uppercase/);
    expect(signOut.className).not.toMatch(/\bborder\b/);
    // `--tap: 48px` (client.html:49) — the touch target stays thumb-sized
    // even though the ink is 12px.
    expect(signOut.className).toMatch(/\bmin-h-12\b/);
  });

  // Sign-out must stay a REAL form submit against the server action — not
  // an onClick handler — so it works with JS disabled and the session row
  // is deleted server-side (src/lib/auth-actions.ts). Rewriting the chrome
  // is exactly when a button gets quietly detached from its form.
  it("keeps sign-out a real form submit", async () => {
    const element = await GalleriesLayout({ children: <div>contenido</div> });
    render(element);

    const signOut = screen.getByRole("button", { name: "Cerrar sesión" });
    expect(signOut.getAttribute("type")).toBe("submit");
    expect(signOut.closest("form")).not.toBeNull();
  });

  // The client area must never pick up the dashboard's token layer — epic
  // #140: this surface stays editorial, on `:root`'s brand tokens. #128
  // scoped every panel token under `[data-surface="app"]` (globals.css:107),
  // so the attribute's absence anywhere in this tree is the check.
  it("never opts the client area into the dashboard's app surface", async () => {
    const element = await GalleriesLayout({ children: <div>contenido</div> });
    const { container } = render(element);

    expect(container.querySelector('[data-surface="app"]')).toBeNull();
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
