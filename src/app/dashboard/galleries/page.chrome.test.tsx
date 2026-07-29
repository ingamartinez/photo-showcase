// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/clients/page.chrome.test.tsx: jsdom
// cannot resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts, src/lib/galleries.ts, src/lib/clients.ts and
// src/lib/packages.ts, even with `vi.mock("server-only", ...)`. So each of
// those modules is mocked WHOLESALE here, and `./actions` is mocked the same
// way (it too pulls in `@/lib/auth-guards` transitively via `<GalleryForm />`).
//
// page.test.ts (node environment) proves the admin guard is real; this file
// is the other half — the only place that proves the queries' output is
// actually wired into markup, not just that the page resolves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
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
    getGalleriesWithDetailsMock.mockResolvedValue([
      {
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
      },
    ]);

    const element = await GalleriesPage();
    render(element);

    // Scoped to the gallery's own list item, not the whole page — the same
    // client also appears (by design) in the <GalleryForm> picker below.
    const listItem = screen.getByText("Boda Ana y Beto").closest("li")!;
    expect(within(listItem).getByText(/Ana Pérez/)).toBeDefined();
    expect(within(listItem).getByText(/Estándar/)).toBeDefined();
    expect(within(listItem).getByText("Borrador")).toBeDefined();
    expect(within(listItem).getByText(/01\/08\/2026/)).toBeDefined();
    expect(within(listItem).getByText("24 fotos")).toBeDefined();

    // Sanity check against a false positive, same reasoning as
    // clients/page.chrome.test.tsx: the empty-state copy must be absent.
    expect(screen.queryByText("Todavía no armaste ninguna galería.")).toBeNull();
  });

  // Review finding on task #94: every fixture in this file used to carry a
  // single client, so page.tsx's own `.join(" · ")` (one gallery's several
  // clients rendered on ONE line, separated by a middle dot) had never
  // actually been rendered with more than one.
  it("joins several clients' names with a middle dot on one line", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        selectionSubmittedAt: null,
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Gómez", email: "beto@example.com" },
        ],
        package: { id: 1, name: "Estándar" },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        photoCount: 24,
      },
    ]);

    const element = await GalleriesPage();
    render(element);

    const listItem = screen.getByText("Boda Ana y Beto").closest("li")!;
    expect(within(listItem).getByText(/Ana Pérez · Beto Gómez/)).toBeDefined();
  });

  // Task #75's core acceptance criterion: a submitted gallery must be
  // identifiable without reading the status text, and that has to hold in a
  // list long enough to actually scroll — one row proves nothing (see this
  // file's task comment history / the ticket's own wording).
  it("marks only the 'selected' status with the accent treatment, even buried in a 24-row list", async () => {
    const galleries: GalleryWithDetails[] = Array.from({ length: 24 }, (_, i) => ({
      id: `g${i}`,
      title: `Galería ${i}`,
      publicSlug: `slug-${i}`,
      status: i === 12 ? "selected" : "proofing",
      sessionDate: "2026-08-01",
      createdAt: new Date("2026-07-01"),
      selectionSubmittedAt: i === 12 ? new Date("2026-07-28") : null,
      clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      package: { id: 1, name: "Estándar" },
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      photoCount: 10,
    }));
    getGalleriesWithDetailsMock.mockResolvedValue(galleries);

    const element = await GalleriesPage();
    const { container } = render(element);

    // Every other row keeps the same muted treatment as before...
    const mutedStatuses = screen.getAllByText("En pruebas");
    expect(mutedStatuses).toHaveLength(23);
    mutedStatuses.forEach((el) => expect(el.className).toContain("text-fg-mute"));

    // ...only the submitted row gets the studio's accent colour and a dot —
    // buried at index 12 of 24, not conveniently first.
    const selectedStatus = screen.getByText("Selección enviada");
    expect(selectedStatus.className).toContain("text-accent");
    expect(container.querySelectorAll(".bg-accent.rounded-full")).toHaveLength(1);
  });

  it("renders the empty state when there are no galleries yet", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);

    const element = await GalleriesPage();
    render(element);

    expect(screen.getByText("Todavía no armaste ninguna galería.")).toBeDefined();
    expect(screen.getByText(/Armá la primera galería con el formulario/)).toBeDefined();
  });

  it("renders the gallery form when there is at least one client", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);

    const element = await GalleriesPage();
    render(element);

    expect(screen.getByRole("button", { name: "Crear galería" })).toBeDefined();
  });

  // A gallery can't be built before there is at least one client to bind it
  // to — this proves the page steers the photographer to create one first
  // instead of rendering a form with an empty client picker.
  // (The "only active packages appear in the picker" criterion is NOT covered
  // here; it lives in packages.test.ts and actions.test.ts.)
  it("guides to /dashboard/clients instead of the form when there are no clients yet", async () => {
    getGalleriesWithDetailsMock.mockResolvedValue([]);
    getClientsForPickerMock.mockResolvedValue([]);

    const element = await GalleriesPage();
    render(element);

    expect(screen.getByText(/Cargá un cliente antes de armar una galería/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Crear galería" })).toBeNull();
  });
});
