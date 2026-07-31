// The live quota counter (task #24): "Estándar · incluidas 13 ·
// seleccionadas 15" on one line, "extras 2 × $5.000 = $10.000 — se coordina
// por fuera de la app" on the next. Purely presentational — every number it
// renders is handed to it already computed by `computeQuota`
// (src/lib/quota.ts), never derived here. This is what keeps the maths in
// ONE pure, unit-tested place instead of scattered across components: this
// file only ever formats numbers it is given, it never subtracts or
// multiplies anything itself.
//
// TASK #147 — THE HARDEST DESIGN PROBLEM IN THE EPIC, restated in
// design/system/client.html's own words: the surcharge has to be
// "impossible to not see" and, at the exact same time, must never read as a
// threat — a client picking wedding photos is not filling a shopping cart.
// Two things follow from that, and neither is cosmetic:
//
//   - THE APP NEVER CHARGES (PLAN.md §3), and until this task that fact only
//     ever appeared once, inside <SubmitSelectionPanel>'s confirmation
//     dialog — which fires ONCE, at the very end of a session that can run
//     twenty minutes. For every one of those minutes before that, a client
//     watching "extras 2 × $5.000 = $10.000" tick upward had no visible
//     reminder that the number is not a bill. It reads exactly like a
//     checkout total unless something on the SAME line says otherwise. The
//     second line now carries that reminder every time this renders, not
//     only at submit.
//   - Always shows all three parts, even when `extras` is 0 — "going over
//     the quota is upsell, never an error" (task #24) means there is
//     nothing to hide when a client is still within their included count;
//     the same sentence SHAPE at every count is also what makes the number
//     changing (not the shape of the sentence) the only thing the client
//     notices as they toggle. A counter that only grows a clause once
//     `extras > 0` would dramatize the exact moment of crossing the
//     threshold — the opposite of what "never scolds" needs. This file
//     never branches its own copy on `quota.extras`'s value, only on its
//     digits.
//
// TWO LINES, NOT ONE, split deliberately along a real seam: the first is
// the identity of the pick ("what package, how many, how many chosen"), the
// second is the money conversation ("what that costs, and where that
// conversation happens"). Splitting them is also what keeps the sentence
// short enough to read on a phone in one glance without wrapping into a
// third line next to <SubmitSelectionPanel>'s own button — see
// proof-grid.tsx's own comment on the sticky bar these two share.
//
// `formatCop` comes from `@/lib/format`, NOT `@/lib/galleries` — this is a
// Client Component (rendered by `<ProofGrid>`, which is `"use client"`), and
// `@/lib/galleries` imports `@/lib/db` (Postgres), which needs Node's `tls`.
// Importing it here bundled the whole DB module graph into the browser
// bundle and broke the production build; see `@/lib/format`'s own header
// comment for the full story.
import { formatCop } from "@/lib/format";
import type { QuotaResult } from "@/lib/quota";

export function SelectionCounter({
  packageName,
  quota,
}: {
  packageName: string;
  quota: QuotaResult;
}) {
  return (
    <div aria-live="polite">
      <p className="text-fg font-serif text-lg leading-snug">
        {packageName} · incluidas {quota.includedPhotosSnapshot} · seleccionadas {quota.selected}
      </p>
      <p className="text-fg-mute mt-1 text-sm">
        extras {quota.extras} × {formatCop(quota.extraPhotoPriceCopSnapshot)} ={" "}
        {formatCop(quota.surchargeCop)} — se coordina por fuera de la app; acá no se cobra nada.
      </p>
    </div>
  );
}
