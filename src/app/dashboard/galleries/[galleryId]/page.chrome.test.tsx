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
  // Task #100: a plain re-implementation of the real rule (a gallery past
  // `draft` needs at least one active client) — this module is mocked
  // wholesale, not via `importActual`, so every export the page imports from
  // it needs an entry here, same "name every export a mock provides" stance
  // as the rest of this mock. The real function and its Spanish copy are
  // covered directly in src/lib/galleries.test.ts; what this file proves is
  // that the page ASKS it and renders the answer.
  activeClientRuleViolation: ({
    targetStatus,
    activeClientCount,
    action,
  }: {
    targetStatus: string;
    activeClientCount: number;
    action: string;
  }) =>
    activeClientCount > 0 || targetStatus === "draft"
      ? null
      : `no-active-client-violation:${action}`,
}));

// `formatCop` lives in `@/lib/format` (a plain, DB-free module — see that
// file's own header comment for why), NOT `@/lib/galleries` — mocked
// separately here since `@/lib/galleries` is mocked wholesale above.
vi.mock("@/lib/format", () => ({
  formatCop: (amountCop: number) => `$ ${amountCop.toLocaleString("es-CO")}`,
}));

// Task #97: the page reads `getClientsForPicker` (`@/lib/clients`) to build
// the "attach" picker's eligible-client list — its REAL implementation
// issues a `db.query.users.findMany(...)` this file never stands up
// (`import "server-only"`, unresolvable under jsdom either), same reasoning
// as this file's own `@/lib/galleries`/`@/lib/r2` mocks.
const getClientsForPickerMock = vi.fn();
vi.mock("@/lib/clients", () => ({
  getClientsForPicker: () => getClientsForPickerMock(),
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
// Same reasoning, same file, for <DeliverGalleryButton> (task #27): its
// module imports `deliverGallery` from here too.
const deliverGalleryMock = vi.fn();
// Same reasoning, same file, for <AttachGalleryClientsForm>/<GalleryClientRow>
// (task #97): their modules import `attachGalleryClients`/
// `removeGalleryClient` from here too.
const attachGalleryClientsMock = vi.fn();
const removeGalleryClientMock = vi.fn();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: (...args: unknown[]) => publishGalleryMock(...args),
  unlockSelection: (...args: unknown[]) => unlockSelectionMock(...args),
  deliverGallery: (...args: unknown[]) => deliverGalleryMock(...args),
  attachGalleryClients: (...args: unknown[]) => attachGalleryClientsMock(...args),
  removeGalleryClient: (...args: unknown[]) => removeGalleryClientMock(...args),
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
    clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
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
  deliverGalleryMock.mockReset();
  attachGalleryClientsMock.mockReset();
  // `useActionState` (React 19) requires its action to resolve to a well-
  // formed state object — a bare `vi.fn()` resolves to `undefined` by
  // default, which crashes `<AttachGalleryClientsForm>`/`<GalleryClientRow>`
  // the instant either form submits, same reasoning as
  // gallery-form.test.tsx's own default mock resolution.
  attachGalleryClientsMock.mockResolvedValue({ status: "idle" });
  removeGalleryClientMock.mockReset();
  removeGalleryClientMock.mockResolvedValue({ status: "idle" });
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([]);
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

  // Review finding on task #94: every fixture in this file used to carry a
  // single client, so the plural rendering page.tsx's own comment describes
  // ("Task #94: a gallery can have several clients now — one line per
  // client") had never actually been rendered with more than one. This
  // proves it for real: a SECOND client gets its OWN `<p>`, not squashed
  // into the first one.
  it("renders one line per client when a gallery has several", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Gómez", email: "beto@example.com" },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const anaLine = screen.getByText(/Ana Pérez/);
    const betoLine = screen.getByText(/Beto Gómez/);
    expect(anaLine).toBeDefined();
    expect(betoLine).toBeDefined();
    // Two DISTINCT paragraphs, not one client's name/email crammed next to
    // the other's inside a single node.
    expect(anaLine).not.toBe(betoLine);
    expect(anaLine.tagName).toBe("P");
    expect(betoLine.tagName).toBe("P");
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

  // Task #100's UI layer, and note the question the page asks: it does not
  // check `clients.length` itself, it calls the SAME
  // `activeClientRuleViolation` the server action calls, about the same
  // destination status, and renders whatever string comes back. Hiding the
  // button is UX; `publishGallery` refuses regardless.
  it("replaces the publish button with the reason when a draft gallery has no clients", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft", clients: [] }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: "Publicar galería" })).toBeNull();
    // The mock's stand-in string, proving the rendered reason is the rule's
    // own message for the PUBLISH action and not copy invented by the page.
    expect(screen.getByText("no-active-client-violation:publish")).toBeDefined();
  });

  // Zero clients is a legitimate draft state since task #100 — it must read
  // as a deliberate state and point at the next action (attaching someone),
  // because it is what is blocking publication.
  it("renders 'Todavía sin cliente' as a deliberate state, not blank space", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft", clients: [] }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText(/Todavía sin cliente/)).toBeDefined();
    expect(screen.getByText(/agregá uno acá abajo para poder publicar la galería/)).toBeDefined();
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

  // Task #27's UI half of the same "hiding is UX only" guard: deliverGallery()
  // itself re-checks the gallery's real status AND every selected asset's
  // finalKey server-side (isDeliverable() + the missing-finals check), but
  // the button still must be wired to appear only for a `selected` gallery.
  it("shows the deliver button for a selected gallery, not for one still in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "selected" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Entregar galería" })).toBeDefined();
  });

  it("hides the deliver button for a gallery still in proofing", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: "Entregar galería" })).toBeNull();
  });

  // The page computes `pendingFinalsCount` itself, off the SAME
  // `gallery.assets` it already fetched, and hands it to
  // <DeliverGalleryButton> purely to disable the button — deliverGallery()
  // itself is the real guard (see that action's own comment). Wired here so
  // a selected-but-incomplete gallery cannot be delivered from a stale click.
  it("disables the deliver button when a selected asset still lacks a final", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "selected",
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: 0,
            finalKey: null,
            isEdited: false,
          },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Entregar galería" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("enables the deliver button once every selected asset has its final", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "selected",
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: 0,
            finalKey: "galleries/g1/assets/a1/final.jpg",
            isEdited: true,
          },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Entregar galería" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});

