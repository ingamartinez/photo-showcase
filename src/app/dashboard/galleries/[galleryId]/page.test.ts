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
// `deliverGallery` is mocked here too (task #86): <GalleryWorkspace> now
// renders <DeliverGalleryButton> itself, whose module imports it from here.
vi.mock("@/app/dashboard/galleries/actions", () => ({
  publishGallery: vi.fn(),
  unlockSelection: vi.fn(),
  deliverGallery: vi.fn(),
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

// Task #97: the page now also reads `getClientsForPicker` (`@/lib/clients`)
// to build the "attach" picker's eligible-client list — its REAL
// implementation issues a `db.query.users.findMany(...)` this test file
// never stands up, same reasoning as `getGalleryDetail`'s own mock above.
const getClientsForPickerMock = vi.fn();
vi.mock("@/lib/clients", () => ({
  getClientsForPicker: (...args: unknown[]) => getClientsForPickerMock(...args),
}));

// Real R2 is never touched here — `getPresignedUrl` is a local signature,
// its own behavior is proven in src/lib/r2.test.ts.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
  // Task #78: identity fake — the page re-attaches the `R2Key` brand to
  // `asset.proofKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #92: mocked so this suite's fixtures (every one of them ships
// `assets: []` or `finalKey: null` rows, none deliverable) never depend on
// that staying true to avoid touching R2 — the real function's own behavior
// is proven directly in src/lib/gallery-archive-size.test.ts.
const getGalleryArchiveSizeMock = vi.fn();
vi.mock("@/lib/gallery-archive-size", () => ({
  getGalleryArchiveSize: (...args: unknown[]) => getGalleryArchiveSizeMock(...args),
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
  getClientsForPickerMock.mockReset();
  getClientsForPickerMock.mockResolvedValue([]);
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
  getGalleryArchiveSizeMock.mockReset();
  getGalleryArchiveSizeMock.mockResolvedValue(null);
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
    clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    originalPhotoPriceCopSnapshot: 2_000,
    termsOverridden: false,
    selectionTrayMode: "flat",
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
            selectionKind: "edited",
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
            selectionKind: "edited",
          },
        ],
      }),
    );

    await GalleryDetailPage(paramsFor(GALLERY_ID));

    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a1.webp");
    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a2.webp");
  });

  // Task #97: the page reads the attach picker's candidate list from
  // `getClientsForPicker()` ONCE per render, and derives the eligible subset
  // in memory (full list minus `gallery.clients`'s own ids, page.tsx) —
  // never one query per attached client.
  //
  // THE FIXTURE SEEDS THREE ATTACHED CLIENTS ON PURPOSE. Do not trim it back
  // to one "because the assertion only counts calls": with a single attached
  // client, "once" and "once per attached client" are the SAME number, and
  // `toHaveBeenCalledTimes(1)` cannot tell an N+1 fan-out apart from the
  // correct shape. A reviewer proved exactly that by replacing page.tsx's
  // `getClientsForPicker()` with
  // `Promise.all(gallery.clients.map(() => getClientsForPicker()))` and
  // watching the old one-client version of this test stay green. Three
  // attached clients is what gives the number its discriminating power.
  //
  // RENAMED after an earlier review: this used to be called "excludes
  // already-active clients from the attach picker's eligible list", which it
  // never checked — it only awaits the page and counts the mock's calls, and
  // this suite renders nothing (it asserts on the RSC's data access, not its
  // markup). The exclusion itself IS covered, against real rendered
  // <option>s, by page.chrome.test.tsx's "excludes an already-active client
  // from the attach picker's options". Kept rather than deleted because the
  // call count is a fact that test does not assert.
  it("reads the attach picker's candidate list exactly once, not once per attached client", async () => {
    authMock.mockResolvedValue(sessionFor("admin"));
    getGalleryDetailMock.mockResolvedValue(
      galleryDetail({
        clients: [
          { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
          { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
          { id: "u3", name: "Carla Díaz", email: "carla@example.com" },
        ],
      }),
    );
    getClientsForPickerMock.mockResolvedValue([
      { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
      { id: "u2", name: "Beto Ruiz", email: "beto@example.com" },
      { id: "u3", name: "Carla Díaz", email: "carla@example.com" },
      { id: "u4", name: "Dani Soto", email: "dani@example.com" },
    ]);

    await expect(GalleryDetailPage(paramsFor(GALLERY_ID))).resolves.toBeTruthy();
    expect(getClientsForPickerMock).toHaveBeenCalledTimes(1);
  });
});
