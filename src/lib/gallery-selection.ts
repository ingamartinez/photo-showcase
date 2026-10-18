// The shared, ATTRIBUTED selection of one gallery — each asset's resolved
// claim, everyone who asked for it, the server-computed quota and the
// four-number counter (epic #250 S6, on top of task #95 and S4/S5's
// `asset_picks` model).
//
// ONE builder, called from three places, deliberately:
//
//   - `src/app/galleries/[publicSlug]/page.tsx`, for the first
//     server-rendered paint of the tray and the counter.
//   - `GET /api/galleries/[galleryId]/selection`, for every live refresh
//     after that.
//   - `PATCH /api/assets/[assetId]/selection`, so a confirmed toggle answers
//     with the SAME entry and counter the next snapshot will carry.
//
// All surfaces therefore hand the client the SAME shape, produced by the SAME
// code. That is the point: the tray's whole job is to converge on server
// truth, and it cannot do that honestly if "what the server said at page
// load" and "what the server says now" are built by two pieces of code that
// could drift.
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

import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getSelectionLockSnapshot, type DbExecutor } from "@/lib/gallery-client-locks";
import { readPickState } from "@/lib/pick-claims";
import { claimFromAsset, derivePickStatus } from "@/lib/pick-resolution";
import { attributeQuota } from "@/lib/quota-attribution";
import { unitsOf, type AssetRow, type PickRow } from "@/lib/pick-plans";
import {
  UNATTRIBUTED_PICKER_LABEL,
  type SelectionClaim,
  type SelectionCounter,
  type SelectionEntry,
  type SelectionEntryPick,
  type SelectionLockSnapshot,
  type SelectionPicker,
} from "@/lib/selection-snapshot";
import type { GalleryQuotaSnapshot, QuotaResult } from "@/lib/quota";

/** Everything the client needs about one gallery's selection, from ONE
 * consistent read (see `getGallerySelection`). */
export type GallerySelectionView = {
  entries: SelectionEntry[];
  quota: QuotaResult;
  counter: SelectionCounter;
  lock: SelectionLockSnapshot;
};

/** The pure part: all derivation, no I/O. `rows` and `picks` come from
 * `readPickState`, so the write paths and these reads see the same state. */
