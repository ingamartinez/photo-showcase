// @vitest-environment jsdom
//
// Scope item "List clients with their gallery count" — page.test.ts (node
// environment) proves the admin guard is real; this file is the other half,
// the only place that proves the query's output is actually WIRED into
// markup (names, emails, phones and the pluralized gallery-count text), not
// just that the page resolves.
//
// Same reasoning as layout.chrome.test.tsx for WHY the mocking is done this
// way: jsdom cannot resolve the bare `import "server-only"` pulled in
// transitively by src/lib/auth-guards.ts and src/lib/clients.ts, even with
// `vi.mock("server-only", ...)` — reproduced independently, same failure
// class as documented there. So `@/lib/auth-guards` and `@/lib/clients` are
// mocked WHOLESALE here (not their `@/auth`/`@/lib/db` boundaries), and
// `@/app/dashboard/clients/actions` is mocked the same way
// client-form.test.tsx already does, since `<ClientForm />` (now behind
// <DashboardClientCreateDialog />) imports it and it too pulls in
// `@/lib/auth-guards` transitively.
//
// `formatClientCount`/`formatClientGalleryCount` are NOT mocked (task #49):
// they moved out into `@/lib/format`, a plain module with no
// `server-only`/`@/lib/db` import, so this test exercises the REAL functions
// instead of re-implementing their pluralization logic inline.
//
// TASK #132 rewrote this file for the table + dialog shape task #131 gave
// the galleries list — see that file's own page.chrome.test.tsx for the
// pattern this one reuses. The null-name fallback test (committed 2026-07-30,
// "test(clients): cover the null-name fallback in the clients list") is
// PRESERVED, not dropped: a client can exist with an email and no name, and
// the row must still show something useful.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** One client fixture, overridable field by field. */
function client(overrides: Partial<ClientWithGalleryCount> = {}): ClientWithGalleryCount {
  return {
    id: "u1",
    name: "Ana Pérez",
    email: "ana@example.com",
    phone: null,
    createdAt: new Date("2026-01-01"),
    galleryCount: 3,
    ...overrides,
  };
}

/** Every client row on the page, in DOM order — `data-client-id` is the
 * row's own machine-readable identity, the closest thing a plain, non-link
 * `<li>` has to galleries' `a[data-status]` selector. */
