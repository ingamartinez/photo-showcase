// Task #136: proves `import { graphql, printSchema } from "graphql"` now
// works DIRECTLY in a Vitest file — see vitest.config.ts's own comment above
// `server.deps.inline` for the root cause and the fix. This file exists to
// exercise exactly the capability #136 was written to unblock: testing a
// resolver in isolation, by calling `graphql()` against the real schema
// directly, WITHOUT going through the Yoga HTTP handler.
//
// This is deliberately NOT a rewrite of src/app/api/graphql/route.test.ts —
// that suite is correct as it is (the reviewer said so) and stays untouched.
// This file's only overlap with it is testing the SAME ownership gate
// (`isGalleryOwner`) once, at the resolver layer instead of the HTTP layer,
// to prove the layer this task unlocks actually works end to end and isn't
// just an import that resolves without error.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// Same mocks as route.test.ts, and for the same reasons — see that file's
// own header comment.
vi.mock("server-only", () => ({}));

const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
}));

const getGalleryDetailMock = vi.fn();
const getGalleriesForClientMock = vi.fn();
const isGalleryVisibleToClientMock = vi.fn();
vi.mock("@/lib/galleries", () => ({
  getGalleryDetail: (...args: [string]) => getGalleryDetailMock(...args),
  getGalleriesForClient: (...args: [string]) => getGalleriesForClientMock(...args),
  isGalleryVisibleToClient: (...args: [string]) => isGalleryVisibleToClientMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function clientBSession(): Session {
  return {
    user: { id: "client-b", role: "client", email: "b@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

beforeEach(() => {
  isGalleryOwnerMock.mockReset();
  getGalleryDetailMock.mockReset();
  getGalleriesForClientMock.mockReset();
  isGalleryVisibleToClientMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the schema, imported and executed directly (no HTTP layer)", () => {
  it("printSchema() produces the expected root Query type", async () => {
    const { printSchema } = await import("graphql");
    const { getSchema } = await import("./schema");

    const sdl = printSchema(getSchema());

    expect(sdl).toContain("type Query");
    expect(sdl).toContain("gallery(id: ID!): Gallery");
    expect(sdl).toContain("galleries: [Gallery!]");
    // Task #31's two additions. `galleryBySlug` takes a String, not an ID:
    // the slug is opaque text this app mints, never a GraphQL identity.
    expect(sdl).toContain("galleryBySlug(publicSlug: String!): Gallery");
    expect(sdl).toContain("galleryList: [GalleryListItem!]");
  });

  // Task #32. This is a printed-SDL assertion, so what it proves is exactly
  // what `printSchema` renders — the `!` markers on the six fields named
  // below — and nothing about what a resolver returns at runtime.
  //
  // WHY IT IS WORTH PINNING AT ALL: `src/lib/graphql/generated/**` is
  // generated FROM this schema and committed, and every field's nullability
  // crosses straight into the TypeScript the client pages read. Reverting
  // `builder.ts`'s `defaultFieldNullability: false` makes every `!` below
  // disappear, `bun run codegen` then widens every generated field to
  // `T | null`, and the pages stop compiling. This test is what turns that
  // into an immediate, named failure instead of a confusing one two steps
  // downstream.
  it("prints `!` on the fields whose backing value cannot be null, and omits it on the three that can", async () => {
    const { printSchema } = await import("graphql");
    const { getSchema } = await import("./schema");

    const sdl = printSchema(getSchema());

    // Non-null: backed by `NOT NULL` columns (see src/lib/db/schema.ts).
    expect(sdl).toContain("id: ID!");
    expect(sdl).toContain("title: String!");
    expect(sdl).toContain("photoCount: Int!");
    expect(sdl).toContain("assets: [Asset!]!");
    // The frozen commercial terms — always present on a gallery row, which is
    // the whole point of freezing them.
    expect(sdl).toContain("includedPhotosSnapshot: Int!");
    expect(sdl).toContain("extraPhotoPriceCopSnapshot: Int!");

    // Genuinely nullable, each carrying its own explicit `nullable: true`:
    // an unsubmitted selection, an unedited asset, a client who never gave a
    // name. Asserted as whole lines so a stray `!` cannot hide inside a
    // substring match.
    expect(sdl).toMatch(/^ {2}selectionSubmittedAt: String$/m);
    expect(sdl).toMatch(/^ {2}finalKey: String$/m);
    expect(sdl).toMatch(/^ {2}name: String$/m);

    // The two refusal-carrying root fields stay nullable: `null` IS how this
    // schema refuses (see ./types/query.ts's header).
    expect(sdl).toContain("gallery(id: ID!): Gallery\n");
    expect(sdl).toContain("galleryBySlug(publicSlug: String!): Gallery\n");
  });

  it("graphql() refuses a client who does not own the gallery — same gate as route.test.ts, exercised without HTTP", async () => {
    // MUTATION-PROVEN: reverting vitest.config.ts's `server.deps.inline`
    // list makes this whole file fail before this assertion is even
    // reached, with graphql-js's own "Cannot use GraphQLSchema ... from
    // another module or realm" error — see this task's report for the
    // observed output.
    isGalleryOwnerMock.mockResolvedValue(false);
    const { graphql } = await import("graphql");
    const { getSchema } = await import("./schema");

    const result = await graphql({
      schema: getSchema(),
      source: `{ gallery(id: "${GALLERY_ID}") { id title } }`,
      contextValue: { session: clientBSession() },
    });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ gallery: null });
    expect(isGalleryOwnerMock).toHaveBeenCalledWith(GALLERY_ID, clientBSession());
    expect(getGalleryDetailMock).not.toHaveBeenCalled();
  });
});
