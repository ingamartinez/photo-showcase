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
import {
  GALLERY_PAGE_SIZE,
  type GalleryListQuery,
  type GalleryStatus,
} from "@/lib/gallery-list-query";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getGalleriesWithDetailsMock =
  vi.fn<(query: GalleryListQuery) => Promise<GalleryWithDetails[]>>();
// Task #276 correction C1 — the counts mock must KEEP its argument: a mock
// that throws it away cannot prove the filter reached the count query, so
// `getGalleryListCounts(parsed.status)` → `getGalleryListCounts(null)` (i.e.
// unfiltered totals under a filter) would stay green.
const getGalleryListCountsMock =
  vi.fn<(status: GalleryStatus | null) => Promise<{ studioTotal: number; matching: number }>>();
const getPendingSelectionCountMock = vi.fn<() => Promise<number>>();
vi.mock("@/lib/galleries", () => ({
  getGalleriesWithDetails: (query: GalleryListQuery) => getGalleriesWithDetailsMock(query),
  getGalleryListCounts: (status: GalleryStatus | null) => getGalleryListCountsMock(status),
  getPendingSelectionCount: () => getPendingSelectionCountMock(),
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

// Task #276 — the control strip is a client component and calls
// `router.push`. The rest of `next/navigation` stays real (nothing on this
// page calls it as an RSC), so this is a partial mock.
const push = vi.fn();
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useRouter: () => ({ ...actual, push }) };
});

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
    // Epic #250 (#263): zero by default — a gallery with no claimed photo
    // without a final is not waiting on anybody, whatever its status says.
    pendingWorkCount: 0,
    ...overrides,
  };
}

