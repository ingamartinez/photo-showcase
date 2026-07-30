// Task #97 — a REAL query-rendering test for `getGalleriesForClient`'s
// ownership filter, deliberately kept OUT of galleries.test.ts (which mocks
// `@/lib/db` wholesale at the top of that file — every test in it only ever
// sees a hand-written fake, never the real relational query builder).
//
// This file SUPERSEDES the one task #98 shipped at this same path (both
// lanes wrote it independently, in parallel). Nothing from #98's version was
// dropped — checked assertion by assertion, after a review found one that
// HAD been: its `findMany` call count and its `"galleries"."gallery_id"`
// symptom are both merged in below, plus the `removed_at` filter #98
// predates.
//
// One MORE assertion is merged in here that never lived in #98's version of
// this file at all: `expect(selectMock).toHaveBeenCalledWith({ id:
// galleryClients.galleryId })`, the structural check on WHICH column the
// ownership subquery selects. It lived in galleries.test.ts (line 215 at
// this branch's base commit, 567fa2c), and task #97 deleted it from there
// when it rewrote that file's `selectMock` default. It is re-expressed below
// as a substring of the really-rendered SQL rather than a call-args
// assertion on a mock. Look in galleries.test.ts's history, not this file's,
// if you are auditing where it came from.
//
// THE BUG this style of test exists to catch, found in production by task
// #98: `getGalleriesForClient` used to
// express its ownership check as a raw `sql` template subquery. Inside
// `db.query.*` (the relational query builder), a raw `sql` template
// silently inherits the ROOT table's own alias for EVERY column reference in
// it, whatever table those columns actually belong to — so
// `galleryClients.galleryId`/`galleryClients.userId` rendered as
// `"galleries"."gallery_id"`/`"galleries"."user_id"` instead of
// `"gallery_clients"."..."`, columns that don't exist on `galleries` at all.
// This 500'd every client's `/galleries` page in production. TWO existing
// tests covered this function before that bug shipped, and NEITHER caught
// it: one deep-equalled the `where` object against an independently-built
// expression (a change detector, not a real render), the other rendered the
// `sql` template in ISOLATION via `PgDialect().sqlToQuery()` — outside the
// `db.query.*` context where the aliasing bug only actually manifests. See
// galleries.test.ts's own comments on those two tests for the same caveat,
// now stated explicitly rather than assumed.
//
// The technique here: spy on `db.query.galleries.findMany` (the REAL one,
// off the REAL `db` — nothing in this file is mocked), let it build a REAL,
// un-awaited drizzle query object off the SAME args `getGalleriesForClient`
// passes it, and call `.toSQL()` on that object. `.toSQL()` COMPILES the
// query without ever executing it — no live Postgres connection is opened,
// the same way `postgres()` (src/lib/db/index.ts) never connects merely by
// being constructed (it connects lazily, on first actual query). The spy
// then returns a resolved `[]` instead of the real (never-awaited, so
// never-executed) promise, so the caller's own `await` resolves immediately
// instead of hanging on a socket that was never opened.
import { afterEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` (galleries.ts, transitively via its own import)
// only resolves inside a real Next.js bundle — see src/lib/auth-guards.test.ts
// for the same stub, needed here since this file imports the real
// `./galleries` module (dynamically, below) rather than mocking it away.
vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getGalleriesForClient — real query rendering", () => {
  it("renders the gallery_clients subquery with removedAt IS NULL, on the CORRECT table alias", async () => {
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
      // Never actually executed — see this file's own header comment for
      // why this never opens a connection either way.
      return Promise.resolve([]);
    }) as unknown as typeof db.query.galleries.findMany);

    const { getGalleriesForClient } = await import("./galleries");
    await getGalleriesForClient("user-1");

    // THE bug this test exists to catch: the subquery's own `where` columns
    // must reference `gallery_clients`, never `galleries` (the root table
    // this whole outer query is aliased to). A regression back to the raw
    // `sql` template would render `"galleries"."user_id"`/
    // `"galleries"."removed_at"` here instead (columns that don't even
    // exist on `galleries`).
    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(renderedSql).toContain('from "gallery_clients" where');
    expect(renderedSql).toContain('"gallery_clients"."user_id"');
    expect(renderedSql).toContain('"gallery_clients"."removed_at" is null');
    expect(renderedSql).not.toContain('"galleries"."user_id"');
    expect(renderedSql).not.toContain('"galleries"."removed_at"');
    // The subquery's SELECTED column, from #98's own version of this file:
    // the production failure rendered it as `"galleries"."gallery_id"` too,
    // and that is a distinct symptom from the `where` columns above — the
    // raw template aliased EVERY reference it contained, not just the
    // predicate's. Asserted separately so a partial regression can't hide.
    expect(renderedSql).not.toContain('"galleries"."gallery_id"');

    // WHICH column the subquery SELECTS, not just which table it reads and
    // which columns it filters on. `expect(selectMock).toHaveBeenCalledWith({
    // id: galleryClients.galleryId })` used to pin this from
    // galleries.test.ts (see this file's header comment for the provenance);
    // task #97 removed it from there, and nothing else here replaces it —
    // every other assertion in this test still passes if the subquery is
    // changed to `db.select({ id: galleryClients.userId })`. That mutation is
    // not hypothetical-only: `inArray(galleries.id, <a list of USER ids>)`
    // then matches nothing at all, every client's `/galleries` silently
    // renders empty, and no error is raised anywhere. Asserted as the whole
    // subquery string so the selected column, the source table and both
    // predicates are pinned together.
    //
    // KNOWN COUPLING, accepted: this literal hard-codes `$1`. The subquery
    // renders `user_id = $1` only because the ownership `inArray` is the
    // FIRST condition of `getGalleriesForClient`'s outer `and(...)`; the
    // status filter that follows takes `$2, $3, $4`. Reorder that outer
    // `and(...)` — a change with no behavioral effect whatsoever — and this
    // assertion fails with a message about a missing subquery string, which
    // points at the wrong thing entirely. If you land here after such a
    // reorder, renumber the placeholder; nothing is actually broken.
    expect(renderedSql).toContain(
      'select "gallery_id" from "gallery_clients" where ("gallery_clients"."user_id" = $1 and "gallery_clients"."removed_at" is null)',
    );
    expect(renderedParams).toContain("user-1");
  });
});
