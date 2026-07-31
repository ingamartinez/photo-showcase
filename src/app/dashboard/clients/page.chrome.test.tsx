// @vitest-environment jsdom
//
// Scope item "List clients with their gallery count" — page.test.ts (node
// environment) proves the admin guard is real; this file is the other half,
// the only place that proves the query's output is actually WIRED into
// markup (names, emails, and the pluralized gallery-count text), not just
// that the page resolves. Without this, a reviewer's independent check found
// two ways this slice could stay 25/25 green while broken: deleting the
// `formatClientGalleryCount(...)` span entirely, or making the non-empty branch
// never render at all (the old page.test.ts always resolved `[]`, so
// clients.map(...) was never exercised).
//
// Same reasoning as layout.chrome.test.tsx for WHY the mocking is done this
// way: jsdom cannot resolve the bare `import "server-only"` pulled in
// transitively by src/lib/auth-guards.ts and src/lib/clients.ts, even with
// `vi.mock("server-only", ...)` — reproduced independently, same failure
// class as documented there. So `@/lib/auth-guards` and `@/lib/clients` are
// mocked WHOLESALE here (not their `@/auth`/`@/lib/db` boundaries), and
// `@/app/dashboard/clients/actions` is mocked the same way
// client-form.test.tsx already does, since `<ClientForm />` imports it and
// it too pulls in `@/lib/auth-guards` transitively.
//
// `formatClientGalleryCount` is NOT mocked (task #49): it moved out of
// `@/lib/clients` into `@/lib/format`, a plain module with no
// `server-only`/`@/lib/db` import (see that file's header comment), so this
// test imports and exercises the REAL function instead of re-implementing
// its pluralization logic inline — the exact duplication #49 was filed to
// remove. `formatClientGalleryCount`'s own pluralization logic is ALSO
// unit-tested directly in src/lib/format.test.ts (node environment); this
// file is what proves the real copy actually reaches the page's markup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import ClientsPage from "./page";
import type { ClientWithGalleryCount } from "@/lib/clients";
import type { CreateClientState } from "./actions";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getClientsWithGalleryCountMock = vi.fn<() => Promise<ClientWithGalleryCount[]>>();
vi.mock("@/lib/clients", () => ({
  getClientsWithGalleryCount: () => getClientsWithGalleryCountMock(),
}));

vi.mock("./actions", () => ({
  createClient:
    vi.fn<(state: CreateClientState, formData: FormData) => Promise<CreateClientState>>(),
}));

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getClientsWithGalleryCountMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ClientsPage chrome", () => {
  it("renders each client's name, email, phone and pluralized gallery count", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([
      {
        id: "u1",
        name: "Ana Pérez",
        email: "ana@example.com",
        phone: null,
        createdAt: new Date("2026-01-01"),
        galleryCount: 3,
      },
      {
        id: "u2",
        name: "Beto Ruiz",
        email: "beto@example.com",
        phone: "+57 300 0000",
        createdAt: new Date("2026-02-01"),
        galleryCount: 0,
      },
    ]);

    const element = await ClientsPage();
    render(element);

    expect(screen.getByText("Ana Pérez")).toBeDefined();
    expect(screen.getByText("ana@example.com")).toBeDefined();
    expect(screen.getByText("3 galerías")).toBeDefined();

    expect(screen.getByText("Beto Ruiz")).toBeDefined();
    expect(screen.getByText("beto@example.com")).toBeDefined();
    expect(screen.getByText("+57 300 0000")).toBeDefined();
    expect(screen.getByText("Sin galerías todavía")).toBeDefined();

    // Sanity check against a false positive: the EMPTY-state copy must be
    // absent — a page that (bug) always renders the empty branch regardless
    // of `clients.length` would otherwise slip past the assertions above if
    // they were ever weakened to "something rendered".
    expect(screen.queryByText("Todavía no cargaste ningún cliente.")).toBeNull();
  });

  it("renders the empty state when there are no clients yet", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([]);

    const element = await ClientsPage();
    render(element);

    expect(screen.getByText("Todavía no cargaste ningún cliente.")).toBeDefined();
    expect(screen.getByText(/Cargá el primer cliente con el formulario/)).toBeDefined();
  });
});
