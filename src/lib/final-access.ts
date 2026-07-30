// The single gate deciding whether a session may reach a gallery's PAID
// DELIVERABLES for one asset — the full-resolution final (task #16/#26/#28)
// and, since task #89, the browsing-sized display derivative built from it.
//
// This module exists because task #89 required the display derivative to be
// gated "exactly the download's ... same ownership check, no new path around
// it". "Exactly" is not something a copy-pasted `if` can promise: two copies
// of a four-condition boolean drift the first time one of them is edited, and
// the leg most likely to be edited (`gallery.status !== "delivered"`) is the
// one protecting the photographer's unwatermarked work. Extracting the
// predicate makes "the two cannot disagree" a property of the code rather
// than of whoever reviews the next change to it — mutate one condition here
// and BOTH routes' tests go red.
//
// Ownership is NOT part of this predicate. It is checked separately and
// first, by `loadOwnedAsset` (src/lib/asset-access.ts), which is also what
// produces the `asset`/`gallery` rows passed in here — resolving the gallery
// from the asset's own foreign key rather than from anything the caller
// supplied. Keeping the two apart is deliberate: ownership answers "is this
// your gallery at all", this answers "is this particular photo a deliverable
// yet". Collapsing them into one function would make it possible to satisfy
// the second while quietly skipping the first.
import type { Session } from "next-auth";
import type { Asset, Gallery } from "@/lib/db/schema";

/**
 * Whether the paid deliverables for `asset` may be served to `session`.
 * Every condition is checked independently rather than inferred from another
 * — the "don't infer one condition from another" stance the final route has
 * documented since task #16:
 *
 * - `asset.isSelected` — the client actually picked this photo. Owning the
 *   gallery must not unlock a final for a photo they never selected, even if
 *   the photographer uploaded one by mistake.
 * - `asset.isEdited` — the photographer finished it. Checked EXPLICITLY, not
 *   inferred from `finalKey`: the POST handler writes both in one update
 *   today, but this gate does not lean on that invariant holding forever.
 * - `asset.finalKey` — the R2 object actually exists. A stray key must never
 *   unlock the two conditions above by itself; conversely, those two must
 *   never unlock a deliverable that was never uploaded.
 * - `gallery.status === "delivered"` — PLAN.md §2's state machine. This is
 *   the one the photographer's leverage rests on: before delivery, a client
 *   must not reach an unwatermarked pixel of their session, no matter what is
 *   already sitting in R2.
 *
 * ADMIN CARVE-OUT, on the delivered leg ONLY (decided in task #26, inherited
 * from #63's review, and preserved verbatim here rather than re-litigated):
 * the photographer must be able to preview a final they just uploaded before
 * flipping the gallery to `delivered` — task #16's gate exists to stop a
 * CLIENT seeing a final early, not to blind the photographer to their own
 * upload. The other three conditions stay unconditional, admin included: an
 * admin previewing a final still needs one to exist, on a photo the client
 * actually selected.
 *
 * Written as a TYPE PREDICATE (`asset is A & { finalKey: string }`), not a
 * plain boolean, so a caller that passes this gate gets `asset.finalKey`
 * narrowed to `string` and has no reason to re-check it. A plain boolean
 * would have left every call site with a redundant `|| !asset.finalKey`
 * purely to satisfy the compiler — and a redundant copy of a gate condition
 * at a call site is exactly the drift this module exists to remove. This is
 * also why the parameters are positional rather than one options object: a
 * TypeScript type predicate can only narrow a named parameter, never a
 * destructured property of one.
 */
export function canReadFinalDeliverable<
  A extends Pick<Asset, "isSelected" | "isEdited" | "finalKey">,
>(asset: A, gallery: Pick<Gallery, "status">, session: Session): asset is A & { finalKey: string } {
  const deliveredGateAppliesToThisSession = session.user.role !== "admin";
  return (
    asset.isSelected &&
    asset.isEdited &&
    asset.finalKey !== null &&
    !(deliveredGateAppliesToThisSession && gallery.status !== "delivered")
  );
}
