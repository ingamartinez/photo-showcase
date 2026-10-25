// Task #287 — the durable cleanup manifest's drainer. The database double is
// the shared fake (`src/test-support/fake-db.ts`), which filters real drizzle
// conditions but models NEITHER row locks NOR rollback (its own header says
// so). These tests therefore prove ORDER (the lock is the first operation, and
// every delete settles inside the locked pass), the reference protection, the
// retry/pending bookkeeping and idempotency — NOT PostgreSQL isolation, and
// not a DB↔R2 distributed transaction.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deleteObjectMock = vi.fn<(key: string) => Promise<void>>();
vi.mock("@/lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/r2")>();
  return {
    ...actual,
    deleteObject: (key: string) => deleteObjectMock(key),
  };
});

vi.mock("@/lib/db", async () => {
  const { createFakeDb } = await import("@/test-support/fake-db");
  const { assets, galleries, galleryFinalCleanup } = await import("@/lib/db/schema");
  return { db: createFakeDb([galleries, galleryFinalCleanup, assets]) };
});

import { assets, galleries, galleryFinalCleanup } from "@/lib/db/schema";
import type { FakeDb } from "@/test-support/fake-db";

type Row = Record<string, unknown>;

const G = "11111111-1111-4111-8111-111111111111";
const T0 = new Date("2026-10-25T14:00:00.000Z");
const T1 = new Date("2026-10-25T15:00:00.000Z");

const FINALS = `galleries/${G}/finals/`;
const DISPLAY = `galleries/${G}/display/`;

function fakeDb(): FakeDb {
  return (globalThis as unknown as { __fakeDb: FakeDb }).__fakeDb;
}

async function loaded() {
  const { db } = (await import("@/lib/db")) as unknown as { db: FakeDb };
  (globalThis as unknown as { __fakeDb: FakeDb }).__fakeDb = db;
  return db;
}

function seedGallery(overrides: Row = {}) {
  fakeDb()
    .__tables.get(galleries)!
    .push({
      id: G,
      status: "proofing",
      publicSlug: "abc123",
      unlockedAt: T1,
      ...overrides,
    });
}

function seedAssets(rows: Row[]) {
  for (const row of rows) {
    fakeDb()
      .__tables.get(assets)!
      .push({ galleryId: G, finalKey: null, ...row });
  }
}

function seedManifest(remainingKeys: string[], epoch: Date = T1) {
  fakeDb()
    .__tables.get(galleryFinalCleanup)!
    .push({ galleryId: G, reopenEpoch: epoch, remainingKeys });
}

function manifestRows(): Row[] {
  return fakeDb().__tables.get(galleryFinalCleanup)!;
}

function deletedKeys(): string[] {
  return deleteObjectMock.mock.calls.map((call) => call[0]);
}

async function drain(epoch: Date = T1) {
  const { drainGalleryFinalCleanup } = await import("@/lib/gallery-final-cleanup");
  return drainGalleryFinalCleanup(G, epoch);
}

beforeEach(async () => {
  deleteObjectMock.mockReset();
  deleteObjectMock.mockResolvedValue(undefined);
  const db = await loaded();
  for (const rows of db.__tables.values()) rows.length = 0;
  db.__log.length = 0;
});