describe("GalleryDetailPage — attaching and removing clients (task #97)", () => {
  it("excludes an already-active client from the attach picker's options", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }] }),
    );
    getClientsForPickerMock.mockResolvedValue([
      { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
      { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
    ]);

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    // Beto (not yet attached) is offered; Ana (already active) is not —
    // her name still appears once, as the gallery's own client line, but
    // never as a second, selectable <option>.
    expect(screen.getByRole("option", { name: "Beto Ruiz" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Ana Pérez" })).toBeNull();
  });

  it("shows a message instead of the picker when every client is already attached", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }] }),
    );
    getClientsForPickerMock.mockResolvedValue([
      { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
    ]);

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText(/Ya agregaste a todos los clientes disponibles/)).toBeDefined();
  });

  it("shows a Quitar affordance for each active client when there is more than one", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getAllByRole("button", { name: "Quitar" })).toHaveLength(2);
  });

  // The last-active-client guard's UI half: hiding "Quitar" is UX only —
  // removeGalleryClient() itself re-checks activeClientRuleViolation()
  // server-side (src/lib/galleries.ts) regardless of what this page renders.
  it("hides the Quitar affordance for the ONLY active client on a non-draft gallery", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "proofing",
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });

  // Task #97's own reversal of part of the invariant: a DRAFT gallery may
  // legitimately reach zero active clients — `removeGalleryClient` is what
  // gets it there — so "Quitar" must NOT be hidden even for the only one.
  it("shows the Quitar affordance for the ONLY active client on a DRAFT gallery", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "draft",
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByRole("button", { name: "Quitar" })).toBeDefined();
  });

  // The confirmation copy must say WHAT is about to happen, not just ask
  // "¿estás seguro?" — this task's own explicit requirement, sharpest for a
  // DELIVERED gallery: removing a client takes away photos they may have
  // already paid for.
  it("names what removal costs a client on a DELIVERED gallery before confirming", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "delivered",
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);

    expect(
      screen.getByText(/perder el acceso para ver y descargar las fotos entregadas/),
    ).toBeDefined();
    expect(removeGalleryClientMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();
  });

  it("submits removeGalleryClient only after the confirm step", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: "Quitar" })[0]!);
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(removeGalleryClientMock).toHaveBeenCalledTimes(1);
  });
});
