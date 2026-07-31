// The ONE ownership check for "is this session allowed to act on this
// gallery" — task #94 (2026-07-29): a gallery moved from a single
// `clientId` FK to the `galleryClients` join table (schema.ts), and every
// route that used to write `gallery.clientId === session.user.id` needs the
// same new comparison. Rewriting that comparison independently in each call
// site is exactly the duplication that produced kanban #86/#87/#88/#91 in
// one day — this module exists so it is written, and gets fixed, exactly
// once.
//
// Admin bypass is intentional and UNIVERSAL here: every existing call site
// this replaces (asset-access.ts's loadOwnedAsset, the submit-selection and
// download-all routes, the client gallery page) already treated an admin as
// "owns everything", so `isGalleryOwner` preserves that. This is a
// DIFFERENT function from `getGalleriesForClient` in src/lib/galleries.ts,
// which deliberately has NO admin bypass — see that function's own header
// comment for why the two must not be conflated. `isGalleryOwner` answers
// "may this session act on THIS ONE gallery" (a single-gallery guard, where
// "an admin may act on anything" is the correct, existing rule);
// `getGalleriesForClient` answers "which galleries does this exact user id
// own" for the CLIENT's own `/galleries` list, where an admin asking the
// same question must get back only galleries where their OWN id is
// attached — never a bypass onto every gallery in the system.
import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import type { Session } from "next-auth";
import { db } from "@/lib/db";
import { galleryClients } from "@/lib/db/schema";

/**
 * Whether `session` may act on the gallery identified by `galleryId` — an
 * admin, unconditionally, or a client attached to it via `gallery_clients`.
 *
 * Takes a bare `galleryId`, not a loaded `Gallery` row, on purpose: every
 * call site already has the id (from the gallery row it just fetched, or
 * from the asset row's own `galleryId`, per asset-access.ts's own header
 * comment on never trusting a caller-supplied gallery id) and this keeps the
 * helper usable before or after that fetch, without forcing a particular
 * query shape on the caller.
 */
export async function isGalleryOwner(galleryId: string, session: Session): Promise<boolean> {
  if (session.user.role === "admin") return true;

  // Task #97 — THE safety-critical filter the whole removal feature rests
  // on: a removed client's row is a SOFT delete (`removedAt` set, never
  // deleted — schema.ts's own comment on `galleryClients`), and this is the
  // ONE ownership check every route/resolver in the app shares (this
  // module's own header comment). Without `isNull(galleryClients.removedAt)`
  // here, removing a client would revoke NOTHING at all — the row would
  // still match this `where`, and every caller of `isGalleryOwner` would
  // keep letting them in. Mutation-proven in gallery-access.test.ts: dropping
  // this condition makes a removed client pass again.
  const [row] = await db
    .select({ userId: galleryClients.userId })
    .from(galleryClients)
    .where(
      and(
        eq(galleryClients.galleryId, galleryId),
        eq(galleryClients.userId, session.user.id),
        isNull(galleryClients.removedAt),
      ),
    )
    .limit(1);

  return row !== undefined;
}

/**
 * Whether `session` is an admin looking at `/galleries/[publicSlug]` — the
 * CLIENT'S OWN view of a gallery — rather than a client who actually owns it
 * (task #139).
 *
 * This is an ORIENTATION question, not a permission one: it decides whether
 * to show the "you're previewing this as the client sees it" banner, nothing
 * else. It grants no capability and blocks no write. `isGalleryOwner` above
 * already lets an admin act on any gallery unconditionally — task #66
 * (closed 2026-07-30, owner-approved) decided that fork deliberately in
 * favor of attribution (`assets.selectedBy`, task #94) over narrowing the
 * toggle, and task #139's own correction note is explicit that re-narrowing
 * it here would relitigate a closed decision. Do not wire this into any
 * write path — see this function's own name: "previewing", not "acting as".
 */
export function isAdminPreviewingClientGallery(session: Session): boolean {
  return session.user.role === "admin";
}
