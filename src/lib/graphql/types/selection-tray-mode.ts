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
 *
 * AN EXHAUSTIVE `switch`, not `wireValue === "BY_PERSON" ? ... : "flat"` —
 * review finding: the ternary's `: "flat"` branch is a SILENT fallback,
 * indistinguishable from "the feature is genuinely off" for every value that
 * is not exactly `"BY_PERSON"`, including a typo, a stale wire format, or a
 * third mode added to the Postgres enum without this function being updated.
 * Today the two-member union type makes that unreachable at the TYPE level,
 * but that only means the compiler is the guard — nothing stops a caller
 * from widening the parameter, and the `default` arm below throws rather
 * than quietly returning the flat default, so a real drift fails loudly
 * instead of rendering the wrong tray and reporting success.
 */
export function selectionTrayModeFromWire(wireValue: "FLAT" | "BY_PERSON"): "flat" | "by-person" {
  switch (wireValue) {
    case "FLAT":
      return "flat";
    case "BY_PERSON":
      return "by-person";
    default: {
      // Exhaustiveness check: if a third member is ever added to the wire
      // enum without updating this `switch`, `wireValue` stops being `never`
      // here and `bun run typecheck` fails at this line — not a runtime
      // guess away.
      const exhaustive: never = wireValue;
      throw new Error(`selectionTrayModeFromWire: unknown wire value "${String(exhaustive)}"`);
    }
  }
}
