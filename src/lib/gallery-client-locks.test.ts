import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "@/test-support/fake-db";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  return { db: createFakeDb([galleries, galleryClients]) };
});

import { db } from "@/lib/db";
import { galleries, galleryClients } from "@/lib/db/schema";
import {
  getClientLock,
  getSelectionLockSnapshot,
  settleGalleryLockStatus,
  type DbTransaction,
} from "@/lib/gallery-client-locks";

const fake = db as unknown as FakeDb;
const galleryRows = () => fake.__tables.get(galleries)!;
const clientRows = () => fake.__tables.get(galleryClients)!;

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const LOCKED_AT = new Date("2026-10-15T10:00:00.000Z");

function member(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    galleryId: GALLERY_ID,
    userId,
    removedAt: null,
    selectionLockedAt: null,
    selectionSubmittedAt: null,
    ...overrides,
  };
}

const locked = { selectionLockedAt: LOCKED_AT, selectionSubmittedAt: LOCKED_AT };

function settle() {
  return settleGalleryLockStatus(db as unknown as DbTransaction, GALLERY_ID);
}

beforeEach(() => {
  galleryRows().length = 0;
  clientRows().length = 0;
  fake.__log.length = 0;
  galleryRows().push({ id: GALLERY_ID, status: "proofing", selectionSubmittedAt: null });
});

describe("getClientLock", () => {
  it("returns the lock of an active membership", async () => {
    clientRows().push(member("a", locked));

    await expect(getClientLock(db, GALLERY_ID, "a")).resolves.toEqual({
      lockedAt: LOCKED_AT,
      submittedAt: LOCKED_AT,
    });
  });

  it("returns null for someone who was never attached", async () => {
    clientRows().push(member("a"));

    await expect(getClientLock(db, GALLERY_ID, "stranger")).resolves.toBeNull();
  });

  it("returns null for a REMOVED membership, even though its lock columns are set", async () => {
    clientRows().push(member("a", { ...locked, removedAt: new Date() }));

    await expect(getClientLock(db, GALLERY_ID, "a")).resolves.toBeNull();
  });
});

describe("getSelectionLockSnapshot", () => {
  it("is open for the viewer and lists only OTHER locked pickers when the viewer is open", async () => {
    clientRows().push(member("a"), member("b", locked));

    await expect(getSelectionLockSnapshot(GALLERY_ID, "a")).resolves.toEqual({
      viewerLock: null,
      lockedPickerIds: ["b"],
    });
  });

  it("exposes the viewer's own lock as ISO strings, and lists them among the locked pickers", async () => {
    clientRows().push(member("a", { selectionLockedAt: LOCKED_AT }), member("b"));

    await expect(getSelectionLockSnapshot(GALLERY_ID, "a")).resolves.toEqual({
      viewerLock: { lockedAt: LOCKED_AT.toISOString(), submittedAt: null },
      lockedPickerIds: ["a"],
    });
  });

  it("never reports a removed client as a locked picker", async () => {
    clientRows().push(member("a"), member("gone", { ...locked, removedAt: new Date() }));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.lockedPickerIds).toEqual([]);
  });

  it("gives an admin (no membership at all) a null viewerLock", async () => {
    clientRows().push(member("a", locked));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "admin-1");

    expect(snapshot).toEqual({ viewerLock: null, lockedPickerIds: ["a"] });
  });
});

describe("settleGalleryLockStatus", () => {
  it("closes a proofing gallery once EVERY active client is locked, stamping selectionSubmittedAt", async () => {
    clientRows().push(member("a", locked), member("b", locked));

    await expect(settle()).resolves.toBe("selected");

    expect(galleryRows()[0]).toMatchObject({ status: "selected" });
    expect(galleryRows()[0]!.selectionSubmittedAt).toBeInstanceOf(Date);
  });

  it("leaves a proofing gallery open while any active client is still unlocked", async () => {
    clientRows().push(member("a", locked), member("b"));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "proofing", selectionSubmittedAt: null });
  });

  it("closes a single-client gallery as soon as that client is locked (today's behaviour)", async () => {
    clientRows().push(member("a", locked));

    await expect(settle()).resolves.toBe("selected");
  });

  it("ignores a REMOVED unlocked client: the remaining clients are all locked, so the gallery closes", async () => {
    clientRows().push(member("a", locked), member("gone", { removedAt: new Date() }));

    await expect(settle()).resolves.toBe("selected");
  });

  it("never closes a gallery with no active clients (vacuous truth is not a submission)", async () => {
    clientRows().push(member("gone", { ...locked, removedAt: new Date() }));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });

  it("reopens a selected gallery when some active client is unlocked", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(member("a", locked), member("b"));

    await expect(settle()).resolves.toBe("proofing");

    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });

  it("keeps a selected gallery selected while everyone is locked", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(member("a", locked), member("b", locked));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "selected" });
  });

  it.each(["draft", "delivered", "archived"])("never touches a %s gallery", async (status) => {
    galleryRows()[0]!.status = status;
    clientRows().push(member("a", locked));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status });
  });

  it("is a no-op the second time: only the first call reports the transition", async () => {
    clientRows().push(member("a", locked));

    await expect(settle()).resolves.toBe("selected");
    const stampedAt = galleryRows()[0]!.selectionSubmittedAt;
    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]!.selectionSubmittedAt).toBe(stampedAt);
  });

  it("takes the gallery row's write lock BEFORE it reads the memberships or writes anything", async () => {
    clientRows().push(member("a", locked));

    await settle();

    expect(fake.__log[0]).toBe("for:update");
  });

  it("returns null for a gallery that does not exist", async () => {
    galleryRows().length = 0;

    await expect(settle()).resolves.toBeNull();
  });
});
