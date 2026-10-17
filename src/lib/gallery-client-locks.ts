// Per-client selection locks (epic #239). Until this epic the lock was
// gallery-wide: one client's "Enviar selección" moved the whole gallery
// `proofing -> selected` and froze the shared board for everybody. Now each
// `gallery_clients` row carries its own `selectionLockedAt` /
// `selectionSubmittedAt` (schema.ts), and the GALLERY status is derived from
// them: `selected` exactly when it has at least one active client and every
// active client is locked.
//
// This module is the single home of that derivation, so the submit route, the
// gallery-wide unlock, `removeGalleryClient` and the admin per-client actions
// of slice #242 cannot each grow their own idea of when a gallery closes.
//
// EVERY read of `gallery_clients` here filters `removedAt IS NULL` — a removed
// client's lock is history, and counting it would keep a gallery open (or
// closed) on the say-so of somebody who is no longer part of it.
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { galleries, galleryClients } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import type { SelectionLockSnapshot } from "@/lib/selection-snapshot";

/** The transaction handle Drizzle passes to `db.transaction(async (tx) => …)`. */
export type DbTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Either the pool or an open transaction — the reads below work on both. */
export type DbExecutor = DB | DbTransaction;

export type ClientLock = {
  lockedAt: Date | null;
  submittedAt: Date | null;
};

/** One client's lock for one gallery, or `null` when `userId` has no ACTIVE
 * membership there (never attached, or soft-removed). */
export async function getClientLock(
  executor: DbExecutor,
  galleryId: string,
  userId: string,
): Promise<ClientLock | null> {
  const [row] = await executor
    .select({
      lockedAt: galleryClients.selectionLockedAt,
      submittedAt: galleryClients.selectionSubmittedAt,
    })
    .from(galleryClients)
    .where(
      and(
        eq(galleryClients.galleryId, galleryId),
        eq(galleryClients.userId, userId),
        isNull(galleryClients.removedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** What the client page and the selection snapshot route hand `<ProofGrid>`
 * (slice #241 consumes it): the viewer's own lock, and which pickers are
 * locked so their picks can render as frozen. `viewerLock` is `null` while the
 * viewer is open — and always for an admin, who has no membership. */
export async function getSelectionLockSnapshot(
  galleryId: string,
  viewerId: string,
  executor: DbExecutor = db,
): Promise<SelectionLockSnapshot> {
  const members = await executor
    .select({
      userId: galleryClients.userId,
      lockedAt: galleryClients.selectionLockedAt,
      submittedAt: galleryClients.selectionSubmittedAt,
      lockedBy: galleryClients.selectionLockedBy,
    })
    .from(galleryClients)
    .where(and(eq(galleryClients.galleryId, galleryId), isNull(galleryClients.removedAt)));

  const locked = members.filter((member) => member.lockedAt !== null);
  const own = locked.find((member) => member.userId === viewerId);
  const ownMembership = members.find((member) => member.userId === viewerId);
  return {
    viewerSubmittedAt: ownMembership?.submittedAt ? ownMembership.submittedAt.toISOString() : null,
    viewerLock: own
      ? {
          lockedAt: own.lockedAt!.toISOString(),
          submittedAt: own.submittedAt ? own.submittedAt.toISOString() : null,
          lockedBy: own.lockedBy,
        }
      : null,
    lockedPickerIds: locked.map((member) => member.userId),
    // Task #244: "submitted" = locked BY THE CLIENT (`selection_locked_by`),
    // not "has a submit timestamp" — under rolling delivery an order sets the
    // timestamp without locking, and a photographer lock can follow it.
    submittedPickerIds: locked
      .filter((member) => member.lockedBy === "client")
      .map((member) => member.userId),
  };
}

/** Takes the gallery row's write lock for the rest of the transaction and
 * returns it fresh. Every writer of per-client locks takes THIS lock first
 * (submit, unlock, remove-client, admin lock/unlock) — one lock order, so two
 * of them cannot deadlock, and so `settleGalleryLockStatus`'s membership read
 * always sees every other writer's committed result (see below). */
export async function lockGalleryRow(
  tx: DbTransaction,
  galleryId: string,
): Promise<Gallery | null> {
  const [gallery] = await tx
    .select()
    .from(galleries)
    .where(eq(galleries.id, galleryId))
    .for("update");
  return gallery ?? null;
}

export type LockTransition = "selected" | "proofing" | null;

/**
 * Reconciles the gallery's status with its clients' locks, inside the
 * caller's transaction:
 *
 *   - `proofing` with >= 1 active client, ALL of them locked -> `selected`
 *     (stamping `galleries.selectionSubmittedAt`);
 *   - `selected` with some active client unlocked -> back to `proofing`.
 *
 * Anything else (`draft`, `delivered`, `archived`, or no change needed) is
 * left alone. A gallery with ZERO active clients never closes — "every client
 * is locked" is vacuously true there, and closing a gallery nobody can open
 * would be a dead end (the same reason `activeClientRuleViolation` exists).
 *
 * CONCURRENCY. Two clients submitting last at the same moment each lock their
 * OWN membership row, so neither blocks the other, and under READ COMMITTED
 * each would then read the other as still open — and nobody would close the
 * gallery. The gallery row lock taken first (`lockGalleryRow`) serializes
 * them: the second transaction's membership read starts only after the first
 * committed. On top of that the status flip is a compare-and-swap
 * (`WHERE status = <what we read>`), so even a caller that skipped the lock
 * could never produce two transitions — only the winner gets a row back.
 *
 * Returns which transition happened (`null` for none).
 */
export async function settleGalleryLockStatus(
  tx: DbTransaction,
  galleryId: string,
): Promise<LockTransition> {
  const gallery = await lockGalleryRow(tx, galleryId);
  if (!gallery) return null;
  if (gallery.status !== "proofing" && gallery.status !== "selected") return null;

  const members = await tx
    .select({ lockedAt: galleryClients.selectionLockedAt })
    .from(galleryClients)
    .where(and(eq(galleryClients.galleryId, galleryId), isNull(galleryClients.removedAt)));

  const everyoneLocked = members.length > 0 && members.every((member) => member.lockedAt !== null);

  if (gallery.status === "proofing" && everyoneLocked) {
    const updated = await tx
      .update(galleries)
      .set({ status: "selected", selectionSubmittedAt: new Date() })
      .where(and(eq(galleries.id, galleryId), eq(galleries.status, "proofing")))
      .returning({ id: galleries.id });
    return updated.length === 1 ? "selected" : null;
  }

  if (gallery.status === "selected" && !everyoneLocked) {
    const updated = await tx
      .update(galleries)
      .set({ status: "proofing" })
      .where(and(eq(galleries.id, galleryId), eq(galleries.status, "selected")))
      .returning({ id: galleries.id });
    return updated.length === 1 ? "proofing" : null;
  }

  return null;
}
