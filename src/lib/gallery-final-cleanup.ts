// Task #287 — PHYSICAL cleanup of the finals a delivered reopen detaches.
//
// The reopen action (`src/app/dashboard/galleries/actions.ts`) clears
// `final_key/is_edited/is_extra/delivered_for` on every asset in ONE database
// transaction, together with the status CAS, the membership reset and the
// whole-gallery cancellation of picks and claims. Bytes are NOT touched there,
// and that ordering is not negotiable: an object deletion cannot be rolled
// back by a failed commit, so deleting first would risk a live row pointing at
// missing bytes (the failure `src/app/api/assets/[assetId]/route.ts` already
// rejects).
//
// Instead the same transaction writes a durable one-row-per-gallery manifest
// (`gallery_final_cleanup`, see schema.ts) listing every object to remove, and
// this module drains it AFTER that commit. Restoring orphan bytes is not the
// goal here — the owner explicitly does not want orphans — so the manifest is
// what makes the obligation survive a process death: a crash between the two
// transactions leaves an admin-visible pending row and a retry that resumes
// from the SAME captured keys, not from memory.
//
// WHY THE DRAINER RE-CHECKS REFERENCES. R2 keys here are deterministic
// (`finalKey` per gallery/asset/extension, `displayKey` per gallery/asset), so
// a fresh upload landing between the reset and the drain can legitimately own
// the very path an old object was at. Deleting from the captured list without
// re-reading would destroy a new cycle's file. Every delete therefore happens
// under the gallery row lock, after re-reading the current final keys, and any
// captured key that is currently referenced — a live `final_key` or the
// display derivative of a live `final_key` — is dropped from the obligation
// instead of being deleted.
//
// WHAT THIS DOES NOT CLAIM. It is not a PostgreSQL↔R2 distributed
// transaction. A storage request that times out is ambiguous about remote
// completion, and an operator writing to the bucket directly bypasses the lock
// discipline entirely. The guarantee is bounded to cooperating application
// writers and to storage calls that settle before returning.
import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, galleryFinalCleanup } from "@/lib/db/schema";
import { deleteObject, displayKey, storedKey } from "@/lib/r2";
import { lockGalleryRow } from "@/lib/gallery-client-locks";

/** How many DELETEs are in flight at once inside the locked pass. Deliberately
 * small: the gallery row lock is held for their whole duration, and the largest
 * real galleries carry tens of objects, not thousands. */
const DELETE_BATCH_SIZE = 3;

export type FinalCleanupResult =
  | { status: "cleaned" }
  /** The obligation survives; `remainingKeys` is its size after this pass.
   * Omitted only when the recovery read itself failed. */
  | { status: "pending"; remainingKeys?: number }
  /** The manifest is unknown to this call — it is gone (idempotent `cleaned`
   * is returned in that case) or belongs to a different reopen epoch. Nothing
   * was deleted. */
  | { status: "changed" };

function sameEpoch(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/** The protected set for one gallery: every object a CURRENT row still
 * references. A display derivative is protected whenever its asset has a final
 * — not only when `isEdited` happens to be true — because the display route
 * resolves through that deterministic builder.
 *
 * Both the sibling display path of the final's OWN namespace (a stored key
 * carries the namespace that was active when it was written) and the current
 * process's `displayKey` are protected. Protecting more than strictly
 * necessary only ever leaves a stale object behind; protecting less would
 * delete a live derivative. */
function protectedKeysOf(
  galleryId: string,
  rows: readonly { id: string; finalKey: string | null }[],
): Set<string> {
  const protectedKeys = new Set<string>();
  for (const row of rows) {
    if (row.finalKey === null) continue;
    protectedKeys.add(row.finalKey);
    const marker = "/finals/";
    const markerIndex = row.finalKey.lastIndexOf(marker);
    if (markerIndex > 0) {
      protectedKeys.add(`${row.finalKey.slice(0, markerIndex + 1)}display/${row.id}.webp`);
    }
    protectedKeys.add(displayKey(galleryId, row.id));
  }
  return protectedKeys;
}

/** Deletes `keys` in bounded batches, retrying each rejected key ONCE in the
 * same locked pass (no sleeping loop, no automatic endless retry). Returns the
 * keys that are still unresolved. */
async function deleteOutsideProtected(keys: readonly string[]): Promise<string[]> {
  const unresolved: string[] = [];
  for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
    const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((key) => deleteObject(storedKey(key))));
    const failed = batch.filter((_, index) => results[index]!.status === "rejected");
    if (failed.length === 0) continue;
    const retried = await Promise.allSettled(failed.map((key) => deleteObject(storedKey(key))));
    failed.forEach((key, index) => {
      if (retried[index]!.status === "rejected") unresolved.push(key);
    });
  }
  return unresolved;
}

