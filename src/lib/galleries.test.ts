import { beforeEach, describe, expect, it, vi } from "vitest";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

// `getGalleriesForClient` (task #98) builds its ownership filter as a REAL
// subquery — `inArray(galleries.id, db.select(...).from(galleryClients)
// .where(...))` — not a bare `sql` template. That subquery has to be a
// genuine, SQL-compilable drizzle query object for `inArray()` to embed it (a
// hand-rolled `{ from: () => ({ where: () => ... }) }` stub is not one), so
// `selectMock` DEFAULTS (in `beforeEach` below) to a REAL, unconnected
// `drizzle-orm/postgres-js` instance's own `.select(...)`, stashed in this
// `vi.hoisted()` holder so the async `vi.mock` factory (which constructs it)
// and `beforeEach` (which reads it) can share it without a TDZ violation.
// `.select()` never executes anything by itself — no network call happens
// until something actually `await`s the built query, which THIS file never
// does, since `findManyMock` intercepts the OUTER query first — so this is
// safe without a live Postgres connection, same reasoning
// galleries.query-rendering.test.ts's own header comment gives for
// `.toSQL()`. Tests that need the OLD "count()/audit" fake shape
// (`getPendingSelectionCount`, `getGalleryUnlockAudit`, `getGalleryCount`)
// still override this per-test via `selectMock.mockReturnValue(...)`, exactly
// as they already did — a later `mockReturnValue` always wins over this
// default `mockImplementation`.
const { findManyMock, findFirstMock, selectMock, realSelectHolder } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  findFirstMock: vi.fn(),
  selectMock: vi.fn(),
  realSelectHolder: { current: undefined as ((...args: unknown[]) => unknown) | undefined },
}));

vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const postgres = (await import("postgres")).default;
  const realDb = drizzle(postgres("postgres://fake:fake@127.0.0.1:1/fake", { max: 1 }));
  realSelectHolder.current = (...args: unknown[]) =>
    (realDb.select as (...a: unknown[]) => unknown)(...args);

  return {
    db: {
      query: {
        galleries: {
          findMany: (...args: unknown[]) => findManyMock(...args),
          findFirst: (...args: unknown[]) => findFirstMock(...args),
        },
      },
      select: (...args: unknown[]) => selectMock(...args),
    },
  };
});

beforeEach(() => {
  findManyMock.mockReset();
  findFirstMock.mockReset();
  selectMock.mockReset();
  selectMock.mockImplementation((...args: unknown[]) => realSelectHolder.current!(...args));
});