/** A page's worth of rows, for the pager tests. */
function rows(count: number, start = 0): GalleryWithDetails[] {
  return Array.from({ length: count }, (_, index) =>
    gallery({ id: `g${start + index}`, title: `Galería ${start + index}` }),
  );
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

/** Task #276 — the page reads the URL through `searchParams`; every test
 * renders through this helper so the shape lives in one place. */
async function renderPage(params: Record<string, string | string[] | undefined> = {}) {
  const element = await GalleriesPage({ searchParams: Promise.resolve(params) });
  return render(element);
}

function deskGroup() {
  return screen.getByRole("group", { name: "Ordenar por columna" });
}

/** Task #276 — the "Ordenar por" combobox AS THE PAGE RENDERED IT (the option
 * list comes from the RSC, not from a test-owned array). */
function sortCombobox() {
  return screen.getByRole("combobox", { name: "Ordenar por" });
}

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getGalleriesWithDetailsMock.mockReset();
  getGalleriesWithDetailsMock.mockResolvedValue([]);
  getGalleryListCountsMock.mockReset();
  getGalleryListCountsMock.mockResolvedValue({ studioTotal: 1, matching: 1 });
  getPendingSelectionCountMock.mockReset();
  getPendingSelectionCountMock.mockResolvedValue(0);
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([
    { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  ]);
  getActivePackagesMock.mockReset();
  getActivePackagesMock.mockResolvedValue([{ id: 1, name: "Estándar", includedPhotos: 13 }]);
  push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GalleriesPage chrome", () => {
  it("renders each gallery's title, client, package, status, session date and photo count", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    const { container } = await renderPage();

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

    const { container } = await renderPage();

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

    const { container } = await renderPage();

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
  it("distinguishes the one waiting-on-YOU row from 23 others, without relying on colour", async () => {
    const galleries = Array.from({ length: 24 }, (_, i) =>
      gallery({
        id: `g${i}`,
        title: `Galería ${i}`,
        publicSlug: `slug-${i}`,
        status: i === 12 ? "selected" : "proofing",
        selectionSubmittedAt: i === 12 ? new Date("2026-07-28") : null,
        photoCount: 10,
        pendingWorkCount: i === 12 ? 4 : 0,
      }),
    );
    getGalleriesWithDetailsMock.mockResolvedValue(galleries);
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 24, matching: 24 });

    const { container } = await renderPage();

    const rows = rowsIn(container);
    expect(rows).toHaveLength(24);
    // Task #276's own guard: this fixture is a ONE-page list only while the
    // page size is at least 24. Lowering GALLERY_PAGE_SIZE must fail loudly
    // here rather than silently turn this into a two-page test that no longer
    // proves what its name says.
    expect(GALLERY_PAGE_SIZE).toBeGreaterThanOrEqual(24);
    expect(screen.queryByRole("navigation", { name: "Paginación" })).toBeNull();

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
      // Scoped to the ROW: the Estado <select> above also contains an
      // `<option>` labelled "En pruebas".
      expect(within(row).getByText("En pruebas")).toBeDefined();
    }
  });

  // The column legend is the ONE element on this page that exists at a single
  // width. It is a legend for columns, not a second copy of the rows (epic
  // #125 forbids a per-breakpoint duplicate markup outright).
  //
  // TASK #276 INVALIDATED THE OLD ASSERTION (one `li[aria-hidden]`) ON
  // PURPOSE. The headings are now LINKS, so `aria-hidden` would hide focusable
  // content; and living inside the <ul> would make a screen reader announce
  // "list, 26 items" for 25 galleries. They are a labelled `role="group"` of
  // links OUTSIDE the <ul>, and `aria-sort` is absent because it is only valid
  // on a columnheader — epic #125 forbids fake table roles on a <ul>. The
  // active direction travels in the link's accessible NAME instead.
  it("renders the desk legend as a labelled group of sort links, with no fake table roles", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    const { container } = await renderPage();

    expect(container.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(0);

    const links = within(deskGroup()).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Galería",
      "Clientes",
      "Estado",
      "Paquete",
      "Sesión",
      "Fotos",
    ]);
    // No sort active → every link is the FIRST click on its column, so the
    // default directions are encoded (and defaults are omitted).
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/dashboard/galleries?sort=title",
      "/dashboard/galleries?sort=clients",
      "/dashboard/galleries?sort=status",
      "/dashboard/galleries?sort=package",
      "/dashboard/galleries?sort=session",
      "/dashboard/galleries?sort=photos",
    ]);

    expect(container.querySelector("[aria-sort]")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("row")).toBeNull();
    expect(screen.queryByRole("columnheader")).toBeNull();

    // The list count is honest: every <li> is a gallery row with exactly one
    // row link — the legend is not an extra list item.
    for (const item of container.querySelectorAll("li")) {
      expect(item.querySelectorAll("a[data-status]")).toHaveLength(1);
    }
  });

  it("names the active sort's direction and clicking it reverses it", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    await renderPage({ sort: "title" });

    const active = within(deskGroup()).getByRole("link", {
      name: "Galería, orden ascendente",
    });
    expect(active.getAttribute("href")).toBe("/dashboard/galleries?sort=title&dir=desc");
  });

  // W3's sibling (task #276 review round 4): this test claims the heading click
  // RESETS the page, so it has to be rendering page 2 when it clicks. The
  // shared 1/1 fixture clamped `?page=2` down to page 1 before the legend was
  // built, and `page=1` emits no param — so mutating `sortedBy`'s `page: 1` to
  // `page: query.page` left the href assertion green. LOCAL 63/26 override (2
  // filtered pages of 25), deliberately NOT the shared fixture, which other
  // cases depend on; with 26 matching rows page 2 survives the clamp.
  it("keeps the filter and resets the page when a desk heading is clicked", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(1, 25));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 26 });

    await renderPage({ status: "draft", page: "2" });

    // PRECONDITION, asserted on the production path: the rows were read as
    // FILTERED PAGE 2 — not as page 1 after a clamp against 1 matching row.
    // Without this, the href assertion below could pass for the wrong reason.
    expect(getGalleriesWithDetailsMock).toHaveBeenCalledWith({
      status: "draft",
      sort: null,
      dir: "desc",
      page: 2,
    });

    const photos = within(deskGroup()).getByRole("link", { name: "Fotos" });
    expect(photos.getAttribute("href")).toBe("/dashboard/galleries?status=draft&sort=photos");
  });

  // C2 (task #276 review round 2) — the controls test renders a TEST-OWNED
  // options array, so it proves the component renders its props; it can never
  // prove the RSC SUPPLIES them. This is the assertion that does, and it is
  // the only one that could: mutating page.tsx to
  // `sortOptions={[{ value: "", label: "Actividad reciente" }]}` removed every
  // explicit sort choice below 1024px (where the heading links are hidden) and
  // left the whole focused suite green.
  //
  // It also pins approved plan §4's ORDER: Sesión and Fotos list their
  // DESCENDING choice first ("más reciente" / "más primero"), the other four
  // columns their ascending one.
  it("offers the real 13 sort choices from the page, in the approved order", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);

    await renderPage();

    const options = [...sortCombobox().querySelectorAll("option")].map((option) => [
      option.value,
      option.textContent,
    ]);

    expect(options).toEqual([
      ["", "Actividad reciente"],
      ["title:asc", "Galería (A–Z)"],
      ["title:desc", "Galería (Z–A)"],
      ["clients:asc", "Clientes (A–Z)"],
      ["clients:desc", "Clientes (Z–A)"],
      ["status:asc", "Estado (de borrador a archivada)"],
      ["status:desc", "Estado (de archivada a borrador)"],
      ["package:asc", "Paquete (A–Z)"],
      ["package:desc", "Paquete (Z–A)"],
      ["session:desc", "Sesión (más reciente)"],
      ["session:asc", "Sesión (más antigua)"],
      ["photos:desc", "Fotos (más primero)"],
      ["photos:asc", "Fotos (menos primero)"],
    ]);
  });

  // C2, second half: a choice made from the REAL page reaches the canonical
  // URL, keeps the filter and drops the page. `session:asc` is deliberately a
  // NON-default direction, so the emitted `dir` is asserted too.
  //
  // W3 (review round 3): the reset claim is only meaningful if the controls are
  // really rendering page 2 when the choice is made. The shared 1/1 fixture
  // clamped `?page=2` down to page 1 BEFORE the controls rendered, so this test
  // could not tell "resets the page" from "keeps the already-clamped page 1".
  // Hence the LOCAL 63/26 override (2 filtered pages of 25 — deliberately not
  // the shared fixture, which other cases depend on) plus the precondition on
  // the row query below: with 26 matching rows, page 2 survives the clamp.
  it("writes a sort chosen on the page into the canonical URL, keeping the filter and resetting the page", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(1, 25));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 26 });
    const user = userEvent.setup();

    await renderPage({ status: "draft", page: "2" });

    // PRECONDITION, asserted on the production path: the rows were read as
    // FILTERED PAGE 2 — not as page 1 after a clamp against 1 matching row.
    // Without this, the push assertion below could pass for the wrong reason.
    expect(getGalleriesWithDetailsMock).toHaveBeenCalledWith({
      status: "draft",
      sort: null,
      dir: "desc",
      page: 2,
    });

    await user.selectOptions(sortCombobox(), "session:asc");

    expect(push).toHaveBeenCalledWith("/dashboard/galleries?status=draft&sort=session&dir=asc");
  });

  // Epic #125's rule from #129/#174: a counter that lies is worse than one
  // that is absent. Task #276 RETIRED the "counted off the very rows
  // rendered" invariant, because pagination makes it impossible — this
  // fixture is the DISAGREEMENT one that proves it: only 3 rows are on
  // screen, their own pending tallies sum to 2, and the queries say 63 and 5.
  // Every number here comes from the count queries, so 3 and 2 must be absent.
  it("summarises the studio with counts from the count queries, not the rows", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      gallery({ id: "g1", title: "Uno", status: "selected", pendingWorkCount: 2 }),
      gallery({ id: "g2", title: "Dos", status: "proofing", pendingWorkCount: 1 }),
      gallery({ id: "g3", title: "Tres", status: "draft" }),
    ]);
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });
    getPendingSelectionCountMock.mockResolvedValue(5);

    const { container } = await renderPage();

    expect(rowsIn(container)).toHaveLength(3);
    expect(screen.getByText(/63 galerías en total/)).toBeDefined();
    expect(screen.getByText(/5 selecciones esperando/)).toBeDefined();
    // Exact strings, not substrings: "3 galerías en total" is a substring of
    // "63 galerías en total", so an unanchored regex would pass for the wrong
    // reason.
    expect(screen.queryByText("3 galerías en total · 2 selecciones esperando")).toBeNull();
  });

  it("shows the filtered total in the header line, with the global pending tally", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery()]);
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 3 });
    getPendingSelectionCountMock.mockResolvedValue(2);

    await renderPage({ status: "draft" });

    // The counts query is asked about the SAME filter the header presents.
    expect(getGalleryListCountsMock).toHaveBeenCalledWith("draft");
    expect(screen.getByText(/3 de 63 galerías · 2 selecciones esperando/)).toBeDefined();
  });

  // Epic #250, decisions 10+11, task #263: a submit no longer locks, so work
  // arrives while the gallery is still `proofing` — and a `selected` gallery
  // whose finals are all uploaded is waiting on nobody. The count and the
  // row's own words are keyed on `pendingWorkCount`, NOT on the status badge.
  //
  // TASK #276: the summary's tally now comes from `getPendingSelectionCount`
  // (the same function the nav badge reads), not from the rendered rows — so
  // its PROOF moved to the mock. The "a status-based predicate would say 1"
  // case lives with `getPendingSelectionCount`'s own predicate test in
  // galleries.test.ts.
  it("counts and emphasises a PROOFING row with pending work, and not a selected one without", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      gallery({ id: "g1", title: "Boda uno", status: "proofing", pendingWorkCount: 3 }),
      gallery({ id: "g2", title: "Boda dos", status: "proofing", pendingWorkCount: 1 }),
      gallery({ id: "g3", title: "Boda tres", status: "selected", pendingWorkCount: 0 }),
    ]);
    getPendingSelectionCountMock.mockResolvedValue(2);

    const { container } = await renderPage();

    const [proofing, second, selected] = rowsIn(container);
    expect(proofing.textContent).toContain("esperando tu revisión");
    expect(second.textContent).toContain("esperando tu revisión");
    expect(selected.textContent).not.toContain("esperando tu revisión");
    // The badge text itself is unchanged — it is still the status.
    expect(within(selected).getByText("Selección enviada")).toBeDefined();
    expect(within(proofing).getByText("En pruebas")).toBeDefined();
    // ...and the summary agrees with the GLOBAL count: two galleries wait on
    // the photographer. A status-based predicate would say 1, and "1" is
    // asserted absent to keep it that way.
    expect(screen.getByText(/2 selecciones esperando/)).toBeDefined();
    expect(screen.queryByText(/1 selección esperando/)).toBeNull();
  });

  it("says nothing about pending selections when none are waiting", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([gallery({ status: "draft" })]);

    await renderPage();

    expect(screen.getByText(/1 galería en total/)).toBeDefined();
    expect(screen.queryByText(/esperando/)).toBeNull();
  });

  it("renders the genuine empty state when the studio has no galleries", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 0, matching: 0 });

    const { container } = await renderPage();

    expect(screen.getByText("Todavía no armaste ninguna galería.")).toBeDefined();
    expect(screen.getByText(/Arma la primera desde «Nueva galería»/)).toBeDefined();
    // A genuine empty state (task #88): no rows, and no count line claiming
    // "0 galerías en total" either.
    expect(rowsIn(container)).toHaveLength(0);
    expect(screen.queryByText(/en total/)).toBeNull();
    // Task #276: the genuine-empty studio shows none of the list chrome —
    // there is nothing to filter, sort or page.
    expect(screen.queryByRole("combobox", { name: "Estado" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Ordenar por columna" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Paginación" })).toBeNull();
  });

  // Task #276 — a filter that matches nothing is NOT an empty studio: the
  // studio has galleries, this status does not. The copy must say so and offer
  // a way back, and the control strip must stay so the filter can be changed.
  it("renders a filter-empty block, distinct from the genuine empty state", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 5, matching: 0 });

    const { container } = await renderPage({ status: "archived", sort: "title" });

    expect(screen.getByText("Ninguna galería en «Archivada».")).toBeDefined();
    expect(screen.getByText(/Prueba con otro estado\./)).toBeDefined();
    expect(screen.queryByText("Todavía no armaste ninguna galería.")).toBeNull();

    // Quitar filtro drops the status but keeps the sort.
    expect(screen.getByRole("link", { name: "Quitar filtro" }).getAttribute("href")).toBe(
      "/dashboard/galleries?sort=title",
    );
    // The filter can still be changed; there are no rows and no desk legend.
    expect(screen.getByRole("combobox", { name: "Estado" })).toBeDefined();
    expect(rowsIn(container)).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "Ordenar por columna" })).toBeNull();
    // The header line still names the filtered total.
    expect(screen.getByText(/0 de 5 galerías/)).toBeDefined();
  });

  // Task #276 — the pager. Only appears past ONE page, shows the range in a
  // live region, and carries filter/sort/dir across pages.
  it("paginates with a range line, Anterior and Siguiente", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(25, 25));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });

    await renderPage({ page: "2" });

    const range = screen.getByText("Mostrando 26–50 de 63");
    expect(range.getAttribute("aria-live")).toBe("polite");

    const nav = screen.getByRole("navigation", { name: "Paginación" });
    expect(within(nav).getByText("Página 2 de 3")).toBeDefined();
    // Page 1 is the default state, so its href omits `page` entirely.
    expect(within(nav).getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe(
      "/dashboard/galleries",
    );
    expect(within(nav).getByRole("link", { name: "Siguiente" }).getAttribute("href")).toBe(
      "/dashboard/galleries?page=3",
    );
  });

  it("disables Siguiente on the last page with no href", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(13, 50));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });

    await renderPage({ page: "3" });

    expect(screen.getByText("Mostrando 51–63 de 63")).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Paginación" });
    const next = within(nav).getByRole("link", { name: "Siguiente" });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.hasAttribute("href")).toBe(false);
    expect(within(nav).getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe(
      "/dashboard/galleries?page=2",
    );
  });

  it("clamps an out-of-range page in render, and queries the clamped page", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(13, 50));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });

    await renderPage({ page: "99" });

    expect(getGalleriesWithDetailsMock).toHaveBeenCalledWith({
      status: null,
      sort: null,
      dir: "desc",
      page: 3,
    });
    expect(
      within(screen.getByRole("navigation", { name: "Paginación" })).getByText("Página 3 de 3"),
    ).toBeDefined();
  });

  // C1 (task #276 review round 2) — the three mutations that stayed green all
  // lived in this area, so this ONE case is built to kill all three: a
  // FILTERED, SORTED, OUT-OF-RANGE URL where the studio's page count and the
  // filtered page count DIFFER.
  //
  //   studioTotal 63 → 3 studio pages; matching 26 → 2 filtered pages.
  //   ?page=99 must clamp to the last FILTERED page (2), never to studio page 3,
  //   and the rows must be read with the filter, not without it.
  //
  // Each mutation fails a DIFFERENT assertion:
  //   - counts asked with `null` instead of the status  → the call arg below;
  //   - rows read with `{ ...query, status: null }`      → the full query;
  //   - clamp against `counts.studioTotal`              → page 2 vs 3, the
  //     "Página 2 de 2" label, the range line and the Anterior href.
  it("clamps a filtered out-of-range page against the MATCHING total, keeping filter and sort", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(1, 25));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 26 });

    await renderPage({ status: "draft", sort: "photos", dir: "asc", page: "99" });

    // The count query is asked about the SAME filter the rows query is.
    expect(getGalleryListCountsMock).toHaveBeenCalledWith("draft");

    // The COMPLETE query the row read receives: filter kept, order kept, page
    // clamped against the filtered total (26 → 2 pages), not the studio's 63.
    expect(getGalleriesWithDetailsMock).toHaveBeenCalledWith({
      status: "draft",
      sort: "photos",
      dir: "asc",
      page: 2,
    });

    // The header, the range line and the pager all describe that same filtered
    // page-2 set.
    expect(screen.getByText(/26 de 63 galerías/)).toBeDefined();
    expect(screen.getByText("Mostrando 26–26 de 26")).toBeDefined();
    const nav = screen.getByRole("navigation", { name: "Paginación" });
    expect(within(nav).getByText("Página 2 de 2")).toBeDefined();
    // Pager hrefs keep the filter and the order; page 1 is those params alone.
    expect(within(nav).getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe(
      "/dashboard/galleries?status=draft&sort=photos&dir=asc",
    );
    const next = within(nav).getByRole("link", { name: "Siguiente" });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.hasAttribute("href")).toBe(false);
  });

  it("falls back to page 1 for a malformed page param", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(25, 0));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });

    await renderPage({ page: "abc" });

    expect(getGalleriesWithDetailsMock).toHaveBeenCalledWith({
      status: null,
      sort: null,
      dir: "desc",
      page: 1,
    });
  });

  it("carries the filter and order across pages", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue(rows(25, 25));
    getGalleryListCountsMock.mockResolvedValue({ studioTotal: 63, matching: 63 });

    await renderPage({ status: "draft", sort: "photos", dir: "asc", page: "2" });

    const nav = screen.getByRole("navigation", { name: "Paginación" });
    expect(within(nav).getByRole("link", { name: "Anterior" }).getAttribute("href")).toBe(
      "/dashboard/galleries?status=draft&sort=photos&dir=asc",
    );
    expect(within(nav).getByRole("link", { name: "Siguiente" }).getAttribute("href")).toBe(
      "/dashboard/galleries?status=draft&sort=photos&dir=asc&page=3",
    );
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

    await renderPage();

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

    await renderPage();

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
  // "Carga un cliente antes de armar una galería" — the exact ordering the
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

    await renderPage();

    await user.click(screen.getByRole("button", { name: "Nueva galería" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByRole("button", { name: "Crear galería" })).toBeDefined();
    expect(within(dialog).getByText(/Todavía no cargaste ningún cliente/)).toBeDefined();
    expect(within(dialog).getByRole("link", { name: "Ir a clientes" })).toBeDefined();
    expect(screen.queryByText(/Carga un cliente antes de armar una galería/)).toBeNull();
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

    const { container } = await renderPage();

    const [row] = rowsIn(container);
    const fallback = within(row).getByText("Todavía sin cliente");
    expect(fallback).toBeDefined();
    // The whole cell is the fallback — nothing joined onto it, no separator.
    expect(fallback.parentElement?.textContent).toBe("Todavía sin cliente");
    expect(row.textContent).not.toContain("· Estándar");
  });
});
