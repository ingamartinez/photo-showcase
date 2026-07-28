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
    render(element);

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
  });
});