describe("getGalleriesWithDetails", () => {
  it("derives photoCount from the joined assets, and never reads the live package price/quota", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        selectionSubmittedAt: null,
        // Task #94: the mocked relational query's row shape — one
        // `galleryClients` row per attached client, each carrying its
        // joined `user` — matching the `with: { galleryClients: { with: {
        // user: ... } } }` shape `getGalleriesWithDetails` now asks for.
        galleryClients: [{ user: { id: "u1", name: "Ana Pérez", email: "ana@example.com" } }],
        // Live package row — priceCop/includedPhotos here are the CURRENT
        // offer, deliberately NOT what this function should report as the
        // gallery's terms.
        package: { id: 2, name: "Estándar", priceCop: 999_999, includedPhotos: 1 },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        assets: [{ id: "a1" }, { id: "a2" }],
      },
    ]);
    const { getGalleriesWithDetails } = await import("./galleries");

    const result = await getGalleriesWithDetails();

    expect(result).toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        selectionSubmittedAt: null,
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
        package: { id: 2, name: "Estándar" },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        photoCount: 2,
      },
    ]);
    // The returned shape never carries the live package's priceCop/
    // includedPhotos at all — only the id/name (for display) and the
    // gallery's own frozen snapshot columns.
    expect(result[0]).not.toHaveProperty("package.priceCop");
    expect(result[0]).not.toHaveProperty("package.includedPhotos");
  });

  // Task #75's core acceptance criterion: recency of SUBMISSION, not
  // creation, must drive placement. This is expressed as a SQL `orderBy`
  // (`COALESCE(selection_submitted_at, created_at) DESC`) rather than a
  // post-fetch JS `.sort()` — see this function's own header comment for why
  // (pagination safety) — so a mocked `findMany` (which doesn't actually run
  // SQL) can only prove the SHAPE of the expression sent to the DB, not
  // observe it reordering rows. That the expression is correct is the one
  // thing worth asserting here; that Postgres honors its own `ORDER BY` is
  // not this codebase's job to re-prove.
  it("asks the DB to order by COALESCE(selectionSubmittedAt, createdAt) descending, not createdAt alone", async () => {
    findManyMock.mockResolvedValue([]);
    const { desc, sql } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getGalleriesWithDetails } = await import("./galleries");

    await getGalleriesWithDetails();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as { orderBy: unknown };
    expect(args.orderBy).toEqual(
      desc(sql`coalesce(${galleries.selectionSubmittedAt}, ${galleries.createdAt})`),
    );
  });

  // Task #97: a removed client must not appear in this list's `clients` —
  // asserted as a QUERY-SHAPE fact (the relational `with` asks for
  // `removedAt IS NULL`), same reasoning/limits as the `orderBy` test above:
  // this mocked `findMany` never actually applies the filter itself, so this
  // only proves the SHAPE sent to the DB, not that Postgres honors it.
  it("asks the DB to filter the joined galleryClients relation to removedAt IS NULL", async () => {
    findManyMock.mockResolvedValue([]);
    const { isNull } = await import("drizzle-orm");
    const { galleryClients } = await import("./db/schema");
    const { getGalleriesWithDetails } = await import("./galleries");

    await getGalleriesWithDetails();

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as {
      with: { galleryClients: { where: unknown } };
    };
    expect(args.with.galleryClients.where).toEqual(isNull(galleryClients.removedAt));
  });
});

