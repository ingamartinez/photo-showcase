import { and, eq, gt, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { assetPicks, galleries, galleryClients } from "@/lib/db/schema";
import { createFakeDb, type FakeDb } from "@/test-support/fake-db";

// The fake is shared infrastructure: a condition it cannot interpret must
// THROW, because silently treating `ne` as `eq`, dropping a leaf inside
// `and`, or reading `or` as `and` makes a suite green for the wrong reason.

type InsertStatement = {
  onConflictDoNothing: (config?: unknown) => InsertStatement;
  onConflictDoUpdate: () => never;
  returning: (columns?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  then: (
    onF?: (rows: Record<string, unknown>[]) => unknown,
    onR?: (error: unknown) => unknown,
  ) => Promise<unknown>;
};
type DeleteStatement = {
  where: (condition: unknown) => Promise<Record<string, unknown>[]> & {
    returning: (columns?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  };
  then: (
    onF?: (rows: Record<string, unknown>[]) => unknown,
    onR?: (error: unknown) => unknown,
  ) => Promise<unknown>;
};

type Fake = Omit<FakeDb, "select" | "update" | "insert" | "delete"> & {
  select: (columns?: Record<string, unknown>) => {
    from: (t: unknown) => { where: (c: unknown) => Promise<Record<string, unknown>[]> };
  };
  update: (t: unknown) => {
    set: (p: Record<string, unknown>) => { where: (c: unknown) => Promise<unknown> };
  };
  insert: (t: unknown) => { values: (rows: unknown) => InsertStatement };
  delete: (t: unknown) => DeleteStatement;
};

let db: Fake;

function rows() {
  return db.__tables.get(galleryClients)!;
}

beforeEach(() => {
  db = createFakeDb([galleryClients]) as Fake;
  rows().push(
    { galleryId: "g1", userId: "a", removedAt: null, selectionLockedAt: new Date() },
    { galleryId: "g1", userId: "b", removedAt: new Date(), selectionLockedAt: null },
    { galleryId: "g2", userId: "a", removedAt: null, selectionLockedAt: null },
  );
});

const read = (condition: unknown) => db.select().from(galleryClients).where(condition);
const ids = (found: Record<string, unknown>[]) =>
  found.map((r) => `${r.galleryId as string}/${r.userId as string}`);

describe("fake db — supported conditions filter for real", () => {
  it("eq", async () => {
    expect(ids(await read(eq(galleryClients.userId, "a")))).toEqual(["g1/a", "g2/a"]);
  });

  it("isNull", async () => {
    expect(ids(await read(isNull(galleryClients.removedAt)))).toEqual(["g1/a", "g2/a"]);
  });

  it("and of eq + isNull, including a nested and()", async () => {
    const condition = and(
      eq(galleryClients.galleryId, "g1"),
      and(eq(galleryClients.userId, "a"), isNull(galleryClients.removedAt)),
    );
    expect(ids(await read(condition))).toEqual(["g1/a"]);
  });

  it("applies the same strict parsing to update().where()", async () => {
    await db
      .update(galleryClients)
      .set({ selectionLockedAt: null })
      .where(and(eq(galleryClients.galleryId, "g1"), eq(galleryClients.userId, "a")));
    expect(rows()[0]!.selectionLockedAt).toBeNull();
    expect(rows()[2]!.selectionLockedAt).toBeNull();
  });
});

describe("fake db — operation log", () => {
  it("logs plain selects, turns a locking select into for:update, and logs writes in order", async () => {
    await read(eq(galleryClients.userId, "a"));
    await (
      db.select().from(galleryClients).where(eq(galleryClients.userId, "a")) as unknown as {
        for: (mode: string) => Promise<unknown>;
      }
    ).for("update");
    await db.update(galleryClients).set({ removedAt: null }).where(eq(galleryClients.userId, "a"));

    expect(db.__log).toEqual(["select", "for:update", "update:2"]);
  });
});

describe("fake db — unsupported conditions THROW instead of being mis-modelled", () => {
  const cases: [string, () => unknown][] = [
    ["ne", () => ne(galleryClients.userId, "a")],
    ["isNotNull", () => isNotNull(galleryClients.removedAt)],
    ["gt", () => gt(galleryClients.createdAt, new Date())],
    ["inArray", () => inArray(galleryClients.userId, ["a", "b"])],
    ["column-to-column eq", () => eq(galleryClients.userId, galleryClients.galleryId)],
    ["or", () => or(eq(galleryClients.userId, "a"), eq(galleryClients.userId, "b"))],
  ];

  it.each(cases)("%s on its own", async (_name, build) => {
    expect(() => read(build())).toThrow(/unsupported condition/);
  });

  it.each(cases)("%s hidden inside and() next to a supported leaf", async (_name, build) => {
    const condition = and(eq(galleryClients.galleryId, "g1"), build() as never);
    expect(() => read(condition)).toThrow(/unsupported condition/);
  });

  it.each(cases)("%s inside update().where()", async (_name, build) => {
    expect(() => db.update(galleryClients).set({ removedAt: null }).where(build())).toThrow(
      /unsupported condition/,
    );
  });

  it.each(cases)("%s inside delete().where()", async (_name, build) => {
    expect(() => db.delete(galleryClients).where(build())).toThrow(/unsupported condition/);
  });

  it("a condition that is not a drizzle expression at all", async () => {
    expect(() => read(undefined)).toThrow(/unsupported condition/);
  });
});

describe("fake db — insert and delete", () => {
  const assetRows = () => db.__tables.get(assetPicks)!;
  const time = () => new Date(Date.UTC(2026, 9, 17, 12, 0, 0));
  const pick = (assetId: string, userId: string) => ({
    assetId,
    galleryId: "g1",
    userId,
    pickedAt: time(),
  });

  beforeEach(() => {
    db = createFakeDb([galleryClients, assetPicks, galleries]) as Fake;
  });

  it("F1 applies the kind/submittedAt defaults and is readable through select", async () => {
    await db.insert(assetPicks).values(pick("a1", "u1"));
    const found = await db.select().from(assetPicks).where(eq(assetPicks.userId, "u1"));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("edited");
    expect(found[0]!.submittedAt).toBeNull();
  });

  it("F2 inserts an array and logs insert:2", async () => {
    await db.insert(assetPicks).values([pick("a1", "u1"), pick("a2", "u2")]);
    expect(assetRows()).toHaveLength(2);
    expect(db.__log).toEqual(["insert:2"]);
  });

  it("F3 rejects an omitted not-null pickedAt and leaves the store unchanged", async () => {
    await expect(
      db.insert(assetPicks).values({ assetId: "a1", galleryId: "g1", userId: "u1" }),
    ).rejects.toThrow(/not-null/);
    expect(assetRows()).toHaveLength(0);
  });

  it("F3b rejects an explicit null on a not-null column", async () => {
    await expect(
      db.insert(assetPicks).values({ ...pick("a1", "u1"), userId: null }),
    ).rejects.toThrow(/not-null/);
    expect(assetRows()).toHaveLength(0);
  });

  it("F4 rejects an unknown column", async () => {
    await expect(db.insert(assetPicks).values({ ...pick("a1", "u1"), nope: 1 })).rejects.toThrow(
      /unknown column/,
    );
  });

  it("F5 requires an explicit value for a SQL default", async () => {
    await expect(
      db.insert(galleryClients).values({ galleryId: "g1", userId: "u1" }),
    ).rejects.toThrow(/SQL default/);
    await db.insert(galleryClients).values({ galleryId: "g1", userId: "u1", createdAt: time() });
    expect(db.__tables.get(galleryClients)).toHaveLength(1);
  });

  it("F6 a duplicate without a conflict clause rejects and the batch writes nothing", async () => {
    await db.insert(assetPicks).values(pick("a0", "u0"));
    await expect(
      db.insert(assetPicks).values([pick("a1", "u1"), pick("a0", "u0")]),
    ).rejects.toThrow(/duplicate key/);
    expect(assetRows().map((row) => `${row.assetId}/${row.userId}`)).toEqual(["a0/u0"]);
  });

  it("F7 onConflictDoNothing skips the duplicate; returning yields only the new row", async () => {
    await db.insert(assetPicks).values(pick("a0", "u0"));
    const returned = await db
      .insert(assetPicks)
      .values([pick("a0", "u0"), pick("a1", "u1")])
      .onConflictDoNothing()
      .returning();
    expect(returned.map((row) => row.assetId)).toEqual(["a1"]);
    expect(assetRows()).toHaveLength(2);
    expect(db.__log[db.__log.length - 1]).toBe("insert:1");
  });

  it("F8 accepts the exact PK target in either order and rejects anything else", async () => {
    await db.insert(assetPicks).values(pick("a0", "u0"));
    await expect(
      db
        .insert(assetPicks)
        .values(pick("a0", "u0"))
        .onConflictDoNothing({ target: [assetPicks.assetId, assetPicks.userId] }),
    ).resolves.toEqual([]);
    await expect(
      db
        .insert(assetPicks)
        .values(pick("a0", "u0"))
        .onConflictDoNothing({ target: [assetPicks.userId, assetPicks.assetId] }),
    ).resolves.toEqual([]);
    expect(() =>
      db
        .insert(assetPicks)
        .values(pick("a0", "u0"))
        .onConflictDoNothing({ target: assetPicks.assetId }),
    ).toThrow(/primary-key target/);
    expect(() =>
      db
        .insert(assetPicks)
        .values(pick("a0", "u0"))
        .onConflictDoNothing({ where: eq(assetPicks.userId, "u0") }),
    ).toThrow(/primary-key target/);
  });

  it("F9 an intra-batch duplicate with DoNothing inserts one row", async () => {
    const returned = await db
      .insert(assetPicks)
      .values([pick("a1", "u1"), pick("a1", "u1")])
      .onConflictDoNothing()
      .returning();
    expect(returned).toHaveLength(1);
    expect(assetRows()).toHaveLength(1);
  });

  it("F10 inserting into galleries rejects: its unique index is not enforced", async () => {
    await expect(
      db.insert(galleries).values({
        id: "g1",
        packageId: "p1",
        title: "t",
        sessionDate: time(),
        publicSlug: "s",
        includedPhotosSnapshot: 1,
        extraPhotoPriceCopSnapshot: 0,
        originalPhotoPriceCopSnapshot: 0,
      }),
    ).rejects.toThrow(/does not enforce/);
  });

  it("F11 onConflictDoUpdate throws; values([]) throws", () => {
    const statement = db.insert(assetPicks).values(pick("a1", "u1"));
    expect(() => statement.onConflictDoUpdate()).toThrow(/not modelled/);
    expect(() => db.insert(assetPicks).values([])).toThrow(/at least one value/);
  });

  it("F12 awaiting the same statement twice inserts once", async () => {
    const statement = db.insert(assetPicks).values(pick("a1", "u1"));
    await statement;
    await statement;
    expect(assetRows()).toHaveLength(1);
    expect(db.__log).toEqual(["insert:1"]);
  });

  it("F13 delete().where() removes only matches in place and returns [] with returning()", async () => {
    const reference = db.__tables.get(assetPicks)!;
    reference.push(pick("a1", "u1"), pick("a2", "u2"), pick("a3", "u1"));
    const deleted = await db
      .delete(assetPicks)
      .where(eq(assetPicks.userId, "u1"))
      .returning({ assetId: assetPicks.assetId });
    expect(deleted).toEqual([{ assetId: "a1" }, { assetId: "a3" }]);
    expect(reference.map((row) => row.assetId)).toEqual(["a2"]);
    expect(db.__log).toEqual(["delete:2"]);
  });

  it("F13b awaiting the where() returns [] and returning() gives full rows", async () => {
    const reference = db.__tables.get(assetPicks)!;
    reference.push(pick("a1", "u1"));
    expect(await db.delete(assetPicks).where(eq(assetPicks.userId, "u1"))).toEqual([]);
    reference.push(pick("a2", "u2"));
    const full = await db.delete(assetPicks).where(eq(assetPicks.userId, "u2")).returning();
    expect(full).toHaveLength(1);
    expect(full[0]!.galleryId).toBe("g1");
  });

  it("F14 awaiting delete(t) with no where rejects", async () => {
    await expect(db.delete(assetPicks)).rejects.toThrow(/without where\(\) is not modelled/);
  });

  it("F15 documents the NON-model: a throwing transaction keeps its writes", async () => {
    const reference = db.__tables.get(assetPicks)!;
    reference.push(pick("a0", "u0"));
    await expect(
      db.transaction(async (tx) => {
        const f = tx as unknown as Fake;
        await f.insert(assetPicks).values(pick("a1", "u1"));
        await f.delete(assetPicks).where(eq(assetPicks.userId, "u0"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(reference.map((row) => row.assetId)).toEqual(["a1"]);
  });

  it("F16 insert/delete on an unregistered table throws unsupported table", () => {
    const local = createFakeDb([assetPicks]) as Fake;
    expect(() => local.insert(galleries)).toThrow(/unsupported table/);
    expect(() => local.delete(galleries)).toThrow(/unsupported table/);
  });
});
