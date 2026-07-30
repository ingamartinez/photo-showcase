// The shared, ATTRIBUTED selection of one gallery — "which photos are picked
// right now, and who picked each of them" (task #95, on top of task #94's
// `assets.selectedBy` column).
//
// ONE function, called from exactly two places, deliberately:
//
//   - `src/app/galleries/[publicSlug]/page.tsx`, for the first server-rendered
//     paint of the tray.
//   - `GET /api/galleries/[galleryId]/selection`, for every live refresh after
//     that.
//
// Both surfaces therefore hand `<SelectionTray>` the SAME shape, produced by
// the SAME query. That is the point: the tray's whole job is to converge on
// server truth, and it cannot do that honestly if "what the server said at
// page load" and "what the server says now" are built by two pieces of code
// that could drift.
//
// NO R2 KEYS AND NO PRESIGNED URLS COME OUT OF HERE, ever. The tray renders
// the same thumbnails the grid already has, off `<ProofGrid>`'s own `urls`
// map — task #95's constraint that this feature must not become a second way
// to obtain image bytes. This module returns asset IDs and attribution, and
// the client component looks the picture up in the map it already holds.
//
// The TYPES this returns live in `@/lib/selection-snapshot`, not here: the
// tray is a Client Component and cannot import a `server-only` module even
// for a type. See that file's own header comment.
import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { assets, users } from "@/lib/db/schema";
import type { SelectionPick, SelectionPicker } from "@/lib/selection-snapshot";

/**
 * Every currently-selected asset of one gallery, oldest pick first, with the
 * picker resolved to something renderable.
 *
 * `pickedBy` is resolved by a SECOND, tiny query rather than a `LEFT JOIN` on
 * `users`: the set of distinct pickers is bounded by the number of clients
 * attached to the gallery (two or three, per task #94's own framing), so this
 * is a handful of rows fetched by primary key, and it is skipped entirely
 * — no second round trip at all — for a gallery where nothing is selected
 * yet, which is every gallery's first minutes.
 *
 * The count of what this returns IS `count(assets where is_selected)` — the
 * derived number PLAN.md §3 and schema.ts insist is never stored. Callers
 * feed `picks.length` straight into `computeQuota`; there is no separate
 * counting query to disagree with this one.
 */
export async function getGallerySelection(galleryId: string): Promise<SelectionPick[]> {
  const rows = await db
    .select({
      assetId: assets.id,
      selectedAt: assets.selectedAt,
      selectedBy: assets.selectedBy,
    })
    .from(assets)
    .where(and(eq(assets.galleryId, galleryId), eq(assets.isSelected, true)))
    // Oldest pick first — the tray reads as the order the group actually
    // chose things in, so a photo appearing at the END is a real signal that
    // it was just added by somebody.
    .orderBy(asc(assets.selectedAt));

  const pickerIds = [...new Set(rows.map((row) => row.selectedBy).filter((id) => id !== null))];

  const pickersById = new Map<string, SelectionPicker>();
  if (pickerIds.length > 0) {
    const pickerRows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, pickerIds));
    for (const picker of pickerRows) {
      pickersById.set(picker.id, { id: picker.id, label: picker.name ?? picker.email });
    }
  }

  return rows.map((row) => ({
    assetId: row.assetId,
    selectedAt: row.selectedAt ? row.selectedAt.toISOString() : null,
    // `?? null`, not `!`: a `selected_by` pointing at a row that is no longer
    // in `users` would otherwise render as `undefined`. Same honest "no
    // attribution" outcome as a null column.
    pickedBy: row.selectedBy ? (pickersById.get(row.selectedBy) ?? null) : null,
  }));
}
