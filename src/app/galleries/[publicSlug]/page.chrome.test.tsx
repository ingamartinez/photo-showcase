// @vitest-environment jsdom
//
// Same reasoning as src/app/dashboard/galleries/[galleryId]/page.chrome.test.tsx:
// jsdom cannot resolve the bare `import "server-only"` pulled in
// transitively by src/lib/auth-guards.ts and src/lib/galleries.ts, even
// with `vi.mock("server-only", ...)`. So both of those modules — and
// `@/lib/r2` (server-only via r2Env(), see its header comment) — are mocked
// wholesale here.
//
// page.test.ts (node environment) proves the session/ownership/status
// guards and the notFound()/forbidden() branches are real; this file is the
// other half — the only place that proves the gallery's title/status and
// its proofs are actually wired into markup, and that the grid reserves
// layout space up front (no CLS).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Session } from "next-auth";
import ClientGalleryPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";

const requireSessionMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireSession: () => requireSessionMock() }));

const getGalleryDetailBySlugMock = vi.fn<() => Promise<GalleryDetail | null>>();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetailBySlug: () => getGalleryDetailBySlugMock(),
  isGalleryVisibleToClient: (status: string) => status !== "draft" && status !== "archived",
  // The studio's own workflow word — admin surfaces only (dashboard) per
  // that function's own comment, and this page's ADMIN-PREVIEW-ONLY
  // fallback for `draft`/`archived` (see page.tsx's own comment on the
  // branch that calls this).
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
  // Task #181 — the CLIENT's own word, the SAME mapping `/galleries`'s own
  // chrome test fakes (src/app/galleries/page.chrome.test.tsx would be the
  // wrong place to look for drift protection between the two pages' fakes;
  // src/lib/galleries.test.ts pins the REAL function against
  // CLIENT_VISIBLE_STATUSES). Throws for `draft`/`archived`, mirroring the
  // real function's own shape.
  //
  // WHAT THIS FAKE'S THROW DOES NOT DO, corrected after review: it does NOT
  // make THIS suite fail if the `isGalleryVisibleToClient` guard is ever
  // dropped from the branch in page.tsx that calls this. Reviewer mutated
  // exactly that and this file stayed green, 27/27 — every fixture here is
  // either a client session (never reaches `draft`/`archived` at all,
  // `getGalleryDetailBySlugMock` never resolves one) or an admin previewing
  // a NON-draft/archived status, so the throwing branch is simply never
  // exercised by anything in this file. The regression IS caught, just not
  // here: `page.test.ts` > "lets an admin view a draft gallery" uses the
  // REAL `formatClientGalleryCardState` (via `importActual`, node
  // environment), and dropping the guard turns that real function's own
  // throw into an unhandled rejection, failing that test's
  // `.resolves.toBeTruthy()`.
  formatClientGalleryCardState: (status: string) => {
    const states: Record<string, { label: string; tone: "pending" | "waiting" | "done" }> = {
      proofing: { label: "Te toca elegir", tone: "pending" },
      selected: { label: "Alejo está editando", tone: "waiting" },
      delivered: { label: "Lista para descargar", tone: "done" },
    };
    const state = states[status];
    if (!state) {
      throw new Error(`formatClientGalleryCardState: "${status}" is not a client-visible status`);
    }
    return state;
  },
  formatSessionDate: (sessionDate: string) => {
    const [year, month, day] = sessionDate.split("-");
    return `${day}/${month}/${year}`;
  },
}));

// <ProofGrid> (via <SelectionCounter>, task #24) pulls `formatCop` off
// `@/lib/format`, NOT `@/lib/galleries` — a plain module with no
// `server-only`/`@/lib/db` import (see that module's own header comment),
// so unlike `@/lib/galleries` above, jsdom resolves it directly and no mock
// is needed here; the real `formatCop` runs.

vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
  // Task #89: deterministic fakes matching the real builders' shape closely
  // enough that a rendered URL is readable in an assertion. The real,
  // environment-namespaced format is r2.test.ts's own business.
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  // Task #78: identity fake — the page re-attaches the `R2Key` brand to
  // `asset.proofKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #94: `@/lib/gallery-access` is server-only (transitively via
