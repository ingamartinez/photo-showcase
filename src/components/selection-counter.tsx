"use client";

// The live quota counter (task #24): "incluidas 13 · seleccionadas 15" on one
// line, "extras 2 × $5.000 = $10.000 — se coordina por fuera de la app" on
// the next. Purely presentational — every number it renders is handed to it
// already computed by `computeQuota`
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
// TASK #206 — THE TWO-TARIFF BREAKDOWN, AND THE RULE IT HAS TO PROTECT.
// `computeQuota` now also returns `extrasSurchargeCop`/`originalsSurchargeCop`
// (src/lib/quota.ts's own comment on why those exist) — the pre-multiplied
// halves this file reads instead of ever computing `quota.extras *
// quota.extraPhotoPriceCopSnapshot` itself, which would break this file's own
// "never subtracts or multiplies anything" promise above.
//
// THE GOVERNING CONSTRAINT (the owner's own restriction, added after this
// task was written): a gallery where nobody marked an original must look
// EXACTLY as it did before this slice — not a breakdown row that says "0
// originales — $0", which would be a default-behaviour change dressed up as
// a zero. So the extra lines below are ABSENT, not zeroed, whenever
// `quota.originals === 0` — and the FIRST line (`extras N × price = X`) reads
// `quota.extrasSurchargeCop` rather than `quota.surchargeCop` specifically so
// its own rendered digits stay byte-identical to before: the two are
// mathematically equal whenever `originals` is 0 (originals contribute
// nothing to either), and only diverge once there is something to show
// beneath them.
//
// Once `quota.originals > 0`, TWO more lines appear: how many originals at
// their own price, and a TOTAL line summing both tariffs — the task's own
// requirement that the breakdown stay "legible in vivo": marking a photo
// original never saves quota, it always adds to what is owed, and a client
// has to be able to see that arithmetic live, not just at submit.
//
// `formatCop` comes from `@/lib/format`, NOT `@/lib/galleries` — this is a
// Client Component (rendered by `<ProofGrid>`, which is `"use client"`), and
// `@/lib/galleries` imports `@/lib/db` (Postgres), which needs Node's `tls`.
// Importing it here bundled the whole DB module graph into the browser
// bundle and broke the production build; see `@/lib/format`'s own header
// comment for the full story.
import { useId, useState } from "react";
import { tierRangeLabel } from "@/lib/extra-price-tiers";
import { formatCop } from "@/lib/format";
import { tierIndexForExtras, type QuotaResult } from "@/lib/quota";

