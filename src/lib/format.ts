// Plain, client-safe formatters — no `server-only`, no `@/lib/db`, no
// dependency of any kind on Postgres. This is deliberately its own module,
// separate from `@/lib/galleries` (which DOES import `@/lib/db`, and
// therefore Postgres, and therefore Node's `tls`): a Client Component that
// imports even ONE export off a module with a `db` import at its top
// bundles the WHOLE module graph behind it into the browser bundle, and
// `next build` fails outright trying to resolve `tls` for the browser
// target (task #24's review — `src/components/selection-counter.tsx`
// pulling `formatCop` off `@/lib/galleries` broke the production build this
// exact way; Vitest never bundles for the browser, so 368 green tests never
// caught it). Anything here must stay pure and DB-free so it can be
// imported from a Client Component without dragging the database in behind
// it — that is the whole reason this file exists, not a stylistic
// preference.

/** Colombian peso, whole units (the schema's *_cop columns carry no
 * decimals — see schema.ts). Used for the frozen package terms shown on the
 * gallery detail page (and the client's live quota counter,
 * src/components/selection-counter.tsx); never for anything computed off
 * the LIVE `packages` row (see src/lib/galleries.ts's header comment and
 * PLAN.md §3's snapshot rule). */
export function formatCop(amountCop: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(amountCop);
}

// ---------------------------------------------------------------------------
// Gallery-count pluralizers (tasks #49 / #90).
//
// Both used to live inside the module that queries the count they format —
// `formatGalleryCount` in `@/lib/clients` (per-client tally) and
// `formatGalleryCountTotal` in `@/lib/galleries` (studio-wide tally) — purely
// because that is where the number came from, not because either function
// touches the database. That placement had two costs:
//
//   1. `src/app/dashboard/clients/page.chrome.test.tsx` cannot import
//      `@/lib/clients` at all (it drags in `import "server-only"`, which
//      jsdom cannot resolve — same failure class documented on this file's
//      own header comment). The test had to mock the whole module AND
//      re-implement the pluralizer's logic inside that mock just to assert
//      on it, so the two copies could silently drift (#49).
//   2. The two names — `formatGalleryCount` / `formatGalleryCountTotal` —
//      differ only by a suffix, one typo away from importing the wrong one
//      at a call site that would still type-check (#90's review of #88).
//
// Moving both here fixes #1 by construction: this module has no
// `server-only` import, so the chrome tests below import the REAL function
// instead of copying it. It fixes #2 by giving each a name that says what it
// counts, not just how it differs from its sibling.
// ---------------------------------------------------------------------------

/** Spanish, pluralized copy for how many galleries belong to ONE client —
 * shown next to each row on `/dashboard/clients` (task #18). "Sin galerías
 * todavía" at zero, same shape as this file's `formatCop` above: a
 * grammatically real Spanish sentence for every input, not a caller-side
 * special case. */
export function formatClientGalleryCount(galleryCount: number): string {
  if (galleryCount === 0) return "Sin galerías todavía";
  if (galleryCount === 1) return "1 galería";
  return `${galleryCount} galerías`;
}

/** Spanish, pluralized copy for the STUDIO-WIDE gallery total shown on
 * `/dashboard` (task #88) — see the section comment above for why this
 * lives here (not `@/lib/galleries`) and why it is no longer named merely
 * by appending "Total" to `formatClientGalleryCount`. Has no zero case:
 * `/dashboard` (src/app/dashboard/page.tsx) renders its own "Todavía no
 * armaste ninguna galería." copy for that count, so this is never called
 * with 0 in practice — same division of labor `formatPendingSelectionCount`
 * (`@/lib/galleries`) already has with its caller. */
export function formatStudioGalleryCount(galleryCount: number): string {
  if (galleryCount === 1) return "1 galería";
  return `${galleryCount} galerías`;
}

// ---------------------------------------------------------------------------
// Client-count and pending-selection pluralizers (task #122).
//
// `formatClientCount` (formerly `@/lib/clients`) and
// `formatPendingSelectionCount` (formerly `@/lib/galleries`) were left behind
// when #49/#90 moved the two gallery-count pluralizers above — #49's own
// scope named the gallery-count collision specifically, and #90's fold-in
// note scoped itself to `formatGalleryCount`/`formatGalleryCountTotal`. That
// left `src/app/dashboard/page.chrome.test.tsx` re-implementing both
// functions' logic inside its whole-module mocks of `@/lib/clients` and
// `@/lib/galleries` (each pulled in for jsdom `server-only` reasons, same as
// this file's own header comment), just to assert on them — the exact
// "wiring test copies the logic it asserts on" smell #49 exists to remove,
// now closed for the last two survivors too.
// ---------------------------------------------------------------------------

/** Spanish, pluralized copy for `getClientCount`'s result (`@/lib/clients`)
 * — the total client count on `/dashboard` (task #88). Distinct from
 * `formatClientGalleryCount` above, which describes how many galleries
 * belong to ONE client, not how many clients exist across the whole studio. */
export function formatClientCount(clientCount: number): string {
  if (clientCount === 1) return "1 cliente";
  return `${clientCount} clientes`;
}

/** Spanish, pluralized copy for `getPendingSelectionCount`'s result
 * (`@/lib/galleries`). Returns `null` at zero — the dashboard renders
 * nothing in that case rather than a "0 selecciones esperando" that would
 * just be noise (same shape as `formatStudioGalleryCount` above, but zero
 * has no useful sentence here). */
export function formatPendingSelectionCount(pendingCount: number): string | null {
  if (pendingCount <= 0) return null;
  if (pendingCount === 1) return "1 selección esperando";
  return `${pendingCount} selecciones esperando`;
}

/** Bare, locale-grouped digit for a `/dashboard` stat tile's OWN number line
 * (task #130's follow-up fix, review round 1) — as opposed to
 * `formatClientCount`/`formatStudioGalleryCount`/`formatPendingSelectionCount`
 * above, which each return a full Spanish SENTENCE ("14 clientes", "1
 * selección esperando") for the prose line above the tiles. A tile's own
 * eyebrow ("CLIENTES") already carries the noun the sentence forms repeat, so
 * the first pass at the tile redesign called those same sentence formatters
 * for the tile's number too, except at zero (where it fell back to a literal
 * `"0"` to avoid the empty-state formatters' own zero-case sentences) — three
 * tiles in the same grid row each showing a differently-shaped value
 * (sentence / bare zero / always-bare pending count), caught in review
 * against `design/system/dashboard.html:655-669`'s uniform eyebrow + bare
 * `.stat__n` digit. `Intl.NumberFormat` rather than a template-literal
 * `${count}` for the same reason `formatCop` above reaches for it: digit
 * grouping matters the moment a studio's client or gallery count crosses
 * three figures, and there is no reason to leave that bug for a future slice
 * to find when the module already has the pattern for it. */
export function formatTileCount(count: number): string {
  return new Intl.NumberFormat("es-CO").format(count);
}

/** Human-scale byte count — binary units (1024-based, matching
 * `ZIP32_MAX_TOTAL_BYTES`'s own "~4 GiB" framing in src/lib/zip-stream.ts),
 * labeled the colloquial way ("GB", not "GiB") since this is read by a
 * photographer, not written into a spec. One decimal place above bytes
 * themselves — task #92's own gallery-detail archive-size warning
 * (`@/lib/gallery-archive-size`) is the one caller: "4.1 GB" reads faster
 * than "4,401,845,516 bytes". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const decimals = unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}