describe("getPendingSelectionCount", () => {
  it("counts galleries in 'selected' via a dedicated count() query, not the full detail query", async () => {
    const whereMock = vi.fn().mockResolvedValue([{ value: 2 }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    const { eq } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getPendingSelectionCount } = await import("./galleries");

    const result = await getPendingSelectionCount();

    expect(result).toBe(2);
    expect(fromMock).toHaveBeenCalledWith(galleries);
    // The predicate itself, not just that SOME predicate was passed — this
    // is the one fact the whole "N selecciones esperando" banner depends on;
    // a filter accidentally changed to another status must fail this test.
    expect(whereMock).toHaveBeenCalledWith(eq(galleries.status, "selected"));
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("returns 0 when no row comes back", async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const { getPendingSelectionCount } = await import("./galleries");

    await expect(getPendingSelectionCount()).resolves.toBe(0);
  });
});

// formatPendingSelectionCount's tests moved to src/lib/format.test.ts (task
// #122) — it is no longer exported from this module, see that file's
// section comment.

describe("isGalleryVisibleToClient", () => {
  it.each([
    ["draft", false],
    ["proofing", true],
    ["selected", true],
    ["delivered", true],
    ["archived", false],
  ] as const)("status %s -> visible to client: %s", async (status, expected) => {
    const { isGalleryVisibleToClient } = await import("./galleries");
    expect(isGalleryVisibleToClient(status)).toBe(expected);
  });
});

// Task #97: `draft` is the ONE status allowed to have zero active clients.
// Two ways to get there, both deliberate — `removeGalleryClient` strips the
// last active client off a `draft` gallery (#97), and `createGallery` accepts
// an empty client list outright (#100). Every other status needs at least one
// client attached.
describe("requiresActiveClient", () => {
  it.each([
    ["draft", false],
    ["proofing", true],
    ["selected", true],
    ["delivered", true],
    ["archived", true],
  ] as const)("status %s -> requires an active client: %s", async (status, expected) => {
    const { requiresActiveClient } = await import("./galleries");
    expect(requiresActiveClient(status)).toBe(expected);
  });
});

// Task #100: the whole rule, in the one place it exists. `publishGallery`,
// `deliverGallery`, `removeGalleryClient` and the gallery detail page's two
// UX mirrors all route through THIS function — nobody rebuilds the
// conjunction. These cases are the contract every one of them inherits.
describe("activeClientRuleViolation", () => {
  it("permits a clientless DRAFT — the one status the rule exempts", async () => {
    const { activeClientRuleViolation } = await import("./galleries");

    expect(
      activeClientRuleViolation({
        targetStatus: "draft",
        activeClientCount: 0,
        action: "remove-client",
      }),
    ).toBeNull();
  });

  it.each(["proofing", "selected", "delivered", "archived"] as const)(
    "refuses zero active clients when the target status is %s",
    async (targetStatus) => {
      const { activeClientRuleViolation } = await import("./galleries");

      const violation = activeClientRuleViolation({
        targetStatus,
        activeClientCount: 0,
        action: "publish",
      });

      expect(violation).toBeTruthy();
    },
  );

  it.each(["draft", "proofing", "selected", "delivered", "archived"] as const)(
    "permits status %s as soon as ONE active client remains",
    async (targetStatus) => {
      const { activeClientRuleViolation } = await import("./galleries");

      expect(
        activeClientRuleViolation({ targetStatus, activeClientCount: 1, action: "deliver" }),
      ).toBeNull();
    },
  );

  // The rule is one; only the sentence differs. Each action's message has to
  // say what to DO about it (the owner's own requirement), so a shared
  // generic string would be a regression, not a simplification.
  it("returns a DIFFERENT, action-specific Spanish message for each of the three operations", async () => {
    const { activeClientRuleViolation } = await import("./galleries");

    const messages = (["publish", "deliver", "remove-client"] as const).map((action) =>
      activeClientRuleViolation({ targetStatus: "proofing", activeClientCount: 0, action }),
    );

    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toMatch(/publicarla/);
    expect(messages[1]).toMatch(/entregarla/);
    expect(messages[2]).toMatch(/quitar/);
    // Spanish, and actionable — every one names the fix, not just the fault.
    for (const message of messages) expect(message).toMatch(/agrega|agregá/i);
  });

  // The publish path is the reason this takes a TARGET status rather than the
  // gallery's current one: a publishable gallery is always `draft`, which the
  // rule exempts. Asked about the current status it would permit exactly what
  // it exists to refuse.
  it("answers about the DESTINATION status, not a draft origin", async () => {
    const { activeClientRuleViolation } = await import("./galleries");

    expect(
      activeClientRuleViolation({
        targetStatus: "proofing",
        activeClientCount: 0,
        action: "publish",
      }),
    ).toBeTruthy();
    expect(
      activeClientRuleViolation({ targetStatus: "draft", activeClientCount: 0, action: "publish" }),
    ).toBeNull();
  });
});

describe("formatGalleryStatus", () => {
  it.each([
    ["draft", "Borrador"],
    ["proofing", "En pruebas"],
    ["selected", "Selección enviada"],
    ["delivered", "Entregada"],
    ["archived", "Archivada"],
  ] as const)("formats %s as %s", async (status, expected) => {
    const { formatGalleryStatus } = await import("./galleries");
    expect(formatGalleryStatus(status)).toBe(expected);
  });
});

describe("formatSessionDate", () => {
  it("formats a stored YYYY-MM-DD string as DD/MM/YYYY without going through Date/timezone conversion", async () => {
    const { formatSessionDate } = await import("./galleries");
    expect(formatSessionDate("2026-08-01")).toBe("01/08/2026");
  });
});

describe("getGalleriesForClient", () => {
  // Task #94/#98: `galleries.clientId` is gone — ownership is expressed as a
  // REAL subquery against `gallery_clients` (`inArray(galleries.id,
  // db.select(...).from(galleryClients).where(...))`, task #98's fix for the
  // production 500 a raw `sql` template caused — see this function's own
  // header comment in galleries.ts for the full story), combined with the
  // client-visible-statuses filter in the SAME outer `where`.
  //
  // Deliberately NOT asserted here via a `.toEqual()` against a second,
  // independently-built expression — task #98's own bug is exactly what that
  // style of test failed to catch twice (see galleries.ts's header comment):
  // a hand-built comparison object can match structurally while the REAL
  // query still renders with the wrong table alias. The tests below instead
  // render `args.where` — the ACTUAL value production code passed to
  // `findMany` — through a real `PgDialect`, and (in
  // galleries.query-rendering.test.ts) through the real relational query
  // builder itself, which is the only place the aliasing bug actually
  // manifested.
  it("derives photoCount from the joined assets and never returns another client's row", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        assets: [{ id: "a1" }, { id: "a2" }],
      },
    ]);
    const { getGalleriesForClient } = await import("./galleries");

    const result = await getGalleriesForClient("user-1");

    expect(result).toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        photoCount: 2,
      },
    ]);
  });

  it("returns an empty list when the client has no galleries at all", async () => {
    findManyMock.mockResolvedValue([]);
    const { getGalleriesForClient } = await import("./galleries");

    await expect(getGalleriesForClient("user-1")).resolves.toEqual([]);
  });

  // The tests above only check the SHAPE of what this function returns —
  // they feed `findMany` a canned array and assert the mapping. None of them
  // asks whether the `where` actually selects anything (this file mocks
  // `@/lib/db` at the top, so no real RELATIONAL query builder — `db.query.*`
  // — is ever involved; `db.select` DOES default to a real one, see this
  // file's own header comment on `selectMock`, and the REAL end-to-end
  // rendering is covered in galleries.query-rendering.test.ts, which mocks
  // nothing). This test
  // complements both with REAL row-level
  // filtering: `findMany`'s fake implementation below renders the `where` it
  // was actually called with through drizzle's own `PgDialect` (the exact
  // technique used to verify the template test), reads out the bound
  // parameters (`clientId`, then the allowed statuses), and filters a
  // seeded `gallery_clients` fixture with them — no canned per-call result,
  // no admin bypass hardcoded into the test itself.
  it("filters seeded rows for real: a client sees only their own galleries, and an admin who owns none gets []", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();

    const galleryRows = [
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        assets: [],
      },
      {
        id: "g2",
        title: "Bautizo de Juan",
        publicSlug: "def456",
        status: "selected",
        sessionDate: "2026-07-15",
        assets: [],
      },
    ];
    const galleryClientRows = [
      { galleryId: "g1", userId: "client-a", removedAt: null as Date | null },
      { galleryId: "g2", userId: "client-b", removedAt: null as Date | null },
    ];

    findManyMock.mockImplementation(async ({ where }: { where: unknown }) => {
      const { sql: renderedSql, params } = dialect.sqlToQuery(
        where as Parameters<typeof dialect.sqlToQuery>[0],
      );
      // Task #97: proves the guard is actually PRESENT in the rendered SQL.
      // `isNull()` binds NO parameter, so the rendered SQL text is its ONLY
      // observable trace at this level — the `params`-driven filtering below
      // is byte-identical with or without the guard, which is exactly why
      // this string assertion, and not the row filtering, is what fails if
      // the guard is dropped. (The `where` is rendered here through a real
      // `PgDialect`, but still outside the relational query builder; the
      // aliasing bug that only manifests INSIDE `db.query.*` is covered in
      // galleries.query-rendering.test.ts, which mocks nothing.)
      expect(renderedSql).toContain("is null");
      const [clientId, ...allowedStatuses] = params as string[];
      const ownedGalleryIds = galleryClientRows
        .filter((row) => row.userId === clientId && row.removedAt === null)
        .map((row) => row.galleryId);
      return galleryRows.filter(
        (row) => ownedGalleryIds.includes(row.id) && allowedStatuses.includes(row.status),
      );
    });
    const { getGalleriesForClient } = await import("./galleries");

    const clientAResult = await getGalleriesForClient("client-a");
    expect(clientAResult).toHaveLength(1);
    expect(clientAResult[0]?.id).toBe("g1");

    const clientBResult = await getGalleriesForClient("client-b");
    expect(clientBResult).toHaveLength(1);
    expect(clientBResult[0]?.id).toBe("g2");

    // An admin's own user id was never inserted into `gallery_clients` for
    // ANY gallery seeded above — this function carries no admin bypass
    // (unlike src/lib/gallery-access.ts's isGalleryOwner, which does), so an
    // admin who owns nothing genuinely gets [], not every gallery.
    await expect(getGalleriesForClient("admin-1")).resolves.toEqual([]);
  });

  // THE mutation-relevant case: a client REMOVED from their only gallery
  // must lose it from this list, even though their `gallery_clients` row
  // still exists (soft delete, schema.ts).
  //
  // READ THIS BEFORE TOUCHING THE ASSERTIONS BELOW. The empty-result
  // expectation at the end of this test CANNOT, on its own, observe
  // `isNull(galleryClients.removedAt)` being dropped from the function's
  // subquery: the fake `findMany` does the row filtering itself, in JS, and
  // `isNull()` binds no parameter — so `params` is byte-identical with and
  // without the guard, and the fake would keep returning [] either way. A
  // reviewer proved exactly that by deleting the guard and watching this
  // test stay green. The assertion that actually fails under that mutation
  // is the rendered-SQL one inside the fake, the same technique the sibling
  // test above uses.
  it("hides a gallery from a client whose membership was REMOVED (removedAt set)", async () => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const dialect = new PgDialect();

    const galleryRows = [
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "proofing",
        sessionDate: "2026-08-01",
        assets: [],
      },
    ];
    const galleryClientRows = [
      { galleryId: "g1", userId: "client-a", removedAt: new Date("2026-07-29T12:00:00.000Z") },
    ];

    findManyMock.mockImplementation(async ({ where }: { where: unknown }) => {
      const { sql: renderedSql, params } = dialect.sqlToQuery(
        where as Parameters<typeof dialect.sqlToQuery>[0],
      );
      // The ONLY assertion in this test that a dropped
      // `isNull(galleryClients.removedAt)` can fail — see the comment above
      // this `it` for why the empty-result expectation below cannot.
      expect(renderedSql).toContain('"gallery_clients"."removed_at" is null');
      const [clientId, ...allowedStatuses] = params as string[];
      const ownedGalleryIds = galleryClientRows
        .filter((row) => row.userId === clientId && row.removedAt === null)
        .map((row) => row.galleryId);
      return galleryRows.filter(
        (row) => ownedGalleryIds.includes(row.id) && allowedStatuses.includes(row.status),
      );
    });
    const { getGalleriesForClient } = await import("./galleries");

    await expect(getGalleriesForClient("client-a")).resolves.toEqual([]);
  });
});