// Task #193 — the package's NAME is deliberately never a prop here, and
// never was going to become one again: the owner's decision (this
// component's own callers cite it) is that a client must never be able to
// read "Estándar · incluidas 20" here and cross-reference it against
// `/contact`'s public price list to deduce they got a special deal. This
// applies to EVERY gallery, overridden or not — see proof-grid.tsx's own
// comment on why the omission has to be unconditional, not just for
// overridden galleries. Only the NUMBERS survive: "incluidas 20 ·
// seleccionadas 14".
export function SelectionCounter({
  quota,
  allowsOriginalSelection,
}: {
  quota: QuotaResult;
  /** Task #214 — the gallery's own switch. `false` (every gallery's default,
   * schema.ts's own comment on `galleries.allowsOriginalSelection`) hides the
   * originals breakdown below EVEN IF `quota.originals` is somehow non-zero
   * (should never happen once `updateAllowsOriginalSelection` ships a reset
   * in the same transaction as turning the switch off — but this display
   * surface does not trust that invariant to hold everywhere upstream of it;
   * "absent, not zeroed" is the governing constraint on the FLAG, not only on
   * the count). */
  allowsOriginalSelection: boolean;
}) {
  const hasOriginals = allowsOriginalSelection && quota.originals > 0;
  // Task #231 — the gallery's volume scale, when it has one. `quota` already
  // carries the unit price in force (`extraUnitPriceCop`); this only lists the
  // frozen steps and marks the one `quota.extras` has reached, via the shared
  // helpers in extra-price-tiers.ts — no price is computed in this file. A
  // flat-price gallery (`null`) renders nothing extra.
  const tiers = quota.extraPhotoPriceTiersSnapshot;
  const activeTier = tiers ? tierIndexForExtras(quota.extras, tiers) : -1;

  // Task #236 — below `lg` the price detail sits behind a disclosure so the
  // bottom bar is one compact row by default. The collapse is the
  // `max-lg:hidden` class (display:none: out of the a11y tree and tab order,
  // like the tray's native `hidden`) and NOT the `hidden` attribute: Tailwind's
  // preflight makes `[hidden]` display:none !important, which would also hide
  // the detail at lg and up, where it must always be visible (the toggle is
  // not shown there either), exactly as before this task.
  const [detailOpen, setDetailOpen] = useState(false);
  const detailId = useId();

  return (
    <div>
      {/* The live region wraps the headline AND the detail, but the toggle is
          OUTSIDE it: a collapsed detail is `hidden` (not announced), while the
          headline numbers — all a collapsed bar shows — keep announcing every
          count change. */}
      <div aria-live="polite">
        <p className="text-fg font-serif text-sm leading-snug lg:text-lg">
          incluidas {quota.includedPhotosSnapshot} · seleccionadas {quota.selected}
        </p>
        <div
          id={detailId}
          className={`max-h-[40vh] overflow-y-auto overscroll-contain lg:max-h-none lg:overflow-visible ${detailOpen ? "" : "max-lg:hidden"}`}
        >
          <p className="text-fg-mute mt-1 text-sm">
            extras {quota.extras} × {formatCop(quota.extraUnitPriceCop)} ={" "}
            {formatCop(quota.extrasSurchargeCop)}
            {!hasOriginals && " — se coordina por fuera de la app; acá no se cobra nada."}
          </p>
          {tiers && (
            <div className="text-fg-mute mt-2 text-sm">
              <p>Precio por foto extra, según cuántas extras elijas:</p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                {tiers.map((tier, i) => (
                  <li
                    key={tier.minExtras}
                    aria-current={i === activeTier ? "true" : undefined}
                    className={i === activeTier ? "text-fg font-semibold" : undefined}
                  >
                    {tierRangeLabel(tiers, i)} fotos: {formatCop(tier.priceCop)} c/u
                  </li>
                ))}
              </ul>
              <p className="mt-1">
                Todas las fotos extra se cobran al precio de la escala alcanzada.
              </p>
            </div>
          )}
          {hasOriginals && (
            <>
              <p className="text-fg-mute mt-1 text-sm">
                originales {quota.originals} × {formatCop(quota.originalPhotoPriceCopSnapshot)} ={" "}
                {formatCop(quota.originalsSurchargeCop)} — un original nunca ahorra cuota, siempre
                suma.
              </p>
              <p className="text-fg-mute mt-1 text-sm">
                total {formatCop(quota.surchargeCop)} — se coordina por fuera de la app; acá no se
                cobra nada.
              </p>
            </>
          )}
        </div>
      </div>
      {/* Mobile-only second row: the running extras amount (own live region,
          only while the detail is folded and there ARE extras — the expanded
          detail already says it) next to the disclosure toggle. */}
      <div className="flex items-baseline gap-3 lg:hidden">
        {/* Always mounted (live regions announce changes, not insertions);
            `empty:hidden` drops its gap while there is nothing to say. */}
        <span aria-live="polite" className="text-fg text-xs empty:hidden">
          {quota.extras > 0 && !detailOpen && `${formatCop(quota.surchargeCop)} en extras`}
        </span>
        <button
          type="button"
          onClick={() => setDetailOpen((open) => !open)}
          aria-expanded={detailOpen}
          aria-controls={detailId}
          className="text-accent focus-visible:ring-accent min-h-7 text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {detailOpen ? "Ocultar detalle" : "Ver detalle"}
        </button>
      </div>
    </div>
  );
}