describe("drainGalleryFinalCleanup", () => {
  it("takes the gallery row lock BEFORE reading the manifest", async () => {
    seedGallery();
    seedManifest([`${FINALS}a1.jpg`]);
    seedAssets([{ id: "a1", finalKey: null }]);

    await drain();

    expect(fakeDb().__log[0]).toBe("for:update");
  });

  it("deletes every captured key and removes the manifest", async () => {
    seedGallery();
    seedAssets([
      { id: "a1", finalKey: null },
      { id: "a2", finalKey: null },
    ]);
    seedManifest([`${FINALS}a1.jpg`, `${DISPLAY}a1.webp`, `${FINALS}a2.tiff`]);

    const result = await drain();

    expect(result).toEqual({ status: "cleaned" });
    expect(deletedKeys().sort()).toEqual(
      [`${FINALS}a1.jpg`, `${DISPLAY}a1.webp`, `${FINALS}a2.tiff`].sort(),
    );
    expect(manifestRows()).toEqual([]);
  });

  it("keeps a fresh upload's final and display object, deleting only the stale variant", async () => {
    seedGallery();
    // The admin re-uploaded as PNG after the reopen: that object, and the
    // display derivative of the SAME asset, now belong to the new cycle.
    seedAssets([{ id: "a1", finalKey: `${FINALS}a1.png` }]);
    seedManifest([`${FINALS}a1.jpg`, `${FINALS}a1.png`, `${DISPLAY}a1.webp`]);

    const result = await drain();

    expect(result).toEqual({ status: "cleaned" });
    expect(deletedKeys()).toEqual([`${FINALS}a1.jpg`]);
    expect(manifestRows()).toEqual([]);
  });

  it("never deletes a display key whose asset still has a final", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: `${FINALS}a1.jpg` }]);
    seedManifest([`${FINALS}a1.jpg`, `${DISPLAY}a1.webp`]);

    await drain();

    expect(deletedKeys()).toEqual([]);
  });

  it("is idempotent when there is no manifest at all", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);

    const result = await drain();

    expect(result).toEqual({ status: "cleaned" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("refuses a stale epoch without deleting anything", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`], T0);

    const result = await drain(T1);

    expect(result).toEqual({ status: "changed" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
    expect(manifestRows()[0]!.remainingKeys).toEqual([`${FINALS}a1.jpg`]);
  });

  it("throws when the manifest epoch disagrees with the gallery's own unlocked_at", async () => {
    seedGallery({ unlockedAt: T0 });
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`], T1);

    await expect(drain()).rejects.toThrow(/does not match gallery/);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("bounds how many deletes are in flight", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    // Each delete announces itself BEFORE resolving, so the peak count is what
    // a single locked pass actually had outstanding.
    let inFlight = 0;
    let peak = 0;
    deleteObjectMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });
    seedManifest(Array.from({ length: 10 }, (_, index) => `${FINALS}a${index}.jpg`));

    await drain();

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("retries a rejected delete once inside the same pass", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`]);
    deleteObjectMock.mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(undefined);

    const result = await drain();

    expect(result).toEqual({ status: "cleaned" });
    expect(deletedKeys()).toEqual([`${FINALS}a1.jpg`, `${FINALS}a1.jpg`]);
    expect(manifestRows()).toEqual([]);
  });

  it("persists exactly the still-failed keys and reports them as pending", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`, `${FINALS}a2.jpg`]);
    deleteObjectMock.mockImplementation(async (key: string) => {
      if (key === `${FINALS}a1.jpg`) throw new Error("r2 down");
    });

    const result = await drain();

    expect(result).toEqual({ status: "pending", remainingKeys: 1 });
    expect(manifestRows()[0]!.remainingKeys).toEqual([`${FINALS}a1.jpg`]);
    // The epoch is untouched: the retry belongs to the same reopen.
    expect(manifestRows()[0]!.reopenEpoch).toEqual(T1);
  });

  it("resumes from the durable remainder in a later invocation", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`, `${FINALS}a2.jpg`]);
    deleteObjectMock.mockImplementation(async (key: string) => {
      if (key === `${FINALS}a1.jpg`) throw new Error("r2 down");
    });

    expect(await drain()).toEqual({ status: "pending", remainingKeys: 1 });
    deleteObjectMock.mockReset();
    deleteObjectMock.mockResolvedValue(undefined);

    // A NEW invocation: no in-memory state survives, only the manifest.
    expect(await drain()).toEqual({ status: "cleaned" });
    expect(deletedKeys()).toEqual([`${FINALS}a1.jpg`]);
    expect(manifestRows()).toEqual([]);
  });

  it("keeps the full obligation when the manifest write fails after the deletes", async () => {
    seedGallery();
    seedAssets([{ id: "a1", finalKey: null }]);
    seedManifest([`${FINALS}a1.jpg`]);
    // The fake db models no rollback, so what this proves is the ORDER: the
    // manifest row is only removed at the very end, so a SQL failure leaves the
    // original over-estimate in place and the retry re-deletes absent keys
    // (which this app already treats as success).
    const db = fakeDb();
    const realDelete = db.delete;
    db.delete = (() => {
      throw new Error("sql down");
    }) as FakeDb["delete"];

    await expect(drain()).rejects.toThrow(/sql down/);
    expect(manifestRows()[0]!.remainingKeys).toEqual([`${FINALS}a1.jpg`]);

    db.delete = realDelete;
    expect(await drain()).toEqual({ status: "cleaned" });
    expect(deletedKeys()).toEqual([`${FINALS}a1.jpg`, `${FINALS}a1.jpg`]);
  });

  it("reports changed when the gallery itself is gone", async () => {
    seedManifest([`${FINALS}a1.jpg`]);

    expect(await drain()).toEqual({ status: "changed" });
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });
});

describe("readGalleryFinalCleanup", () => {
  it("returns the epoch and the number of pending objects, never the keys", async () => {
    seedGallery();
    seedManifest([`${FINALS}a1.jpg`, `${FINALS}a2.jpg`]);
    const { readGalleryFinalCleanup } = await import("@/lib/gallery-final-cleanup");

    const pending = await readGalleryFinalCleanup(G);

    expect(pending).toEqual({ reopenEpoch: T1.toISOString(), remainingKeys: 2 });
    expect(JSON.stringify(pending)).not.toContain("finals");
  });

  it("answers null for a gallery with no pending cleanup", async () => {
    seedGallery();
    const { readGalleryFinalCleanup } = await import("@/lib/gallery-final-cleanup");

    expect(await readGalleryFinalCleanup(G)).toBeNull();
  });
});
