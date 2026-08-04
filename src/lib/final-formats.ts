// Accepted final-upload formats — the SINGLE source of truth for both the
// server-side gate (POST /api/assets/[assetId]/final) and the two client
// file pickers that need to match it (src/components/asset-tile.tsx,
// src/components/finals-bulk-uploader.tsx).
//
// EXTRACTED FOR A REAL REASON, NOT PREEMPTIVELY (task #220 review follow-up):
// this map used to live only in the route file, and the two pickers hand-
// copied the same MIME list into their own `accept` attribute with nothing
// enforcing the two stayed in sync. They drifted for real, twice, inside
// this ONE task: #218 narrowed both pickers to `image/jpeg` only; #220's
// first pass widened the route's map to add PNG but left both pickers
// exactly as #218 left them — the owner's PNG finals were greyed out in the
// native file dialog even after the server would have happily accepted
// them. A reviewer mutation then proved the gap directly: adding
// `"image/tiff"` to a route-local copy of this map left all 1847 tests
// green, because nothing tied the pickers' `accept` string to the server's
// own list at all — a component test asserting a literal string only
// catches an edit to THAT component, never the server widening out from
// under it.
//
// Same "pull the shared rule into its own leaf module" precedent this
// codebase already has twice for the identical reason: `final-access.ts`
// (task #103, one gate instead of two hand-copied `if`s that could drift)
// and `final-filename-match.ts` (task #217, one matcher instead of a
// component re-deriving the same mapping rule). This module follows that
// shape rather than reinventing one.
//
// NO SERVER-ONLY IMPORTS — no `@/lib/db`, no `@/lib/r2`, no `next/server`,
// nothing that reads an env var or touches a database — specifically so a
// "use client" component can import this module directly. That is what
// actually closes the gap above: `FINAL_UPLOAD_ACCEPT` below is DERIVED from
// the same map the route imports, so a future format added to
// `ACCEPTED_FINAL_FORMATS` widens both pickers' `accept` attribute for free,
// by construction, with no second string to remember to update.
//
// An ALLOWLIST of two, not "any `image/*`" — every accepted entry must have
// a KNOWN extension (what `finalKey()`, src/lib/r2.ts, needs) and be
// something `processDisplay` (src/lib/images.ts) can decode into the
// browsing derivative every accepted format still gets. Adding TIFF/WebP
// later is a one-line change to this map; neither is added speculatively
// here — there is no evidence today's photographer produces either.
// Anything not in this map is refused 415 `not_an_image` by the route.
export const ACCEPTED_FINAL_FORMATS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** The `accept` attribute value for a final-upload `<input type="file">` —
 * every key of `ACCEPTED_FINAL_FORMATS` above, comma-joined, in insertion
 * order. Used verbatim by both asset-tile.tsx's per-tile picker and
 * finals-bulk-uploader.tsx's bulk picker; neither hand-copies the format
 * list any more. */
export const FINAL_UPLOAD_ACCEPT = Object.keys(ACCEPTED_FINAL_FORMATS).join(",");
