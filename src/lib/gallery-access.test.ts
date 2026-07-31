import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

// Same fake-db approach as src/lib/asset-access.test.ts — a minimal
// `eq()`/`isNull()` interpreter over an in-memory row list, duplicated per
// this codebase's own per-file test-double convention rather than shared.
type Row = Record<string, unknown>;

// A single leaf comparison this fake understands: either `eq(column, value)`
// or `isNull(column)`. Drizzle renders both as a SQL node whose OWN
// `queryChunks` carry the column reference directly (a chunk with `name` +
// `table`) — `eq` additionally carries a `value`+`encoder` chunk, `isNull`
// instead carries a plain string chunk whose text is " is null". Read this
// node's chunks LOCALLY (not flattened into the whole tree) so the two shapes
// are never confused with each other.
type LeafCondition =
  { column: string; op: "eq"; value: unknown } | { column: string; op: "isNull" };

function parseLeaf(node: unknown): LeafCondition | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;

  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  let hasValue = false;
  let isNullText = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
      if ("value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
        if ((chunk as { value: string[] }).value.join("").includes("is null")) isNullText = true;
      }
    }
  }
  if (!dbColumnName || !table) return undefined;
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  if (!jsKey) return undefined;
  if (isNullText) return { column: jsKey, op: "isNull" };
  if (hasValue) return { column: jsKey, op: "eq", value };
  return undefined;
}

// `and(a, b, c, ...)` nests its operands inside an EXTRA wrapper SQL node
// (drizzle groups them with parens and joins with " and " one level deeper
// than a flat `queryChunks` array) — this walks the WHOLE tree, but treats
// any node `parseLeaf` can resolve as a LEAF and never recurses INTO it, so
// an `eq()`'s own value chunk is never mistaken for a sibling condition.
function andConditions(condition: unknown): LeafCondition[] {
  const leaf = parseLeaf(condition);
  if (leaf) return [leaf];
  const chunks = (condition as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  const results: LeafCondition[] = [];
  for (const chunk of chunks) results.push(...andConditions(chunk));
  return results;
}

vi.mock("@/lib/db", async () => {
  const { galleryClients } = await import("@/lib/db/schema");

  const galleryClientRows: Row[] = [];

  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: unknown) => {
            if (table !== galleryClients) {
              throw new Error("fake db: unsupported table in select().where()");
            }
            const conditions = andConditions(condition);
            const rows = galleryClientRows.filter((row) =>
              conditions.every((c) =>
                c.op === "isNull" ? row[c.column] == null : row[c.column] === c.value,
              ),
            );
            return { limit: async (n: number) => rows.slice(0, n) };
          },
        }),
      }),
      __rows: { galleryClients: galleryClientRows },
    },
  };
});

async function seededDb() {
  const { db } = (await import("@/lib/db")) as unknown as {
    db: { __rows: { galleryClients: Row[] } };
  };
  return db;
}

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";

function clientSession(userId: string): Session {
  return {
    user: { id: userId, role: "client", email: `${userId}@example.com` },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

beforeEach(async () => {
  const db = await seededDb();
  db.__rows.galleryClients.length = 0;
});

describe("isGalleryOwner", () => {
  it("allows a client attached to the gallery via gallery_clients", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a" });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(true);
  });

  it("refuses a client who is signed in but not attached to THIS gallery", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a" });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-b"))).resolves.toBe(false);
  });

  // The core of task #94's model: several clients, same gallery, same
  // rights — the SECOND client attached must be just as much an owner as
  // the first.
  it("allows a SECOND client attached to the same gallery, not just the first", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push(
      { galleryId: GALLERY_ID, userId: "client-a" },
      { galleryId: GALLERY_ID, userId: "client-b" },
    );
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(true);
    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-b"))).resolves.toBe(true);
  });

  it("refuses a client attached to a DIFFERENT gallery", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: OTHER_GALLERY_ID, userId: "client-a" });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(false);
  });

  it("refuses a client when the gallery has no clients attached at all", async () => {
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(false);
  });

  it("allows an admin through regardless of who is attached to the gallery", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({ galleryId: GALLERY_ID, userId: "client-a" });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, adminSession())).resolves.toBe(true);
  });

  it("allows an admin through even when the gallery has no clients at all", async () => {
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, adminSession())).resolves.toBe(true);
  });

  // THE safety-critical guard task #97 rests on: a removed row is SOFT
  // deleted (`removedAt` set, never actually removed — schema.ts's own
  // comment on `galleryClients`), and a removed client must lose access
  // immediately. Mutation-proven per this task's own instructions: dropping
  // `isNull(galleryClients.removedAt)` from `isGalleryOwner`'s own `where`
  // makes THIS test fail — the removed client would be let back in. See this
  // task's final report for the observed failure output with the guard
  // removed, and the observed pass with it restored.
  it("refuses a client whose gallery_clients row has been REMOVED (removedAt set)", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-a",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(false);
  });

  it("allows a client whose row is active (removedAt still null) even when a DIFFERENT client on the same gallery was removed", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push(
      { galleryId: GALLERY_ID, userId: "client-a", removedAt: null },
      {
        galleryId: GALLERY_ID,
        userId: "client-b",
        removedAt: new Date("2026-07-29T12:00:00.000Z"),
      },
    );
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(true);
    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-b"))).resolves.toBe(false);
  });

  // Models the TRANSITION, not just its end state. Seeding a row that was
  // never removed and asserting `true` would be byte-identical to the
  // "allows an attached client" test above and would prove nothing about
  // re-attachment — the name would promise a state change the fixture never
  // built. So: push the membership as REMOVED, confirm access is refused,
  // then clear `removedAt` in place the way `attachGalleryClients`'
  // re-attach path does (an UPDATE, never a second INSERT — the composite
  // PK on `(gallery_id, user_id)` would reject a duplicate row, so
  // `attachGalleryClients` partitions its input into never-attached ids it
  // INSERTs and previously-removed ids it UPDATEs), and confirm access
  // comes back.
  it("allows a client who was removed and then RE-ATTACHED (removedAt cleared back to null)", async () => {
    const db = await seededDb();
    const membership: { galleryId: string; userId: string; removedAt: Date | null } = {
      galleryId: GALLERY_ID,
      userId: "client-a",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    };
    db.__rows.galleryClients.push(membership);
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(false);

    membership.removedAt = null;

    await expect(isGalleryOwner(GALLERY_ID, clientSession("client-a"))).resolves.toBe(true);
  });

  it("still allows an admin through even when the gallery's only client row is removed", async () => {
    const db = await seededDb();
    db.__rows.galleryClients.push({
      galleryId: GALLERY_ID,
      userId: "client-a",
      removedAt: new Date("2026-07-29T12:00:00.000Z"),
    });
    const { isGalleryOwner } = await import("./gallery-access");

    await expect(isGalleryOwner(GALLERY_ID, adminSession())).resolves.toBe(true);
  });
});

// Task #139: an ORIENTATION predicate, not a permission one — see this
// function's own header comment for why. These tests deliberately do NOT
// touch the fake db above: the function reads only `session.user.role`, no
// gallery, no query.
describe("isAdminPreviewingClientGallery", () => {
  it("is true for an admin session", async () => {
    const { isAdminPreviewingClientGallery } = await import("./gallery-access");

    expect(isAdminPreviewingClientGallery(adminSession())).toBe(true);
  });

  it("is false for a client session, even the gallery's own owning client", async () => {
    const { isAdminPreviewingClientGallery } = await import("./gallery-access");

    expect(isAdminPreviewingClientGallery(clientSession("client-a"))).toBe(false);
  });
});
