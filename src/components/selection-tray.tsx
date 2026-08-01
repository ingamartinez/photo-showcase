"use client";

// The collaborative selection tray (task #95) — the owner's own request,
// verbatim in intent: "when a photo is selected it moves into a list at the
// TOP of the page, in the same thumbnail style as the grid, saying who chose
// it, in real time, so several clients can collaborate properly."
//
// Purely presentational. It computes nothing, fetches nothing, and owns no
// state: `<ProofGrid>` holds the single source of truth for the shared
// selection (seeded server-side, then converged on the server's own snapshot
// every tick — see that component's polling section) and hands this the
// already-decided list. Same discipline as <SelectionCounter>, and for the
// same reason: two components deriving "what is selected" independently is
// exactly the class of bug kanban #86 was.
//
// NO PRESENCE. The owner asked for attribution of PICKS, not "who is online"
// (task #95 is explicit). There is no viewer list here, no green dot, and
// nothing in the transport reports that a session merely has the page open.
//
// THUMBNAILS COME FROM THE GRID'S OWN PRESIGNED URL MAP, passed in as `urls`.
// This component never fetches an image URL and never sees an R2 key — R2
// objects stay private and there is exactly ONE way to obtain bytes for an
// asset, the one `<ProofGrid>` already owns. A pick whose asset is not in the
// map (an asset uploaded after this page was rendered, which an admin can do
// while a gallery is still `proofing`) renders as a labelled placeholder
// rather than a broken image: stale-but-honest, and it resolves itself the
// next time the client loads the page.
//
// ALWAYS VISIBLE, decided rather than defaulted. The tray renders even when
// nobody has picked anything yet, showing what it is for. Two reasons: the
// collaboration surface is the point of this screen and a client who never
// sees it before their first pick has no idea their partner's picks will
// appear there; and a tray that materialises on the first pick would shove
// the entire grid down the page at the exact moment the client is aiming at
// a thumbnail.
//
// STICKY TO THE TOP (task #147, design/system/client.html's own `.tray`,
// `position: sticky; top: 0` in the app — the mock's own comment at :286
// offsets it under its demo chrome, which this app has none of). "Se pega
// arriba, así la ves formarse mientras recorrés 84 fotos" — the tray is
// where the shared pick, and therefore the surcharge, is building up, and
// scrolling it out of view while browsing 84 photos is exactly the "the
// client reaches the end surprised" failure #147 exists to close. `z-30`,
// below the lightbox's `z-50` (proof-lightbox.tsx) and the sticky bottom
// bar's `z-40` (proof-grid.tsx) — the tray must never sit on top of either.
//
// DECLARED DEVIATION FROM THE MOCK: this file does NOT build the tray-IS-
// the-quota treatment client.html proposes for this exact screen — 13
// dashed `.slot--ghost` placeholders pre-filling as photos are picked
// (:663-669), a `.tray__cut` divider plus an "Extra" `.tray__tag` once the
// count passes the included quota (:751-754), and per-slot avatar-initial
// attribution (`.slot__by`) replacing the name printed under each thumbnail
// here. That whole treatment was SEEN, not missed: it is the mock's own
// answer to #147's hardest problem (making the surcharge impossible to not
// see), and it is a genuinely different, richer design than what shipped.
//
// It was scoped OUT of this slice, not deferred by oversight, for two
// reasons. First, cost against what #147's actual acceptance criteria need:
// the surcharge already cannot be missed via the mechanism this slice DID
// build — <ProofGrid>'s sticky bottom bar keeps <SelectionCounter>'s
// "seleccionadas N · extras E × price = surcharge — se coordina por fuera de
// la app" pinned to the viewport for the entire session, which is a lower-
// risk way to satisfy "visible before submitting, on the phone" than
// reshaping this component's slot model to double as a progress meter.
// Second, blast radius: turning the tray into a quota widget changes what a
// "slot" IS (a pick today; a pick-or-an-empty-quota-seat under the mock)
// and would touch every test in selection-tray.test.tsx plus the shared
// attribution model #145's own review already flagged as delicate (see this
// task's kanban body, "El mock contradice el schema" — a single-avatar-per-
// tile decision the OWNER had to make explicitly, in writing, before any
// visual work proceeded). Re-doing that same kind of identity-model
// judgment for the tray's own avatars, inside the same slice that already
// touches the counter, the bar and both grid states, was judged too much
// surface for one pass.
//
// Revisit if the owner wants the progressive "watch the quota fill up"
// feeling specifically — the sticky bar already covers the letter of "never
// miss the surcharge," but not the mock's particular way of making it feel
// earned rather than announced.
//
// TASK #203 — COLLAPSIBLE, HEIGHT-CAPPED TRAY. The tray above was correct in
// isolation but never bounded its own height: with ~50 picks on a 390px
// phone the `<ul>` grew to ~17 wrapped rows (~2100px) and, being
// `sticky top-0`, sat fixed over the grid instead of scrolling away —
// production clients hit this and could no longer reach the grid at all.
// Two additions close that, in order of how much they change the markup:
//
// 1. THE LIST'S OWN SCROLL CAP IS MEASURED, NOT GUESSED. The naive fix is a
//    hardcoded `max-h-[…]`, e.g. `max-h-[248px]` for "two rows" — this file's
//    own math (96px image + 4px `mt-1` + a line at Tailwind's preflight
//    `line-height: 1.5` × the label's `text-[11px]` ≈ 116.5px/row, doubled
//    plus one `gap-3` ≈ 245px) lands almost exactly there, which is the
//    trap: that number is only right as long as nobody ever changes the
//    label's type scale, and it is silently wrong the day someone does.
//    `<TrayItem>`'s label already carries `truncate` (one line, no wrap —
//    see there), so row height IS deterministic; this file still measures
//    the real rendered height of the first `<li>` (see the effect below)
//    rather than re-deriving that arithmetic here, so the cap tracks
//    whatever the label's actual computed line-height turns out to be
//    instead of a number frozen at the moment this comment was written.
//
// 2. COLLAPSIBLE, STARTING EXPANDED. A control folds the list away, leaving
//    only the header — but the header's counter (not the list) is what the
//    `aria-live="polite"` region below has left to announce once collapsed;
//    see the comment on that `<span>`. The hidden subtree uses the native
//    `hidden` attribute rather than a CSS-only visibility trick, because
//    `hidden` is the one technique that removes an element from BOTH the
//    accessibility tree and the tab order in every major browser — a
//    visually-hidden-but-focusable div would leave a collapsed tray's
//    thumbnails reachable by Tab, exactly the trap the task called out.
//
// Deliberately NOT done, per the task body: no auto-scroll when a pick
// lands (hostile under a moving finger, and the grid tile + header counter
// already give feedback) and no reordering of picks (would reshuffle a list
// the client is actively looking at).
// TASK #204 — FLAT vs. BY-PERSON MODE, AND WHY THE HEIGHT CAP HAD TO BE
// RE-DECIDED, NOT REUSED. #203 (above) capped the flat list by measuring its
// own first `<li>` — that works only because every item in a FLAT list is
// uniform. `by-person` groups the SAME picks under one header per picker, and
// those groups are NOT uniform: a group of 20 photos and a group of 1 would
// otherwise produce wildly different "two rows" caps depending on which
// picker happened to render first, which is not what "two rows" is supposed
// to mean.
//
// RESOLUTION (this file's own decision, task body's first option): the cap
// is a PIXEL BUDGET equivalent to flat mode's, not "two rows of groups" —
// switching modes must not change how much of the screen the tray occupies,
// which is almost certainly what the photographer setting this expects, and
// it sidesteps "two rows of WHAT" entirely for a shape that has no uniform
// row. The budget is still MEASURED, never hardcoded, from a REAL rendered
// `<TrayItem>` inside the grouped list (same 96px image + one-line label
// markup flat mode uses — see the effect below), so it tracks the exact same
// arithmetic #203 already established, just applied to a different ref.
//
// THIS DOES NOT TOUCH #203'S OWN MECHANISM. The flat branch below (`mode ===
// "flat"`) is byte-for-byte what #203 shipped: same `listRef`, same
// `maxListHeightPx` state, same effect, same JSX. A second, independent ref/
// state/effect trio exists purely for the `by-person` branch — reusing (or
// generalizing) the flat measurement here was deliberately rejected: a
// "generalize the selector" refactor would touch code that also runs for
// `flat`, and the app's own constraint on this slice is that flat's current
// behavior must not depend on a mechanism shared with a mode it didn't have
// yesterday, even if the two happen to compute the same number today.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Gallery } from "@/lib/db/schema";
import {
  pickerLabelFor,
  type SelectionPick,
  UNATTRIBUTED_PICKER_LABEL,
} from "@/lib/selection-snapshot";

