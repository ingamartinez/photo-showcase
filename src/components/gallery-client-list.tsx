"use client";

// The gallery detail page's client list (task #273): a grid that fills the
// whole width of its column instead of one narrow stack, capped at TWO ROWS
// with the rest behind a "Ver todos" / "Mostrar menos" disclosure.
//
// WHY COLUMNS AND NOT ROW HEIGHTS. The precedent worth knowing about is
// `selection-tray.tsx`'s two-row budget, and it is deliberately NOT copied
// here: that budget measures one item's height and clips with `overflow`, so
// the extra items stay mounted, tabbable and inside the accessibility tree.
// Acceptable there (the tray is a scrolling region); not acceptable here,
// because this is a DISCLOSURE — the criterion is that the rows behind the
// toggle are neither focusable nor announced. The only measurement that
// allows HIDING the surplus is how many columns the grid resolved to: grid
// auto-placement is row-major and every `<li>` spans one cell, so items
// `0 … 2c − 1` are exactly rows 1–2, whatever their heights are. Draft rows
// (~46px), non-draft rows (~74px, the per-person tally) and an open "Quitar"
// confirmation all become irrelevant — nothing here measures a height.
//
// WHY `grid-template-columns` AND NOT `offsetTop`. Counting how many items
// share a row from their `offsetTop` would loop: hiding items removes them
// from the layout and changes the very thing being measured. The resolved
// template does not depend on how many children are hidden, so observing the
// `<ul>` converges in one pass.
//
// THE SENTINEL, AND WHY IT IS THE WHOLE BUG THIS FILE EXISTS AROUND. State is
// `columns: number | null`, and `null` means UNMEASURED — never "one column".
// Unmeasured renders EVERY row and NO toggle. That happens (a) before the
// first measurement, (b) when `ResizeObserver` does not exist, (c) when the
// resolved value is `""` (jsdom: no stylesheet, so no cascade at all), and
// (d) when it holds anything that is not a list of px tracks (`none`, an
// unresolved `repeat(auto-fill, …)`, …). Every one of those must degrade to
// "show everything"; a fallback of `1` would clamp a 3-column grid to two
// visible rows and silently hide the rest — the failure mode is a list that
// looks plausible and is wrong, which is why `countGridColumns` returns `null`
// and never a number it did not read.
//
// NOTHING IS UNMOUNTED. Overflow rows get the native `hidden` attribute on
// the `<li>` this component owns (same technique as `selection-tray.tsx`),
// which is `display: none` — out of the tab order, out of the accessibility
// tree — while each row keeps its own `useActionState` (resend, removal, and
// epic #239/#250's selection actions) across a collapse/expand cycle. An open
// "Quitar → Confirmar" confirmation on a row that becomes hidden stays open
// and invisible, and cannot fire: submitting needs a click on "Confirmar",
// which `display: none` makes unreachable by pointer and by keyboard. The one
// accepted cost: a `role="status"` result that arrives while its row is
// hidden is not announced, and is simply visible again on expand.
//
// The accept/reject decisions behind this shape (keep the attach form
// outside, don't move "+ Agregar cliente" into the grid) belong to the page
// and to task #273's own body, not here.
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A resolved track as browsers serialize a used `grid-template-columns`
 * value: `"300px 300px 300px"`. */
const PX_TRACK = /^\d+(\.\d+)?px$/;

/** How many columns the grid resolved to, or `null` when the value cannot be
 * read — which means UNMEASURED, never "one column". Exported for its own
 * unit test; the component is its only caller in shipped code. */
export function countGridColumns(value: string): number | null {
  const tracks = value
    .trim()
    .split(/\s+/)
    .filter((track) => track.length > 0);
  if (tracks.length === 0) return null;
  if (!tracks.every((track) => PX_TRACK.test(track))) return null;
  return tracks.length;
}

export function GalleryClientList({
  items,
}: {
  /** One entry per active client, in display order. `row` is the page's own
   * `<GalleryClientRow>` element, built server-side with every server-computed
   * prop (`removable`, `resendable`, `selection`, `preview`) already applied;
   * this component only places it in the grid, so nothing new crosses the
   * server/client boundary. */
  items: { id: string; row: ReactNode }[];
}) {
  const [columns, setColumns] = useState<number | null>(null);
  // Starts collapsed — that is the point of the slice: reach the proof grid
  // below without scrolling past every client first.
  const [collapsed, setCollapsed] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  // `useLayoutEffect`, not `useEffect`: on client-side navigation into this
  // page it measures and collapses before the first paint, so there is no
  // flash of every row. (The first `useLayoutEffect` in src/ — React 19 no
  // longer warns about one during SSR, and the server render simply stays
  // unmeasured, i.e. renders everything.)
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const measure = () => {
      setColumns(countGridColumns(window.getComputedStyle(list).gridTemplateColumns));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Observing the `<ul>` covers viewport resizes: the column count is a
    // function of its width. Re-measuring with an unchanged number is a
    // no-op (`setColumns` bails out), so the height change that collapsing
    // causes cannot feed back into a loop.
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [items.length]);

  const visibleCount = columns === null ? items.length : 2 * columns;
  const hiddenCount = items.length - visibleCount;
  const overflow = hiddenCount > 0;

  return (
    <div className="flex flex-col items-start gap-2">
      {/* `grid-cols-1` at the base is deliberate rather than redundant: the
          mock's base has no template at all, and the resolved value of an
          implicit-only track list is not a px track, which the sentinel above
          would have to treat as unmeasured forever. An explicit
          `repeat(1, minmax(0,1fr))` resolves to one px value, and `minmax(0,
          …)` also stops a long email from widening the track.

          `minmax(190px,1fr)` rather than the mock's 280px
          (design/system/dashboard.html:600) — an owner decision recorded in
          task #273: at 280px the left column (viewport − 620px) yields ONE
          column on every 1024–1187px laptop, which is the exact defect this
          slice removes. 190px is what makes 2/3/4/6 columns fit at
          1024/1280/1476/1920. */}
      <ul
        id={listId}
        ref={listRef}
        aria-label="Clientes de la galería"
        className="grid w-full grid-cols-1 gap-2 lg:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]"
      >
        {items.map(({ id, row }, index) => (
          <li key={id} hidden={overflow && collapsed && index >= visibleCount} className="min-w-0">
            {row}
          </li>
        ))}
      </ul>

      {overflow && (
        // The disclosure names its own state and carries the hidden count, so
        // the toggle says how much it is hiding rather than only what it will
        // do. `min-h-11` is the 44px touch floor; `lg:min-h-6` the 24px
        // pointer floor (epic #125's rule from #129).
        <button
          type="button"
          onClick={() => setCollapsed((current) => !current)}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
        >
          {collapsed ? `Ver todos (${hiddenCount})` : "Mostrar menos"}
        </button>
      )}
    </div>
  );
}
