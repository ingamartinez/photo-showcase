// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/galleries/page.chrome.test.tsx: jsdom
// cannot resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts and src/lib/galleries.ts, even with
// `vi.mock("server-only", ...)`. So both modules are mocked wholesale here.
//
// page.test.ts (node environment) proves the admin guard is real and that
// getPendingSelectionCount()/getClientCount()/getGalleryCount() are never
// called before it passes; this file is the other half — the only place
// that proves those counts (tasks #75 and #88) are actually wired into
// markup, and that "no pending selections"/"nothing loaded yet" render the
// genuine empty states rather than being permanently shown.
//
// `@/lib/galleries` and `@/lib/clients` are mocked WHOLESALE here (not
// selectively) because BOTH genuinely import `@/lib/db` and therefore
// Postgres and therefore Node's `tls`, which jsdom cannot resolve — same
// failure class as this file's own header comment on `server-only`. Only the
// DB-touching readers (`getPendingSelectionCount`, `getGalleryCount`,
// `getClientCount`) are mocked below; none of the four formatters this page
// uses (`formatClientCount`, `formatPendingSelectionCount`,
// `formatStudioGalleryCount`, `formatTileCount`) live in either module
// anymore — task #49/#90 moved the first two out already, task #122 moved
// the next two survivors, and task #130's review round 1 added the fourth
// — they all now live in `@/lib/format`, a plain module with no
// `server-only`/`@/lib/db` import that this file never mocks, so the REAL
// functions run here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import DashboardPage from "./page";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
const getGalleryCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", () => ({
  getPendingSelectionCount: () => getPendingSelectionCountMock(),
  getGalleryCount: () => getGalleryCountMock(),
}));

const getClientCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/clients", () => ({
  getClientCount: () => getClientCountMock(),
}));

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", name: "Alejo", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getPendingSelectionCountMock.mockReset();
  getClientCountMock.mockReset();
  getClientCountMock.mockResolvedValue(0);
  getGalleryCountMock.mockReset();
  getGalleryCountMock.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
});

describe("DashboardPage chrome", () => {
  it("renders no pending-selection banner when nothing is waiting", async () => {
    getPendingSelectionCountMock.mockResolvedValue(0);

    const element = await DashboardPage();
    render(element);

    expect(screen.queryByText("Esperando tu revisión")).toBeNull();
    expect(screen.queryByText(/selecci/)).toBeNull();
  });

  it("renders a singular banner for exactly one pending selection", async () => {
    getPendingSelectionCountMock.mockResolvedValue(1);

    const element = await DashboardPage();
    render(element);

    expect(screen.getByText("Esperando tu revisión")).toBeDefined();
    expect(screen.getByText("1 selección esperando")).toBeDefined();
  });

  it("renders a pluralized banner linking to /dashboard/galleries for multiple pending selections", async () => {
    getPendingSelectionCountMock.mockResolvedValue(3);

    const element = await DashboardPage();
    render(element);

    const banner = screen.getByText("3 selecciones esperando").closest("a")!;
    expect(banner.getAttribute("href")).toBe("/dashboard/galleries");
  });

  // Task #88's genuine empty state: reached because BOTH counts came back
  // zero, not assumed. It must still exist and be good for a real first run.
  it("shows the genuine empty state when there are no clients and no galleries", async () => {
    getClientCountMock.mockResolvedValue(0);
    getGalleryCountMock.mockResolvedValue(0);

    const element = await DashboardPage();
    render(element);

    expect(screen.getByText(/Todavía no hay nada acá\./)).toBeDefined();
    expect(screen.getByText(/Este va a ser tu punto de partida/)).toBeDefined();
    expect(screen.getByText("Todavía no cargaste ningún cliente.")).toBeDefined();
    expect(screen.getByText("Todavía no armaste ninguna galería.")).toBeDefined();
    // The retired "el panel recién se está construyendo" framing (task #17,
    // stale since #18/#19 shipped clients and galleries) must be gone
    // entirely — not just from the non-empty branch.
    expect(screen.queryByText(/recién se está construyendo/)).toBeNull();
  });

  // Task #88's core acceptance criterion, proven by mutation: this test is
  // written to FAIL if the client/gallery counts on the page are hardcoded
  // rather than read from the DB-backed mocks. Report of the mutation test
  // (freezing the query at zero while this test supplies non-zero data)
  // lives in the task's final report, not in this file.
  it("reports real client and gallery counts instead of the retired empty-state copy", async () => {
    getClientCountMock.mockResolvedValue(2);
    getGalleryCountMock.mockResolvedValue(2);

    const element = await DashboardPage();
    render(element);

    expect(screen.getByText(/Así está tu estudio\./)).toBeDefined();
    expect(screen.getByText(/Tenés 2 clientes y 2 galerías en marcha\./)).toBeDefined();
    // The tiles' OWN number line is a bare, locale-grouped digit
    // (`formatTileCount`, task #130 review round 1) — the sentence forms
    // above stay in the prose line only. Scoped by accessible name (the
    // eyebrow + the bare digit) rather than by the digit alone, since "2"
    // on its own would be ambiguous against a third tile showing the same
    // count.
    expect(screen.getByRole("link", { name: "Clientes 2" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Galerías 2" })).toBeDefined();
    // The hardcoded lies this task removes must never render once there is
    // real data.
    expect(screen.queryByText("Todavía no hay nada acá.")).toBeNull();
    expect(screen.queryByText("Todavía no cargaste ningún cliente.")).toBeNull();
    expect(screen.queryByText("Todavía no armaste ninguna galería.")).toBeNull();
  });

  // Task #90: this used to be one test named "...and vice versa" that only
  // ever exercised the 0-clients/1-gallery direction — the reverse
  // (1 client, 0 galleries) was claimed by the title but never asserted.
  // Split into the two directions below so each title matches exactly what
  // it checks; see the epic-level pattern this guards against in this
  // file's own reasoning (#73/#26/#84 all shipped a test whose name
  // overstated its own coverage).
  it("reports a client count with none loaded yet alongside a real gallery", async () => {
    getClientCountMock.mockResolvedValue(0);
    getGalleryCountMock.mockResolvedValue(1);

    const element = await DashboardPage();
    render(element);

    // Not the genuine first-run empty state — a gallery already exists —
    // but the client card still tells the truth about having zero clients.
    expect(screen.queryByText("Todavía no hay nada acá.")).toBeNull();
    expect(screen.getByText("Todavía no cargaste ningún cliente.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Galerías 1" })).toBeDefined();
  });

  it("reports a gallery count with none loaded yet alongside a real client", async () => {
    getClientCountMock.mockResolvedValue(1);
    getGalleryCountMock.mockResolvedValue(0);

    const element = await DashboardPage();
    render(element);

    // Not the genuine first-run empty state — a client already exists — but
    // the gallery card still tells the truth about having zero galleries.
    expect(screen.queryByText("Todavía no hay nada acá.")).toBeNull();
    expect(screen.getByText("Todavía no armaste ninguna galería.")).toBeDefined();
    expect(screen.getByRole("link", { name: "Clientes 1" })).toBeDefined();
  });
});