/** One picker's row in `by-person` mode: a label, a count, and — deliberately
 * `SelectionPick[]`, not just a count — the picker's own picks, IN THE ORDER
 * `getGallerySelection()` returned them (oldest first). Grouping never
 * reorders within a group; see `groupPicksByPicker`'s own comment. */
export type PickGroup = {
  /** `pickedBy.id`, or the sentinel below for the unattributed group. Used as
   * the React key and as the identity a viewer/alphabetical sort compares
   * against — never the label, which two different people can share. */
  key: string;
  /** From `pickerLabelFor`, same function (and same "Vos" convention) every
   * individual thumbnail in this file already uses — see `groupPicksByPicker`
   * for why the viewer's OWN group header also reads "Vos" rather than their
   * real name. */
  label: string;
  picks: SelectionPick[];
};

/** Not a real picker id (those are `users.id`, uuids) — a sentinel so the
 * unattributed group can be told apart from a real group without comparing
 * against `null` in three different places. */
const UNATTRIBUTED_GROUP_KEY = "__unattributed__";

/**
 * Groups a gallery's picks by who picked them, for `by-person` mode —
 * PRESENTATION only (task #204's own acceptance criterion 9):
 * `getGallerySelection()` still returns one flat, oldest-first list, and
 * grouping it is this component's job, not the query's.
 *
 * ORDERING, in the exact priority the task body specifies:
 *  1. The VIEWER's own group first — matched by `pickedBy.id === viewerId`,
 *     NEVER by comparing labels (two different people can share a display
 *     name; only the id is a safe identity check).
 *  2. Everyone else, ALPHABETICAL by label. Deliberately NOT by count: the
 *     tray updates live, and sorting by count would make a row jump position
 *     the instant someone (possibly mid-tap) adds a pick — alphabetical is
 *     the one order that never moves as picks arrive.
 *  3. The unattributed group (`pickedBy === null` — a real, reachable state:
 *     a picker whose `users` row was later deleted, `onDelete: "set null"`)
 *     LAST, in its own group, never merged into anyone else's.
 *
 * WITHIN a group, picks keep the order they arrived in — this function never
 * reorders `picks` itself, only partitions it.
 */
