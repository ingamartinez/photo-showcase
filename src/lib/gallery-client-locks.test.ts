import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeDb } from "@/test-support/fake-db";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", async () => {
  const { galleries, galleryClients, assetPicks } = await import("@/lib/db/schema");
  const { createFakeDb } = await import("@/test-support/fake-db");
  return { db: createFakeDb([galleries, galleryClients, assetPicks]) };
});

import { db } from "@/lib/db";
import { galleries, galleryClients, assetPicks } from "@/lib/db/schema";
import {
  getClientLock,
  getSelectionLockSnapshot,
  settleGalleryLockStatus,
  type DbTransaction,
} from "@/lib/gallery-client-locks";

const fake = db as unknown as FakeDb;
const galleryRows = () => fake.__tables.get(galleries)!;
const clientRows = () => fake.__tables.get(galleryClients)!;
const pickRows = () => fake.__tables.get(assetPicks)!;

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

const locked = {
  selectionLockedAt: LOCKED_AT,
  selectionSubmittedAt: LOCKED_AT,
  selectionLockedBy: "client",
};
const adminLocked = { selectionLockedAt: LOCKED_AT, selectionLockedBy: "admin" };
// Decision 10: an ORDER sets the submit stamp and never locks.
const submitted = { selectionSubmittedAt: LOCKED_AT };

function cart(userId: string, assetId = "asset-a", galleryId = GALLERY_ID) {
  return {
    assetId,
    galleryId,
    userId,
    kind: "edited",
    pickedAt: LOCKED_AT,
    submittedAt: null,
  };
}

function settle() {
  return settleGalleryLockStatus(db as unknown as DbTransaction, GALLERY_ID);
}

