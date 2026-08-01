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
import { cleanup, render, screen, within } from "@testing-library/react";
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
  // Task #101: a plain re-implementation of the real predicate's status set
  // (draft/archived are NOT client-visible) — same "name every export, prove
  // the REAL Spanish/rule in galleries.test.ts, prove the page ASKS it and
  // renders the answer here" stance as `activeClientRuleViolation` above.
  isGalleryVisibleToClient: (status: string) =>
    status === "proofing" || status === "selected" || status === "delivered",
}));

// `formatCop` lives in `@/lib/format` (a plain, DB-free module — see that
// file's own header comment for why), NOT `@/lib/galleries` — mocked
// separately here since `@/lib/galleries` is mocked wholesale above.
vi.mock("@/lib/format", () => ({
  formatCop: (amountCop: number) => `$ ${amountCop.toLocaleString("es-CO")}`,
  // Task #92: `@/lib/format` is mocked wholesale here (no `importActual` —
  // that would re-drag in this file's own real, non-DB dependents), so
  // every export the page reads off it needs its own entry, same stance as
  // every other mock in this file. A deliberately simple fake, not the real
  // binary-unit math (proven directly in src/lib/format.test.ts) — this
  // suite's own job is whether the PAGE calls it and renders the result.
  formatBytes: (bytes: number) => `${bytes} bytes`,
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
  // Task #78: identity fake — the page re-attaches the `R2Key` brand to
  // `asset.proofKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #92: mocked wholesale for the same jsdom-cannot-resolve-"server-only"
// reason as `@/lib/galleries`/`@/lib/r2` above — this module's own
// `import "server-only"` is unresolvable under jsdom regardless of
// `vi.mock("server-only", ...)`. Defaults to `null` (nothing deliverable
// yet), matching every fixture's default `assets: []`; the dedicated
// archive-size describe block below overrides it per test.
const getGalleryArchiveSizeMock = vi.fn();
vi.mock("@/lib/gallery-archive-size", () => ({
  getGalleryArchiveSize: (...args: unknown[]) => getGalleryArchiveSizeMock(...args),
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
// `removeGalleryClient` from here too. Task #101 adds `resendGalleryAccessEmail`
// to the same list — <GalleryClientRow>'s module now imports it too.
const attachGalleryClientsMock = vi.fn();
const removeGalleryClientMock = vi.fn();
const resendGalleryAccessEmailMock = vi.fn();
// Task #200: the page now renders <EditGalleryTermsDialog> unconditionally
// (no status gate — that is the whole point of this task); its module
// imports `updateGalleryTerms` from here too.
const updateGalleryTermsMock = vi.fn();
// Task #204: the page now renders <SelectionTrayModeControl> unconditionally
// (no status gate — same "presentation, not a commercial term" reasoning
// schema.ts's own comment on `selectionTrayMode` explains); its module
// imports `updateSelectionTrayMode` from here too.
const updateSelectionTrayModeMock = vi.fn();
// Task #214: the page now renders <AllowsOriginalSelectionControl>
// unconditionally (no status gate — same "no too-late-to-change-your-mind
// moment" reasoning `updateSelectionTrayMode` above already established);
// its module imports `updateAllowsOriginalSelection` from here too.
const updateAllowsOriginalSelectionMock = vi.fn();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: (...args: unknown[]) => publishGalleryMock(...args),
  unlockSelection: (...args: unknown[]) => unlockSelectionMock(...args),
  deliverGallery: (...args: unknown[]) => deliverGalleryMock(...args),
  attachGalleryClients: (...args: unknown[]) => attachGalleryClientsMock(...args),
  removeGalleryClient: (...args: unknown[]) => removeGalleryClientMock(...args),
  resendGalleryAccessEmail: (...args: unknown[]) => resendGalleryAccessEmailMock(...args),
  updateGalleryTerms: (...args: unknown[]) => updateGalleryTermsMock(...args),
  updateSelectionTrayMode: (...args: unknown[]) => updateSelectionTrayModeMock(...args),
  updateAllowsOriginalSelection: (...args: unknown[]) => updateAllowsOriginalSelectionMock(...args),
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
    originalPhotoPriceCopSnapshot: 2_000,
    termsOverridden: false,
    selectionTrayMode: "flat",
    allowsOriginalSelection: false,
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
  resendGalleryAccessEmailMock.mockReset();
  resendGalleryAccessEmailMock.mockResolvedValue({ status: "idle" });
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([]);
  getGalleryArchiveSizeMock.mockReset();
  getGalleryArchiveSizeMock.mockResolvedValue(null);
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
    // "En pruebas" renders as one of the stepper's four ALWAYS-rendered step
    // labels — its mere presence proves nothing about the gallery's actual
    // status (see the dedicated "state stepper" describe block below for the
    // real discriminating assertion, `aria-current="step"`). Kept here only
    // as part of this test's broader "does the page render at all" smoke
    // check.
    expect(screen.getByText("En pruebas")).toBeDefined();
    expect(screen.getByText("Estándar")).toBeDefined();
    expect(screen.getByText("13")).toBeDefined();
  });

  // Task #139's own core finding: `rg publicSlug src/app/dashboard
  // src/components` used to return nothing at all — no link from this page
  // to `/galleries/[publicSlug]` existed anywhere, so reaching the client's
  // view meant hand-building the URL from the database. This proves the
  // link is real, points at the RIGHT gallery's slug (not a hardcoded one),
  // and opens in a new tab rather than navigating the admin away from the
  // panel.
  it("links to the client's own view of the gallery, by its publicSlug, opened in a new tab", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ publicSlug: "xyz789" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const link = screen.getByRole("link", { name: /Ver como la ve el cliente/ });
    expect(link.getAttribute("href")).toBe("/galleries/xyz789");
    expect(link.getAttribute("target")).toBe("_blank");
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

  // Task #193 — the admin detail page is the ONE surface allowed to say a
  // gallery's terms were hand-typed rather than inherited from its package;
  // see this component's own comment for why the label is read straight off
  // `gallery.termsOverridden`, never re-derived from a snapshot/live-package
  // comparison.
  it("labels the terms 'Del paquete' when the gallery was never overridden", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ termsOverridden: false }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("Del paquete")).toBeDefined();
    expect(screen.queryByText("Personalizados")).toBeNull();
  });

  it("labels the terms 'Personalizados' when the admin overrode them at creation", async () => {
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({ termsOverridden: true, includedPhotosSnapshot: 20 }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("Personalizados")).toBeDefined();
    expect(screen.queryByText("Del paquete")).toBeNull();
    // Still the EFFECTIVE terms, the same snapshot other tests in this file
    // pin — the label marks the terms as overridden, it does not replace
    // them with anything else.
    expect(screen.getByText("20")).toBeDefined();
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
            selectionKind: "edited",
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
            selectionKind: "edited",
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
            selectionKind: "edited",
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
            selectionKind: "edited",
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

// The state stepper's own discriminating signal (task #133, review round 1
// finding): all FOUR step labels render unconditionally on every gallery, so
// a test that only checks one of them is present (as the smoke test above
// does) cannot tell "the right step is marked current" from "the stepper
// always renders the same way regardless of status" — a bug that silently
// stopped marking the current step would leave every one of those assertions
// green. `aria-current="step"` is the ONE thing that actually varies with
// `gallery.status`, so these two tests assert on THAT, and — because a
// single case cannot rule out "always current" as easily as "never
// current" — both use a DIFFERENT status and expect a DIFFERENT step
// marked, which a one-sided implementation could not satisfy for both.
describe("GalleryDetailPage — state stepper (task #133)", () => {
  it("marks 'En pruebas' as the current step for a gallery in proofing, and no other step", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const currentStep = screen.getByText("En pruebas").closest("li");
    expect(currentStep?.getAttribute("aria-current")).toBe("step");
    // Exactly one step is ever current — not zero, not two.
    expect(screen.getAllByText(/Borrador|En pruebas|Selección enviada|Entregada/).length).toBe(4);
    expect(screen.getByText("Borrador").closest("li")?.getAttribute("aria-current")).toBeNull();
    expect(
      screen.getByText("Selección enviada").closest("li")?.getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.getByText("Entregada").closest("li")?.getAttribute("aria-current")).toBeNull();
  });

  it("marks 'Entregada' as the current step for a delivered gallery instead", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "delivered" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const currentStep = screen.getByText("Entregada").closest("li");
    expect(currentStep?.getAttribute("aria-current")).toBe("step");
    // The step that was current for the OTHER test above is not current here.
    expect(screen.getByText("En pruebas").closest("li")?.getAttribute("aria-current")).toBeNull();
  });
});

describe("GalleryDetailPage — archive-size warning (task #92)", () => {
  it("renders nothing about archive size when there is no deliverable final yet", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail());
    getGalleryArchiveSizeMock.mockResolvedValue(null);

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByText("Peso de la descarga")).toBeNull();
    expect(screen.queryByText(/descarga completa/)).toBeNull();
  });

  it("shows the archive's total size once there is at least one deliverable final, with no warning at 'ok'", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail());
    getGalleryArchiveSizeMock.mockResolvedValue({
      status: "ok",
      totalBytes: 200 * 1024 * 1024,
      entryCount: 5,
    });

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.getByText("Peso de la descarga")).toBeDefined();
    expect(screen.getByText(`${200 * 1024 * 1024} bytes`)).toBeDefined();
    expect(screen.queryByText(/descarga completa/)).toBeNull();
  });

  it("calls out a gallery approaching the ceiling, in Spanish, saying what to do", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail());
    getGalleryArchiveSizeMock.mockResolvedValue({
      status: "approaching",
      totalBytes: 3_600_000_000,
      entryCount: 18,
    });

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const warning = screen.getByText(/no va a funcionar por encima de unos 4 GB/);
    expect(warning.textContent).toContain("Considerá exports más livianos");
  });

  it("uses different, more urgent copy once the gallery has already crossed the ceiling", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail());
    getGalleryArchiveSizeMock.mockResolvedValue({
      status: "over",
      totalBytes: 4_400_000_000,
      entryCount: 22,
    });

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    const warning = screen.getByText(/ya no va a funcionar/);
    expect(warning.textContent).toContain("entrega dividida");
    expect(screen.queryByText(/no va a funcionar por encima de unos 4 GB\. Considerá/)).toBeNull();
  });

  it("passes the gallery's own assets to getGalleryArchiveSize, not an empty/derived list", async () => {
    const assets = [
      {
        id: "a1",
        originalFilename: "IMG_0001.JPG",
        proofKey: "galleries/g1/proofs/a1.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: true,
        sortOrder: 0,
        finalKey: "galleries/g1/finals/a1.jpg",
        isEdited: true,
        selectionKind: "edited" as const,
      },
    ];
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ assets }));
    getGalleryArchiveSizeMock.mockResolvedValue(null);

    await GalleryDetailPage(paramsFor(GALLERY_ID));

    expect(getGalleryArchiveSizeMock).toHaveBeenCalledWith(assets);
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

  // Task #133: "Quitar" and "Reenviar acceso" no longer sit on the row as
  // two adjacent small buttons — they live behind the row's own 44px
  // "Acciones" trigger (<GalleryClientRow>'s <DropdownMenu>). Opening it is
  // now part of reaching either affordance, the same way a real
  // pointer/keyboard user would.
  it("shows a Quitar affordance for each active client when there is more than one", async () => {
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

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    expect(screen.getByRole("menuitem", { name: "Quitar" })).toBeDefined();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Acciones para Beto Ruiz" }));
    expect(screen.getByRole("menuitem", { name: "Quitar" })).toBeDefined();
  });

  // The last-active-client guard's UI half: hiding "Quitar" is UX only —
  // removeGalleryClient() itself re-checks activeClientRuleViolation()
  // server-side (src/lib/galleries.ts) regardless of what this page renders.
  it("hides the Quitar affordance for the ONLY active client on a non-draft gallery", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "proofing",
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    // The trigger itself still renders — "Reenviar acceso" is still offered
    // for a `proofing` gallery (task #101) — only "Quitar" is missing from
    // what it opens.
    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    expect(screen.queryByRole("menuitem", { name: "Quitar" })).toBeNull();
  });

  // Task #97's own reversal of part of the invariant: a DRAFT gallery may
  // legitimately reach zero active clients — `removeGalleryClient` is what
  // gets it there — so "Quitar" must NOT be hidden even for the only one.
  it("shows the Quitar affordance for the ONLY active client on a DRAFT gallery", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "draft",
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    expect(screen.getByRole("menuitem", { name: "Quitar" })).toBeDefined();
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

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));

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

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(removeGalleryClientMock).toHaveBeenCalledTimes(1);
  });
});

