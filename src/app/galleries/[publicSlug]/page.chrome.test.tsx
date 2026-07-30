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
import { cleanup, render, screen } from "@testing-library/react";
import type { Session } from "next-auth";
import ClientGalleryPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";

const requireSessionMock = vi.fn<() => Promise<Session>>();
vi.mock("@/lib/auth-guards", () => ({ requireSession: () => requireSessionMock() }));

const getGalleryDetailBySlugMock = vi.fn<() => Promise<GalleryDetail | null>>();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetailBySlug: () => getGalleryDetailBySlugMock(),
  isGalleryVisibleToClient: (status: string) => status !== "draft" && status !== "archived",
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
  });

  it("renders the gallery's title, status and session date", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    expect(screen.getByText("Boda Ana y Beto")).toBeDefined();
    expect(screen.getByText("En pruebas")).toBeDefined();
    expect(screen.getByText(/01\/08\/2026/)).toBeDefined();
  });

  it("renders every asset's proof by its presigned URL, with an aspect ratio reserved from proofWidth/proofHeight", async () => {
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

    // The CLS-prevention contract: the wrapper reserves the exact aspect
    // ratio from the asset's own proofWidth/proofHeight BEFORE the <img>
    // has ever loaded, not after.
    const wrapper = images[0]?.parentElement;
    expect(wrapper?.getAttribute("style")).toContain("aspect-ratio: 1600 / 1067");
    const secondWrapper = images[1]?.parentElement;
    expect(secondWrapper?.getAttribute("style")).toContain("aspect-ratio: 900 / 1600");
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
          },
        ],
      }),
    );

    const element = await ClientGalleryPage(paramsFor(SLUG));
    render(element);

    // Not `getByText`: the gallery's own status badge (formatGalleryStatus)
    // renders the SAME Spanish label ("Selección enviada") for the `selected`
    // status, so this specific status message — the submit panel's own
    // `role="status"` — is queried by role to disambiguate the two. Matched
    // against the CORRECTED copy specifically ("tiene acceso"), not just the
    // "Selección enviada" prefix both the status badge and the (earlier,
    // dishonest) panel copy share — see submit-selection-panel.test.tsx's
    // own comment on this exact pinning.
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

    // The grid still reserves each tile from the PROOF's dimensions, which is
    // what keeps this migration-free: nothing stores the derivative's own
    // width/height. Pinned here so the trade-off is visible rather than
    // discovered — if the photographer cropped the final differently from
    // the original, `object-cover` on the tile absorbs the difference.
    it("still reserves the tile's aspect ratio from the proof's stored dimensions", async () => {
      getGalleryDetailBySlugMock.mockResolvedValue(
        galleryDetail({ status: "delivered", assets: [DELIVERABLE] }),
      );

      const element = await ClientGalleryPage(paramsFor(SLUG));
      const { container } = render(element);

      const wrapper = container.querySelector("img")?.parentElement;
      expect(wrapper?.getAttribute("style")).toContain("aspect-ratio: 1600 / 1067");
    });
  });
});