describe("getGalleryDetail", () => {
  const galleryRow = {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "draft" as const,
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    // Task #94: see getGalleriesWithDetails's own fixture comment above for
    // why this is `galleryClients: [{ user: {...} }]`, not a bare `client`.
    galleryClients: [{ user: { id: "u1", name: "Ana Pérez", email: "ana@example.com" } }],
    // Live package row — priceCop/includedPhotos here are the CURRENT
    // offer, deliberately NOT what this function should report as the
    // gallery's terms (same trap getGalleriesWithDetails already guards).
    package: { id: 2, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [
      {
        id: "a2",
        originalFilename: "IMG_0002.JPG",
        proofKey: "galleries/g1/proofs/a2.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: false,
        sortOrder: 1,
        finalKey: null,
        isEdited: false,
      },
      {
        id: "a1",
        originalFilename: "IMG_0001.JPG",
        proofKey: "galleries/g1/proofs/a1.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: true,
        sortOrder: 0,
        finalKey: `galleries/g1/finals/a1.jpg`,
        isEdited: true,
      },
    ],
  };

  it("returns null when no gallery with this id exists, instead of throwing", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const { getGalleryDetail } = await import("./galleries");

    await expect(getGalleryDetail("missing")).resolves.toBeNull();
  });

  it("maps the gallery's frozen terms and its assets, and asks the query to order by sort_order", async () => {
    findFirstMock.mockResolvedValue(galleryRow);
    const { getGalleryDetail } = await import("./galleries");

    const result = await getGalleryDetail("g1");

    expect(result).toEqual({
      id: "g1",
      title: "Boda Ana y Beto",
      publicSlug: "abc123",
      status: "draft",
      sessionDate: "2026-08-01",
      createdAt: new Date("2026-07-01"),
      clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
      package: { id: 2, name: "Estándar" },
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
      assets: galleryRow.assets,
    });

    // The query itself asks the relational API to order assets by
    // sort_order — this is a query-shape assertion, not a re-sort of the
    // fake's already-out-of-order fixture above (the fake doesn't honor
    // `orderBy`, only a real Postgres does).
    expect(findFirstMock).toHaveBeenCalledTimes(1);
    const args = findFirstMock.mock.calls[0]?.[0] as {
      with: { assets: { orderBy: unknown } };
    };
    expect(args.with.assets.orderBy).toBeDefined();
  });

  // Task #97: same query-shape assertion as getGalleriesWithDetails's own —
  // this powers BOTH `getGalleryDetail` (admin) and `getGalleryDetailBySlug`
  // (client-facing), since both share `findGalleryDetail`'s query.
  it("asks the DB to filter the joined galleryClients relation to removedAt IS NULL", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const { isNull } = await import("drizzle-orm");
    const { galleryClients } = await import("./db/schema");
    const { getGalleryDetail } = await import("./galleries");

    await getGalleryDetail("g1");

    expect(findFirstMock).toHaveBeenCalledTimes(1);
    const args = findFirstMock.mock.calls[0]?.[0] as {
      with: { galleryClients: { where: unknown } };
    };
    expect(args.with.galleryClients.where).toEqual(isNull(galleryClients.removedAt));
  });
});

