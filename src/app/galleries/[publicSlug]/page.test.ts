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
}));

beforeEach(() => {
  authMock.mockReset();
  getGalleryDetailBySlugMock.mockReset();
  getPresignedUrlMock.mockReset();
  getPresignedUrlMock.mockReturnValue("https://r2.example.com/presigned-proof-url");
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

describe("ClientGalleryPage", () => {
  it("resolves for the owning client with an existing, proofing gallery", async () => {
    authMock.mockResolvedValue(sessionFor("client", "client-a"));
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();
    expect(getGalleryDetailBySlugMock).toHaveBeenCalledWith(SLUG);
  });

  it("resolves for an admin session regardless of who the gallery's client is", async () => {
    authMock.mockResolvedValue(sessionFor("admin", "admin-1"));
    getGalleryDetailBySlugMock.mockResolvedValue(
      galleryDetail({ client: { id: "someone-else", name: null, email: "x@example.com" } }),
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
      galleryDetail({ client: { id: "client-a", name: "Ana Pérez", email: "ana@example.com" } }),
    );

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });
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
          },
          {
            id: "a2",
            originalFilename: "IMG_0002.JPG",
            proofKey: "galleries/g1/proofs/a2.webp",
            proofWidth: 1600,
            proofHeight: 1067,
            isSelected: false,
            sortOrder: 1,
          },
        ],
      }),
    );

    await ClientGalleryPage(paramsFor(SLUG));

    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a1.webp");
    expect(getPresignedUrlMock).toHaveBeenCalledWith("galleries/g1/proofs/a2.webp");
  });
});
