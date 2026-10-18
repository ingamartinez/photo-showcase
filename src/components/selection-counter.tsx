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
import { emptyShare, type AttributionShare } from "@/lib/quota-attribution";
import { UNATTRIBUTED_PICKER_LABEL, type SelectionCounter } from "@/lib/selection-snapshot";

// Task #264 — THE PER-PERSON MONEY BREAKDOWN.
//
// THE FINDING THAT MADE THIS NECESSARY: a client with 5 picks was reading a
// "total $273.000" that was the whole gallery's bill. That was correct when a
// gallery was assumed to have one bill-payer; since epic #250 it is false, and
// a global total only reads as the truth when one person pays. So the detail
// now lists PEOPLE first and keeps the gallery total as what it is: the sum.
//
// WHERE THE NUMBERS COME FROM, and why nothing here multiplies: every count
// and every amount below is read off `counter.people[].share` (or
// `counter.unattributedShare`), which the SERVER filled from
// `attributeQuota`'s own buckets — priced by the one `computeQuota` call over
// the whole gallery. This file formats them and never adds them up: the
// "Entre todos" total is `quota.surchargeCop`, read, not summed, so a
// disagreement between the rows and the total cannot be produced here. It is
// also why `units` is the server's `person.units` and never a recount of
// picks.
//
// THE REGRESSION GUARD (the owner's own rule, and every pre-#264 test in this
// file depends on it): one holder of units renders EXACTLY what this
// component rendered before — no breakdown, no "Entre todos", no headline
// change. A single payer IS the gallery-wide total, so repeating it twice
// would be noise, and a gallery where one person picks must not learn a new
// vocabulary overnight.
//
// TASK #269 — TWO LEVELS, NOT ONE WALL. #264 put the rows and the gallery
// total in the same block, and the owner reported two consequences of that
// on 2026-10-18: on desktop the opened detail was a wall (every person's
// numbers plus the whole pricing block at once), and on mobile expanding it
// pushed the grid and the bar around. Both are the same defect — one
// disclosure revealing two different questions — so the detail now has two:
//
//   "Ver detalle"     -> the person rows only, and nothing else.
//   "Ver total de la galería" -> the pre-#264 global block, default closed.
//
// The second control lives INSIDE the bounded scroll region, not next to it:
// expanding it grows that region's content, never the bar's own height, so
// nothing below it moves. And the region stays `max-h-[40vh] overflow-y-auto`
// at EVERY breakpoint (the old `lg:max-h-none lg:overflow-visible` is gone —
// that is exactly what let the desktop detail become the wall the owner saw).
//
// WHEN THE SECOND LEVEL EXISTS: only when more than one row actually HOLDS
// UNITS — `showBreakdown` is looser than that, because it also turns on for
// the viewer's own zero row next to a single holder (or next to a bucket of
// legacy picks with no attribution). That shape has ONE bill-holder, so the
// gallery total IS that holder's amount and there is no wall to break up; it
// keeps this component's pre-#269 output byte for byte, exactly like the
// rows <= 1 single-payer case. A single payer never learns a second control.
export type MoneyRow = {
  key: string;
  /** "Tú" for the viewer, the person's `name ?? email` otherwise, and
   * "Sin registro" for the unattributed bucket. */
  label: string;
  /** The server's own unit count for this row. */
  units: number;
  share: AttributionShare;
  /** The viewer's own row: first, and the only one emphasised. */
  viewer: boolean;
};

/** The rows of the breakdown, in display order: the viewer first (even with
 * zero units — "$ 0 a tu nombre" is information when somebody else holds
 * money), then everybody else by label in `es-CO` order, then "Sin registro"
 * last. Pure and exported so its ordering is testable without a DOM.
 *
 * Sorted by LABEL, like `groupPicksByPicker` in <SelectionTray>, never by
 * amount: rows that reorder as the total moves would make the one number a
 * person cares about — their own — the one that jumps away. */
