// GraphQL enum for `galleries.selection_tray_mode` — task #204.
//
// UNLIKE `./gallery-status.ts`, this cannot just spread `selectionTrayMode
// .enumValues` (Drizzle's own `pgEnum` export, schema.ts) straight into
// `values` — GraphQL enum member names may only contain `[_a-zA-Z0-9]`, and
// `"by-person"` has a hyphen. `assertName` (graphql-js) throws building the
// schema otherwise, which is how this got caught (`bun run codegen` refused
// to run). So this is the one enum in `./types/*` mapping GraphQL names to
// Postgres values explicitly rather than reusing the array verbatim: each
// key IS the wire-facing name, `value` is the actual Postgres string this
// resolves to and round-trips through `t.expose("selectionTrayMode", ...)`
// on `GalleryType`.
import "server-only";

import { builder } from "../builder";

export const SelectionTrayModeType = builder.enumType("SelectionTrayMode", {
  values: {
    FLAT: { value: "flat" },
    BY_PERSON: { value: "by-person" },
  },
});

/**
 * The inverse of the mapping above, for the one seam that needs it:
 * `/galleries/[publicSlug]/page.tsx` reads `selectionTrayMode` through
 * GraphQL (`client-gallery-reads.ts`) and receives graphql-js's own
 * over-the-wire serialization of an enum — the MEMBER NAME (`"FLAT"` /
 * `"BY_PERSON"`), not the internal `value` configured above. It then hands
 * that field to `<ProofGrid>`/`<SelectionTray>`, which share the exact
 * `Gallery["selectionTrayMode"]` union (`"flat" | "by-person"`) the
 * dashboard's REST-read `GalleryDetail` already uses — one Postgres-shaped
 * type for every non-GraphQL consumer in the app. Converting here, once, at
 * the boundary that actually has both representations, is cheaper and safer
 * than widening every downstream prop to also accept the wire spelling.
 */
export function selectionTrayModeFromWire(wireValue: "FLAT" | "BY_PERSON"): "flat" | "by-person" {
  return wireValue === "BY_PERSON" ? "by-person" : "flat";
}
