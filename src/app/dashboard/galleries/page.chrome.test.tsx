// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/clients/page.chrome.test.tsx: jsdom
// cannot resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts, src/lib/galleries.ts, src/lib/clients.ts and
// src/lib/packages.ts, even with `vi.mock("server-only", ...)`. So each of
// those modules is mocked WHOLESALE here, and `./actions` is mocked the same
// way (it too pulls in `@/lib/auth-guards` transitively via `<GalleryForm />`).
//
// `@/lib/format` is deliberately NOT mocked — it is the DB-free module that
// exists so tests can use the real pluralizers instead of re-implementing them
// inside a mock (see its own header comment, tasks #49/#90/#122).
//
// page.test.ts (node environment) proves the admin guard is real; this file
// is the other half — the only place that proves the queries' output is
// actually wired into markup, not just that the page resolves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "next-auth";
import GalleriesPage from "./page";
import type { GalleryWithDetails } from "@/lib/galleries";
import type { ClientForPicker } from "@/lib/clients";
import type { PackageForPicker } from "@/lib/packages";
import type { CreateGalleryState } from "./actions";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getGalleriesWithDetailsMock = vi.fn<() => Promise<GalleryWithDetails[]>>();
vi.mock("@/lib/galleries", () => ({
  getGalleriesWithDetails: () => getGalleriesWithDetailsMock(),
  formatGalleryStatus: (status: string) => {
    const labels: Record<string, string> = {
      draft: "Borrador",
      proofing: "En pruebas",
      selected: "Selección enviada",
      delivered: "Entregada",
      archived: "Archivada",
    };
    return labels[status] ?? status;
  },
  formatSessionDate: (sessionDate: string) => {
    const [year, month, day] = sessionDate.split("-");
    return `${day}/${month}/${year}`;
  },
}));

const getClientsForPickerMock = vi.fn<() => Promise<ClientForPicker[]>>();
vi.mock("@/lib/clients", () => ({
  getClientsForPicker: () => getClientsForPickerMock(),
}));

const getActivePackagesMock = vi.fn<() => Promise<PackageForPicker[]>>();
vi.mock("@/lib/packages", () => ({
  getActivePackages: () => getActivePackagesMock(),
}));

vi.mock("./actions", () => ({
  createGallery:
    vi.fn<(state: CreateGalleryState, formData: FormData) => Promise<CreateGalleryState>>(),
}));

/** One gallery fixture, overridable field by field. */
function gallery(overrides: Partial<GalleryWithDetails> = {}): GalleryWithDetails {
  return {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "draft",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    selectionSubmittedAt: null,
    clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    photoCount: 24,
    ...overrides,
  };
}

/** Every gallery row on the page, in DOM order.
 *
 * Task #131 made the row itself the link (the whole row is the target), and
 * `data-status` is the row's machine-readable state — see the note on the
 * status badge in page.tsx for why the tests below key off that attribute
 * rather than off a class name. The `[href^=...]` half of the selector keeps
 * this from ever matching some future non-row element that happens to carry a
 * status attribute. */
function rowsIn(container: HTMLElement): HTMLAnchorElement[] {
  return Array.from(
    container.querySelectorAll<HTMLAnchorElement>('a[data-status][href^="/dashboard/galleries/"]'),
  );
}

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getGalleriesWithDetailsMock.mockReset();
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([
    { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  ]);
  getActivePackagesMock.mockReset();
  getActivePackagesMock.mockResolvedValue([{ id: 1, name: "Estándar", includedPhotos: 13 }]);
});

afterEach(() => {
  cleanup();
});

