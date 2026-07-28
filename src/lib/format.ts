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
