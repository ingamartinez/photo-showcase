// The SHAPE of a gallery's shared, attributed selection (task #95, extended by
// epic #250 S6): each asset's claim, the people who asked for it and what each
// of them asked for, the server-computed quota, and the four-number counter.
// Plus the one pure decision about how a person is named. No I/O, no imports
// of anything that touches Postgres or R2.
//
// This module exists for the same reason `@/lib/format` and `@/lib/quota` do,
// and the reason is a production build failure, not tidiness: the tray is a
// Client Component, so anything it imports is bundled for the browser.
// `@/lib/gallery-selection.ts` — which produces these values — is
// `server-only` and reaches Postgres, and `@/lib/db` needs Node's `tls`;
// importing it from a component broke the build once already (see
// `@/lib/format`'s own header comment for that story). So the TYPES and the
// pure label logic live here, imported by the server query, the route and the
// tray alike, and nobody has to remember which side of the boundary they are
// on.
//
// Everything below travels to the browser, so nothing that must not be
// public may be added to these types: no R2 keys, no presigned URLs, no
// gallery id, no session id. Asset ids, people and what they asked for only —
// the tray looks each thumbnail up in the presigned URL map `<ProofGrid>`
// already holds.
import type { QuotaResult } from "@/lib/quota";
// Task #264 — the money breakdown needs the per-person split on the wire, so
// this module names `AttributionShare`. Type-only: `@/lib/quota-attribution`
// is pure (two imports, no I/O — its own test pins that), and the import is
// erased at build time, so nothing new is bundled for the browser.
import type { AttributionShare } from "@/lib/quota-attribution";

/** Same five literals as `Gallery["status"]` in schema.ts, hand-rolled for
 * the identical reason `SelectionKind` below is: a type-only import off a
 * module this close to `@/lib/db` has broken this app's production build
 * before. Keep in sync with `galleryStatus` in schema.ts. */
export type GalleryStatus = "draft" | "proofing" | "selected" | "delivered" | "archived";

/** Who a claimed unit is billed to, or one of the people who asked for it. */
export type SelectionPicker = {
  id: string;
  /** `users.name` when the photographer recorded one, otherwise the email
   * address — the same `name ?? email` fallback every other surface in this
   * app uses for a person (src/lib/clients.ts, the dashboard gallery list,
   * the client-attach form), so a client with no name never renders blank.
   *
   * This is the ONE place in the product where a client can see another
   * client's contact detail, and it is deliberate rather than incidental:
   * everyone who can read it is attached to the SAME gallery (or is the
   * photographer), the photographer created both records, and the
   * alternative — an unattributable pick — removes the only thing task #95
   * exists to show. The email is a FALLBACK, not the default: a named client
   * shows their name and nothing else. */
  label: string;
};

/** What one person asked THEIR pick to become: `edited` (the default) or
 * `original` (delivered as shot, no edit — see `packages.originalPhotoPriceCop`'s
 * own comment in schema.ts, and `assets.selectionKind`'s comment there for the
 * full "original is a commercial label on a request, not a second set of bytes
 * this app can serve" story).
 *
 * Hand-rolled here rather than imported from `@/lib/db/schema`'s own
 * `selectionKind` pgEnum, for the identical reason `GalleryStatus` above is
 * hand-rolled. Keep in sync with `selectionKind` in schema.ts. */
export type SelectionKind = "edited" | "original";

/** The read-time state of one person's pick on one asset. Same literal union
 * as `PickStatus` (pick-resolution.ts:29); a type-level test pins the equality.
 * `cart`: unsent on an unclaimed asset. `degraded`: unsent on an asset somebody
 * else already claimed (decision 8). `billed`: sent, and this person holds the
 * asset's unit. `joined`: sent, but the unit belongs to someone else. */
export type SelectionPickState = "cart" | "degraded" | "billed" | "joined";

/** One person's request for one asset. */
export type SelectionEntryPick = {
  userId: string;
  /** `users.name ?? users.email`, resolved on the server. */
  label: string;
  /** `asset_picks.kind`: what THIS person asked for. */
  kind: SelectionKind;
  /** ISO 8601. */
  pickedAt: string;
  /** ISO 8601; `null` = still "por enviar". */
  submittedAt: string | null;
  /** `derivePickStatus(pick, claimFromAsset(row))`, computed once on the
   * server so no client re-implements the state machine. */
  state: SelectionPickState;
};

/** The resolved claim of one asset: what `assets` stores, written only by
 * submit/admin paths, never by a client PATCH. */
export type SelectionClaim = {
  /** ISO 8601, from `assets.selected_at` — NEVER `requested_at`, which is
   * NULL on the classic claims the 0017 backfill imported. */
  claimedAt: string | null;
  /** `assets.selection_kind`, resolved: edited iff some submitted pick was
   * edited. */
  resolvedKind: SelectionKind;
  /** The unit's holder. `null` = a legacy unit with no recorded owner,
   * rendered "Sin registro". */
  billedTo: SelectionPicker | null;
  /** Which tariff this unit landed in, straight from `attributeQuota`'s own
   * `units[].charge` — the included/extra boundary is quota maths and must
   * not be re-derived on the client. */
  charge: "included" | "extra" | "original";
};

