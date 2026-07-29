import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";

// `import "server-only"` only resolves inside a real Next.js bundle — see
// src/lib/auth-guards.test.ts for the same stub, needed here transitively.
vi.mock("server-only", () => ({}));

// Same fake-db approach as src/lib/asset-access.test.ts — a minimal `eq()`
// interpreter over an in-memory row list, duplicated per this codebase's own
// per-file test-double convention rather than shared.
type Row = Record<string, unknown>;

function eqColumnAndValue(condition: unknown): { column?: string; value?: unknown } {
  const chunks = (condition as { queryChunks?: unknown[] }).queryChunks ?? [];
  let dbColumnName: string | undefined;
  let table: unknown;
  let value: unknown;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) {
        dbColumnName = (chunk as { name: string }).name;
        table = (chunk as { table: unknown }).table;
      }
      if ("value" in chunk && "encoder" in chunk) value = (chunk as { value: unknown }).value;
    }
  }
  if (!dbColumnName || !table) return { column: undefined, value };
  const jsKey = Object.entries(table as Record<string, unknown>).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  )?.[0];
  return { column: jsKey, value };
}

// `and(eq1, eq2)` nests its two operands inside an EXTRA wrapper SQL node
// (drizzle groups them with parens and joins with " and " one level deeper
// than a flat `queryChunks` array), so this walks the WHOLE tree looking for
// every node `eqColumnAndValue` can resolve, rather than assuming the two
// `eq()`s sit as direct siblings.
function andConditions(condition: unknown): { column?: string; value?: unknown }[] {
  const results: { column?: string; value?: unknown }[] = [];
  function walk(node: unknown) {
    if (!node || typeof node !== "object") return;
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!chunks) return;
    const { column, value } = eqColumnAndValue(node);
    if (column) {
      results.push({ column, value });
      return;
    }
    for (const chunk of chunks) walk(chunk);
  }
  walk(condition);
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
              conditions.every(({ column, value }) => column && row[column] === value),
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
});