function rowsIn(container: HTMLElement): HTMLLIElement[] {
  return Array.from(container.querySelectorAll<HTMLLIElement>("li[data-client-id]"));
}

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
      client({ id: "u1", name: "Ana Pérez", email: "ana@example.com", galleryCount: 3 }),
      client({
        id: "u2",
        name: "Beto Ruiz",
        email: "beto@example.com",
        phone: "+57 300 0000",
        galleryCount: 0,
      }),
      // Task #52 / #132: a client row created by the magic-link flow (rather
      // than the dashboard form) can genuinely have no name — `users.name` is
      // nullable. Both fixtures above always had a name, so the page's
      // `client.name ?? client.email` fallback went uncovered without this.
      client({ id: "u3", name: null, email: "carla@example.com", galleryCount: 1 }),
    ]);

    const element = await ClientsPage();
    const { container } = render(element);

    const rows = rowsIn(container);
    expect(rows).toHaveLength(3);

    expect(within(rows[0]).getByText("Ana Pérez")).toBeDefined();
    expect(within(rows[0]).getByText("ana@example.com")).toBeDefined();
    expect(within(rows[0]).getByText("3 galerías")).toBeDefined();

    expect(within(rows[1]).getByText("Beto Ruiz")).toBeDefined();
    expect(within(rows[1]).getByText("beto@example.com")).toBeDefined();
    expect(within(rows[1]).getByText("+57 300 0000")).toBeDefined();
    expect(within(rows[1]).getByText("Sin galerías todavía")).toBeDefined();

    // The nameless client's row renders its email in BOTH the name slot
    // (the `client.name ?? client.email` fallback) and the dedicated email
    // cell below it, so the same string appears twice inside that one row.
    expect(within(rows[2]).getAllByText("carla@example.com")).toHaveLength(2);
    expect(within(rows[2]).getByText("1 galería")).toBeDefined();

    // Sanity check against a false positive: the EMPTY-state copy must be
    // absent — a page that (bug) always renders the empty branch regardless
    // of `clients.length` would otherwise slip past the assertions above if
    // they were ever weakened to "something rendered".
    expect(screen.queryByText("Todavía no cargaste ningún cliente.")).toBeNull();
  });

  // Task #132's own trap: a client row is not a link today, because there is
  // no client detail page. If this ever grows an <a>, it must not be to a
  // route that does not exist — and until then, this asserts the row stays a
  // plain, non-interactive element.
  it("renders a client row as a plain row, not a link", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([client()]);

    const element = await ClientsPage();
    const { container } = render(element);

    const [row] = rowsIn(container);
    expect(row.tagName).toBe("LI");
    expect(container.querySelector("a[data-client-id]")).toBeNull();
    expect(within(row).queryByRole("link")).toBeNull();
  });

  // The nullable field this task's own body names explicitly: "not an empty
  // row" — a client with no WhatsApp on file must show nothing here, not a
  // placeholder dash, and must not push the gallery-count cell out of place.
  it("renders nothing in the phone cell when the client has no phone on file", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([client({ phone: null, galleryCount: 2 })]);

    const element = await ClientsPage();
    const { container } = render(element);

    const [row] = rowsIn(container);
    expect(within(row).queryByText("Teléfono:")).toBeNull();
    // The gallery count is still there, and still its own value — proof the
    // missing phone did not eat its column.
    expect(within(row).getByText("2 galerías")).toBeDefined();
  });

  it("renders the empty state when there are no clients yet", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([]);

    const element = await ClientsPage();
    const { container } = render(element);

    expect(screen.getByText("Todavía no cargaste ningún cliente.")).toBeDefined();
    expect(screen.getByText(/Cargá el primero desde «Nuevo cliente»/)).toBeDefined();
    expect(rowsIn(container)).toHaveLength(0);
    // A genuine empty state (task #88): no rows, and no count line claiming
    // "0 clientes en total" either.
    expect(screen.queryByText(/en total/)).toBeNull();
  });

  it("summarises the list with a count taken from the rows themselves", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([
      client({ id: "u1" }),
      client({ id: "u2" }),
      client({ id: "u3" }),
    ]);

    const element = await ClientsPage();
    const { container } = render(element);

    expect(rowsIn(container)).toHaveLength(3);
    expect(screen.getByText(/3 clientes en total/)).toBeDefined();
  });

  // ---------------------------------------------------------------------
  // The creation dialog (task #132, same pattern as #131's galleries one).
  // The form used to occupy a permanent 360px column; it now lives behind
  // one trigger in the page head.
  // ---------------------------------------------------------------------

  it("renders the client form inside a dialog opened from the page head", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([]);
    const user = userEvent.setup();

    const element = await ClientsPage();
    render(element);

    // Closed to begin with — the 360px column is genuinely gone, not hidden.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Agregar cliente" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Nuevo cliente" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Agregar cliente" })).toBeDefined();
    expect(within(dialog).getByLabelText("Nombre")).toBeDefined();
    expect(within(dialog).getByLabelText("Correo electrónico")).toBeDefined();
  });

  it("closes the dialog on Escape and returns focus to the trigger", async () => {
    getClientsWithGalleryCountMock.mockResolvedValue([]);
    const user = userEvent.setup();

    const element = await ClientsPage();
    render(element);

    const trigger = screen.getByRole("button", { name: "Nuevo cliente" });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    // Radix unmounts the dialog content on close; wait for that rather than
    // asserting on the very next tick.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