export function groupPicksByPicker(picks: SelectionPick[], viewerId: string | null): PickGroup[] {
  const groups = new Map<string, PickGroup>();

  for (const pick of picks) {
    // The id, never the label — see this function's own header comment on
    // why grouping by name would silently merge two different people who
    // share one.
    const key = pick.pickedBy?.id ?? UNATTRIBUTED_GROUP_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.picks.push(pick);
      continue;
    }
    groups.set(key, {
      key,
      label: pickerLabelFor(pick.pickedBy, viewerId),
      picks: [pick],
    });
  }

  const viewerGroup: PickGroup[] = [];
  const namedGroups: PickGroup[] = [];
  const unattributedGroup: PickGroup[] = [];

  for (const group of groups.values()) {
    if (group.key === UNATTRIBUTED_GROUP_KEY) {
      unattributedGroup.push(group);
    } else if (viewerId !== null && group.key === viewerId) {
      viewerGroup.push(group);
    } else {
      namedGroups.push(group);
    }
  }

  // `es-CO` — same locale the dashboard's own unlock-audit date already uses
  // (page.tsx's `toLocaleDateString("es-CO")`) — so an accented name (e.g.
  // "Ángela") sorts the way a Spanish speaker expects, not by raw code point.
  namedGroups.sort((a, b) => a.label.localeCompare(b.label, "es-CO"));

  return [...viewerGroup, ...namedGroups, ...unattributedGroup];
}

