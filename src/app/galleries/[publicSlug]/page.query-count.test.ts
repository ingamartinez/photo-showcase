// Task #31's second acceptance criterion, for the client gallery DETAIL page:
// "No N+1 on the asset lists; verify with query logging, not by reading code."
//
// Same technique as ../page.query-count.test.ts (and, before both,
// src/lib/graphql/gallery-details-by-ids.test.ts): spy the REAL `db` entry
// points, let the REAL `getGalleryDetailBySlug` build a REAL drizzle query off
// the args it passes, compile it with `.toSQL()` without executing it, and
// count what the whole page does end to end. `@/lib/galleries` and
// `@/lib/graphql/*` are NOT mocked, so this counts the page's actual trip
// through the actual resolver.
//
// WHAT IS MOCKED, and why each one is not part of the count:
//  * `@/lib/gallery-access` — `isGalleryOwner` would otherwise EXECUTE its
//    query against a real Postgres. Its own cost is one query, fixed, and
//    independent of how many assets the gallery has; this file asserts it is
//    called exactly ONCE so that its absence from the count is a measured fact
//    rather than a hole.
//  * `@/lib/gallery-selection` — same, and proven in its own suite.
//  * `@/lib/r2` — `getPresignedUrl` reads R2 credentials through `r2Env()`.
//
// THE FIXTURE RUNS AT THREE, FIVE AND FORTY ASSETS. Do not collapse it to one:
// with a single asset, "one query" and "one query per asset" are the same
// number, and `toHaveBeenCalledTimes(1)` cannot tell them apart — the
// discriminating-fixture rule
// src/app/dashboard/galleries/[galleryId]/page.test.ts spells out for its own
// count. Asserting the same number at three different N is what makes this a
// measurement.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import ClientGalleryPage from "./page";

const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: (...args: unknown[]) => authMock(...args) }));

const isGalleryOwnerMock = vi.fn<(galleryId: string, session: Session) => Promise<boolean>>();
vi.mock("@/lib/gallery-access", () => ({
  isGalleryOwner: (...args: [string, Session]) => isGalleryOwnerMock(...args),
  // Task #139: reads only `session.user.role`, no query — its absence from
  // this file's own count needs no explanation the way `isGalleryOwner`'s
  // does above.
  isAdminPreviewingClientGallery: (session: Session) => session.user.role === "admin",
}));

vi.mock("@/lib/gallery-selection", () => ({ getGallerySelection: () => Promise.resolve([]) }));

vi.mock("@/lib/r2", () => ({
  getPresignedUrl: (key: string) => `https://r2.example.com/${key}?presigned=1`,
  displayKey: (galleryId: string, assetId: string) =>
    `galleries/${galleryId}/display/${assetId}.webp`,
  storedKey: (key: string) => key,
}));

const SLUG = "AbCdEf0123456789_-xyzQ";

/** A row shaped exactly as `galleryDetailWith` (src/lib/galleries.ts) returns
 * one — the relational row `toGalleryDetail` maps, not the mapped result. */
function galleryRow(assetCount: number) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Boda Ana y Beto",
    publicSlug: SLUG,
    status: "delivered" as const,
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    // Task #206 — closes the wiring gap #205 left open: the GraphQL `Gallery`
    // type now exposes this as non-null, so a row missing it fails the whole
    // read rather than rendering a silent `0`.
    originalPhotoPriceCopSnapshot: 2_000,
    selectionTrayMode: "flat" as const,
    selectionSubmittedAt: new Date("2026-07-28T12:00:00.000Z"),
    galleryClients: [{ user: { id: "client-a", name: "Ana Pérez", email: "ana@example.com" } }],
    package: { id: 1, name: "Estándar" },
    assets: Array.from({ length: assetCount }, (_unused, index) => ({
      id: `a${index}`,
      originalFilename: `IMG_${index}.JPG`,
      proofKey: `dev/galleries/g1/proofs/a${index}.webp`,
      proofWidth: 1600,
      proofHeight: 1067,
      isSelected: true,
      sortOrder: index,
      finalKey: `dev/galleries/g1/finals/a${index}.jpg`,
      isEdited: true,
    })),
  };
}

/** Spies EVERY `db` entry point this page's read could plausibly reach, so the
 * assertion below is a total query count rather than a count of the one method
 * the current implementation happens to use. */
