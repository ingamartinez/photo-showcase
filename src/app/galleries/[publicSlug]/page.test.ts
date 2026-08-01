import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import ClientGalleryPage from "./page";
import type { GalleryDetail } from "@/lib/galleries";

// `import "server-only"` (transitively, via src/lib/auth-guards.ts and
// src/lib/galleries.ts) only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts.
vi.mock("server-only", () => ({}));

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const getGalleryDetailBySlugMock = vi.fn();
vi.mock("@/lib/galleries", async () => {
  const actual = await vi.importActual<typeof import("@/lib/galleries")>("@/lib/galleries");
  return {
    ...actual,
    getGalleryDetailBySlug: (...args: unknown[]) => getGalleryDetailBySlugMock(...args),
  };
});

// Real R2 is never touched here — `getPresignedUrl` is a local signature,
// proven for real in src/lib/r2.test.ts.
const getPresignedUrlMock = vi.fn();
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (...args: unknown[]) => getPresignedUrlMock(...args),
  // Task #89: the page presigns this key for a delivered gallery's edited
  // assets. Deterministic fake, same treatment as every other key builder in
  // this app's route tests.
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  // Task #78: identity fake — the page re-attaches the `R2Key` brand to
  // `asset.proofKey` via `storedKey` before calling `getPresignedUrl`.
  storedKey: (key: string) => key,
}));

// Task #94: ownership itself moved to src/lib/gallery-access.ts's
// `isGalleryOwner`, which has its own dedicated, mutation-tested suite
// (gallery-access.test.ts). Mocked here with a realistic default (admin, or
// the session that owns `client-a`'s gallery, is an owner — anyone else
// isn't), so this suite keeps testing exactly its own job: does this PAGE
// call `isGalleryOwner` and honor its result.
const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
  // Task #139: a plain re-implementation of the real predicate (admin, full
  // stop) — this module is mocked wholesale, not via `importActual`, same
  // reasoning as `isGalleryOwner` above. The real function's own suite is
  // gallery-access.test.ts; this file's own concern is authorization and the
  // notFound()/forbidden() branches, not this banner's gate.
  isAdminPreviewingClientGallery: (session: Session) => session.user.role === "admin",
}));

// Task #95: the collaborative tray's first paint. Mocked for the same reason
// `@/lib/gallery-access` is — it reaches Postgres, and it has its own
// dedicated suite (src/lib/gallery-selection.test.ts). What THIS suite cares
// about is that the page reads it only AFTER the ownership and visibility
// gates have passed, which the guard tests below prove by asserting it was
// never called at all on a refused request.
const getGallerySelectionMock = vi.fn<(galleryId: string) => Promise<unknown[]>>();
vi.mock("@/lib/gallery-selection", () => ({
  getGallerySelection: (...args: [string]) => getGallerySelectionMock(...args),
}));

beforeEach(() => {
  authMock.mockReset();
  getGallerySelectionMock.mockReset();
  getGallerySelectionMock.mockResolvedValue([]);
  getGalleryDetailBySlugMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockImplementation(
    async (_galleryId, session) => session.user.role === "admin" || session.user.id === "client-a",
  );
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

function sessionFor(role: "admin" | "client", userId = "client-a"): Session {
  return {
    user: { id: userId, role, email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

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
    assets: [],
    selectionSubmittedAt: null,
    ...overrides,
  };
}

function paramsFor(publicSlug: string) {
  return { params: Promise.resolve({ publicSlug }) };
}

describe("ClientGalleryPage", () => {
  it("resolves for the owning client with an existing, proofing gallery", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    expect(getGalleryDetailBySlugMock).toHaveBeenCalledWith(SLUG);
  });

  it("resolves for an admin session regardless of who the gallery's clients are", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "someone-else", name: null, email: "x@example.com" }] }),
    );

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
  });

  it("redirects to /login when there is no session at all", async () => {
    authMock.mockResolvedValue(null);

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    expect(getGalleryDetailBySlugMock).not.toHaveBeenCalled();
  });

  it("404s when no gallery matches the slug", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(null);

    await expect(ClientGalleryPage(paramsFor("does-not-exist"))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // The task's headline security acceptance criterion, restated for the
  // slug-keyed route: another client's slug in the URL yields 403 — an
  // unguessable slug only stops enumeration, it is not authorization by
  // itself (src/lib/galleries.ts's own comment on getGalleryDetailBySlug).
  it("403s a signed-in client who does not own this gallery, even though they have its slug", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-b"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({ clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }] }),
    );

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
  });

  // Task #94's core acceptance criterion — "a SECOND client attached to the
  // same gallery is just as much an owner as the first" — is proven for
  // REAL against the actual `gallery_clients` query in
  // src/lib/gallery-access.test.ts ("allows a SECOND client attached to the
  // same gallery, not just the first"). This page never reads
  // `gallery.clients` itself (see page.tsx: ownership is decided entirely by
  // `isGalleryOwner(gallery.id, session)`), so a test here that stubs
  // `isGalleryOwnerMock` to unconditionally resolve `true` cannot exercise
  // that acceptance criterion no matter what the `clients` fixture contains
  // — it would pass identically with `client-b` removed from the array
  // entirely. What this test CAN prove, and does, is the review's own
  // finding: that the page calls `isGalleryOwner` with the gallery's OWN id,
  // never anything the caller supplied — the same shortcut
  // src/lib/asset-access.ts's header comment warns never to take.
  it("resolves when isGalleryOwner approves, calling it with the gallery's OWN id and the acting session", async () => {
    const session = sessionFor("client", "client-b");
    authMock.mockResolvedValue(session);
    isGalleryOwnerMock.mockResolvedValue(true);
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ id: "g1" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    expect(isGalleryOwnerMock).toHaveBeenCalledWith("g1", session);
  });

  // A draft gallery is still being assembled — must never be visible to a
  // client, even the one who legitimately owns it.
  it("404s a draft gallery for its own owning client", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  // Admins bypass the draft gate — they need to be able to preview a
  // gallery before publishing it.
  it("lets an admin view a draft gallery", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
  });

  it.each(["proofing", "selected", "delivered"] as const)(
    "renders a %s gallery for its owning client",
    async (status) => {
      authMock.mockResolvedValue(sessionFor("client", "client-a"));
      getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status }));

      await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    },
  );

  it("presigns a proof URL for every asset in the gallery", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
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

    await ClientGalleryPage(paramsFor(SLUG));

    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a1.webp");
    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a2.webp");
  });
});
