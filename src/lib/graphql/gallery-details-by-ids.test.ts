// Task #138 — a REAL query-count proof for `getGalleryDetailsByIds`,
// deliberately following `src/lib/galleries.query-rendering.test.ts`'s own
// technique: spy on the REAL `db.query.galleries.findMany`, let it build a
// REAL (never-awaited) drizzle query off the same args this function passes
// it, and call `.toSQL()` on that query object to compile it WITHOUT ever
// executing it — no live Postgres connection is opened (see that file's own
// header comment for why `.toSQL()` is safe here). The spy then resolves to
// `[]` so this function's own `await` returns immediately.
//
// THIS is the "not by reading code" proof task #138 requires: a fixture of
// >= 3 ids is passed, and the assertion is that `db.query.galleries.findMany`
// was called EXACTLY ONCE regardless of how many ids were requested — the
// property that distinguishes this function from the N+1 pattern it
// replaces. `db.query.galleries.findFirst` (what `getGalleryDetail`, the OLD
// per-gallery call, uses) is asserted to NEVER be called at all, so a
// regression back to "map ids through `getGalleryDetail`" would fail this
// file even if someone forgot to update the call-count assertion below.
import { afterEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` (this module, transitively via its own import)
// only resolves inside a real Next.js bundle — same stub every suite in this
// codebase uses for it (see src/lib/auth-guards.test.ts).
vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGalleryDetailsByIds — real query count", () => {
  it("issues exactly ONE db.query.galleries.findMany call for three ids", async () => {
    const originalFindMany = db.query.galleries.findMany.bind(db.query.galleries);
    let renderedSql = "";
    let renderedParams: unknown[] = [];

    const findManySpy = vi.spyOn(db.query.galleries, "findMany").mockImplementation(((
      args: unknown,
    ) => {
      const compiled = originalFindMany(args as Parameters<typeof originalFindMany>[0]);
      const rendered = compiled.toSQL();
      renderedSql = rendered.sql;
      renderedParams = rendered.params;
      // Never actually executed — see this file's own header comment.
      return Promise.resolve([]);
    }) as unknown as typeof db.query.galleries.findMany);
    const findFirstSpy = vi.spyOn(db.query.galleries, "findFirst");

    const { getGalleryDetailsByIds } = await import("./gallery-details-by-ids");
    await getGalleryDetailsByIds(["gallery-1", "gallery-2", "gallery-3"]);

    // The core proof: ONE query for three ids, not three.
    expect(findManySpy).toHaveBeenCalledTimes(1);
    // The OLD per-gallery path (`getGalleryDetail` -> `findGalleryDetail`)
    // uses `findFirst`, never `findMany` — asserting it was never touched
    // rules out a hybrid regression (e.g. one `findMany` PLUS N `findFirst`
    // calls) that a bare `findManySpy` count alone would miss.
    expect(findFirstSpy).not.toHaveBeenCalled();
    expect(renderedSql).toContain("in (");
    expect(renderedParams).toEqual(expect.arrayContaining(["gallery-1", "gallery-2", "gallery-3"]));
  });

  it("still issues exactly ONE call for five ids — the query count does not grow with the id count", async () => {
    const originalFindMany = db.query.galleries.findMany.bind(db.query.galleries);
    const findManySpy = vi.spyOn(db.query.galleries, "findMany").mockImplementation(((
      args: unknown,
    ) => {
      originalFindMany(args as Parameters<typeof originalFindMany>[0]).toSQL();
      return Promise.resolve([]);
    }) as unknown as typeof db.query.galleries.findMany);

    const { getGalleryDetailsByIds } = await import("./gallery-details-by-ids");
    await getGalleryDetailsByIds(["g1", "g2", "g3", "g4", "g5"]);

    expect(findManySpy).toHaveBeenCalledTimes(1);
  });

  it("never touches the database for an empty id list", async () => {
    const findManySpy = vi.spyOn(db.query.galleries, "findMany");

    const { getGalleryDetailsByIds } = await import("./gallery-details-by-ids");
    const result = await getGalleryDetailsByIds([]);

    expect(result).toEqual([]);
    expect(findManySpy).not.toHaveBeenCalled();
  });
});