/** One asset that is claimed OR has at least one pick. */
export type SelectionEntry = {
  assetId: string;
  /** `null` iff `assets.is_selected` is false (a pure cart/degraded asset). */
  claim: SelectionClaim | null;
  /** Everyone who asked for this asset, in display order: the billed holder's
   * pick first, then by `pickedAt`, then by id. */
  picks: SelectionEntryPick[];
};

/** The four numbers (decision 14). All computed on the server; the client
 * never counts picks or claims. */
export type SelectionCounter = {
  /** "entre todos": claimed photos. Always `=== quota.selected`. */
  group: number;
  /** The subject's own partition; `null` when there is no subject (an admin
   * without view-as). `yours` may only go down because of somebody else's
   * escalation, never up. */
  viewer: { yours: number; shared: number; toSend: number } | null;
  /** Units per billed person, removed members included, in userId code-unit
   * order. The UI sorts for display.
   *
   * `share` (task #264) is `attributeQuota`'s own `PersonShare` for this
   * person, minus the id: the counts AND the money, priced at the gallery's
   * unit prices by the server. The browser formats it, it never computes it —
   * so `share.included + share.extras + share.originals === units` by
   * construction, and no client can disagree with the gallery total below. */
  people: { userId: string; label: string; units: number; share: AttributionShare }[];
  /** Units billed to nobody ("Sin registro"). */
  unattributed: number;
  /** The "Sin registro" bucket's money, straight from `attributeQuota` — the
   * last term of the Σ invariant the client renders as a row (task #264). */
  unattributedShare: AttributionShare;
};

/** Epic #239 — the per-client selection lock, as the browser sees it. Dates
 * are ISO 8601 strings (this crosses the server/client boundary). */
export type ViewerLock = {
  /** When this viewer stopped being able to change picks. */
  lockedAt: string;
  /** When the viewer pressed "Enviar selección" themselves — `null` when an
   * admin locked them instead. */
  submittedAt: string | null;
  /** Task #244 — WHO locked the viewer, computed on the SERVER from
   * `gallery_clients.selection_locked_by`. The client never infers it from
   * `submittedAt` (a member can order and later be locked by the
   * photographer). Optional for older snapshots and test doubles. */
  lockedBy?: "client" | "admin" | null;
};

export type SelectionLockSnapshot = {
  /** `null` while the viewer is open (and always when there is no subject,
   * e.g. an admin without view-as). */
  viewerLock: ViewerLock | null;
  /** User ids of every ACTIVE client the PHOTOGRAPHER locked. Only admin
   * locks are written since epic #250 S5; a `'client'` lock survives only as
   * history in closed galleries, where `isGalleryLocked` already freezes
   * everything, so it is not listed here. */
  adminLockedPickerIds: string[];
  /** Task #244 — the subject's own LAST submit time (ISO), whether or not it
   * locked them. Under order semantics a submit never locks, so
   * `viewerLock.submittedAt` is always absent there and this is the only
   * place "Último envío" can come from. `null` before any submit or without a
   * subject. */
  viewerSubmittedAt: string | null;
};

/** The `GET /api/galleries/[galleryId]/selection` body, and the shape the page
 * hands `<ProofGrid>` in pieces. */
export type SelectionSnapshot = {
  status: GalleryStatus;
  submittedAt: string | null;
  quota: QuotaResult;
  counter: SelectionCounter;
  entries: SelectionEntry[];
  viewerLock: ViewerLock | null;
  adminLockedPickerIds: string[];
  viewerSubmittedAt: string | null;
};

/** Copy shown when a unit has no attribution at all — see
 * `SelectionClaim.billedTo`. Deliberately not a name-shaped guess: the tray
 * would rather admit it does not know than credit the wrong person. */
export const UNATTRIBUTED_PICKER_LABEL = "Sin registro";

/**
 * How one person's request is named in the tray, from the point of view of the
 * session looking at it.
 *
 * The viewer's OWN pick reads "Tú", not their own name: with two or three
 * people picking into one shared set, the question the tray answers is "who
 * asked for this", and "me / one of the others" is the distinction that
 * actually matters when a photo you did not ask for appears. Tuteo also
 * matches the voice the rest of this app's Spanish copy uses (task #262's own
 * copy rule: "Toca", "puedes", "escríbele").
 */
export function pickerLabelFor(pickedBy: SelectionPicker | null, viewerId: string | null): string {
  if (!pickedBy) return UNATTRIBUTED_PICKER_LABEL;
  if (viewerId !== null && pickedBy.id === viewerId) return "Tú";
  return pickedBy.label;
}

/** The CLAIMED entries, in server (arrival) order. Every expression that used
 * to read the old `picks` list reads this, and only this — a filter, never a
 * count. */
export function claimedEntries(entries: readonly SelectionEntry[]): SelectionEntry[] {
  return entries.filter((entry) => entry.claim !== null);
}

/** The viewer's own pick on one entry, or `null`. Identity is the user id,
 * never the label. */
export function viewerPickOf(
  entry: SelectionEntry,
  viewerId: string | null,
): SelectionEntryPick | null {
  if (viewerId === null) return null;
  return entry.picks.find((pick) => pick.userId === viewerId) ?? null;
}
