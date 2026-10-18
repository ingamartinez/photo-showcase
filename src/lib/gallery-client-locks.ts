// Per-client selection locks (epic #239, revised by epic #250 decisions 10
// and 13). Until epic #239 the lock was gallery-wide: one client's "Enviar
// selección" moved the whole gallery `proofing -> selected` and froze the
// shared board for everybody. Then each `gallery_clients` row carried its own
// `selectionLockedAt` / `selectionSubmittedAt` (schema.ts), and the GALLERY
// status was derived from the locks.
//
// EPIC #250 REPLACED THE RULE. Choosing became asking: a submit places an
// order and does NOT lock the member (decision 10), so "every member is
// locked" can never be true for a gallery whose members order. Decision 13:
// the gallery is `selected` exactly when it has at least one active member and
// EVERY active member is DONE, where
//
//     done(member) = that member has no pick with `submitted_at IS NULL`
//                    (no cart) AND
//                    (`selection_submitted_at` is set OR
//                     `selection_locked_at` is set)
//
// An admin lock counts as done (decision 18 guarantees it leaves no cart), and
// a locked member with a cart is NOT done — unreachable after S5, and the
// fail-safe direction (open and visible, never closed with work pending).
//
// The derivation is SYMMETRIC on that predicate, which is what makes an
// unlocked-but-submitted member safe: they never reopen a closed gallery. Only
// an explicit act that clears BOTH stamps reopens one — attach (a new member),
// a per-client unlock, or an admin removing their picks.
//
// EVERY read of `gallery_clients` here filters `removedAt IS NULL` — a removed
// client's lock is history, and counting it would keep a gallery open (or
// closed) on the say-so of somebody who is no longer part of it. Carts of
// removed members are ignored for the same reason: the cart set is only ever
// consulted for ACTIVE members.
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { db, type DB } from "@/lib/db";
import { galleries, galleryClients, assetPicks } from "@/lib/db/schema";
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
 * (slice #241 consumes it): the subject's own lock, and which pickers the
 * PHOTOGRAPHER locked so their picks can render as frozen. `viewerLock` is
 * `null` while the subject is open — and always when there is no subject
 * (`viewerId === null`: an admin without view-as).
 *
 * `adminLockedPickerIds` lists ADMIN locks only. Since epic #250 S5 a client
 * submit never locks (it places an order), and migration 0017 cleared every
 * client lock in `proofing`; a `'client'` lock therefore survives only as
 * history in `selected`/`delivered`/`archived` galleries, where the gallery
 * status already freezes every control. "Envió" is derived per pick from
 * `asset_picks.submitted_at`, not from a list here. */
export async function getSelectionLockSnapshot(
  galleryId: string,
  viewerId: string | null,
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
  const own = viewerId === null ? undefined : locked.find((member) => member.userId === viewerId);
  const ownMembership =
    viewerId === null ? undefined : members.find((member) => member.userId === viewerId);
  return {
    viewerSubmittedAt: ownMembership?.submittedAt ? ownMembership.submittedAt.toISOString() : null,
    viewerLock: own
      ? {
          lockedAt: own.lockedAt!.toISOString(),
          submittedAt: own.submittedAt ? own.submittedAt.toISOString() : null,
          lockedBy: own.lockedBy,
        }
      : null,
    // Only the photographer's locks are written since S5; a `'client'` lock is
    // closed-gallery history and would be a lie about who froze whom.
    adminLockedPickerIds: locked
      .filter((member) => member.lockedBy === "admin")
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
 * Reconciles the gallery's status with its members' progress, inside the
 * caller's transaction:
 *
 *   - `proofing` with >= 1 active member, ALL of them done -> `selected`
 *     (stamping `galleries.selectionSubmittedAt`);
 *   - `selected` with some active member NOT done -> back to `proofing`.
 *
 * `done` is decision 13's predicate (module header). Anything else (`draft`,
 * `delivered`, `archived`, or no change needed) is left alone. A gallery with
 * ZERO active members never closes — "every member is done" is vacuously true
 * there, and closing a gallery nobody can open would be a dead end (the same
 * reason `activeClientRuleViolation` exists).
 *
 * CONCURRENCY. Two members submitting last at the same moment each write
 * their OWN membership row, so neither blocks the other, and under READ
 * COMMITTED each would then read the other as still open — and nobody would
 * close the gallery. The gallery row lock taken first (`lockGalleryRow`)
 * serializes them: the second transaction's membership and cart reads start
 * only after the first committed. On top of that the status flip is a
 * compare-and-swap (`WHERE status = <what we read>`), so even a caller that
 * skipped the lock could never produce two transitions — only the winner gets
 * a row back.
 *
 * ACCEPTED WINDOW, stated rather than papered over: the cart read happens
 * under this lock, but the client PATCH route inserts cart picks WITHOUT it.
 * A cart inserted between this read and this commit therefore lands in a
 * `selected` gallery. It is non-monetary (carts never bill), it is cleared by
 * an unlock or by the member's own remove, and closing it properly would put a
 * transaction and a `FOR SHARE` on the hottest route. Accepted deliberately.
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
    .select({
      userId: galleryClients.userId,
      lockedAt: galleryClients.selectionLockedAt,
      submittedAt: galleryClients.selectionSubmittedAt,
    })
    .from(galleryClients)
    .where(and(eq(galleryClients.galleryId, galleryId), isNull(galleryClients.removedAt)));

  const carts = await tx
    .select({ userId: assetPicks.userId })
    .from(assetPicks)
    .where(and(eq(assetPicks.galleryId, galleryId), isNull(assetPicks.submittedAt)));
  const hasCart = new Set(carts.map((cart) => cart.userId));

  const isDone = (member: { userId: string; lockedAt: Date | null; submittedAt: Date | null }) =>
    !hasCart.has(member.userId) && (member.lockedAt !== null || member.submittedAt !== null);

  const everyoneDone = members.length > 0 && members.every(isDone);

  if (gallery.status === "proofing" && everyoneDone) {
    const updated = await tx
      .update(galleries)
      .set({ status: "selected", selectionSubmittedAt: new Date() })
      .where(and(eq(galleries.id, galleryId), eq(galleries.status, "proofing")))
      .returning({ id: galleries.id });
    return updated.length === 1 ? "selected" : null;
  }

  if (gallery.status === "selected" && !everyoneDone) {
    const updated = await tx
      .update(galleries)
      .set({ status: "proofing" })
      .where(and(eq(galleries.id, galleryId), eq(galleries.status, "selected")))
      .returning({ id: galleries.id });
    return updated.length === 1 ? "proofing" : null;
  }

  return null;
}