// Task #101: `resendable` is computed HERE, on the page, off the SAME
// `isGalleryVisibleToClient` predicate `attachGalleryClients` already uses —
// never inside <GalleryClientRow>, which cannot import a `server-only`
// module at all (it is a Client Component). These tests prove the page asks
// the right question and wires the answer through; the predicate's own
// Spanish-free status set is proven directly in galleries.test.ts.
describe("GalleryDetailPage — resend affordance wiring (task #101)", () => {
  it("shows 'Reenviar acceso' for a client-visible gallery (proofing)", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "proofing" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    expect(screen.getByRole("menuitem", { name: /Reenviar acceso/ })).toBeDefined();
  });

  // A draft gallery's single client still gets the Acciones trigger (task
  // #97's "Quitar" is available even for the only active client on a
  // draft), it just doesn't offer "Reenviar acceso" behind it — nothing to
  // view yet.
  it("hides 'Reenviar acceso' for a draft gallery — nothing to view yet", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Acciones para Ana Pérez" }));
    expect(screen.queryByRole("menuitem", { name: /Reenviar acceso/ })).toBeNull();
  });

  // Unlike the draft case above, an archived gallery's only client has
  // NEITHER affordance (not resendable, and the last-active-client guard
  // blocks removal too) — the Acciones trigger itself never renders.
  it("hides the Acciones trigger entirely for an archived gallery", async () => {
    getGalleryDetailMock.mockResolvedValue(galleryDetail({ status: "archived" }));

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);

    expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
  });
});

