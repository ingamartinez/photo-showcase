// Task #31's second acceptance criterion, for the client gallery INDEX: "No
// N+1 on the asset lists; verify with query logging, not by reading code."
//
// So this file reads no code and trusts no comment. It spies the REAL
// `db.query.galleries.*` methods, lets the REAL `getGalleriesForClient` build a
// REAL drizzle query off the args it passes, compiles it with `.toSQL()`
// WITHOUT executing it (the technique src/lib/galleries.query-rendering.test.ts
// and src/lib/graphql/gallery-details-by-ids.test.ts already use — no Postgres
// connection is opened), and counts the calls the whole page makes end to end.
//
// Note what is deliberately NOT mocked here: `@/lib/galleries` and
// `@/lib/graphql/*` both run for real, so the count below is the count of the
// page's actual GraphQL round trip through the actual resolver, not of a fake
// standing in for one.
//
// THE FIXTURE IS DELIBERATELY THREE GALLERIES, AND THEN FIVE. Do not trim it
// to one: with a single gallery, "one query" and "one query per gallery" are
// the same number, and `toHaveBeenCalledTimes(1)` cannot tell them apart — the
// same discriminating-fixture rule
// src/app/dashboard/galleries/[galleryId]/page.test.ts spells out for its own
// attach-picker count. Running the assertion at two different N values is what
// makes "does not grow with N" a measurement rather than a hope.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import ClientGalleriesPage from "./page";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

// Task #180: the page presigns each gallery's own cover key — `@/lib/r2`
// constructs a real `S3Client` off `r2Env()` (see r2.ts's own header), which
// this query-count file has no reason to exercise. Mocked with the same
// deterministic fake every other test in this app uses for it.
vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
  storedKey: (key: string) => key,
}));

/** A row shaped exactly as `getGalleriesForClient`'s own relational query
 * returns one: the gallery's columns plus an id-only `assets` projection it
 * counts in memory. `coverAssetId` defaults to `null` — no cover picked
 * yet, task #180's own ordinary state — and can be overridden to exercise
 * the SECOND, batched cover-asset query below. */
function galleryRow(index: number, photoCount: number, coverAssetId: string | null = null) {
  return {
    id: `g${index}`,
    title: `Sesión ${index}`,
    publicSlug: `slug-${index}`,
    status: "proofing" as const,
    sessionDate: "2026-08-01",
    coverAssetId,
    assets: Array.from({ length: photoCount }, (_unused, asset) => ({ id: `g${index}-a${asset}` })),
  };
}

/** Spies both relational entry points on `galleries` and returns the pair of
 * spies. `findMany` compiles the real query and resolves `rows` without ever
 * executing it; `findFirst` is spied bare, so a regression into a per-gallery
 * detail fetch shows up as a non-zero count rather than as a silent extra
 * round trip. */
function spyOnGalleryQueries(rows: ReturnType<typeof galleryRow>[]) {
  const realFindMany = db.query.galleries.findMany.bind(db.query.galleries);
  const compiled: string[] = [];

  const findMany = vi.spyOn(db.query.galleries, "findMany").mockImplementation(((args: unknown) => {
    compiled.push(realFindMany(args as Parameters<typeof realFindMany>[0]).toSQL().sql);
    return Promise.resolve(rows);
  }) as unknown as typeof db.query.galleries.findMany);
  const findFirst = vi.spyOn(db.query.galleries, "findFirst");

  return { findMany, findFirst, compiled };
}

/** Task #180 — spies `db.query.assets.findMany`, the SECOND, batched query
 * `getGalleriesForClient` issues to resolve cover photos. Resolves canned
 * `coverAssets` without ever touching Postgres, same technique as
 * `spyOnGalleryQueries` above. */
function spyOnAssetsFindMany(coverAssets: { id: string; galleryId: string; proofKey: string }[]) {
  return vi
    .spyOn(db.query.assets, "findMany")
    .mockImplementation((() =>
      Promise.resolve(coverAssets)) as unknown as typeof db.query.assets.findMany);
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({
    user: { id: "client-a", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/galleries — real query count through the GraphQL read", () => {
  it("renders THREE galleries with 40 photos each in exactly ONE galleries query", async () => {
    const rows = [galleryRow(1, 40), galleryRow(2, 40), galleryRow(3, 40)];
    const { findMany, findFirst, compiled } = spyOnGalleryQueries(rows);

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();

    // THE PROOF: one query for three galleries and 120 assets.
    expect(findMany).toHaveBeenCalledTimes(1);
    // A per-gallery detail fetch (`getGalleryDetail` -> `findGalleryDetail`)
    // would show up here, which rules out a hybrid regression that a bare
    // `findMany` count alone would miss.
    expect(findFirst).not.toHaveBeenCalled();
    // And it really is a compiled SQL statement against the galleries table,
    // not an untouched mock that would count the same either way.
    expect(compiled).toHaveLength(1);
    expect(compiled[0]).toContain('from "galleries"');
  });

  it("still issues exactly ONE query for FIVE galleries — the count does not grow with N", async () => {
    const rows = [1, 2, 3, 4, 5].map((index) => galleryRow(index, 40));
    const { findMany, findFirst } = spyOnGalleryQueries(rows);

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findFirst).not.toHaveBeenCalled();
  });

  // The other axis of the same criterion: the count must not grow with the
  // number of PHOTOS either. `galleryList` carries a `photoCount`, and the one
  // query above materialises ids to derive it — never one query per asset, and
  // never a second query for the gallery's full asset rows (which is what
  // reading this page's data off `Query.galleries` would have cost).
  it("does not grow with the number of photos in a gallery", async () => {
    const { findMany } = spyOnGalleryQueries([galleryRow(1, 300)]);

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  // Task #180 — the SAME "no N+1" criterion, extended to the cover photo.
  // Five galleries, each with its OWN cover set, must still cost exactly one
  // extra (batched) query for the covers — never one per gallery.
  it("resolves FIVE galleries' cover photos in exactly ONE additional batched query", async () => {
    const rows = [1, 2, 3, 4, 5].map((index) => galleryRow(index, 10, `g${index}-a0`));
    const { findMany } = spyOnGalleryQueries(rows);
    const findManyAssets = spyOnAssetsFindMany(
      [1, 2, 3, 4, 5].map((index) => ({
        id: `g${index}-a0`,
        galleryId: `g${index}`,
        proofKey: `galleries/g${index}/proofs/a0.webp`,
      })),
    );

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findManyAssets).toHaveBeenCalledTimes(1);
  });

  // The no-cover-set case costs NOTHING extra: the batched cover query is
  // skipped entirely rather than issued with an empty `inArray`.
  it("never queries for cover assets when nothing in the page has a cover set", async () => {
    const rows = [galleryRow(1, 10), galleryRow(2, 10)];
    spyOnGalleryQueries(rows);
    const findManyAssets = spyOnAssetsFindMany([]);

    await expect(ClientGalleriesPage()).resolves.toBeTruthy();

    expect(findManyAssets).not.toHaveBeenCalled();
  });
});
