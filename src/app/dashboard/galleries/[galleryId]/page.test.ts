import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import GalleryDetailPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

// Same boundary as src/app/dashboard/galleries/page.test.ts: mock only
// `@/auth`'s `auth()`, leave `redirect()`/`forbidden()`/`notFound()` from
// `next/navigation` real, so this only passes if the page actually calls
// requireAdmin() and actually checks the query's result before rendering.
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// The page now renders <PublishGalleryButton>/<UnlockSelectionPanel>, whose
// modules import `publishGallery`/`unlockSelection` from here — mocked
// wholesale (this file never exercises either action) so this test never
// has to also stand up `@/lib/db` writes or `@/auth`'s `signIn`, same
// reasoning as gallery-form.test.tsx's mock of this same module.
vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: vi.fn(),
  unlockSelection: vi.fn(),
}));

const getGalleryDetailMock = vi.fn();
// Task #73's own read, mocked alongside `getGalleryDetail` for the identical
// reason: its REAL implementation issues a `db.select(...)` this test file
// never stands up (unlike `getGalleryDetail` here, `@/lib/db` itself is not
// mocked anywhere in this suite) — leaving it real via `importActual` would
// make every test in this file reach for the real, unmocked database.
const getGalleryUnlockAuditMock = vi.fn();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleryDetail: (...args: unknown[]) => getGalleryDetailMock(...args),
    getGalleryUnlockAudit: (...args: unknown[]) => getGalleryUnlockAuditMock(...args),
  };
});

// Real R2 is never touched here — `getPresignedUrl` is a local signature,
// its own behavior is proven in src/lib/r2.test.ts.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
  getGalleryDetailMock.mockReset();
  getGalleryUnlockAuditMock.mockReset();
  getGalleryUnlockAuditMock.mockResolvedValue({
    unlockedAt: null,
    unlockedByEmail: null,
    unlockReason: null,
  });
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client"): Session {
  return {
    user: { id: "user-1", role, name: "Alejo", email: "someone@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "draft",
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

describe("GalleryDetailPage", () => {
  it("resolves for an admin session with an existing gallery", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
    getGalleryDetailMock.mockResolvedValue(galleryDetail());

    await expect(GalleryDetailPage(paramsFor(GALLERY_ID))).resolves.toBeTruthy();
  });

  it("refuses a signed-in CLIENT with a 403", async () => {
    authMock.mockResolvedValue(sessionFor("client"));

    await expect(GalleryDetailPage(paramsFor(GALLERY_ID))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(GalleryDetailPage(paramsFor(GALLERY_ID))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });

  it("404s for a malformed gallery id, before ever querying the database", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));

    await expect(GalleryDetailPage(paramsFor("not-a-uuid"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });

  it("404s when the gallery does not exist", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
    getGalleryDetailMock.mockResolvedValue(null);

    await expect(GalleryDetailPage(paramsFor(GALLERY_ID))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(getGalleryUnlockAuditMock).not.toHaveBeenCalled();
  });

  it("looks up the unlock audit trail for the SAME gallery it just resolved", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
    getGalleryDetailMock.mockResolvedValue(galleryDetail());

    await GalleryDetailPage(paramsFor(GALLERY_ID));

    expect(getGalleryUnlockAuditMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("presigns a proof URL for every asset in the gallery", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
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
            isSelected: false,
            sortOrder: 1,
            finalKey: null,
            isEdited: false,
          },
        ],
      }),
    );

    await GalleryDetailPage(paramsFor(GALLERY_ID));

    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a1.webp");
    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a2.webp");
  });
});