// Two rows of picks stay visible before the list scrolls on its own axis.
const VISIBLE_ROWS = 2;

// The `<ul>` below carries `gap-3` (`row-gap: 0.75rem` = 12px). Used ONLY as
// a fallback when the real computed value cannot be read — Vitest's jsdom
// environment never loads the compiled Tailwind stylesheet, so
// `getComputedStyle(list).rowGap` there is always empty. In a real browser
// the actual computed value wins; this constant exists so the derived cap
// still lands close to correct instead of collapsing to 0 under test.
const FALLBACK_ROW_GAP_PX = 12;

// The cap applied for the one render before the effect below has measured
// anything (first paint, including the server-rendered HTML a slow client
// sees before hydration runs). Deliberately generous rather than exact —
// unlike a final, unmeasured cap, this one self-corrects within the same
// frame the DOM becomes available, so a couple of stray pixels of a third
// row peeking through for an instant is the acceptable failure mode, not a
// silently-wrong permanent one.
const PRE_MEASURE_MAX_HEIGHT_PX = 260;

export function SelectionTray({
  picks,
  urls,
  filenamesByAssetId,
  viewerId,
  mode,
  isLocked,
  isStale,
  allowsOriginalSelection,
  onOpenAsset,
  onImageError,
}: {
  /** The shared selection, oldest pick first — exactly what the server last
   * said, never a locally-derived list. */
  picks: SelectionPick[];
  /** `<ProofGrid>`'s own presigned URL map, keyed by asset id. Shared, not
   * copied, so a URL already refreshed by a grid tile is already refreshed
   * here. */
  urls: Record<string, string>;
  /** For the accessible label on each thumbnail. Same map the grid builds
   * from its server-rendered assets. */
  filenamesByAssetId: Record<string, string>;
  /** The signed-in user's own id, so their picks read "Vos" — see
   * `pickerLabelFor`. `null` is tolerated (nothing renders as "Vos") rather
   * than required, so this component stays renderable without a session in
   * tests. */
  viewerId: string | null;
  /** Task #204 — `flat` (one list, today's only behavior) or `by-person`
   * (one row per picker, see `groupPicksByPicker`). Set by the admin on the
   * gallery itself (`galleries.selection_tray_mode`, schema.ts), never by
   * this component or by anything the client can control. */
  mode: Gallery["selectionTrayMode"];
  /** Whether the selection is closed. Mirrors `<ProofGrid>`'s `isLocked`,
   * which converges on the SERVER's gallery status every tick — the tray is
   * where a collaborator finds out that somebody else already submitted. */
  isLocked: boolean;
  /** Whether the live connection is currently failing. The tray keeps showing
   * the last snapshot it got and says so — stale-but-honest beats
   * silently-wrong, task #95's own acceptance criterion. */
  isStale: boolean;
  /** Task #214 — the gallery's own switch. `false` (every gallery's default,
   * schema.ts's own comment on `galleries.allowsOriginalSelection`) hides the
   * type line below EVEN IF `hasAnyOriginal` would otherwise be true (a data
   * anomaly, not a reachable state once `updateAllowsOriginalSelection` ships
   * — but this component does not trust its callers to guarantee that; see
   * `showType`'s own computation below). */
  allowsOriginalSelection: boolean;
  onOpenAsset: (assetId: string) => void;
  /** `<ProofGrid>`'s own `refreshUrl` — the SAME one-shot re-sign the grid
   * tiles and the lightbox already use, sharing the same `refreshedAssetIds`
   * dedupe, so an asset is still only ever refreshed once no matter which of
   * the three surfaces notices it went stale first.
   *
   * NOT optional, and not a convenience: presigned URLs expire after
   * `PRESIGNED_URL_TTL_SECONDS` (5 minutes, src/lib/r2.ts), and this feature
   * exists for a group spending twenty minutes arguing about photos. A pick
   * arriving from another session at minute six, whose grid tile is below the
   * fold — `loading="lazy"`, so never fetched, so never errored, so never
   * refreshed by the grid — would otherwise render here as a broken
   * thumbnail. That is this feature's PRIMARY scenario, not an edge case, and
   * <ProofGrid>'s own header comment already states the rule it would break:
   * "a page that only ever trusted its initial batch of URLs would start
   * showing broken images partway through a normal session." */
  onImageError: (assetId: string) => void;
}) {
  // Starts expanded (task #203's explicit acceptance criterion): the tray
  // exists to show live collaboration, and a client who never sees it
  // populated has no idea a partner's picks will land there. Collapsing is
  // for the client who already knows what they picked and wants the screen
  // back for the grid.
  const [isCollapsed, setIsCollapsed] = useState(false);
  const listRegionId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [maxListHeightPx, setMaxListHeightPx] = useState<number | null>(null);
  const hasPicks = picks.length > 0;

  // Task #206, criterion 8 — the governing constraint: a gallery where
  // nobody marked an original looks and counts EXACTLY as before this slice.
  // `<TrayItem>` renders an extra type line only when this is true, so a
  // gallery with zero originals gets the exact same markup (same height, same
  // #203 cap) it always did — not a row that says "editada" either, which
  // would still be new bytes nobody asked for. Once true, EVERY item gets the
  // line (not just the originals) — deliberately, so every item's own
  // rendered height stays UNIFORM: the #203/#204 height-cap measurement reads
  // the FIRST `<li>`'s box and assumes every sibling matches it, and a label
  // that appeared on some items but not others would make that assumption
  // false again, in a smaller, easier-to-miss way than #204's own by-person
  // bug (task #208's own warning about this exact class of mistake).
  const hasAnyOriginal = picks.some((pick) => pick.selectionKind === "original");
  // Task #214 — the ADDITIONAL gate: even with a real `original` pick in the
  // list, the type line stays absent while the gallery's own switch is off.
  // "Absent, not zeroed" (task #214's own governing constraint) applies to
  // this FLAG, not only to the derived `hasAnyOriginal` above — a gallery
  // that never turned the switch on must render byte-identically to one that
  // has zero originals, even in the narrow, should-never-happen case of a
  // stray `selectionKind: "original"` row surviving past a switch flip.
  const showType = allowsOriginalSelection && hasAnyOriginal;

  // Measures the ACTUAL rendered height of one row rather than hardcoding a
  // pixel figure — see this file's header comment for why a hand-computed
  // number is a trap here. Runs once picks first exist, and again whenever
  // the observed item's own box changes size (font swap, zoom, a future
  // style change to the label) — the row height does NOT depend on how many
  // picks there are, only on the fixed 96px image and the single-line label
  // beneath it, so re-measuring on `picks.length` changing count is not
  // needed once a first real measurement has landed.
  useEffect(() => {
    const list = listRef.current;
    const firstItem = list?.querySelector("li") ?? null;
    if (!firstItem) return;

    const measure = () => {
      const itemHeight = firstItem.getBoundingClientRect().height;
      // A zero height means the row is currently not laid out (e.g. this ran
      // while `hidden` is set on an ancestor, which forces every descendant's
      // box to 0) — keep whatever was last measured rather than clobbering it
      // with a bogus cap.
      if (itemHeight <= 0) return;
      // `|| FALLBACK_ROW_GAP_PX` alone would treat a real, legitimate `0px`
      // gap (e.g. `gap-3` ever gets dropped from the `<ul>` below) as
      // "unreadable" too, since `0` is falsy — silently overshooting the cap
      // by 12px. `Number.isFinite` only falls back for the actual unreadable
      // case (jsdom's empty string parses to `NaN`).
      const parsedRowGapPx = parseFloat(window.getComputedStyle(list as HTMLUListElement).rowGap);
      const rowGapPx = Number.isFinite(parsedRowGapPx) ? parsedRowGapPx : FALLBACK_ROW_GAP_PX;
      setMaxListHeightPx(itemHeight * VISIBLE_ROWS + rowGapPx * (VISIBLE_ROWS - 1));
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(firstItem);
    return () => observer.disconnect();
  }, [hasPicks]);

  // `by-person` mode's OWN grouping (task #204) — computed here, not by
  // `getGallerySelection()`, per that function's own header comment and this
  // slice's acceptance criterion 9: the query returns one flat list, and
  // partitioning it by picker is a presentation decision this component
  // owns. Recomputed on every `picks`/`viewerId` change — `useMemo` only to
  // avoid re-sorting on an unrelated re-render (a lightbox open/close, a
  // toggled `isStale`), not because the computation is expensive.
  const groups = useMemo(() => groupPicksByPicker(picks, viewerId), [picks, viewerId]);

  // `by-person`'s OWN height cap — a SEPARATE ref/state/effect from the flat
  // trio above, not a generalization of it. See this file's header comment
  // ("TASK #204 — FLAT vs. BY-PERSON MODE...") for why: the flat effect above
  // is untouched, and this one only ever measures something when the
  // `by-person` branch below is actually mounted (`groupedListRef.current`
  // is `null` while `mode === "flat"`, so this effect is a no-op then).
  const groupedListRef = useRef<HTMLDivElement>(null);
  const [groupedMaxHeightPx, setGroupedMaxHeightPx] = useState<number | null>(null);

  useEffect(() => {
    const container = groupedListRef.current;
    // The first REAL `<TrayItem>` `<li>`, wherever it lands — the first
    // picker's group is whichever one `groupPicksByPicker` put first (the
    // viewer's, if they have any picks), not necessarily the biggest or the
    // smallest. Its dimensions are identical to flat mode's own item (same
    // component, same classes), which is exactly what makes "the same pixel
    // budget as flat" a measured fact rather than an assumption.
    const firstItem = container?.querySelector("li") ?? null;
    if (!firstItem) return;

    const measure = () => {
      const itemHeight = firstItem.getBoundingClientRect().height;
      if (itemHeight <= 0) return;
      // The gap between a GROUP'S OWN items, read off the `<ul>` that
      // actually wraps them (`gap-3`, same class as flat's list) — not the
      // outer `groupedListRef` div, whose own gap separates GROUPS from each
      // other, a different number for a different purpose.
      const itemsList = firstItem.closest("ul");
      const parsedRowGapPx = itemsList
        ? parseFloat(window.getComputedStyle(itemsList).rowGap)
        : NaN;
      const rowGapPx = Number.isFinite(parsedRowGapPx) ? parsedRowGapPx : FALLBACK_ROW_GAP_PX;
      setGroupedMaxHeightPx(itemHeight * VISIBLE_ROWS + rowGapPx * (VISIBLE_ROWS - 1));
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(firstItem);
    return () => observer.disconnect();
  }, [mode, hasPicks]);

  return (
    <section
      aria-label="Fotos elegidas"
      className="border-bg-2 bg-bg/95 sticky top-0 z-30 mb-6 rounded-sm border p-4 backdrop-blur-md"
      // Announced politely: a pick landing from ANOTHER session is a change
      // the client did not cause, which is precisely the case a screen reader
      // user would otherwise never learn about. `polite`, not `assertive` —
      // it must not interrupt someone mid-navigation of the grid.
      aria-live="polite"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-baseline gap-2">
          <h2 className="font-serif text-lg">Fotos elegidas</h2>
          {/* Survives collapse ON PURPOSE — the whole section above is
              `aria-live="polite"`, precisely so a pick from ANOTHER session
              gets announced to a screen reader user who would otherwise
              never learn about it. Collapsing the list below must not leave
              that live region with nothing left to change when a pick
              lands; this count is what changes instead. */}
          <span className="text-fg-mute text-sm">{picks.length}</span>
        </div>
        <div className="flex items-center gap-3">
          {isLocked ? (
            <p className="text-fg-mute text-xs">La selección ya fue enviada.</p>
          ) : (
            <p className="text-fg-mute text-xs">Se actualiza sola con lo que elijan los demás.</p>
          )}
          <button
            type="button"
            onClick={() => setIsCollapsed((collapsed) => !collapsed)}
            aria-expanded={!isCollapsed}
            aria-controls={listRegionId}
            className="text-accent focus-visible:ring-accent shrink-0 text-xs whitespace-nowrap underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            {isCollapsed ? "Mostrar" : "Ocultar"}
          </button>
        </div>
      </div>

      {isStale && (
        // OUTSIDE the collapsible region on purpose (task #203 acceptance
        // criterion #8): this warns that the data below might be out of
        // date, and hiding that warning exactly when the tray is folded away
        // — i.e. exactly when the client is trusting the header instead of
        // reading the list — would be worse than not having it. Never hides
        // or clears the list itself either — the picks are the last thing
        // the server actually said, and saying "these may be out of date" is
        // strictly more useful than an empty box or a confident lie.
        <p className="mb-3 text-xs text-[#e0796b]">
          Se perdió la conexión: esta lista puede estar desactualizada.
        </p>
      )}

      {/* Native `hidden`, not `className="hidden"` layered under something
          conditional and not a visually-hidden-only trick — see this file's
          header comment on why that specific technique is the one that is
          both inert to assistive tech AND unreachable by Tab. */}
      <div id={listRegionId} hidden={isCollapsed}>
        {picks.length === 0 ? (
          // No scroll chrome for the empty state (task #203 acceptance
          // criterion #7) — an empty scrollable box reads as broken, not as
          // "nothing here yet". Shared by BOTH modes: zero picks means zero
          // groups either way, so there is nothing `by-person` would show
          // differently here.
          <p className="text-fg-dim text-[15px] leading-relaxed">
            Todavía no eligieron ninguna foto. Las que elijan van a aparecer acá, con el nombre de
            quién las eligió.
          </p>
        ) : mode === "by-person" ? (
          // Task #204 — one row per picker, viewer first, alphabetical rest,
          // unattributed last (`groupPicksByPicker` above). Same
          // `overflow-y-auto overscroll-contain` + measured cap discipline as
          // flat mode, on a SEPARATE ref (`groupedListRef`/
          // `groupedMaxHeightPx`) — see this file's header comment for why
          // that pair is not shared with flat's own.
          <div
            ref={groupedListRef}
            className="flex flex-col gap-4 overflow-y-auto overscroll-contain"
            style={{ maxHeight: groupedMaxHeightPx ?? PRE_MEASURE_MAX_HEIGHT_PX }}
          >
            {groups.map((group) => (
              <div key={group.key}>
                {/* "alejandro (5)" — the task's own example copy. The count
                    is plain text, not a separate `aria-hidden`/`sr-only`
                    pair: a screen reader reads this exactly as sighted users
                    see it, same as the header's own pick counter above.
                    Deliberately NOT `uppercase`: this surface's own styling
                    guard (marketing-styling.test.ts, task #149) reserves
                    `uppercase` for ONE sanctioned kicker treatment
                    (`tracking-[0.18em]`) and forbids it everywhere else under
                    /galleries — a picker's own name is not that. */}
                <p
                  className={`text-fg-dim mb-2 text-sm font-medium ${
                    group.key === UNATTRIBUTED_GROUP_KEY ? "italic" : ""
                  }`}
                >
                  {group.label}{" "}
                  <span className="text-fg-mute font-normal">({group.picks.length})</span>
                </p>
                <ul className="flex flex-wrap gap-3">
                  {group.picks.map((pick) => (
                    <TrayItem
                      key={pick.assetId}
                      pick={pick}
                      src={urls[pick.assetId]}
                      originalFilename={filenamesByAssetId[pick.assetId]}
                      viewerId={viewerId}
                      onOpen={() => onOpenAsset(pick.assetId)}
                      onError={() => onImageError(pick.assetId)}
                      showType={showType}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          // `overscroll-contain`: without it, a finger scrolling this list to
          // its end on a phone chains into scrolling the PAGE — the exact
          // "trapped/confused" feeling this whole fix exists to avoid at the
          // list's outer sticky boundary.
          <div
            className="overflow-y-auto overscroll-contain"
            style={{ maxHeight: maxListHeightPx ?? PRE_MEASURE_MAX_HEIGHT_PX }}
          >
            <ul ref={listRef} className="flex flex-wrap gap-3">
              {picks.map((pick) => (
                <TrayItem
                  key={pick.assetId}
                  pick={pick}
                  src={urls[pick.assetId]}
                  originalFilename={filenamesByAssetId[pick.assetId]}
                  viewerId={viewerId}
                  onOpen={() => onOpenAsset(pick.assetId)}
                  onError={() => onImageError(pick.assetId)}
                  showType={showType}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function TrayItem({
  pick,
  src,
  originalFilename,
  viewerId,
  onOpen,
  onError,
  showType,
}: {
  pick: SelectionPick;
  /** `undefined` when this pick's asset was not in the page's initial render
   * — see this file's header comment on why that is a real, honest state. */
  src: string | undefined;
  originalFilename: string | undefined;
  viewerId: string | null;
  onOpen: () => void;
  onError: () => void;
  /** Task #206, criterion 8 — `<SelectionTray>`'s own `hasAnyOriginal`,
   * NEVER this item's own `pick.selectionKind`: whether the type line renders
   * at all is a decision for the WHOLE gallery, made once, not per item. A
   * gallery with zero originals must render this component with EXACTLY the
   * markup it had before this slice — not a row that says "editada" either,
   * which would still be new bytes nobody asked for and new height nobody
   * turned on. See this file's own `hasAnyOriginal` comment for why, once
   * true, every item gets the line rather than only the originals. */
  showType: boolean;
}) {
  const label = pickerLabelFor(pick.pickedBy, viewerId);
  const filename = originalFilename ?? "una foto";
  const isOriginal = pick.selectionKind === "original";

  return (
    <li className="w-24">
      <button
        type="button"
        onClick={onOpen}
        // Not "deselect": the tray is a view of the shared selection, and the
        // one control that changes it stays on the tile in the grid, where
        // it has been since task #24. Clicking here opens the lightbox — the
        // useful thing to do with "somebody picked this one" is look at it.
        //
        // Task #206 — the type joins the accessible name too, but ONLY when
        // `showType` (criterion 8: the default gallery's accessible name must
        // stay byte-identical, not just its visible pixels).
        aria-label={
          showType
            ? `Ver ${filename}, elegida por ${label}, ${isOriginal ? "original" : "editada"}`
            : `Ver ${filename}, elegida por ${label}`
        }
        className="focus-visible:ring-accent block w-full rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="bg-bg-2 relative aspect-square overflow-hidden rounded-sm">
          {src === undefined ? (
            <span className="text-fg-mute absolute inset-0 flex items-center justify-center px-1 text-center text-[10px] leading-tight">
              Recargá para verla
            </span>
          ) : (
            // Plain <img>, not next/image — same reasoning as the grid's own
            // tiles: these are short-lived, private, presigned R2 URLs whose
            // query string is never stable between two loads.
            //
            // `onError` is the SAME one-shot re-sign the grid tile and the
            // lightbox already wire up, and it matters more here than on
            // either of them — see this file's `onImageError` prop comment for
            // why a below-the-fold pick arriving from another session is the
            // case that would otherwise break.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              onError={onError}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <p
          // `truncate` (task #203): a picker's name is client-controlled
          // text, and a long one wrapping to a second line would make each
          // row's height depend on WHICH picks are visible, breaking the
          // "two rows" cap above (see this file's header comment). Pinning
          // this to one line — `title` still exposes the full name on
          // hover/long-press — is what makes the row height something the
          // tray can measure once and trust.
          className={`mt-1 truncate text-[11px] ${
            label === UNATTRIBUTED_PICKER_LABEL ? "text-fg-mute italic" : "text-fg-dim"
          }`}
          title={label}
        >
          {label}
        </p>
        {/* Task #206 — the type line. ONLY rendered when the gallery has any
            originals at all (`showType`, see this component's own prop
            comment) — absent, not zeroed, for the ordinary gallery this
            slice must not visibly change (criterion 8). `truncate` for the
            same reason the picker label above has it: a fixed one-line
            height is what keeps every item's box the SAME height, which is
            what makes the #203 height-cap measurement (reads the FIRST
            `<li>`'s box) trustworthy for every OTHER item too. */}
        {showType && (
          <p className={`truncate text-[10px] ${isOriginal ? "text-accent" : "text-fg-mute"}`}>
            {isOriginal ? "Original" : "Editada"}
          </p>
        )}
      </button>
    </li>
  );
}