function spyOnEveryQuery(row: ReturnType<typeof galleryRow>) {
  const realFindFirst = db.query.galleries.findFirst.bind(db.query.galleries);
  const compiled: string[] = [];

  const galleriesFindFirst = vi.spyOn(db.query.galleries, "findFirst").mockImplementation(((
    args: unknown,
  ) => {
    compiled.push(realFindFirst(args as Parameters<typeof realFindFirst>[0]).toSQL().sql);
    return Promise.resolve(row);
  }) as unknown as typeof db.query.galleries.findFirst);

  return {
    compiled,
    galleriesFindFirst,
    galleriesFindMany: vi.spyOn(db.query.galleries, "findMany"),
    assetsFindFirst: vi.spyOn(db.query.assets, "findFirst"),
    assetsFindMany: vi.spyOn(db.query.assets, "findMany"),
    select: vi.spyOn(db, "select"),
  };
}

function paramsFor(publicSlug: string) {
  return { params: Promise.resolve({ publicSlug }) };
}

beforeEach(() => {
  authMock.mockReset();
  authMock.mockResolvedValue({
    user: { id: "client-a", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session);
  isGalleryOwnerMock.mockReset();
  isGalleryOwnerMock.mockResolvedValue(true);
  // Only the refusal test below reaches `forbidden()`, which reads this at
  // call time — stubbed unconditionally anyway, matching every other suite in
  // this route's folder.
  vi.stubEnv("__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS", "true");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("/galleries/[publicSlug] — real query count through the GraphQL read", () => {
  it("renders a THREE-asset gallery with exactly ONE database query in total", async () => {
    const spies = spyOnEveryQuery(galleryRow(3));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();

    // THE PROOF: one query, and it is the gallery-detail read.
    expect(spies.galleriesFindFirst).toHaveBeenCalledTimes(1);
    expect(spies.compiled).toHaveLength(1);
    expect(spies.compiled[0]).toContain('from "galleries"');
    // Nothing else was touched — no per-asset read, no batched second pass, no
    // hand-rolled `db.select`.
    expect(spies.galleriesFindMany).not.toHaveBeenCalled();
    expect(spies.assetsFindFirst).not.toHaveBeenCalled();
    expect(spies.assetsFindMany).not.toHaveBeenCalled();
    expect(spies.select).not.toHaveBeenCalled();
    // And the one query this file mocks away really is called once, so its
    // fixed cost is accounted for rather than hidden.
    expect(isGalleryOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("still issues exactly ONE query for FIVE assets", async () => {
    const spies = spyOnEveryQuery(galleryRow(5));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();

    expect(spies.galleriesFindFirst).toHaveBeenCalledTimes(1);
    expect(spies.assetsFindMany).not.toHaveBeenCalled();
    expect(isGalleryOwnerMock).toHaveBeenCalledTimes(1);
  });

  it("still issues exactly ONE query for FORTY assets — the count does not grow with the gallery", async () => {
    const spies = spyOnEveryQuery(galleryRow(40));

    await expect(ClientGalleryPage(paramsFor(SLUG))).resolves.toBeTruthy();

    expect(spies.galleriesFindFirst).toHaveBeenCalledTimes(1);
    expect(spies.assetsFindMany).not.toHaveBeenCalled();
    expect(isGalleryOwnerMock).toHaveBeenCalledTimes(1);
  });

  // The refusal path costs one EXTRA gallery read, by design and not by
  // accident: `galleryBySlug` collapses every refusal to `null`, so the page
  // re-derives 403-versus-404 from the same helpers (see page.tsx). Pinned
  // here so that cost stays a deliberate two rather than drifting upward
  // unnoticed, and so the happy path above can be read as "one query" without
  // qualification.
  it("costs one extra read — and only one — when the resolver refuses", async () => {
    isGalleryOwnerMock.mockResolvedValue(false);
    const spies = spyOnEveryQuery(galleryRow(3));

    await expect(ClientGalleryPage(paramsFor(SLUG))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;403",
    });

    expect(spies.galleriesFindFirst).toHaveBeenCalledTimes(2);
    expect(spies.assetsFindMany).not.toHaveBeenCalled();
  });
});
