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

vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
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
    client: { id: "client-a", name: "Ana Pérez", email: "ana@example.com" },
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [],
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
});

afterEach(() => {
  cleanup();
});

describe("ClientGalleryPage chrome", () => {
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
          },
          {
            id: "a2",
            originalFilename: "IMG_0002.JPG",
            proofKey: "galleries/g1/proofs/a2.webp",
            proofWidth: 900,
            proofHeight: 1600,
            isSelected: false,
            sortOrder: 1,
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
});
