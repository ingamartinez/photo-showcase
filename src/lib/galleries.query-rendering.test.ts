import { describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

// Task #98 (production incident): `galleries.test.ts` covers
// `getGalleriesForClient` twice, and NEITHER test could have caught the bug
// that shipped — one deep-equals the `where` expression's own structure
// (never rendered), the other renders it in isolation via
// `new PgDialect().sqlToQuery(where)`, OUTSIDE the relational query it
// actually lives in. Rendered standalone, the old raw `sql` subquery was
// syntactically fine; the aliasing bug only appeared once
// `db.query.galleries.findMany` wrapped it and aliased the root table as
// `"galleries"`.
//
// This file does NOT mock `@/lib/db` — it imports the real `db`, the real
// schema, and asks the REAL relational query builder to compile the REAL
// query `getGalleriesForClient` sends, then inspects the actual SQL text.
// `PgRelationalQuery#toSQL()` (drizzle-orm/pg-core) is pure compilation —
// it never opens a session or touches the network (see
// `node_modules/drizzle-orm/pg-core/query-builders/query.js`, `_toSQL()` /
// `_getQuery()`), so this is safe to run without a live Postgres.
//
// `db.query.galleries.findMany` is spied on (not mocked away) so it still
// runs the real relational query builder — the spy only swaps `.execute()`
// for `.toSQL()` so the test never actually opens a DB connection, and
// resolves the `await` in `getGalleriesForClient` with an empty result.
describe("getGalleriesForClient — real relational query rendering", () => {
  it("qualifies the ownership subquery against gallery_clients, not against the outer galleries alias", async () => {
    const { db } = await import("@/lib/db");
    const { getGalleriesForClient } = await import("./galleries");

    const originalFindMany = db.query.galleries.findMany.bind(db.query.galleries);
    let renderedSql = "";
    const findManySpy = vi
      .spyOn(db.query.galleries, "findMany")
      .mockImplementation((config: Parameters<typeof originalFindMany>[0]) => {
        renderedSql = originalFindMany(config).toSQL().sql;
        return Promise.resolve([]) as unknown as ReturnType<typeof originalFindMany>;
      });

    await getGalleriesForClient("user-1");

    expect(findManySpy).toHaveBeenCalledTimes(1);
    // The subquery itself, qualified against ITS OWN table
    // (`gallery_clients`), independent of whatever alias the outer
    // relational query uses for its root table.
    expect(renderedSql).toContain('from "gallery_clients" where "gallery_clients"."user_id" = $1');
    // The exact failure mode from production: before the fix, the subquery's
    // columns inherited the outer relational query's root-table alias
    // instead of their own — `"galleries"."gallery_id"` and
    // `"galleries"."user_id"`, neither of which exists on `galleries`.
    expect(renderedSql).not.toContain('"galleries"."gallery_id"');
    expect(renderedSql).not.toContain('"galleries"."user_id"');

    findManySpy.mockRestore();
  });
});