export function moneyRowsFor(
  counter: SelectionCounter | null | undefined,
  viewerId: string | null | undefined,
): MoneyRow[] {
  if (!counter) return [];
  const id = viewerId ?? null;
  const rows: MoneyRow[] = [];

  if (counter.viewer !== null) {
    const own = id === null ? undefined : counter.people.find((person) => person.userId === id);
    rows.push({
      key: "viewer",
      label: "Tú",
      units: own?.units ?? 0,
      share: own?.share ?? emptyShare(),
      viewer: true,
    });
  }

  rows.push(
    ...counter.people
      .filter((person) => person.userId !== id)
      .map((person) => ({
        key: person.userId,
        label: person.label,
        units: person.units,
        share: person.share,
        viewer: false,
      }))
      .sort((a, b) => {
        const byLabel = a.label.localeCompare(b.label, "es-CO");
        if (byLabel !== 0) return byLabel;
        return a.key === b.key ? 0 : a.key < b.key ? -1 : 1;
      }),
  );

  if (counter.unattributed > 0) {
    rows.push({
      key: "unattributed",
      label: UNATTRIBUTED_PICKER_LABEL,
      units: counter.unattributed,
      share: counter.unattributedShare,
      viewer: false,
    });
  }

  return rows;
}

/** "1 foto" / "2 fotos" — every count in the rows is read, never derived. */
function counted(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

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
  counter,
  viewerId,
  collapsible = false,
}: {
  quota: QuotaResult;
  /** Task #236 — only the sticky proofing bar turns this on: below `lg` the
   * price detail folds behind a "Ver detalle" toggle. Every other caller (the
   * `selected` view in normal flow) keeps the full detail visible, no toggle. */
  collapsible?: boolean;
  /** Task #264 — the server's per-person counter. Omitted (or a counter with
   * at most one holder of units) keeps this component's pre-#264 rendering
   * byte-for-byte. */
  counter?: SelectionCounter;
  /** Task #264 — who "Tú" is. Same value <ProofGrid> already threads to the
   * tray; it authorizes nothing, it only decides whose row is emphasised. */
  viewerId?: string | null;
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
  // Task #264 — the breakdown, and the one condition that gates every bit of
  // it: more than one row means more than one bill-holder, which is the ONLY
  // situation in which "the gallery total" is not already the whole story.
  const moneyRows = moneyRowsFor(counter, viewerId);
  const showBreakdown = moneyRows.length > 1;
  // Task #269 — the second level is for a gallery with SEVERAL bill-holders,
  // not merely several rows: `moneyRows` also carries the viewer's own zero
  // row, which can be the only other row next to a single holder. One holder
  // of units means the gallery total is that holder's own amount (this file's
  // own pre-#264 rule), so there is nothing to hide behind a second control.
  const unitHolders = moneyRows.filter((row) => row.units > 0).length;
  const showTotalLevel = showBreakdown && unitHolders > 1;
  const viewerShare = moneyRows.find((row) => row.viewer)?.share;
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
  const folded = collapsible && !detailOpen;
  // Task #269 — the second level. Independent of `detailOpen` on purpose: the
  // person rows and the gallery total answer different questions, so closing
  // one never silently closes the other.
  const [totalOpen, setTotalOpen] = useState(false);
  const totalId = useId();
  // The compact row's amount. Without originals the surcharge IS the extras
  // amount; with originals `surchargeCop` is the TOTAL of both tariffs, so it
  // gets an honest "en total" label (and shows even at 0 extras).
  // Task #264 — once there is more than one bill-holder, the number that
  // belongs to the person reading the bar is theirs, and it says so ("a tu
  // nombre"). A zero viewer amount keeps the gallery-wide wording: "$ 0 a tu
  // nombre" is only noise, and the detail below already spells the row out.
  const compactAmount =
    showBreakdown && viewerShare && viewerShare.surchargeCop > 0
      ? `${formatCop(viewerShare.surchargeCop)} a tu nombre`
      : hasOriginals
        ? quota.surchargeCop > 0
          ? `${formatCop(quota.surchargeCop)} en total`
          : ""
        : quota.extras > 0
          ? `${formatCop(quota.extrasSurchargeCop)} en extras`
          : "";

  // Task #269 — extracted so the two branches below (single payer: rendered
  // in place; more than one bill-holder: behind the second disclosure) share
  // ONE copy of the pre-#264 gallery block. Content, order and formatter are
  // unchanged on purpose — the second level changes when it shows, never what
  // it says.
  const galleryTotal = (
    <>
      {/* The gallery is the SUM once more than one person holds units,
          and says so — the total below is read off `quota`, never added
          up from the rows above. */}
      {showBreakdown && <p className="text-fg-mute mt-3 text-sm font-medium">Entre todos</p>}
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
          <p className="mt-1">Todas las fotos extra se cobran al precio de la escala alcanzada.</p>
        </div>
      )}
      {hasOriginals && (
        <>
          <p className="text-fg-mute mt-1 text-sm">
            originales {quota.originals} × {formatCop(quota.originalPhotoPriceCopSnapshot)} ={" "}
            {formatCop(quota.originalsSurchargeCop)} — un original nunca ahorra cuota, siempre suma.
          </p>
          <p className="text-fg-mute mt-1 text-sm">
            total {formatCop(quota.surchargeCop)} — se coordina por fuera de la app; acá no se cobra
            nada.
          </p>
        </>
      )}
    </>
  );

  return (
    <div>
      {/* The live region wraps the headline AND the detail, but the toggle is
          OUTSIDE it: a collapsed detail is `hidden` (not announced), while the
          headline numbers — all a collapsed bar shows — keep announcing every
          count change. */}
      <div aria-live="polite">
        <p className="text-fg font-serif text-sm leading-snug lg:text-lg">
          incluidas {quota.includedPhotosSnapshot} · seleccionadas {quota.selected}
          {showBreakdown && " entre todos"}
        </p>
        <div
          id={detailId}
          // Task #269 — bounded and internally scrollable at EVERY breakpoint.
          // The old `lg:max-h-none lg:overflow-visible` is deliberately gone:
          // that is what let the opened desktop detail grow into a wall.
          className={`max-h-[40vh] overflow-y-auto overscroll-contain ${folded ? "max-lg:hidden" : ""}`}
        >
          {/* Task #264 — people first, and (task #269) people ONLY: "Tú" leads
              and is emphasised; the amounts are the server's own shares. */}
          {showBreakdown && (
            <dl className="text-fg-mute mt-1 grid gap-1 text-sm">
              {moneyRows.map((row) => (
                <div key={row.key} className="flex justify-between gap-4">
                  <dt className={row.viewer ? "text-fg font-medium" : undefined}>{row.label}</dt>
                  <dd className={`tabular-nums ${row.viewer ? "text-fg font-medium" : ""}`}>
                    {counted(row.units, "foto", "fotos")} ·{" "}
                    {counted(row.share.extras, "extra", "extras")}
                    {allowsOriginalSelection &&
                      row.share.originals > 0 &&
                      ` · ${counted(row.share.originals, "original", "originales")}`}{" "}
                    · {formatCop(row.share.surchargeCop)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {/* Task #269 — the second level, INSIDE the scroll region so that
              expanding it can never grow the bar or move the grid below it.
              Only rendered when more than one person holds units: a single
              bill-holder gets the pre-#264 detail unchanged, with no extra
              control to explain. */}
          {showTotalLevel ? (
            <>
              <button
                type="button"
                onClick={() => setTotalOpen((open) => !open)}
                aria-expanded={totalOpen}
                aria-controls={totalId}
                className="text-accent focus-visible:ring-accent mt-2 min-h-7 text-xs underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                {totalOpen ? "Ocultar total" : "Ver total de la galería"}
              </button>
              {/* Always mounted, so `aria-controls` always names a real
                  element; empty while closed, so an unopened total takes no
                  space and is absent from the accessibility tree. */}
              <div id={totalId}>{totalOpen && galleryTotal}</div>
            </>
          ) : (
            galleryTotal
          )}
        </div>
      </div>
      {/* Mobile-only second row: the running extras amount (own live region,
          only while the detail is folded and there ARE extras — the expanded
          detail already says it) next to the disclosure toggle. */}
      {collapsible && (
        <div className="flex items-baseline gap-3 lg:hidden">
          {/* Always mounted (live regions announce changes, not insertions);
            `empty:hidden` drops its gap while there is nothing to say. */}
          <span aria-live="polite" className="text-fg text-xs empty:hidden">
            {!detailOpen && compactAmount}
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
      )}
    </div>
  );
}