// Task #210 — the wiring seam the dialog's OWN unit tests cannot see: those
// prove <EditGalleryTermsDialog> computes the right preview GIVEN the right
// props, never whether THIS page hands it the right ones. Coordinator review
// finding: a mutation that reverted this page's own call site back to
// `selectedEditedCount={selectedCount} selectedOriginalCount={0}` (the exact
// pre-#210 defect) left the whole suite green, because nothing anywhere
// rendered the real <EditGalleryTermsDialog> against a real, multi-original
// <GalleryDetail> fixture through THIS page. This describe block closes that
// gap — it renders the real page, opens the real dialog, and reads the real
// preview text, the same way the resend-affordance block above proves the
// page ASKS the right question rather than only that the predicate itself is
// correct.
describe("GalleryDetailPage — terms-edit preview receives the real edited/original split (task #210)", () => {
  it("shows a surcharge in the terms-edit preview that prices in at least one already-selected original", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        status: "selected",
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        originalPhotoPriceCopSnapshot: 2_000,
        // 15 edited + 3 original, the SAME fixture shape
        // edit-gallery-terms-dialog.test.tsx's own "matches the client's own
        // counter" test uses — both sums strictly positive so a mutation
        // that drops either slot (edited folded into originals, or vice
        // versa) cannot pass by accident.
        assets: [
          ...Array.from({ length: 18 }, (_unused, index) => ({
            id: `a${index + 1}`,
            originalFilename: `IMG_${String(index + 1).padStart(4, "0")}.JPG`,
            proofKey: `galleries/g1/proofs/a${index + 1}.webp`,
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: index,
            finalKey: null,
            isEdited: false,
            selectionKind: index < 15 ? ("edited" as const) : ("original" as const),
          })),
          // Coordinator review finding: nothing in this fixture previously
          // distinguished `asset.isSelected && asset.selectionKind ===
          // "original"` (page.tsx's own filter) from a filter that checked
          // `selectionKind` alone — every asset above is selected. This one
          // is NOT: an unselected asset carrying `selectionKind: "original"`
          // should not exist in practice (the selection route resets it to
          // "edited" on both select and deselect,
          // src/app/api/assets/[assetId]/selection/route.ts's own comment),
          // but "should not exist" is exactly what a defensive `isSelected
          // &&` guard is for, and a filter that dropped that guard would
          // silently count this asset as a selected original too. Contributes
          // to neither `selectedEditedCount` nor `selectedOriginalCount`
          // either way, so it changes none of this test's own numbers.
          {
            id: "a19",
            originalFilename: "IMG_0019.JPG",
            proofKey: "galleries/g1/proofs/a19.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: false,
            sortOrder: 18,
            finalKey: null,
            isEdited: false,
            selectionKind: "original" as const,
          },
        ],
      }),
    );

    const element = await GalleryDetailPage(paramsFor(GALLERY_ID));
    render(element);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Editar términos" }));
    const dialog = await screen.findByRole("dialog");

    // computeQuota(15, 3, {13, 5000, 2000}) => extras 2, originalsSurchargeCop
    // 6_000, surchargeCop 16_000 — the number this ticket exists to fix.
    // Before task #210 (and after the coordinator's own re-applied
    // mutation), this page fed the dialog `selectedEditedCount={18}
    // selectedOriginalCount={0}`, which would render 5 extras (18 - 13) ×
    // $5.000 = $25.000 here instead.
    expect(
      within(dialog).getByText("El cliente ve hoy: 13 incluidas · 2 extras · $ 16.000"),
    ).toBeDefined();
  });
});