/**
 * Drains the pending cleanup obligation of one gallery, in its own transaction
 * whose FIRST operation is the gallery row lock.
 *
 * Outcomes:
 * - no manifest -> `cleaned`, nothing written (idempotent retry);
 * - `expectedEpoch` differs from the stored one -> `changed`, no deletes: the
 *   caller is retrying an obligation a later reopen already replaced;
 * - every captured key is now either deleted or protected by a live upload ->
 *   manifest removed, `cleaned`;
 * - some keys still rejected after one immediate retry -> `remainingKeys`
 *   shrinks to exactly those and stays `pending`. The reopen itself is NOT
 *   undone: it committed already and remains correct.
 *
 * A manifest whose epoch disagrees with the LOCKED gallery's own `unlockedAt`
 * throws instead of sweeping: that combination cannot be produced by this
 * action, so it means somebody/something wrote either row outside the contract.
 */
export async function drainGalleryFinalCleanup(
  galleryId: string,
  expectedEpoch: Date,
): Promise<FinalCleanupResult> {
  let result: FinalCleanupResult = { status: "cleaned" };

  await db.transaction(async (tx) => {
    const lockedGallery = await lockGalleryRow(tx, galleryId);
    if (!lockedGallery) {
      result = { status: "changed" };
      return;
    }

    const [manifest] = await tx
      .select()
      .from(galleryFinalCleanup)
      .where(eq(galleryFinalCleanup.galleryId, lockedGallery.id))
      .limit(1);
    if (!manifest) {
      result = { status: "cleaned" };
      return;
    }

    // The retry carries the epoch it was rendered with. A newer reopen owns a
    // newer manifest; this call must not sweep the wrong obligation.
    if (!sameEpoch(manifest.reopenEpoch, expectedEpoch)) {
      result = { status: "changed" };
      return;
    }
    if (!sameEpoch(manifest.reopenEpoch, lockedGallery.unlockedAt)) {
      throw new Error(
        `gallery-final-cleanup: manifest epoch does not match gallery ${galleryId}'s unlocked_at; ` +
          "refusing to sweep a manifest this app cannot explain",
      );
    }

    // FRESH references, under the lock — never the pre-reset snapshot.
    const photos = await tx
      .select({ id: assets.id, finalKey: assets.finalKey })
      .from(assets)
      .where(eq(assets.galleryId, lockedGallery.id));
    const protectedKeys = protectedKeysOf(lockedGallery.id, photos);

    const targets = manifest.remainingKeys.filter((key) => !protectedKeys.has(key));
    const unresolved = await deleteOutsideProtected(targets);

    if (unresolved.length === 0) {
      await tx
        .delete(galleryFinalCleanup)
        .where(eq(galleryFinalCleanup.galleryId, lockedGallery.id));
      result = { status: "cleaned" };
      return;
    }

    // Only the still-failed keys are persisted; the protected ones were
    // resolved by a fresh upload and must not be retried forever.
    await tx
      .update(galleryFinalCleanup)
      .set({ remainingKeys: unresolved })
      .where(eq(galleryFinalCleanup.galleryId, lockedGallery.id));
    result = { status: "pending", remainingKeys: unresolved.length };
  });

  return result;
}

/** The admin-facing read: is a cleanup still pending for this gallery, and how
 * many objects does it still owe? Object keys are NEVER returned — they are an
 * internal storage detail and the admin action takes none from the client. */
export async function readGalleryFinalCleanup(
  galleryId: string,
): Promise<{ reopenEpoch: string; remainingKeys: number } | null> {
  const [row] = await db
    .select({
      reopenEpoch: galleryFinalCleanup.reopenEpoch,
      remainingKeys: galleryFinalCleanup.remainingKeys,
    })
    .from(galleryFinalCleanup)
    .where(eq(galleryFinalCleanup.galleryId, galleryId))
    .limit(1);
  if (!row) return null;
  return {
    reopenEpoch: row.reopenEpoch.toISOString(),
    remainingKeys: row.remainingKeys.length,
  };
}