describe("GalleriesPage chrome", () => {
  it("renders each gallery's title, client, package, status, session date and photo count", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    const element = await GalleriesPage();
    const { container } = render(element);

    // Scoped to the gallery's own row, not the whole page — the same client
    // also appears (by design) in the <GalleryForm> picker inside the dialog.
    const [row] = rowsIn(container);
    expect(within(row).getByText(/Ana Pérez/)).toBeDefined();
    expect(within(row).getByText(/Estándar/)).toBeDefined();
    expect(within(row).getByText("Borrador")).toBeDefined();
    expect(within(row).getByText(/01\/08\/2026/)).toBeDefined();
    // The mock renders a bare tabular number under an `aria-hidden` "Fotos"
    // heading that does not exist at phone widths at all, so the unit travels
    // with the number as screen-reader-only text (dashboard.html:321, :794).
    // `getByText` matches an element's OWN text nodes, so these two assertions
    // together are what proves the split: "24" is what is drawn, "24 fotos" is
    // what is announced.
    expect(within(row).getByText("24")).toBeDefined();
    expect(within(row).getByText("24").textContent).toBe("24 fotos");

    // Sanity check against a false positive, same reasoning as
    // clients/page.chrome.test.tsx: the empty-state copy must be absent.
    expect(screen.queryByText("Todavía no armaste ninguna galería.")).toBeNull();
  });

  // Task #131's acceptance criterion, and the reason the row is an <a> that
  // IS the grid rather than an <a> nested inside one cell of it: the whole row
  // is the target, so every value in it is inside the link.
  it("makes the WHOLE row the link to that gallery, not just its title", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery({ id: "g-42" })]);

    const element = await GalleriesPage();
    const { container } = render(element);

    const [row] = rowsIn(container);
    expect(row.getAttribute("href")).toBe("/dashboard/galleries/g-42");
    for (const value of ["Boda Ana y Beto", "Ana Pérez", "Estándar", "Borrador", "24"]) {
      expect(within(row).getByText(value)).toBeDefined();
    }
  });

  // Review finding on task #94: every fixture in this file used to carry a
  // single client, so page.tsx's own `.join(" · ")` (one gallery's several
  // clients rendered on ONE line, separated by a middle dot) had never
  // actually been rendered with more than one.
  it("joins several clients' names with a middle dot on one line", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      gallery({
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Gómez", email: "beto@example.com" },
        ],
      }),
    ]);

    const element = await GalleriesPage();
    const { container } = render(element);

    const [row] = rowsIn(container);
    expect(within(row).getByText("Ana Pérez · Beto Gómez")).toBeDefined();
  });

  // TASK #75's core acceptance criterion, REWRITTEN FOR INTENT (task #131).
  //
  // This test used to read three class names off the DOM —
  // `className).toContain("text-fg-mute")`, `toContain("text-accent")` and
  // `querySelectorAll(".bg-accent.rounded-full")` — the only class-based
  // assertions anywhere in the dashboard suite. They pinned an implementation,
  // and worse, what they pinned was a COLOUR: #75's own stated goal was that a
  // submitted gallery "reads at a glance without requiring the words to be
  // read", which a colour alone never delivered for a photographer who cannot
  // perceive it or who is listening to the page.
  //
  // So the distinction is asserted where it is now actually carried: a
  // machine-readable `data-status` on the row, and real words only the
  // `selected` row has. Both survive any restyle; neither can be satisfied by
  // a colour.
  //
  // And it has to hold in a list long enough to actually scroll — one row
  // proves nothing (see the ticket's own wording).
  it("distinguishes the one 'selected' row from 23 others, without relying on colour", async () => {
    const galleries = Array.from({ length: 24 }, (_, i) =>
      gallery({
        id: `g${i}`,
        title: `Galería ${i}`,
        publicSlug: `slug-${i}`,
        status: i === 12 ? "selected" : "proofing",
        selectionSubmittedAt: i === 12 ? new Date("2026-07-28") : null,
        photoCount: 10,
      }),
    );
    getGalleriesWithDetailsMock.mockResolvedValue(galleries);

    const element = await GalleriesPage();
    const { container } = render(element);

    const rows = rowsIn(container);
    expect(rows).toHaveLength(24);

    // Machine-readable, and unique — buried at index 12 of 24, not
    // conveniently first.
    const selected = rows.filter((row) => row.dataset.status === "selected");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(rows[12]);
    expect(within(selected[0]).getByText("Selección enviada")).toBeDefined();

    // The non-colour signal: the one state that means somebody is waiting on
    // YOU says so in words a screen reader reads out. No other row does.
    expect(selected[0].textContent).toContain("esperando tu revisión");
    for (const row of rows.filter((candidate) => candidate !== selected[0])) {
      expect(row.dataset.status).toBe("proofing");
      expect(row.textContent).not.toContain("esperando tu revisión");
    }

    // ...and every other row still shows its own status label, unchanged.
    expect(screen.getAllByText("En pruebas")).toHaveLength(23);
  });

  // The column legend is the ONE element on this page that exists at a single
  // width. It is a legend for columns, not a second copy of the rows (epic
  // #125 forbids a per-breakpoint duplicate markup outright), and it is
  // `aria-hidden` because a <ul> is not a <table>: unhidden it would read as
  // six stray words with nothing associated to them.
  it("renders exactly one column legend, hidden from assistive technology", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    const element = await GalleriesPage();
    const { container } = render(element);

    const legends = container.querySelectorAll('li[aria-hidden="true"]');
    expect(legends).toHaveLength(1);
    expect(Array.from(legends[0].children).map((child) => child.textContent)).toEqual([
      "Galería",
      "Clientes",
      "Estado",
      "Paquete",
      "Sesión",
      "Fotos",
    ]);
  });

  // Epic #125's rule from #129/#174: a counter that lies is worse than one
  // that is absent. Both numbers here are counted off the very rows rendered,
  // so this asserts they AGREE with the list rather than merely that they
  // render.
  it("summarises the list with counts taken from the rows themselves", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      gallery({ id: "g1", title: "Uno", status: "selected" }),
      gallery({ id: "g2", title: "Dos", status: "selected" }),
      gallery({ id: "g3", title: "Tres", status: "draft" }),
    ]);

    const element = await GalleriesPage();
    const { container } = render(element);

    expect(rowsIn(container)).toHaveLength(3);
    expect(screen.getByText(/3 galerías en total/)).toBeDefined();
    expect(screen.getByText(/2 selecciones esperando/)).toBeDefined();
  });

  it("says nothing about pending selections when none are waiting", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery({ status: "draft" })]);

    const element = await GalleriesPage();
    render(element);

    expect(screen.getByText(/1 galería en total/)).toBeDefined();
    expect(screen.queryByText(/esperando/)).toBeNull();
  });

  it("renders the empty state when there are no galleries yet", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);

    const element = await GalleriesPage();
    const { container } = render(element);

    expect(screen.getByText("Todavía no armaste ninguna galería.")).toBeDefined();
    expect(screen.getByText(/Armá la primera desde «Nueva galería»/)).toBeDefined();
    // A genuine empty state (task #88): no rows, and no count line claiming
    // "0 galerías en total" either.
    expect(rowsIn(container)).toHaveLength(0);
    expect(screen.queryByText(/en total/)).toBeNull();
  });

  // ---------------------------------------------------------------------
  // The creation dialog (task #131). The form used to occupy a permanent
  // 360px column; it is now behind one trigger in the page head.
  // ---------------------------------------------------------------------

  // Since task #100 the form renders regardless of how many clients exist —
  // the sibling test below covers the zero case. This one is the ordinary
  // path, kept distinct so a regression in either is attributable.
  it("renders the gallery form inside a dialog opened from the page head", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    const user = userEvent.setup();

    const element = await GalleriesPage();
    render(element);

    // Closed to begin with — the 360px column is genuinely gone, not hidden.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Crear galería" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Nueva galería" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Crear galería" })).toBeDefined();
    expect(within(dialog).getByLabelText("Título")).toBeDefined();
    expect(within(dialog).getByLabelText("Fecha de la sesión")).toBeDefined();
  });

  it("closes the dialog on Escape and returns focus to the trigger", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    const user = userEvent.setup();

    const element = await GalleriesPage();
    render(element);

    const trigger = screen.getByRole("button", { name: "Nueva galería" });
    await user.click(trigger);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");

    // Radix unmounts the dialog content on close; wait for that rather than
    // asserting on the very next tick.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  // Task #100 REVERSED this. The page used to replace the whole form with
  // "Cargá un cliente antes de armar una galería" — the exact ordering the
  // owner asked to undo. It now always renders the form; <GalleryForm> puts
  // the guidance (and the link) inside the client field itself, where it
  // explains the field rather than blocking the page. Moving the form into a
  // dialog must not resurrect that block, which is what this asserts.
  // (The "only active packages appear in the picker" criterion is NOT covered
  // here; it lives in packages.test.ts and actions.test.ts.)
  it("still renders the creation form, with guidance, when there are no clients yet", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    getClientsForPickerMock.mockResolvedValue([]);
    const user = userEvent.setup();

    const element = await GalleriesPage();
    render(element);

    await user.click(screen.getByRole("button", { name: "Nueva galería" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("button", { name: "Crear galería" })).toBeDefined();
    expect(within(dialog).getByText(/Todavía no cargaste ningún cliente/)).toBeDefined();
    expect(within(dialog).getByRole("link", { name: "Ir a clientes" })).toBeDefined();
    expect(screen.queryByText(/Cargá un cliente antes de armar una galería/)).toBeNull();
  });

  // Task #100: a gallery with nobody attached is legitimate while it is a
  // draft, and the list must SAY so. Joining an empty array would render
  // " · Estándar" — a separator floating over nothing, which reads as missing
  // data rather than as a deliberate state. In a table cell the same rule
  // means the CELL says it; it must never come out as blank space or as a
  // dangling separator in front of the package name.
  it("renders 'Todavía sin cliente' as its own value, never an empty join", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      gallery({ title: "Sesión sin cliente", clients: [] }),
    ]);

    const element = await GalleriesPage();
    const { container } = render(element);

    const [row] = rowsIn(container);
    const fallback = within(row).getByText("Todavía sin cliente");
    expect(fallback).toBeDefined();
    // The whole cell is the fallback — nothing joined onto it, no separator.
    expect(fallback.parentElement?.textContent).toBe("Todavía sin cliente");
    expect(row.textContent).not.toContain("· Estándar");
  });
});
