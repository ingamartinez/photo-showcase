// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/galleries/page.chrome.test.tsx: jsdom
// cannot resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts and src/lib/galleries.ts, even with
// `vi.mock("server-only", ...)`. So both modules are mocked wholesale here.
//
// page.test.ts (node environment) proves the admin guard is real and that
// getPendingSelectionCount() is never called before it passes; this file is
// the other half — the only place that proves the pending-selection count
// (task #75) is actually wired into markup, and that "no pending
// selections" renders no banner at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import DashboardPage from "./page";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", () => ({
  getPendingSelectionCount: () => getPendingSelectionCountMock(),
  // Real pluralization logic, not a mock — this file is what proves the
  // real copy actually reaches the page (src/lib/galleries.test.ts already
  // proves formatPendingSelectionCount's own logic in isolation).
  formatPendingSelectionCount: (pendingCount: number) => {
    if (pendingCount <= 0) return null;
    if (pendingCount === 1) return "1 selección esperando";
    return `${pendingCount} selecciones esperando`;
  },
}));

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", name: "Alejo", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getPendingSelectionCountMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DashboardPage chrome", () => {
  it("renders no pending-selection banner when nothing is waiting, and keeps the original 'panel vacío' copy", async () => {
    getPendingSelectionCountMock.mockResolvedValue(0);

    const element = await DashboardPage();
    render(element);

    expect(screen.queryByText("Esperando tu revisión")).toBeNull();
    expect(screen.queryByText(/selecci/)).toBeNull();
    expect(screen.getByText(/Por ahora está vacío porque el panel/)).toBeDefined();
  });

  it("renders a singular banner for exactly one pending selection, and drops the 'está vacío' claim that would contradict it", async () => {
    getPendingSelectionCountMock.mockResolvedValue(1);

    const element = await DashboardPage();
    render(element);

    expect(screen.getByText("Esperando tu revisión")).toBeDefined();
    expect(screen.getByText("1 selección esperando")).toBeDefined();
    // The banner announces something IS here — the static paragraph must not
    // simultaneously claim the panel is empty (task #75 fix #4).
    expect(screen.queryByText(/Por ahora está vacío/)).toBeNull();
    expect(screen.getByText(/El resto todavía está vacío/)).toBeDefined();
  });

  it("renders a pluralized banner linking to /dashboard/galleries for multiple pending selections", async () => {
    getPendingSelectionCountMock.mockResolvedValue(3);

    const element = await DashboardPage();
    render(element);

    const banner = screen.getByText("3 selecciones esperando").closest("a")!;
    expect(banner.getAttribute("href")).toBe("/dashboard/galleries");
  });
});