beforeEach(() => {
  galleryRows().length = 0;
  clientRows().length = 0;
  pickRows().length = 0;
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
  it("is open for the viewer and lists no admin lock when only a CLIENT lock exists (closed-gallery history)", async () => {
    clientRows().push(member("a"), member("b", locked));

    await expect(getSelectionLockSnapshot(GALLERY_ID, "a")).resolves.toEqual({
      viewerLock: null,
      adminLockedPickerIds: [],
      viewerSubmittedAt: null,
    });
  });

  it("exposes the viewer's own admin lock as ISO strings, and lists them among the admin-locked pickers", async () => {
    clientRows().push(member("a", adminLocked), member("b"));

    await expect(getSelectionLockSnapshot(GALLERY_ID, "a")).resolves.toEqual({
      viewerLock: { lockedAt: LOCKED_AT.toISOString(), submittedAt: null, lockedBy: "admin" },
      adminLockedPickerIds: ["a"],
      viewerSubmittedAt: null,
    });
  });

  it("lists only admin locks; a client lock (closed-gallery history) is excluded", async () => {
    clientRows().push(member("a"), member("sub", locked), member("adm", adminLocked));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.adminLockedPickerIds).toEqual(["adm"]);
  });

  // Task #244 — the lock source is READ from `selection_locked_by`, never
  // inferred from the timestamps: this member ordered (submitted_at set) and
  // was LATER locked by the photographer, so both columns are set — the same
  // shape as a classic submit.
  it("tells a photographer lock after an order apart from a client submit", async () => {
    clientRows().push(
      member("a", {
        selectionLockedAt: LOCKED_AT,
        selectionSubmittedAt: new Date("2026-10-14T10:00:00.000Z"),
        selectionLockedBy: "admin",
      }),
      member("b", locked),
    );

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.viewerLock?.lockedBy).toBe("admin");
    expect(snapshot.adminLockedPickerIds).toEqual(["a"]);
  });

  it("never reports a removed client as a locked picker", async () => {
    clientRows().push(member("a"), member("gone", { ...locked, removedAt: new Date() }));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.adminLockedPickerIds).toEqual([]);
  });

  it("gives an admin (no membership at all) a null viewerLock", async () => {
    clientRows().push(member("a", adminLocked));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "admin-1");

    expect(snapshot).toEqual({
      viewerLock: null,
      adminLockedPickerIds: ["a"],
      viewerSubmittedAt: null,
    });
  });

  it("gives a null SUBJECT null viewer fields, even when members are locked", async () => {
    clientRows().push(member("a", adminLocked), member("sub", locked));

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, null);

    expect(snapshot.viewerLock).toBeNull();
    expect(snapshot.viewerSubmittedAt).toBeNull();
    expect(snapshot.adminLockedPickerIds).toEqual(["a"]);
  });

  it("exposes the viewer's own submit time even when they are NOT locked (rolling delivery, task #244)", async () => {
    clientRows().push(
      member("a", { selectionSubmittedAt: LOCKED_AT }),
      member("b", { selectionSubmittedAt: new Date("2026-01-01") }),
    );

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.viewerLock).toBeNull();
    expect(snapshot.viewerSubmittedAt).toBe(LOCKED_AT.toISOString());
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

  // Decision 13, the half that keeps order semantics safe: a member who
  // ordered (submitted, never locked — exactly every member after an
  // order-semantic submit, and every member migration 4.5 unlocked) is DONE.
  // The pre-S5 rule reopened any `selected` gallery with an unlocked member,
  // which meant the next admin action would reopen every rolling gallery.
  it("does NOT reopen when the unlocked member submitted and has no cart", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(member("a", submitted), member("b", submitted));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "selected" });
  });

  it("reopens a selected gallery when an active member neither submitted nor was locked", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(member("a", locked), member("b"));

    await expect(settle()).resolves.toBe("proofing");

    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });

  it("an unsubmitted CART keeps a proofing gallery open even when everyone else is done", async () => {
    clientRows().push(member("a", submitted), member("b", submitted));
    pickRows().push(cart("b"));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });

  it("an admin lock counts as done (decision 18 guarantees it leaves no cart)", async () => {
    clientRows().push(member("a", adminLocked), member("b", submitted));

    await expect(settle()).resolves.toBe("selected");
  });

  it("a LOCKED member who still has a cart is not done — the fail-safe direction", async () => {
    clientRows().push(member("a", locked), member("b", locked));
    pickRows().push(cart("a"));

    await expect(settle()).resolves.toBeNull();

    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });

  it("reopens a selected gallery when an active member still has a cart", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(member("a", locked), member("b", locked));
    pickRows().push(cart("b"));

    await expect(settle()).resolves.toBe("proofing");
  });

  it("ignores a REMOVED member's cart", async () => {
    clientRows().push(member("a", locked), member("gone", { removedAt: new Date() }));
    pickRows().push(cart("gone"));

    await expect(settle()).resolves.toBe("selected");
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

// Every fixture above lives in ONE gallery, which hides a dropped
// `galleryId` condition (the query would still find the right rows by
// accident). These put the SAME user ids in a SECOND gallery with the
// OPPOSITE lock state, and list the other gallery's rows FIRST so a query that
// forgets to scope returns them before the right ones.
describe("gallery scoping — the same users in another gallery with the opposite state", () => {
  const OTHER_GALLERY_ID = "22222222-2222-4222-8222-222222222222";
  const other = (userId: string, overrides: Record<string, unknown> = {}) =>
    member(userId, { galleryId: OTHER_GALLERY_ID, ...overrides });

  it("getClientLock reads the lock of THIS gallery, not the same user's lock in another", async () => {
    clientRows().push(other("a", locked), member("a"));

    await expect(getClientLock(db, GALLERY_ID, "a")).resolves.toEqual({
      lockedAt: null,
      submittedAt: null,
    });
  });

  it("getSelectionLockSnapshot ignores another gallery's locks, for the viewer and for the picker list", async () => {
    clientRows().push(other("a", locked), other("b", locked), member("a"), member("b"));

    await expect(getSelectionLockSnapshot(GALLERY_ID, "a")).resolves.toEqual({
      viewerLock: null,
      adminLockedPickerIds: [],
      viewerSubmittedAt: null,
    });
  });

  it("getSelectionLockSnapshot does not take another gallery's admin lock as this gallery's", async () => {
    clientRows().push(
      other("b", adminLocked),
      member("b", { selectionLockedAt: LOCKED_AT, selectionLockedBy: "admin" }),
      member("a"),
    );

    const snapshot = await getSelectionLockSnapshot(GALLERY_ID, "a");

    expect(snapshot.adminLockedPickerIds).toEqual(["b"]);
  });

  it("settle ignores another gallery's cart for the same user", async () => {
    clientRows().push(other("a", locked), member("a", locked));
    pickRows().push(cart("a", "asset-other", OTHER_GALLERY_ID));

    await expect(settle()).resolves.toBe("selected");
  });

  it("settle closes this gallery even though the same user is still OPEN in another gallery", async () => {
    clientRows().push(other("a"), member("a", locked));

    await expect(settle()).resolves.toBe("selected");
  });

  it("settle keeps a selected gallery selected even though the same user is open elsewhere, and reopens only for an unlocked member of THIS gallery", async () => {
    galleryRows()[0]!.status = "selected";
    clientRows().push(other("a"), member("a", locked));

    await expect(settle()).resolves.toBeNull();
    expect(galleryRows()[0]).toMatchObject({ status: "selected" });
  });

  it("settle does not stay open because another gallery's locked member shares an id with an open one here", async () => {
    clientRows().push(other("b", locked), member("a", locked), member("b"));

    await expect(settle()).resolves.toBeNull();
    expect(galleryRows()[0]).toMatchObject({ status: "proofing" });
  });
});
