// Task #31 — the authorization scenarios for `Query.galleryBySlug`, the new
// field the client gallery page resolves against.
//
// Exercised at the RESOLVER layer, by calling `graphql()` against the real
// schema directly, which is the capability task #136 unlocked (see
// vitest.config.ts's `server.deps.inline` comment, and ../schema.test.ts for
// the first use of it). `src/app/api/graphql/route.test.ts` is deliberately
// left alone — #136's review said so — and this field's HTTP transport is
// identical to `gallery`'s, which that suite already covers.
//
// THE POINT OF THIS FILE: `galleryBySlug` is a SECOND way into a gallery, and
// the epic's stated risk (task #6) is a second API surface growing a second,
// weaker set of authorization rules. Every scenario `gallery` has is repeated
// here, plus the one that only exists for a slug-keyed lookup: the slug is
// unguessable, and that is explicitly NOT treated as authorization.
//
// No `vi.mock("server-only", ...)` is needed any more — vitest.config.ts
// aliases the marker to an inert stub for every environment (task #31).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { GalleryDetail } from "@/lib/galleries";

const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

const getGalleryDetailBySlugMock = vi.fn<(publicSlug: string) => Promise<GalleryDetail | null>>();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetailBySlug: (...args: [string]) => getGalleryDetailBySlugMock(...args),
  // The REAL rule, not a stub that could disagree with it: `draft` and
  // `archived` are the two statuses a client must not see.
  isGalleryVisibleToClient: (status: string) => status !== "draft" && status !== "archived",
}));

const SLUG = "AbCdEf0123456789_-xyzQ";

function sessionFor(role: "admin" | "client", userId: string): Session {
  return {
    user: { id: userId, role, email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function galleryDetail(overrides: Partial<GalleryDetail> = {}): GalleryDetail {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Boda Ana y Beto",
    publicSlug: SLUG,
    status: "proofing",
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    clients: [{ id: "client-a", name: "Ana Pérez", email: "ana@example.com" }],
    package: { id: 1, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [],
    selectionSubmittedAt: null,
    ...overrides,
  };
}

const QUERY = /* GraphQL */ `
  query ($publicSlug: String!) {
    galleryBySlug(publicSlug: $publicSlug) {
      id
      title
      status
    }
  }
`;

async function run(publicSlug: string, session: Session | null) {
  const { graphql } = await import("graphql");
  const { getSchema } = await import("../schema");

  return graphql({
    schema: getSchema(),
    source: QUERY,
    variableValues: { publicSlug },
    contextValue: { session },
  });
}

beforeEach(() => {
  isGalleryOwnerMock.mockReset();
  getGalleryDetailBySlugMock.mockReset();
});

describe("Query.galleryBySlug authorization", () => {
  it("returns null, not an error, for an unauthenticated caller — and never reads the gallery", async () => {
    const result = await run(SLUG, null);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ galleryBySlug: null });
    expect(getGalleryDetailBySlugMock).not.toHaveBeenCalled();
    expect(isGalleryOwnerMock).not.toHaveBeenCalled();
  });

  it("refuses a signed-in client who does not own the gallery, even holding its slug", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    isGalleryOwnerMock.mockResolvedValue(false);

    const result = await run(SLUG, sessionFor("client", "client-b"));

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ galleryBySlug: null });
    // Checked against the gallery's OWN id as read from the database — never
    // the slug the caller supplied.
    expect(isGalleryOwnerMock).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      sessionFor("client", "client-b"),
    );
  });

  // THE no-existence-oracle property, asserted as an equality between two
  // responses rather than as two separate "is null" checks: a client probing
  // slugs must not be able to tell "that gallery exists but is not yours"
  // apart from "no such gallery".
  it("answers a non-owner and an unknown slug with byte-identical responses", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    isGalleryOwnerMock.mockResolvedValue(false);
    const refused = await run(SLUG, sessionFor("client", "client-b"));

    getGalleryDetailBySlugMock.mockResolvedValue(null);
    const missing = await run("nOtArEaLsLuGaTaLl123", sessionFor("client", "client-b"));

    expect(JSON.stringify(refused)).toBe(JSON.stringify(missing));
    expect(refused.errors).toBeUndefined();
  });

  it("serves the gallery to a client who owns it", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail());
    isGalleryOwnerMock.mockResolvedValue(true);

    const result = await run(SLUG, sessionFor("client", "client-a"));

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      galleryBySlug: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Boda Ana y Beto",
        status: "proofing",
      },
    });
    expect(getGalleryDetailBySlugMock).toHaveBeenCalledWith(SLUG);
  });

  it("hides a DRAFT gallery from its own owning client", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));
    isGalleryOwnerMock.mockResolvedValue(true);

    const result = await run(SLUG, sessionFor("client", "client-a"));

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ galleryBySlug: null });
  });

  it("lets an admin read a DRAFT gallery, bypassing the client-visibility gate", async () => {
    getGalleryDetailBySlugMock.mockResolvedValue(galleryDetail({ status: "draft" }));
    isGalleryOwnerMock.mockResolvedValue(true);

    const result = await run(SLUG, sessionFor("admin", "admin-1"));

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({
      galleryBySlug: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Boda Ana y Beto",
        status: "draft",
      },
    });
  });

  it("rejects a malformed slug before touching the database at all", async () => {
    const result = await run("", sessionFor("client", "client-a"));

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ galleryBySlug: null });
    expect(getGalleryDetailBySlugMock).not.toHaveBeenCalled();
  });
});
