// Task #31 — covers ./client-gallery-reads.ts and ./execute.ts together,
// because the thing most worth proving spans both: that the documents the
// client gallery pages ship actually match the schema they are executed
// against, and that a document which does NOT match fails loudly instead of
// resolving to `undefined`.
//
// That is the failure mode ./execute.ts's header calls out: graphql-js's
// `execute()` does not validate, and an unknown field in an unvalidated
// document is silently skipped. A page reading `data.galleryBySlug.title`
// would then crash on `undefined`, several frames away from the typo that
// caused it, or — worse for a boolean — render the wrong thing quietly.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { ClientGalleryListItem, GalleryDetail } from "@/lib/galleries";

const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

const getGalleryDetailBySlugMock = vi.fn<(publicSlug: string) => Promise<GalleryDetail | null>>();
const getGalleriesForClientMock = vi.fn<(clientId: string) => Promise<ClientGalleryListItem[]>>();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetailBySlug: (...args: [string]) => getGalleryDetailBySlugMock(...args),
  getGalleriesForClient: (...args: [string]) => getGalleriesForClientMock(...args),
  isGalleryVisibleToClient: (status: string) => status !== "draft" && status !== "archived",
}));

const SLUG = "AbCdEf0123456789_-xyzQ";
const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function session(role: "admin" | "client" = "client", userId = "client-a"): Session {
  return {
    user: { id: userId, role, email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: GALLERY_ID,
    title: "Boda Ana y Beto",
    publicSlug: SLUG,
    status: "delivered",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }],
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [
      {
        id: "a1",
        originalFilename: "IMG_0001.JPG",
        proofKey: "dev/galleries/g1/proofs/a1.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: true,
        sortOrder: 0,
        finalKey: "dev/galleries/g1/finals/a1.jpg",
        isEdited: true,
      },
    ],
    selectionSubmittedAt: new Date("2026-07-28T12:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockResolvedValue(true);
  getGalleryDetailBySlugMock.mockReset();
  getGalleriesForClientMock.mockReset();
});

describe("the documents the client gallery pages execute", () => {
  // THE DRIFT GUARD. Everything else in this file could stay green while a
  // field was renamed in the schema and left stale in a document; this is what
  // catches that, and it catches it for every document at once rather than only
  // the ones some other test happens to execute.
  it("every shipped document validates against the real schema", async () => {
    const { validate } = await import("graphql");
    const { getSchema } = await import("./schema");
    const { CLIENT_GALLERY_DOCUMENTS } = await import("./client-gallery-reads");

    const schema = getSchema();
    for (const [name, document] of Object.entries(CLIENT_GALLERY_DOCUMENTS)) {
      expect(
        validate(schema, document).map((error) => error.message),
        name,
      ).toEqual([]);
    }
  });

  it("still ships both documents — a deleted entry must not silently pass the guard above", async () => {
    const { CLIENT_GALLERY_DOCUMENTS } = await import("./client-gallery-reads");

    expect(Object.keys(CLIENT_GALLERY_DOCUMENTS).sort()).toEqual([
      "ClientGalleryBySlug",
      "ClientGalleryList",
    ]);
  });

  // The other half of the guard: proof that `validate` is actually WIRED INTO
  // the execution path, not just called by the test above. Without this, a
  // future edit could drop the validation step from execute.ts and the drift
  // guard would still pass.
  it("throws, rather than returning undefined, for a document asking a field the schema does not have", async () => {
    const { parse } = await import("graphql");
    const { executeServerDocument } = await import("./execute");

    await expect(
      executeServerDocument({
        document: parse("{ galleryList { id totallyNotAField } }"),
        session: session(),
      }),
    ).rejects.toThrow(/does not match the schema/);
  });

  it("surfaces a resolver failure as a thrown error instead of half-populated data", async () => {
    const { parse } = await import("graphql");
    const { executeServerDocument } = await import("./execute");
    getGalleriesForClientMock.mockRejectedValue(new Error("postgres is down"));

    await expect(
      executeServerDocument({
        document: parse("{ galleryList { id } }"),
        session: session(),
      }),
    ).rejects.toThrow(/GraphQL execution failed: postgres is down/);
  });
});

describe("readClientGalleryBySlug", () => {
  it("returns exactly the projection the client detail page renders", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    const { readClientGalleryBySlug } = await import("./client-gallery-reads");

    const gallery = await readClientGalleryBySlug(SLUG, session());

    expect(gallery).toEqual({
      id: GALLERY_ID,
      title: "Boda Ana y Beto",
      status: "delivered",
      sessionDate: "2026-08-01",
      // A `Date` on the way in, an ISO string on the way out — the schema has
      // no Date scalar, see ./types/gallery.ts.
      selectionSubmittedAt: "2026-07-28T12:00:00.000Z",
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      package: { name: "Estándar" },
      assets: [
        {
          id: "a1",
          originalFilename: "IMG_0001.JPG",
          proofKey: "dev/galleries/g1/proofs/a1.webp",
          proofWidth: 1600,
          proofHeight: 1067,
          isSelected: true,
          finalKey: "dev/galleries/g1/finals/a1.jpg",
          isEdited: true,
        },
      ],
    });
  });

  // The narrowing is the point, not an accident of the fixture: the document
  // deliberately does not select the gallery's OTHER attached clients, its
  // `publicSlug` or its `createdAt`. A widened document would start handing
  // the page data it has no business rendering.
  it("does not carry the gallery's other clients, publicSlug or createdAt", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    const { readClientGalleryBySlug } = await import("./client-gallery-reads");

    const gallery = await readClientGalleryBySlug(SLUG, session());

    expect(Object.keys(gallery ?? {}).sort()).toEqual([
      "assets",
      "extraPhotoPriceCopSnapshot",
      "id",
      "includedPhotosSnapshot",
      "package",
      "selectionSubmittedAt",
      "sessionDate",
      "status",
      "title",
    ]);
  });

  it("hands the caller's own session to the ownership check, and returns null when it refuses", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    isGalleryOwnerMock.mockResolvedValue(false);
    const acting = session("client", "client-b");
    const { readClientGalleryBySlug } = await import("./client-gallery-reads");

    await expect(readClientGalleryBySlug(SLUG, acting)).resolves.toBeNull();
    expect(isGalleryOwnerMock).toHaveBeenCalledWith(GALLERY_ID, acting);
  });
});

describe("readClientGalleryList", () => {
  it("returns the client's own index rows", async () => {
    getGalleriesForClientMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "s1",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 24,
      },
    ]);
    const { readClientGalleryList } = await import("./client-gallery-reads");

    await expect(readClientGalleryList(session())).resolves.toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "s1",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 24,
      },
    ]);
    expect(getGalleriesForClientMock).toHaveBeenCalledWith("client-a");
  });
});
