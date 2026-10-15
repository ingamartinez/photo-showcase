import { and, eq, gt, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { galleryClients } from "@/lib/db/schema";
import { createFakeDb, type FakeDb } from "@/test-support/fake-db";

// The fake is shared infrastructure: a condition it cannot interpret must
// THROW, because silently treating `ne` as `eq`, dropping a leaf inside
// `and`, or reading `or` as `and` makes a suite green for the wrong reason.

type Fake = FakeDb & {
  select: (columns?: Record<string, unknown>) => {
    from: (t: unknown) => { where: (c: unknown) => Promise<Record<string, unknown>[]> };
  };
  update: (t: unknown) => {
    set: (p: Record<string, unknown>) => { where: (c: unknown) => Promise<unknown> };
  };
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

  it("a condition that is not a drizzle expression at all", async () => {
    expect(() => read(undefined)).toThrow(/unsupported condition/);
  });
});
