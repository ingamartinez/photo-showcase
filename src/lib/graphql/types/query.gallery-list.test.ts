// Task #31 — the authorization scenarios for `Query.galleryList`, the light
// index projection `/galleries` renders.
//
// The scoping rule this field relies on is NOT re-implemented in the resolver:
// it is `getGalleriesForClient`, whose own ownership subquery, soft-removal
// filter and CLIENT_VISIBLE_STATUSES filter are proven for real against
// Postgres in src/lib/galleries.test.ts and
// src/lib/galleries.query-rendering.test.ts. What this file proves is the part
// that lives in the resolver and nowhere else: that the id it scopes by comes
// from the SESSION, that a signed-out caller gets `[]` rather than an error,
// and that no argument exists through which a caller could ask for someone
// else's list.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import type { ClientGalleryListItem } from "@/lib/galleries";

const getGalleriesForClientMock = vi.fn<(clientId: string) => Promise<ClientGalleryListItem[]>>();
vi.mock("@/lib/galleries", () => ({
  getGalleriesForClient: (...args: [string]) => getGalleriesForClientMock(...args),
}));

vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: () => Promise.resolve(false),
}));

function sessionFor(role: "admin" | "client", userId: string): Session {
  return {
    user: { id: userId, role, email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function listItem(overrides: Partial<ClientGalleryListItem> = {}): ClientGalleryListItem {
  return {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "AbCdEf0123456789_-xyzQ",
    status: "proofing",
    sessionDate: "2026-08-01",
    photoCount: 24,
    ...overrides,
  };
}

const QUERY = /* GraphQL */ `
  {
    galleryList {
      id
      title
      publicSlug
      status
      sessionDate
      photoCount
    }
  }
`;

async function run(session: Session | null) {
  const { graphql } = await import("graphql");
  const { getSchema } = await import("../schema");

  return graphql({ schema: getSchema(), source: QUERY, contextValue: { session } });
}

beforeEach(() => {
  getGalleriesForClientMock.mockReset();
});

describe("Query.galleryList authorization", () => {
  it("returns an empty list, not an error, for an unauthenticated caller — and never queries", async () => {
    const result = await run(null);

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ galleryList: [] });
    expect(getGalleriesForClientMock).not.toHaveBeenCalled();
  });

  it("scopes the query to the SESSION's own user id", async () => {
    getGalleriesForClientMock.mockResolvedValue([listItem()]);

    const result = await run(sessionFor("client", "client-a"));

    expect(result.errors).toBeUndefined();
    expect(getGalleriesForClientMock).toHaveBeenCalledWith("client-a");
    expect(getGalleriesForClientMock).toHaveBeenCalledTimes(1);
  });

  // The mirror of `getGalleriesForClient`'s own no-admin-bypass property, at
  // the resolver layer: an admin gets their OWN id passed through, never a
  // wildcard and never another client's.
  it("passes an ADMIN's own user id too, never a studio-wide listing", async () => {
    getGalleriesForClientMock.mockResolvedValue([]);

    await run(sessionFor("admin", "admin-1"));

    expect(getGalleriesForClientMock).toHaveBeenCalledWith("admin-1");
  });

  // Structural, not behavioural: a field with no arguments cannot be asked for
  // somebody else's list in the first place, which is a stronger guarantee
  // than validating an argument correctly.
  it("exposes no argument a caller could use to name a different client", async () => {
    const { getSchema } = await import("../schema");
    const field = getSchema().getQueryType()?.getFields().galleryList;

    expect(field).toBeDefined();
    expect(field?.args).toEqual([]);
  });

  it("returns every field the client index renders, in the order the query returned them", async () => {
    getGalleriesForClientMock.mockResolvedValue([
      listItem({ id: "g1", title: "Sesión de verano", publicSlug: "s1", photoCount: 30 }),
      listItem({ id: "g2", title: "Cumpleaños", publicSlug: "s2", photoCount: 15 }),
    ]);

    const result = await run(sessionFor("client", "client-a"));

    expect(result.data).toEqual({
      galleryList: [
        {
          id: "g1",
          title: "Sesión de verano",
          publicSlug: "s1",
          status: "proofing",
          sessionDate: "2026-08-01",
          photoCount: 30,
        },
        {
          id: "g2",
          title: "Cumpleaños",
          publicSlug: "s2",
          status: "proofing",
          sessionDate: "2026-08-01",
          photoCount: 15,
        },
      ],
    });
  });
});
