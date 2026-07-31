// @vitest-environment jsdom
//
// Acceptance criterion #2: the public site's header/footer must not leak
// into the dashboard. `layout.test.ts` proves the guard by calling the
// function directly and inspecting the thrown digest — deliberately not
// rendering anything, per the task's own instruction not to prove
// authorization by inspecting markup. This file is the other half: the
// chrome-leak question IS a markup question, so it renders the resolved
// tree and asserts on text unique to `SiteHeader`/`SiteFooter`, not on
// whether this file happens to import those components (a passing import
// check would stay green even if someone re-added the import without
// actually using it, or vice versa).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import DashboardLayout from "./layout";

// This file runs under `@vitest-environment jsdom` (needed for
// @testing-library/react below) — and Vitest/Vite's jsdom environment fails
// to resolve the bare `import "server-only"` specifier at transform time
// even with `vi.mock("server-only", ...)` (reproduced independently: the
// same mock works fine for `src/lib/auth-guards.test.ts` under the default
// node environment, and fails only when the SAME module graph is pulled in
// under jsdom). Mocking `@/lib/auth-guards` wholesale — instead of mocking
// `@/auth` and letting the real `requireAdmin()` run — sidesteps that
// resolution failure entirely, since this file's only concern is chrome
// (header/footer), not the guard's own logic (already covered by
// `layout.test.ts` under the node environment, where the real
// `requireAdmin()` runs against a mocked `auth()`).
const requireAdminMock = vi.fn<() => Promise<Session>>();

vi.mock("@/lib/auth-guards", () => ({
  requireAdmin: () => requireAdminMock(),
}));

vi.mock("@/auth", () => ({
  signOut: vi.fn(),
}));

// The shell's nav is a client component reading `usePathname()` (task #129 —
// a Server Component layout is never handed the pathname, so marking the
// current route cannot happen server-side). Rendered outside an app-router
// tree there is no pathname to read; this mock supplies one. Which route is
// current is `dashboard-nav.test.tsx`'s subject, not this file's.
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard",
}));

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "user-1", role: "admin", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
});

afterEach(() => {
  cleanup();
});

describe("DashboardLayout chrome", () => {
  it("does not render the public site's header/footer", async () => {
    const element = await DashboardLayout({ children: <div>contenido</div> });
    const { container } = render(element);

    // "Reservar" (SiteHeader's booking CTA) and "@alejo_frames" (SiteFooter's
    // Instagram handle) exist nowhere else in the app — their absence is
    // what proves the marketing chrome did not leak in, not an import check.
    expect(screen.queryByText("Reservar")).toBeNull();
    expect(screen.queryByText(/@alejo_frames/)).toBeNull();

    // Sanity check against a false positive: a layout that rendered nothing
    // at all (a bug of its own) would also pass the two assertions above.
    // The dashboard's OWN chrome must actually be present.
    expect(screen.getByText("Clientes")).toBeDefined();
    expect(screen.getByText("Cerrar sesión")).toBeDefined();
    expect(screen.getByText("contenido")).toBeDefined();

    // Task #129: the marketing `.wrap` (1280px centred column) must not be
    // what holds a dense work surface. Asserted on the rendered tree rather
    // than on the source, so it stays true however the shell is refactored.
    expect(container.querySelector(".wrap")).toBeNull();
  });

  // The whole point of the shell rebuild: `[data-surface="app"]` is what
  // switches on the scoped token layer in globals.css (task #128 shipped
  // every token inert, because nothing set the attribute). If this element
  // loses the attribute, the panel silently falls back to the public site's
  // scale and density with no other test noticing.
  it("puts the dashboard tree on the app surface", async () => {
    const element = await DashboardLayout({ children: <div>contenido</div> });
    const { container } = render(element);

    const surface = container.querySelector('[data-surface="app"]');
    expect(surface).not.toBeNull();
    // On the ROOT of the shell, so every screen under /dashboard inherits it.
    expect(surface?.contains(screen.getByText("contenido"))).toBe(true);
    expect(surface?.contains(screen.getByText("Cerrar sesión"))).toBe(true);
  });

  // A sidebar makes landmarks meaningful in a way the previous single top bar
  // did not: nav and content are now two regions a keyboard/screen-reader user
  // moves between. There must be exactly ONE navigation — the phone tab bar
  // and the desktop sidebar are one element relocated by CSS (epic #125), and
  // a second landmark here would be the duplicated-markup bug.
  it("exposes one navigation landmark and one main landmark", async () => {
    const element = await DashboardLayout({ children: <div>contenido</div> });
    render(element);

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Principal" })).toBeDefined();

    const main = screen.getByRole("main");
    expect(main.contains(screen.getByText("contenido"))).toBe(true);
    // The chrome lives OUTSIDE `<main>`: a "skip to content" jump, or a
    // screen reader's main-landmark shortcut, must not land the user back in
    // the navigation.
    expect(main.contains(screen.getByText("Cerrar sesión"))).toBe(false);
  });
});
