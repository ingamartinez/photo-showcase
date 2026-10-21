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
import {
  DEFAULT_GALLERY_LIST_QUERY,
  DEFAULT_SORT_DIRECTION,
  GALLERY_SORT_KEYS,
  type GalleryListQuery,
} from "./gallery-list-query";

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

describe("getGalleriesWithDetails — real query rendering", () => {
  /** Compiles the REAL query `getGalleriesWithDetails` builds, without
   * executing it. Same technique as the suite above: the spy hands the args
   * to the REAL builder, `.toSQL()` compiles, and the fake returns `[]` so
   * the caller's `await` never waits on a socket. */
  async function renderGalleryList(query: GalleryListQuery) {
    const originalFindMany = db.query.galleries.findMany.bind(db.query.galleries);
    let rendered: { sql: string; params: unknown[] } = { sql: "", params: [] };

    vi.spyOn(db.query.galleries, "findMany").mockImplementation(((args: unknown) => {
      rendered = originalFindMany(args as Parameters<typeof originalFindMany>[0]).toSQL();
      return Promise.resolve([]);
    }) as unknown as typeof db.query.galleries.findMany);

    const { getGalleriesWithDetails } = await import("./galleries");
    await getGalleriesWithDetails(query);
    return rendered;
  }

  /** Only the ORDER BY tail — so an assertion cannot be satisfied by the
   * same expression appearing anywhere else in the query. */
  function orderByOf(sql: string) {
    return sql.slice(sql.lastIndexOf(" order by "));
  }

  const RECENCY_TAIL =
    'coalesce("galleries"."selection_submitted_at", "galleries"."created_at") desc, "galleries"."id" asc';

  it.each([
    ["title", '"galleries"."title"', ['"galleries"."title" collate "es-x-icu" asc']],
    [
      "clients",
      '("gallery_clients"."gallery_id" = "galleries"."id" and "gallery_clients"."removed_at" is null)',
      [
        'from "gallery_clients" inner join "users" on "users"."id" = "gallery_clients"."user_id" where ("gallery_clients"."gallery_id" = "galleries"."id" and "gallery_clients"."removed_at" is null)',
        'min(coalesce("users"."name", "users"."email") collate "es-x-icu")',
        "asc nulls last",
      ],
    ],
    [
      "package",
      '"packages"."id" = "galleries"."package_id"',
      [
        'from "packages" where "packages"."id" = "galleries"."package_id"',
        'collate "es-x-icu"',
        "asc",
      ],
    ],
    ["session", '"galleries"."session_date"', ['"galleries"."session_date" desc']],
    [
      "photos",
      '"assets"."gallery_id" = "galleries"."id"',
      ['(select count(*) from "assets" where "assets"."gallery_id" = "galleries"."id")', ") desc"],
    ],
  ] as const)("renders the %s key inside the ORDER BY", async (sort, present, expected) => {
    const { sql } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort,
      dir: DEFAULT_SORT_DIRECTION[sort],
    });
    const orderBy = orderByOf(sql);

    expect(sql).toContain(present);
    for (const fragment of expected) {
      expect(orderBy).toContain(fragment);
    }
  });

  it("renders Estado as a CASE in workflow order, never alphabetically", async () => {
    const { sql, params } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort: "status",
      dir: "asc",
    });

    expect(orderByOf(sql)).toMatch(/case "galleries"\."status" when \$\d+ then \$\d+/);

    // The paired values are the contract: draft→0 … archived→4. Asserted as a
    // contiguous slice so a reordering of the branches is caught, and so the
    // strings cannot be satisfied by the filter or the select list.
    const start = params.findIndex((value) => value === "draft");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(params.slice(start, start + 10)).toEqual([
      "draft",
      0,
      "proofing",
      1,
      "selected",
      2,
      "delivered",
      3,
      "archived",
      4,
    ]);
  });

  it("reverses a text key's direction (title desc)", async () => {
    const { sql } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort: "title",
      dir: "desc",
    });

    expect(orderByOf(sql)).toContain('"galleries"."title" collate "es-x-icu" desc');
  });

  it("keeps clientless galleries last in the DESC direction too", async () => {
    const { sql } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort: "clients",
      dir: "desc",
    });

    expect(orderByOf(sql)).toContain("desc nulls last");
  });

  it.each(GALLERY_SORT_KEYS)("ends every %s sort with recency then id", async (sort) => {
    const { sql } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort,
      dir: DEFAULT_SORT_DIRECTION[sort],
    });

    expect(orderByOf(sql)).toContain(RECENCY_TAIL);
  });

  // THE #98 GUARD, for every key. A derived sort written as a raw `sql`
  // template would render its non-root columns against the root alias
  // (`"galleries"."gallery_id"`, `"galleries"."removed_at"`, …) — columns
  // that do not exist — and 500 the page in production while every mocked
  // test stays green. That is exactly how #98 shipped. This suite proves the
  // real render, so it is the only place that can catch a "simplification".
  it.each(GALLERY_SORT_KEYS)("never aliases a subquery's columns to %s's root", async (sort) => {
    const { sql } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      sort,
      dir: DEFAULT_SORT_DIRECTION[sort],
    });

    for (const wrongAlias of [
      '"galleries"."gallery_id"',
      '"galleries"."user_id"',
      '"galleries"."removed_at"',
      '"galleries"."name"',
      '"galleries"."email"',
    ]) {
      expect(sql).not.toContain(wrongAlias);
    }
  });

  it("renders the default query as recency desc then id asc, in the ORDER BY", async () => {
    const { sql } = await renderGalleryList(DEFAULT_GALLERY_LIST_QUERY);

    expect(orderByOf(sql)).toMatch(
      new RegExp(
        `^ order by ${RECENCY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} limit \\$\\d+$`,
      ),
    );
  });

  it("renders the status filter as a root-column equality", async () => {
    const { sql, params } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      status: "draft",
    });

    expect(sql).toContain('where "galleries"."status" = ');
    expect(params).toContain("draft");
  });

  it("renders no status filter when the filter is null", async () => {
    const { sql } = await renderGalleryList(DEFAULT_GALLERY_LIST_QUERY);
    expect(sql).not.toContain('"galleries"."status" = ');
  });

  it("renders limit 25 and offset 50 for page 3", async () => {
    const { params } = await renderGalleryList({
      ...DEFAULT_GALLERY_LIST_QUERY,
      page: 3,
    });

    expect(params.slice(-2)).toEqual([25, 50]);
  });

  it("renders one core count query with the filtered half as a FILTER", async () => {
    const { buildGalleryListCountsQuery } = await import("./galleries");

    const filtered = buildGalleryListCountsQuery("draft").toSQL();
    // A single-table CORE select renders its columns UNQUALIFIED — unlike
    // `getPendingSelectionCount`, which joins `assets` and therefore gets
    // `"galleries"."status"`. The plan expected the qualified form; the real
    // render (and this test, which compiles it) says otherwise. The SQL is
    // still unambiguous, and it is a count over one table by construction.
    expect(filtered.sql).toContain('count(*) filter (where "status" = $1)');
    expect(filtered.sql).toContain('from "galleries"');
    expect(filtered.params).toEqual(["draft"]);

    const unfiltered = buildGalleryListCountsQuery(null).toSQL();
    expect(unfiltered.sql).not.toContain("filter (");
  });
});