// `@/lib/db`), same reasoning as `@/lib/galleries`/`@/lib/r2` above — mocked
// wholesale rather than resolved for real. Authorization itself is proven
// exhaustively in page.test.ts (node environment); this file's own default
// is always-allow (every fixture here is the session's own `client-a`), but
// it's a real `vi.fn`, not a hardcoded literal, so the one negative case
// below can override it per-test rather than needing a second mock module.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
  // Task #139: a plain re-implementation of the real predicate (admin, full
  // stop — no gallery lookup) — this module is mocked wholesale, not via
  // `importActual`, so every export the page imports needs its own entry
  // here, same stance as every other mock in this file. The real function
  // is proven directly in gallery-access.test.ts; this file's own job is
  // whether the PAGE asks it and renders <ClientPreviewBanner> accordingly.
  isAdminPreviewingClientGallery: (session: Session) => session.user.role === "admin",
}));

// Task #95: `@/lib/gallery-selection` is server-only for the same reason —
// it reaches Postgres — so jsdom cannot resolve it either. Its own query is
// proven in src/lib/gallery-selection.test.ts; what this file proves is that
// whatever it returns reaches the collaborative tray's markup.
const getGallerySelectionMock = vi.fn<(galleryId: string) => Promise<unknown[]>>();
vi.mock("@/lib/gallery-selection", () => ({
  getGallerySelection: (...args: [string]) => getGallerySelectionMock(...args),
}));

const SLUG = "abc123def456";

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: SLUG,
    status: "proofing",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }],
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

function paramsFor(publicSlug: string) {
  return { params: Promise.resolve({ publicSlug }) };
}