export function buildGallerySelection(input: {
  rows: AssetRow[];
  picks: PickRow[];
  labels: ReadonlyMap<string, string>;
  terms: GalleryQuotaSnapshot;
  subjectId: string | null;
}): Omit<GallerySelectionView, "lock"> {
  const { rows, picks, labels, terms, subjectId } = input;

  const attribution = attributeQuota(unitsOf(rows), terms);
  const unitById = new Map(attribution.units.map((unit) => [unit.assetId, unit]));
  const picksByAsset = new Map<string, PickRow[]>();
  for (const pick of picks) {
    const list = picksByAsset.get(pick.assetId);
    if (list) list.push(pick);
    else picksByAsset.set(pick.assetId, [pick]);
  }

  const pickerFor = (userId: string | null): SelectionPicker | null => {
    if (userId === null) return null;
    const label = labels.get(userId);
    return label ? { id: userId, label } : null;
  };

  const entryFor = (row: AssetRow): SelectionEntry => {
    const claim: SelectionClaim | null = row.isSelected
      ? {
          // `selected_at`, NEVER `requested_at`: the latter is NULL on the
          // classic claims 0017 backfilled, so reading it would silently drop
          // their claim time.
          claimedAt: row.selectedAt ? row.selectedAt.toISOString() : null,
          resolvedKind: row.selectionKind,
          billedTo: pickerFor(row.billedTo),
          charge: unitById.get(row.id)?.charge ?? "included",
        }
      : null;

    const entryPicks: SelectionEntryPick[] = (picksByAsset.get(row.id) ?? [])
      .map((pick) => ({
        userId: pick.userId,
        label: labels.get(pick.userId) ?? UNATTRIBUTED_PICKER_LABEL,
        kind: pick.kind,
        pickedAt: pick.pickedAt.toISOString(),
        submittedAt: pick.submittedAt ? pick.submittedAt.toISOString() : null,
        state: derivePickStatus(pick, claimFromAsset(row)),
      }))
      .sort((a, b) => {
        // The billed holder's chip first, then arrival, then id — the same
        // deterministic order S7's mock delta calls for.
        if (row.billedTo !== null) {
          if (a.userId === row.billedTo && b.userId !== row.billedTo) return -1;
          if (b.userId === row.billedTo && a.userId !== row.billedTo) return 1;
        }
        const diff = a.pickedAt.localeCompare(b.pickedAt);
        if (diff !== 0) return diff < 0 ? -1 : 1;
        return a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1;
      });

    return { assetId: row.id, claim, picks: entryPicks };
  };

  const rowsById = new Map(rows.map((row) => [row.id, row]));

  // Claimed entries first, in `attributeQuota`'s arrival order (the same order
  // the included/extra boundary is cut in). `units` covers every claimed row.
  const entries: SelectionEntry[] = [];
  const placed = new Set<string>();
  for (const unit of attribution.units) {
    const row = rowsById.get(unit.assetId);
    if (!row) continue;
    entries.push(entryFor(row));
    placed.add(row.id);
  }

  // Then unclaimed entries that still have somebody's cart or degraded pick,
  // earliest pick first (deterministic; the tray may re-sort for display).
  const unclaimed = rows
    .filter((row) => !row.isSelected && !placed.has(row.id) && picksByAsset.has(row.id))
    .map((row) => {
      const earliest = Math.min(
        ...(picksByAsset.get(row.id) ?? []).map((pick) => pick.pickedAt.getTime()),
      );
      return { row, earliest };
    })
    .sort((a, b) =>
      a.earliest !== b.earliest ? a.earliest - b.earliest : a.row.id < b.row.id ? -1 : 1,
    );
  for (const { row } of unclaimed) entries.push(entryFor(row));

  // The subject's own partition, counted by pick state. "Tuyas" can only go
  // down when somebody else escalates; it never goes up because another
  // CLIENT acted (decision 7).
  let viewer: SelectionCounter["viewer"] = null;
  if (subjectId !== null) {
    let yours = 0;
    let shared = 0;
    let toSend = 0;
    for (const entry of entries) {
      for (const pick of entry.picks) {
        if (pick.userId !== subjectId) continue;
        if (pick.state === "billed") yours += 1;
        else if (pick.state === "joined") shared += 1;
        else toSend += 1;
      }
    }
    viewer = { yours, shared, toSend };
  }

  const counter: SelectionCounter = {
    // `quota.selected` and the number of claimed entries are the same number
    // by construction (both are `units.length`); derived once here so a test
    // can assert they agree rather than the code assuming it.
    group: attribution.units.length,
    viewer,
    people: attribution.people.map((person) => ({
      userId: person.userId,
      label: labels.get(person.userId) ?? UNATTRIBUTED_PICKER_LABEL,
      units: person.included + person.extras + person.originals,
    })),
    unattributed:
      attribution.unattributed.included +
      attribution.unattributed.extras +
      attribution.unattributed.originals,
  };

  return { entries, quota: attribution.quota, counter };
}

/**
 * The whole read, in ONE read-only, repeatable-read transaction.
 *
 * `readPickState` is two selects. Read under READ COMMITTED, a submit or an
 * admin removal landing between them can produce a state `derivePickStatus`
 * and `reresolveClaim` throw on (a submitted pick over an unclaimed asset).
 * That is a 500 from correct data. REPEATABLE READ gives every statement the
 * same snapshot, so this can only see a committed state; the throw stays as a
 * loud assertion about real contradictions.
 *
 * `subjectId` decides whose "tuyas / compartidas / por enviar" and whose lock
 * the view describes. `null` = nobody (an admin without view-as): the
 * counter's viewer partition and the viewer lock are both null, and the
 * gallery-wide numbers are unchanged.
 */
export async function getGallerySelection(
  galleryId: string,
  terms: GalleryQuotaSnapshot,
  subjectId: string | null,
): Promise<GallerySelectionView> {
  return db.transaction(
    async (tx) => {
      const { rows, picks } = await readPickState(tx, galleryId);
      const labels = await labelsFor(tx, rows, picks);
      const lock = await getSelectionLockSnapshot(galleryId, subjectId, tx);
      return { ...buildGallerySelection({ rows, picks, labels, terms, subjectId }), lock };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** `userId -> name ?? email` for everybody named in the read: every picker
 * and every billed holder. One query, skipped entirely when nothing is
 * claimed or picked (every gallery's first minutes). */
async function labelsFor(
  executor: DbExecutor,
  rows: readonly AssetRow[],
  picks: readonly PickRow[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const pick of picks) ids.add(pick.userId);
  for (const row of rows) if (row.isSelected && row.billedTo !== null) ids.add(row.billedTo);
  if (ids.size === 0) return new Map();

  const found = await executor
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, [...ids]));
  return new Map(found.map((user) => [user.id, user.name ?? user.email]));
}