describe("getGalleryDetailsByIds", () => {
  // Same fixture shape `getGalleryDetail`'s own describe block above uses —
  // both go through the same `toGalleryDetail` mapper (task #154), so a
  // fixture that exercises one exercises the other.
  const galleryRow = {
    id: "g1",
    title: "Boda Ana y Beto",
    publicSlug: "abc123",
    status: "draft" as const,
    sessionDate: "2026-08-01",
    createdAt: new Date("2026-07-01"),
    galleryClients: [{ user: { id: "u1", name: "Ana Pérez", email: "ana@example.com" } }],
    package: { id: 2, name: "Estándar" },
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 5_000,
    assets: [
      {
        id: "a1",
        originalFilename: "IMG_0001.JPG",
        proofKey: "galleries/g1/proofs/a1.webp",
        proofWidth: 1600,
        proofHeight: 1067,
        isSelected: true,
        sortOrder: 0,
        finalKey: `galleries/g1/finals/a1.jpg`,
        isEdited: true,
      },
    ],
  };

  it("returns [] without touching the database for an empty id list", async () => {
    const { getGalleryDetailsByIds } = await import("./galleries");

    await expect(getGalleryDetailsByIds([])).resolves.toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("maps every row for the given ids in ONE query, using the same shape getGalleryDetail uses", async () => {
    findManyMock.mockResolvedValue([galleryRow]);
    const { getGalleryDetailsByIds } = await import("./galleries");

    const result = await getGalleryDetailsByIds(["g1"]);

    expect(result).toEqual([
      {
        id: "g1",
        title: "Boda Ana y Beto",
        publicSlug: "abc123",
        status: "draft",
        sessionDate: "2026-08-01",
        createdAt: new Date("2026-07-01"),
        clients: [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }],
        package: { id: 2, name: "Estándar" },
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5_000,
        assets: galleryRow.assets,
      },
    ]);
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("asks the DB to filter the joined galleryClients relation to removedAt IS NULL", async () => {
    findManyMock.mockResolvedValue([]);
    const { isNull } = await import("drizzle-orm");
    const { galleryClients } = await import("./db/schema");
    const { getGalleryDetailsByIds } = await import("./galleries");

    await getGalleryDetailsByIds(["g1"]);

    expect(findManyMock).toHaveBeenCalledTimes(1);
    const args = findManyMock.mock.calls[0]?.[0] as {
      with: { galleryClients: { where: unknown } };
    };
    expect(args.with.galleryClients.where).toEqual(isNull(galleryClients.removedAt));
  });
});

// Task #154 — the actual proof for "a change to the projection shape cannot
// leave one caller stale", not just a comment asserting it. See
// galleries.ts's own comment above `galleryDetailWith` for the history.
describe("the gallery-detail projection is ONE definition, not two (task #154)", () => {
  it("getGalleryDetail and getGalleryDetailsByIds pass the IDENTICAL `with` config object to Drizzle", async () => {
    findFirstMock.mockResolvedValue(undefined);
    findManyMock.mockResolvedValue([]);
    const { getGalleryDetail, getGalleryDetailsByIds } = await import("./galleries");

    await getGalleryDetail("g1");
    await getGalleryDetailsByIds(["g1", "g2"]);

    expect(findFirstMock).toHaveBeenCalledTimes(1);
    expect(findManyMock).toHaveBeenCalledTimes(1);
    const singleWith = (findFirstMock.mock.calls[0]?.[0] as { with: unknown }).with;
    const batchedWith = (findManyMock.mock.calls[0]?.[0] as { with: unknown }).with;

    // Reference equality (`toBe`, not `toEqual`): two independently-authored
    // objects can look identical today and still drift the moment either one
    // is edited without the other — that is exactly the shape task #154
    // exists to close. Only literally the SAME object, passed to both
    // queries, makes that drift structurally impossible rather than merely
    // unlikely. If `getGalleryDetailsByIds` (or `findGalleryDetail`) ever goes
    // back to building its own `with` object, this assertion is the one that
    // catches it — a deep-equal check would stay green right up until the
    // moment someone actually edited one copy and not the other.
    expect(singleWith).toBe(batchedWith);
  });
});

describe("getGalleryUnlockAudit", () => {
  it("returns null when no gallery with this id exists", async () => {
    const whereMock = vi.fn().mockReturnValue({ limit: async () => [] });
    selectMock.mockReturnValue({ from: () => ({ where: whereMock }) });
    const { getGalleryUnlockAudit } = await import("./galleries");

    await expect(getGalleryUnlockAudit("missing")).resolves.toBeNull();
  });

  // The honest "never unlocked" state — every column is nullable and `null`
  // across the board is exactly what a gallery that has never been unlocked
  // looks like, not an absent/optional shape (same stance as
  // `GalleryDetail.selectionSubmittedAt`).
  it("reports all-null when the gallery has never been unlocked", async () => {
    const whereMock = vi.fn().mockReturnValue({
      limit: async () => [{ unlockedAt: null, unlockedByEmail: null, unlockReason: null }],
    });
    selectMock.mockReturnValue({ from: () => ({ where: whereMock }) });
    const { getGalleryUnlockAudit } = await import("./galleries");

    await expect(getGalleryUnlockAudit("g1")).resolves.toEqual({
      unlockedAt: null,
      unlockedByEmail: null,
      unlockReason: null,
    });
  });

  it("maps who unlocked it, when, and the optional reason", async () => {
    const unlockedAt = new Date("2026-07-28T20:00:00.000Z");
    const whereMock = vi.fn().mockReturnValue({
      limit: async () => [
        {
          unlockedAt,
          unlockedByEmail: "photographer@example.com",
          unlockReason: "El cliente pidió agregar dos fotos más.",
        },
      ],
    });
    selectMock.mockReturnValue({ from: () => ({ where: whereMock }) });
    const { getGalleryUnlockAudit } = await import("./galleries");

    await expect(getGalleryUnlockAudit("g1")).resolves.toEqual({
      unlockedAt,
      unlockedByEmail: "photographer@example.com",
      unlockReason: "El cliente pidió agregar dos fotos más.",
    });
  });
});

describe("getGalleryCount", () => {
  it("counts galleries via a dedicated count() query, not the full detail query", async () => {
    const whereMock = vi.fn().mockResolvedValue([{ value: 2 }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    const { galleries } = await import("./db/schema");
    const { getGalleryCount } = await import("./galleries");

    const result = await getGalleryCount();

    expect(result).toBe(2);
    expect(fromMock).toHaveBeenCalledWith(galleries);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // Task #90: the dashboard sentence this powers says "en marcha" — a
  // gallery this query counted while its status was `archived` would make
  // the number and the words lie the moment archival ships (#42). Asserting
  // the actual predicate passed to `.where()`, not just that some predicate
  // was passed, is what would have caught the original bug: a mock that
  // simply returns `[{ value: 2 }]` regardless of the filter would stay
  // green even if the `ne(...)` below were deleted entirely.
  it("excludes archived galleries from the count", async () => {
    const whereMock = vi.fn().mockResolvedValue([{ value: 2 }]);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    selectMock.mockReturnValue({ from: fromMock });
    const { ne } = await import("drizzle-orm");
    const { galleries } = await import("./db/schema");
    const { getGalleryCount } = await import("./galleries");

    await getGalleryCount();

    expect(whereMock).toHaveBeenCalledWith(ne(galleries.status, "archived"));
  });

  it("returns 0 when no row comes back", async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve([]) }) });
    const { getGalleryCount } = await import("./galleries");

    await expect(getGalleryCount()).resolves.toBe(0);
  });
});

// Task #121: nothing pinned `GALLERY_COUNT_EXCLUDED_STATUS` against the
// `gallery_status` enum, so a sixth status added to the enum would be
// silently counted as "en marcha" with zero test failures — the same shape
// of defect #90 itself was filed for, a count and the words describing it
// quietly drifting apart. Mirrors the pattern src/lib/asset-access.test.ts
// established for `ASSET_MUTATION_BLOCKED_STATUSES` (task #58): rather than
// asserting the exclusion equals a hand-copied literal list (a second copy
// that would drift in lockstep with the real one), this filters the LIVE
// `galleryStatus.enumValues` down to the statuses the count INCLUDES —
// everything except the real, exported `GALLERY_COUNT_EXCLUDED_STATUS` — and
// asserts that remainder is exactly what is expected today. A status added
// to the enum without an explicit decision here changes the filtered
// remainder and fails this assertion instead of shipping silently.
describe("getGalleryCount's 'en marcha' exclusion — pinned against the gallery_status enum", () => {
  it("counts every enum member except GALLERY_COUNT_EXCLUDED_STATUS", async () => {
    const { galleryStatus } = await import("./db/schema");
    const { GALLERY_COUNT_EXCLUDED_STATUS } = await import("./galleries");

    const included = galleryStatus.enumValues.filter(
      (status) => status !== GALLERY_COUNT_EXCLUDED_STATUS,
    );

    // Today's deliberate decision (task #90): every status except `archived`
    // counts as "en marcha". A sixth status lands in `included` too (since
    // it won't equal GALLERY_COUNT_EXCLUDED_STATUS) and fails this exact
    // assertion until a human decides which side it belongs on.
    expect([...included].sort()).toEqual(["delivered", "draft", "proofing", "selected"]);
  });
});

// formatGalleryCountTotal's tests moved to src/lib/format.test.ts
// (task #49/#90) — it is no longer exported from this module, see that
// file's `formatStudioGalleryCount`.
