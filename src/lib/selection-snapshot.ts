// The SHAPE of a gallery's shared, attributed selection (task #95), plus the
// one pure decision about how a picker is named. No I/O, no imports of
// anything that touches Postgres or R2.
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
// gallery id, no session id. Asset ids and picker attribution only — the tray
// looks each thumbnail up in the presigned URL map `<ProofGrid>` already
// holds.

/** Who picked one photo. */
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

/** Task #206 — what the client asked THIS pick to become: `edited` (the
 * default, today's only pre-#206 behavior) or `original` (delivered as shot,
 * no edit — see `packages.originalPhotoPriceCop`'s own comment in schema.ts,
 * and `assets.selectionKind`'s comment there for the full "original is a
 * commercial label on a request, not a second set of bytes this app can
 * serve" story).
 *
 * Hand-rolled here rather than imported from `@/lib/db/schema`'s own
 * `selectionKind` pgEnum, for the identical reason `use-shared-selection.ts`
 * hand-rolls `GalleryStatus` instead of importing `Gallery["status"]`: even a
 * type-only import off a module this close to `@/lib/db` has broken this
 * app's production build before (see that file's own header comment) —
 * duplicating one two-value string union costs nothing and removes the need
 * to ever reason about it again. Keep in sync with `selectionKind` in
 * schema.ts. */
export type SelectionKind = "edited" | "original";

export type SelectionPick = {
  assetId: string;
  /** ISO 8601, or `null` for a row whose `selected_at` was never stamped.
   * Kept in lockstep with `is_selected` by the PATCH selection route since
   * task #24, so in practice this is always set for a selected asset. */
  selectedAt: string | null;
  /** `null` when `assets.selected_by` is null. Two reachable ways to get
   * there, both honest states rather than bugs: a pick made before task #94
   * added the column, and a picker whose `users` row was later deleted
   * (`onDelete: "set null"`, schema.ts). The tray says so plainly instead of
   * guessing a name. */
  pickedBy: SelectionPicker | null;
  /** Task #206 — travels the SAME channel every other fact about a pick
   * already does (the server render, the poll route, the PATCH route's own
   * response, the SSE-triggered refresh): there is no second channel for
   * "what type is this pick", by design — see `use-shared-selection.ts`'s
   * own `setSelectionKind`. Meaningless for an asset that isn't picked at
   * all (that's `assets.isSelected`, a separate question); every entry in a
   * `SelectionPick[]` IS picked by construction, so this is never optional
   * here. */
  selectionKind: SelectionKind;
};

/** Copy shown when a pick carries no attribution at all — see
 * `SelectionPick.pickedBy`. Deliberately not a name-shaped guess: the tray
 * would rather admit it does not know than credit the wrong person. */
export const UNATTRIBUTED_PICKER_LABEL = "Sin registro";

/**
 * How one pick's picker is named in the tray, from the point of view of the
 * session looking at it.
 *
 * The viewer's OWN picks read "Vos", not their own name: with two or three
 * people picking into one shared set, the question the tray answers is "who
 * chose this", and "me / one of the others" is the distinction that actually
 * matters when a photo you did not pick appears. Second person also matches
 * the voice the rest of this app's Spanish copy already uses ("Todavía no
 * subiste fotos…").
 */
export function pickerLabelFor(pickedBy: SelectionPicker | null, viewerId: string | null): string {
  if (!pickedBy) return UNATTRIBUTED_PICKER_LABEL;
  if (viewerId !== null && pickedBy.id === viewerId) return "Vos";
  return pickedBy.label;
}
