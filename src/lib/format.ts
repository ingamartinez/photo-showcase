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
