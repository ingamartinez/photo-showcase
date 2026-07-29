// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/galleries/page.chrome.test.tsx: jsdom
// cannot resolve the bare `import "server-only"` pulled in transitively by
// src/lib/auth-guards.ts and src/lib/galleries.ts, even with
// `vi.mock("server-only", ...)`. So both of those modules are mocked
// WHOLESALE here, and `@/lib/r2` (server-only via r2Env(), see its header
// comment) is mocked too.
//
// page.test.ts (node environment) proves the admin guard and the notFound()
// branches are real; this file is the other half — the only place that
// proves the gallery's frozen terms and its assets are actually wired into
// markup, not just that the page resolves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import GalleryDetailPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";

const requireAdminMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireAdmin: () => requireAdminMock() }));

const getGalleryDetailMock = vi.fn<() => Promise<GalleryDetail | null>>();
// Task #73's own read — mocked here too (this module is mocked wholesale,
// not via `importActual`, so leaving this out would resolve to `undefined`
// and the page's own `await getGalleryUnlockAudit(...)` call would throw).
const getGalleryUnlockAuditMock = vi.fn<
  () => Promise<{
    unlockedAt: Date | null;
    unlockedByEmail: string | null;
    unlockReason: string | null;
  }>
>();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetail: () => getGalleryDetailMock(),
  getGalleryUnlockAudit: () => getGalleryUnlockAuditMock(),
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

// `formatCop` lives in `@/lib/format` (a plain, DB-free module — see that
// file's own header comment for why), NOT `@/lib/galleries` — mocked
// separately here since `@/lib/galleries` is mocked wholesale above.
vi.mock("@/lib/format", () => ({
  formatCop: (amountCop: number) => `$ ${amountCop.toLocaleString("es-CO")}`,
}));

vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
}));

// The page now renders <PublishGalleryButton> whenever a fixture's status
// is "draft" — its module imports `publishGallery` from here, which
// transitively pulls in `@/lib/auth-guards` (`import "server-only"`,
// unresolvable under jsdom — see this file's header comment) if left real.
// Mocked wholesale for the same reason as page.test.ts's mock of this
// module.
const publishGalleryMock = vi.fn();
// Same reasoning, same file, for <UnlockSelectionPanel> (task #73): its
// module imports `unlockSelection` from here too.
const unlockSelectionMock = vi.fn();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: (...args: unknown[]) => publishGalleryMock(...args),
  unlockSelection: (...args: unknown[]) => unlockSelectionMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "proofing",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    client: { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [],
    selectionSubmittedAt: null,
    ...overrides,
  };
}

function paramsFor(galleryId: string) {
  return { params: Promise.resolve({ galleryId }) };
}

beforeEach(() => {
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({
    user: { id: "admin-1", role: "admin", email: "admin@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getGalleryDetailMock.mockReset();
  getGalleryUnlockAuditMock.mockReset();
  getGalleryUnlockAuditMock.mockResolvedValue({
    unlockedAt: null,
    unlockedByEmail: null,
    unlockReason: null,
  });
  publishGalleryMock.mockReset();
  unlockSelectionMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("GalleryDetailPage chrome", () => {
  it("renders the gallery's title, client, session date, status and frozen package terms", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail());

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("Boda Ana y Beto")).toBeDefined();
    expect(screen.getByText(/Ana Pérez/)).toBeDefined();
    expect(screen.getByText(/01\/08\/2026/)).toBeDefined();
    expect(screen.getByText("En pruebas")).toBeDefined();
    expect(screen.getByText("Estándar")).toBeDefined();
    expect(screen.getByText("13")).toBeDefined();
  });

  // The headline rule this epic repeats everywhere: the terms shown come off
  // the gallery's OWN frozen snapshot columns. A live-package price leaking
  // through here (e.g. because a future refactor reads `gallery.package.
  // priceCop` instead of `gallery.extraPhotoPriceCopSnapshot`) would slip
  // past a test that only checks "some number renders" — this pins the
  // snapshot value itself.
  it("shows the gallery's frozen extraPhotoPriceCopSnapshot, not a live package price", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ extraPhotoPriceCopSnapshot: 7_777 }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("$ 7.777")).toBeDefined();
  });

  it("renders every asset's thumbnail and filename", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: false,
            sortOrder: 0,
            finalKey: null,
            isEdited: false,
          },
          {
            id: "a2",
            originalFilename: "IMG_0002.JPG",
            proofKey: "galleries/g1/proofs/a2.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: 1,
            finalKey: null,
            isEdited: false,
          },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("IMG_0001.JPG")).toBeDefined();
    expect(screen.getByText("IMG_0002.JPG")).toBeDefined();
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe(
      "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
    );

    // "2 fotos subidas" and "1 seleccionada" — the derived counts (never
    // stored, per PLAN.md §6) computed straight off the assets array.
    expect(screen.getByText("2")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
  });

  it("renders the empty state and the upload widget when there are no assets yet", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ assets: [] }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText(/Todavía no subiste fotos/)).toBeDefined();
    expect(screen.getByText("Subir fotos")).toBeDefined();
  });

  // Task #21's UI half of the guard: hiding the button once a gallery is no
  // longer "draft" is UX only (publishGallery() itself re-checks the status
  // server-side — see actions.ts's isPublishable()), but it still must be
  // wired correctly, or the photographer would see a dead-end button on an
  // already-published gallery.
  it("shows the publish button for a draft gallery, not for one already in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Publicar galería" })).toBeDefined();
  });

  it("hides the publish button once the gallery is already in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: "Publicar galería" })).toBeNull();
  });

  // Task #73's UI half of the same "hiding is UX only" guard: unlockSelection()
  // itself re-checks the gallery's real status server-side (isUnlockable()),
  // but the panel still must be wired to appear only for a `selected` gallery.
  it("shows the unlock panel for a selected gallery, not for one still in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "selected" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Desbloquear selección" })).toBeDefined();
  });

  it("hides the unlock panel for a gallery still in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: "Desbloquear selección" })).toBeNull();
  });

  it("renders who unlocked the gallery, when, and their note, when it was ever unlocked", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));
    getGalleryUnlockAuditMock.mockResolvedValue({
      unlockedAt: new Date("2026-07-28T20:00:00.000Z"),
      unlockedByEmail: "photographer@example.com",
      unlockReason: "El cliente pidió agregar dos fotos más.",
    });

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText(/Desbloqueada el/)).toBeDefined();
    expect(screen.getByText(/photographer@example\.com/)).toBeDefined();
    expect(screen.getByText(/El cliente pidió agregar dos fotos más\./)).toBeDefined();
  });

  it("renders nothing about the unlock audit for a gallery that was never unlocked", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByText(/Desbloqueada el/)).toBeNull();
  });
});