beforeEach(() => {
  requireSessionMock.mockReset();
  requireSessionMock.mockResolvedValue({
    user: { id: "client-a", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  getGalleryDetailBySlugMock.mockReset();
  getGallerySelectionMock.mockReset();
  getGallerySelectionMock.mockResolvedValue([]);
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockResolvedValue(true);
  // Only needed by the one negative test below, which reaches `forbidden()`
  // — every other test in this file resolves before that call ever throws.
  // Stubbed unconditionally here anyway (matching the node-environment route
  // suites' own convention) rather than scoped to that single test, since
  // `next/navigation`'s `forbidden()` reads this at call time either way.
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("ClientGalleryPage chrome", () => {
  // The negative case this file was missing entirely (review finding on
  // task #94): this suite's default is always-allow, which on its own can
  // never distinguish "the page correctly checks ownership" from "the page
  // never checks it at all" — a regression that deleted the `isGalleryOwner`
  // call outright would leave every test above still green. This is the one
  // test in this file that flips the mock to refuse, proving the chrome
  // never renders when it does.
  it("never renders the page's chrome when isGalleryOwner refuses the session", async () => {
    isGalleryOwnerMock.mockResolvedValue(false);
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    // Task #95: and it never read the selection either. That query returns
    // the OTHER clients' names, so it must sit behind the ownership gate, not
    // beside it.
    expect(getGallerySelectionMock).not.toHaveBeenCalled();
  });

  // Task #95: the collaborative tray, wired end to end from the page's own
  // `getGallerySelection` read through to markup.
  describe("collaborative selection tray", () => {
    /** The tray only exists inside a gallery that HAS photos — a gallery with
     * no assets renders <ProofGrid>'s own "your photographer hasn't uploaded
     * anything yet" state and nothing else, which is the right thing: there is
     * nothing to pick, so there is nothing to collaborate on. */
    function withOnePhoto(isSelected = true): GalleryDetail {
      return galleryDetail({
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected,
            sortOrder: 0,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
          },
        ],
      });
    }

    it("renders the tray with each pick attributed to whoever chose it", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(withOnePhoto());
      getGallerySelectionMock.mockResolvedValue([
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-b", label: "Beto Ruiz" },
        },
      ]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByRole("region", { name: "Fotos elegidas" })).toBeDefined();
      expect(screen.getByText("Beto Ruiz")).toBeDefined();
    });

    it("renders THIS session's own pick as 'Vos', from the session id the page passes down", async () => {
      // `requireSessionMock`'s default user is `client-a` — the same id this
      // pick is attributed to.
      getGalleryDetailBySlugMock.mockResolvedValue(withOnePhoto());
      getGallerySelectionMock.mockResolvedValue([
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
        },
      ]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByText("Vos")).toBeDefined();
    });

    it("renders the tray, with its explanation, before anybody has picked anything", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(withOnePhoto(false));
      getGallerySelectionMock.mockResolvedValue([]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
    });

    it("reads the selection with the gallery's OWN id, never the slug from the URL", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(withOnePhoto());

      render(await ClientGalleryPage(paramsFor(SLUG)));

      expect(getGallerySelectionMock).toHaveBeenCalledWith("g1");
    });

    // Task #204 — END TO END through the REAL GraphQL pipeline (nothing under
    // src/lib/graphql/** is mocked in this file), the exact seam BLOCKING 1 of
    // the review flagged: `readClientGalleryBySlug` gets `selectionTrayMode`
    // back as graphql-js's own wire NAME ("BY_PERSON"), and
    // `selectionTrayModeFromWire` (page.tsx) has to convert it back to
    // `"by-person"` before <ProofGrid>/<SelectionTray> ever see it. A
    // reviewer-run mutation (`selectionTrayModeFromWire` forced to always
    // return `"flat"`) left the OTHER 1677 tests in this repo green — this is
    // the one that would have caught it, because it is the only place that
    // exercises the real resolver AND the real converter in the same render.
    it("renders the by-person tray layout end to end when the gallery is set to that mode", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          selectionTrayMode: "by-person",
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
      getGallerySelectionMock.mockResolvedValue([
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-b", label: "Beto Ruiz" },
        },
        {
          assetId: "a2",
          selectedAt: "2026-07-30T12:05:00.000Z",
          pickedBy: { id: "client-b", label: "Beto Ruiz" },
        },
      ]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      // Only by-person mode renders a group header with a parenthesized
      // count — flat mode renders each pick's label alone (see the "renders
      // the tray with each pick attributed" test above, which asserts the
      // bare "Beto Ruiz" text with no count). `screen.getByText` alone
      // cannot see this: the count lives in a nested `<span>`, so RTL's
      // default matcher — which does not concatenate text across a child
      // element — never finds "Beto Ruiz (2)" as one node's text, even
      // though it renders correctly; querying the `<p>`'s own `textContent`
      // directly (same technique selection-tray.test.tsx's own
      // `groupHeaderTexts` helper uses) is what actually proves it.
      const groupHeaders = [...container.querySelectorAll("p")]
        .map((p) => p.textContent)
        .filter((text): text is string => /\(\d+\)/.test(text ?? ""));
      expect(groupHeaders).toEqual(["Beto Ruiz (2)"]);
    });

    // Task #206, criterion 4 — END TO END through the REAL GraphQL pipeline
    // (nothing under src/lib/graphql/** is mocked here, same seam #204's own
    // end-to-end test above exercises): the gap this test closes is
    // `originalPhotoPriceCopSnapshot` actually reaching the page's rendered
    // counter through `Gallery.originalPhotoPriceCopSnapshot` (the wiring
    // gap #205 left and this task's own first commit closed) AND the
    // edited/original split reaching it through the real picks list. A
    // fixture with picks above the quota AND originals present, so neither
    // term can be silently dropped without changing the rendered total.
    it("renders the correct two-tariff total end to end, picking above the quota AND marking originals", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          includedPhotosSnapshot: 2,
          extraPhotoPriceCopSnapshot: 5_000,
          originalPhotoPriceCopSnapshot: 2_000,
          // Task #214 — this test's own picks include originals, so the
          // switch has to be ON for the two-tariff breakdown below to render
          // at all; see this file's own "the switch is OFF" test for the
          // complementary case.
          allowsOriginalSelection: true,
          assets: Array.from({ length: 5 }, (_unused, index) => ({
            id: `a${index + 1}`,
            originalFilename: `IMG_000${index + 1}.JPG`,
            proofKey: `galleries/g1/proofs/a${index + 1}.webp`,
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: index,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
          })),
        }),
      );
      // 3 edited (a1-a3) -> 1 over the 2 included -> 5_000. 2 originals
      // (a4-a5) -> 4_000 more. Total 9_000 — reachable only by summing both.
      getGallerySelectionMock.mockResolvedValue([
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a2",
          selectedAt: "2026-07-30T12:01:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a3",
          selectedAt: "2026-07-30T12:02:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a4",
          selectedAt: "2026-07-30T12:03:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "original",
        },
        {
          assetId: "a5",
          selectedAt: "2026-07-30T12:04:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "original",
        },
      ]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByText(/incluidas 2/)).toBeDefined();
      expect(screen.getByText(/seleccionadas 5/)).toBeDefined();
      expect(screen.getByText(/extras 1 × \$/)).toBeDefined();
      expect(screen.getByText(/originales 2 × \$/)).toBeDefined();
      expect(screen.getByText(/total \$\s*9\.000/)).toBeDefined();
      // The tray itself shows each thumbnail's own type too (criterion 7) —
      // scoped to the tray region, since the grid tile's own type control
      // (task #206) also renders these exact words on every selected tile.
      const tray = screen.getByRole("region", { name: "Fotos elegidas" });
      expect(within(tray).getAllByText("Original")).toHaveLength(2);
      expect(within(tray).getAllByText("Editada")).toHaveLength(3);
    });

    // Task #214's own complementary case, end to end through the REAL
    // GraphQL pipeline, same as the test above: the identical fixture
    // (originals genuinely present in `getGallerySelection`'s own response)
    // but with the gallery's switch off. Nothing about originals may reach
    // the rendered page at all — no breakdown row, no tray type line, no
    // type buttons on the tile — even though the underlying picks are
    // exactly the ones the test above renders as "Original".
    it("renders no originals breakdown, tray type line, or tile type control end to end, when the switch is off", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          includedPhotosSnapshot: 2,
          extraPhotoPriceCopSnapshot: 5_000,
          originalPhotoPriceCopSnapshot: 2_000,
          allowsOriginalSelection: false,
          assets: Array.from({ length: 5 }, (_unused, index) => ({
            id: `a${index + 1}`,
            originalFilename: `IMG_000${index + 1}.JPG`,
            proofKey: `galleries/g1/proofs/a${index + 1}.webp`,
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: true,
            sortOrder: index,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
          })),
        }),
      );
      getGallerySelectionMock.mockResolvedValue([
        {
          assetId: "a1",
          selectedAt: "2026-07-30T12:00:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a2",
          selectedAt: "2026-07-30T12:01:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a3",
          selectedAt: "2026-07-30T12:02:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "edited",
        },
        {
          assetId: "a4",
          selectedAt: "2026-07-30T12:03:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "original",
        },
        {
          assetId: "a5",
          selectedAt: "2026-07-30T12:04:00.000Z",
          pickedBy: { id: "client-a", label: "Ana Pérez" },
          selectionKind: "original",
        },
      ]);

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      // Positive control first: the page genuinely mounted with the real
      // numbers — the negative assertions below only mean something once
      // this is established.
      expect(screen.getByText(/incluidas 2/)).toBeDefined();
      expect(screen.getByText(/seleccionadas 5/)).toBeDefined();

      expect(screen.queryByText(/originales \d+ ×/)).toBeNull();
      expect(screen.queryByText(/^total \$/)).toBeNull();
      const tray = screen.getByRole("region", { name: "Fotos elegidas" });
      expect(within(tray).queryByText("Original")).toBeNull();
      expect(within(tray).queryByText("Editada")).toBeNull();
      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    });
  });

  it("renders the gallery's title, the CLIENT's own word for its status, and the session date", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    expect(screen.getByText("Boda Ana y Beto")).toBeDefined();
    // Task #181: "Te toca elegir" (client language), never "En pruebas" (the
    // studio's own workflow word) — see the dedicated leak-detection suite
    // below for the negative half of this claim across all three
    // client-visible statuses.
    expect(screen.getByText("Te toca elegir")).toBeDefined();
    expect(screen.getByText(/01\/08\/2026/)).toBeDefined();
  });

  // Task #181's own acceptance criterion: "a test that fails red if a studio
  // internal word reappears on a client surface." Enumerates every status a
  // real client can reach this page with (CLIENT_VISIBLE_STATUSES) and
  // asserts NONE of the studio's own three words for them ever renders.
  // Mutation-proof: reverting page.tsx's status span back to
  // `formatGalleryStatus(gallery.status)` turns every case of this red.
  // Task #181's own acceptance criterion: "verify there is no other client
  // surface with the same leak." Checked: `src/components/submit-selection-
  // panel.tsx:106` renders the literal string "Selección enviada" too — but
  // as a sentence about the CLIENT's own action ("Selección enviada el
  // [date] — tu fotógrafo ya tiene acceso a esta selección"), not a status
  // echo, and it predates this slice. Left as-is: fixing a leak means
  // removing the STUDIO's workflow word from a place that names the STATE;
  // this sentence names an EVENT the client caused, in the client's own
  // language, which is exactly what #181 wants elsewhere. No other
  // `formatGalleryStatus` call site exists outside `src/app/dashboard/**`
  // (grepped as part of this task) and this one client-facing exception.
  describe("never leaks the studio's internal workflow word (task #181)", () => {
    it.each([
      ["proofing", "En pruebas"],
      ["selected", "Selección enviada"],
      ["delivered", "Entregada"],
    ] as const)("status=%s never renders the studio's own word %s", async (status, studioWord) => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          status,
          selectionSubmittedAt: status === "selected" ? new Date("2026-07-28T12:00:00.000Z") : null,
        }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.queryByText(studioWord)).toBeNull();
    });
  });

  // Task #193 — the owner's decision, checked end to end through the REAL
  // client page (not just the isolated <SelectionCounter> unit): a client
  // must never see the bound package's name anywhere on their own gallery,
  // on a gallery that was NEVER overridden — this is where the name used to
  // exist (`gallery.package.name`, page.tsx's own removed `packageName`
  // prop) and is being taken away, so THIS is the case that actually proves
  // the removal, not the overridden case.
  //
  // THE TRAP THIS TEST GUARDS AGAINST (this task's own named defect, #176):
  // a bare `not.toContain("Estándar")` would pass even if <ProofGrid> never
  // rendered its counter at all. The positive assertion below — the real
  // "incluidas 13 · seleccionadas 0" text — has to pass FIRST, proving the
  // counter genuinely mounted, before the negative assertion means anything.
  it("never renders the bound package's name on the client's own gallery page", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({
        status: "proofing",
        package: { id: 1, name: "Estándar" },
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
        ],
      }),
    );

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    // Positive control first: the live quota counter genuinely mounted with
    // its real numbers.
    expect(screen.getByText(/incluidas 13/)).toBeDefined();
    expect(screen.getByText(/seleccionadas 0/)).toBeDefined();

    expect(screen.queryByText(/Estándar/)).toBeNull();
    expect(document.body.textContent).not.toContain("Estándar");
  });

  it("renders every asset's proof by its presigned URL, with a uniform tile box reserved before load", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(
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
            proofWidth: 900,
            proofHeight: 1600,
            isSelected: false,
            sortOrder: 1,
            finalKey: null,
            isEdited: false,
            selectionKind: "edited",
          },
        ],
      }),
    );

    const element = await ClientGalleryPage(paramsFor(SLUG));
    const { container } = render(element);

    // Not getByRole("img"): each tile's <img alt=""> is deliberately
    // decorative (the enclosing button already carries an aria-label with
    // the filename — see proof-grid.tsx's own comment), which removes it
    // from the accessibility tree's "img" role entirely. Queried directly
    // off the DOM instead, since that's what actually renders.
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe(
      "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
    );

    // The CLS-prevention contract, as task #145 left it: the wrapper reserves
    // its box BEFORE the <img> has ever loaded, not after. The box is now the
    // mock's uniform 2:3 (design/system/client.html:181) rather than each
    // asset's own proofWidth/proofHeight — proof-tile.tsx carries the measured
    // reason, and proof-tile.test.tsx pins the shape per orientation. These
    // two fixtures are deliberately one landscape (1600x1067) and one portrait
    // (900x1600): the whole point of the change is that they now reserve the
    // SAME box, which is what stopped the pick control floating in dead space
    // below a short tile.
    const wrapper = images[0]?.parentElement;
    const secondWrapper = images[1]?.parentElement;
    expect(wrapper?.className).toContain("aspect-[2/3]");
    expect(secondWrapper?.className).toContain("aspect-[2/3]");
    expect(wrapper?.getAttribute("style")).toBeNull();
    expect(secondWrapper?.getAttribute("style")).toBeNull();
  });

  // Task #145: the redesigned pick control is an unlabelled 48px circle
  // (design/system/client.html:200-208), so the screen has to say once what
  // it does — the mock's own sentence, at client.html:714. Copy lives with
  // its test in the same slice, per this epic's standing rule; if this
  // sentence is ever reworded, this is the assertion that moves with it.
  describe("the pick control's one instruction (task #145)", () => {
    const ONE_ASSET = [
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
        selectionKind: "edited" as const,
      },
    ];

    it("tells the client what the circle does while the selection is still open", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ assets: ONE_ASSET }));

      render(await ClientGalleryPage(paramsFor(SLUG)));

      expect(
        screen.getByText(/Tocá una foto para verla grande\. El círculo la elige\./),
      ).toBeDefined();
    });

    // The negative half: once the selection is submitted every toggle renders
    // disabled (#25), so there is no circle left to press and the sentence
    // would be a lie. A regression that renders it unconditionally is exactly
    // what this catches.
    it("stops saying it once the selection has been submitted", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          status: "selected",
          selectionSubmittedAt: new Date("2026-07-28T12:00:00.000Z"),
          assets: ONE_ASSET,
        }),
      );

      render(await ClientGalleryPage(paramsFor(SLUG)));

      expect(screen.queryByText(/El círculo la elige/)).toBeNull();
    });
  });

  it("shows a friendly empty state when the gallery has no assets yet", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ assets: [] }));

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    expect(screen.getByText(/todavía no subió fotos/i)).toBeDefined();
  });

  // Task #25, wired end to end through the real page: a gallery that
  // already left `proofing` renders the "already submitted" message, not
  // the submit button — and its toggle buttons render disabled.
  it("shows the already-submitted message, not the submit button, for a selected gallery", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({
        status: "selected",
        selectionSubmittedAt: new Date("2026-07-28T12:00:00.000Z"),
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

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    // Queried by role, not `getByText`, and matched against the CORRECTED
    // copy specifically ("tiene acceso") rather than a prefix — see
    // submit-selection-panel.test.tsx's own comment on this exact pinning.
    // (Before task #181 the eyebrow badge above also rendered "Selección
    // enviada" via `formatGalleryStatus`, sharing this panel's own opening
    // words; #181 moved the badge to `formatClientGalleryCardState`'s "Alejo
    // está editando", so `role: "status"` is no longer load-bearing for
    // disambiguation, only for scoping to this panel's own message.)
    expect(screen.getByRole("status").textContent).toMatch(/tiene acceso/);
    expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
    expect(screen.getByRole("button", { name: /Quitar de seleccionadas/ })).toHaveProperty(
      "disabled",
      true,
    );
  });

  // Task #28: wired end to end through the real page — `hasFinal` is
  // computed here (isSelected && isEdited && finalKey !== null), never off
  // any single one of those columns alone, and the raw `finalKey` itself
  // never appears anywhere in the rendered output.
  describe("delivered gallery downloads", () => {
    function deliveredGalleryWithAsset(assetOverrides: {
      isSelected: boolean;
      isEdited: boolean;
      finalKey: string | null;
    }) {
      return galleryDetail({
        status: "delivered",
        assets: [
          {
            id: "a1",
            originalFilename: "IMG_0001.JPG",
            proofKey: "galleries/g1/proofs/a1.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            sortOrder: 0,
            selectionKind: "edited",
            ...assetOverrides,
          },
        ],
      });
    }

    it("renders a download button for a delivered gallery's selected, edited asset with a final", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        deliveredGalleryWithAsset({
          isSelected: true,
          isEdited: true,
          finalKey: "galleries/g1/finals/a1.jpg",
        }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toBeDefined();
    });

    it("does not render a download button for a delivered gallery's asset that was never selected", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        deliveredGalleryWithAsset({ isSelected: false, isEdited: false, finalKey: null }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("does not render a download button for a selected-but-not-yet-edited asset, even though it's selected", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        deliveredGalleryWithAsset({ isSelected: true, isEdited: false, finalKey: null }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("never leaks the raw finalKey into the rendered markup", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        deliveredGalleryWithAsset({
          isSelected: true,
          isEdited: true,
          finalKey: "galleries/g1/finals/a1.jpg",
        }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      expect(container.innerHTML).not.toContain("galleries/g1/finals/a1.jpg");
    });
  });

  // Task #89: the headline behaviour, wired end to end through the real page
  // and the real <ProofGrid>. What renders in the <img src> is the whole
  // point — the client paid, so the watermark should be gone from what they
  // LOOK at, not only from what they save.
  describe("unwatermarked display after delivery (task #89)", () => {
    const DELIVERABLE = {
      id: "a1",
      originalFilename: "IMG_0001.JPG",
      proofKey: "galleries/g1/proofs/a1.webp",
      proofWidth: 1600,
      proofHeight: 1067,
      sortOrder: 0,
      isSelected: true,
      isEdited: true,
      finalKey: "galleries/g1/finals/a1.jpg",
      selectionKind: "edited" as const,
    };
    const NOT_DELIVERABLE = {
      id: "a2",
      originalFilename: "IMG_0002.JPG",
      proofKey: "galleries/g1/proofs/a2.webp",
      proofWidth: 900,
      proofHeight: 1600,
      sortOrder: 1,
      isSelected: false,
      isEdited: false,
      finalKey: null,
      selectionKind: "edited" as const,
    };

    function srcsOf(container: HTMLElement): (string | null)[] {
      return Array.from(container.querySelectorAll("img")).map((img) => img.getAttribute("src"));
    }

    it("renders the display derivative, not the watermarked proof, for a delivered gallery", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({ status: "delivered", assets: [DELIVERABLE] }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      expect(srcsOf(container)).toEqual([
        "https://r2.example.com/galleries/g1/display/a1.webp?presigned=1",
      ]);
    });

    // THE negative case, and the reason the whole product has a watermark at
    // all. Same asset, same three deliverable flags, only the gallery status
    // moved back — and the client is served the proof again. Mutating the
    // page's `status === "delivered"` check to a constant `true` turns this
    // red.
    // Only `proofing` and `selected` are enumerated: `draft` and `archived`
    // never reach this render at all for a client — `isGalleryVisibleToClient`
    // 404s them a few lines earlier (task #63), which is a stricter refusal
    // than serving a proof. These two are the statuses where the client IS
    // looking at their gallery and must still see the mark.
    it.each(["proofing", "selected"] as const)(
      "keeps serving the watermarked proof while the gallery is %s",
      async (status) => {
        getGalleryDetailBySlugMock.mockResolvedValue(
          galleryDetail({ status, assets: [DELIVERABLE] }),
        );

        const element = await ClientGalleryPage(paramsFor(SLUG));
        const { container } = render(element);

        expect(srcsOf(container)).toEqual([
          "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
        ]);
      },
    );

    // "An asset that is selected but has no final yet keeps showing its
    // proof. A mixed gallery must not look broken." — task #89's own words.
    // One delivered gallery, two assets, two different sources in the SAME
    // render.
    it("serves display and proof side by side in a mixed delivered gallery", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({ status: "delivered", assets: [DELIVERABLE, NOT_DELIVERABLE] }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      expect(srcsOf(container)).toEqual([
        "https://r2.example.com/galleries/g1/display/a1.webp?presigned=1",
        "https://r2.example.com/galleries/g1/proofs/a2.webp?presigned=1",
      ]);
    });

    // The deliberate asymmetry between this PAGE and
    // `GET /api/assets/[assetId]/display`: that route keeps the download
    // gate's admin carve-out verbatim, this page has none. This page renders
    // the CLIENT'S view; an admin opening it is previewing exactly that, and
    // a preview that silently dropped the watermark would show the
    // photographer something no client of theirs can see.
    it("does not drop the watermark for an ADMIN previewing an undelivered gallery", async () => {
      requireSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
        expires: "2099-01-01T00:00:00.000Z",
      } as Session);
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({ status: "proofing", assets: [DELIVERABLE] }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      expect(srcsOf(container)).toEqual([
        "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
      ]);
    });

    it("keeps serving the proof for a selected asset the photographer has not finished editing", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({
          status: "delivered",
          assets: [{ ...DELIVERABLE, isEdited: false, finalKey: null }],
        }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      expect(srcsOf(container)).toEqual([
        "https://r2.example.com/galleries/g1/proofs/a1.webp?presigned=1",
      ]);
    });

    // WHY THIS TEST NO LONGER MENTIONS THE PROOF'S STORED DIMENSIONS. It used
    // to assert `aspect-ratio: 1600 / 1067`, pinning task #89's own trade-off:
    // the tile was sized from the PROOF's width/height even when it was
    // showing the unwatermarked DISPLAY derivative, so nothing had to store
    // the derivative's dimensions and no migration was needed; if the
    // photographer had cropped the final differently, `object-cover` absorbed
    // the difference.
    //
    // Task #145 made the tile a uniform 2:3 box, which does not weaken that
    // argument, it removes its premise entirely — the tile now reads NO stored
    // dimensions at all, so the display derivative cannot disagree with
    // anything. What is still worth pinning is the half of #89's claim that
    // can actually regress: `object-cover`, which is what keeps a
    // differently-cropped final from stretching inside the box.
    it("still lets object-cover absorb a final cropped differently from its proof", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({ status: "delivered", assets: [DELIVERABLE] }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      const img = container.querySelector("img");
      expect(img?.className).toContain("object-cover");
      expect(img?.parentElement?.className).toContain("aspect-[2/3]");
    });
  });

  // Task #139: the orientation banner. Note what these tests do NOT touch —
  // `isGalleryOwnerMock` stays at its default (`true`) throughout, and
  // nothing about the selection toggles is asserted here, because this
  // slice is an orientation fix, not a permission one (#66, closed
  // 2026-07-30 — ZERO changes to the selection permission model). The
  // banner's own gate is `isAdminPreviewingClientGallery`, proven for real in
  // gallery-access.test.ts; this file's job is whether the PAGE asks it and
  // renders accordingly.
  describe("admin preview banner (task #139)", () => {
    it("shows the preview banner for an admin session", async () => {
      requireSessionMock.mockResolvedValue({
        user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
        expires: "2099-01-01T00:00:00.000Z",
      } as Session);
      getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.getByText(/como lo ve el cliente/)).toBeDefined();
      expect(screen.getByRole("link", { name: /Volver al panel/ })).toHaveProperty(
        "href",
        expect.stringContaining("/dashboard/galleries/g1"),
      );

      // Review finding on task #139: the banner's FIRST draft claimed a
      // toggle here "se guarda como si lo hubiera tocado el cliente" —
      // false, and the exact impersonation framing the task's own trap
      // warns against. `selection/route.ts:163` writes `selectedBy` as the
      // ACTING session's id (an admin's, here), never the client's — see
      // `gallery-access.ts`'s own header comment on `isGalleryOwner`'s
      // admin bypass and #94's attribution. This pins the corrected,
      // accurate claim so a regression back to the false one is caught
      // here, not just in review.
      expect(
        screen.getByText(/se guarda en la selección real del cliente, a tu nombre/),
      ).toBeDefined();
    });

    // The default fixture in this file is the owning CLIENT (`client-a`) —
    // this is the negative case a banner-always-on regression would miss:
    // a real client must never see "you are previewing" copy about their
    // own gallery.
    it("does not show the preview banner for the owning client", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

      const element = await ClientGalleryPage(paramsFor(SLUG));
      render(element);

      expect(screen.queryByText(/como lo ve el cliente/)).toBeNull();
    });
  });
});
