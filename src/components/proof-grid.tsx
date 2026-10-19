"use client";

// The client's own view of a gallery's proofs (task #23): a responsive grid
// that reserves every tile's box up front (no cumulative layout shift while
// images load) plus a lightbox for full-screen browsing with keyboard/swipe
// navigation. Since task #145 that box is a UNIFORM 2:3 rather than each
// asset's own ratio — see proof-tile.tsx's own comment on it for what was
// measured at 390px and why the crop is the cheaper of the two costs.
//
// WHAT LIVES WHERE (task #144)
// ============================
// This file used to be 1045 lines carrying five separate concerns at once,
// which made any redesign of the MARKUP arrive in the same diff as the live
// synchronisation logic — the hardest part of this product to review. Task
// #144 split it, moving each block of reasoning with the code it describes
// rather than summarising anything:
//
//   - `use-proof-urls.ts` — the URL-EXPIRY STRATEGY (why a presigned proof URL
//     goes stale mid-session, and the one-shot per-asset re-sign that heals it
//     in place without losing the client's scroll position).
//   - `use-shared-selection.ts` — selection, the live quota counter (#24), the
//     "LIVE SYNC" section (#95: the conflict rule and the submit lock) and the
//     "PUSH TRANSPORT" section (#114: the SSE wiring and what "issue clock"
//     means for a pushed event). Cross-references elsewhere in the repo
//     (PLAN.md §2, src/lib/selection-events.ts, the selection route) that name
//     "proof-grid.tsx's LIVE SYNC / PUSH TRANSPORT sections" mean that file
//     now — the text moved whole.
//   - `proof-tile.tsx` — one tile's markup, including the aspect-ratio
//     reservation and the #25 lock on its toggle button.
//
// What stays HERE is composition: the props the server component hands down,
// the two facts derived from `initialStatus` (#28/#29's download affordances),
// the lightbox index, and the layout that arranges tray, counter, grid and
// submit panel. That is deliberately the part a redesign touches.
//
// THREE STATES, THREE LAYOUTS (tasks #147/#148)
// ==============================================
// Before this pair of slices, `proofing`, `selected` and `delivered` all
// rendered the SAME tray + counter + grid + submit-panel arrangement, with
// only per-asset flags (`isLocked`, `showDownload`) changing what a given
// control looked like — epic #140's own words for this were "hoy son la
// misma pantalla con botones distintos". This file now renders three
// genuinely different bodies, gated on `isLocked` / `isDelivered`:
//
//   - `proofing` (`!isLocked`) — unchanged in substance: tray, instruction
//     line, grid, and <SelectionCounter>/<SubmitSelectionPanel> now sharing
//     one STICKY BOTTOM BAR (task #147's own "impossible to not see" — see
//     that bar's own comment below) instead of sitting in the normal
//     document flow where scrolling 84 photos could carry it off-screen.
//   - `selected` (`isLocked && !isDelivered`) — everything `proofing` shows
//     for review (tray, counter, the picked photos, the submit panel's own
//     "ya fue enviada" message) PLUS a new voice: `<SelectedStateNote>`
//     below, task #148's own acceptance criterion that this screen "explica
//     qué pasa ahora" instead of being read as a wall of disabled controls.
//     Deliberately ADDITIVE rather than a replacement of the existing view —
//     a client can still live here for days and wants to see exactly which
//     photos they are waiting on, not just be told to wait.
//   - `delivered` (`isDelivered`) — the tray, the live counter and the
//     submit panel are ALL retired here, not merely disabled: nothing about
//     the shared selection can change once delivered (`isLocked` is true
//     forever, `useSharedSelection`'s own `LIVE_SYNC_STATUSES` already
//     spends zero polls on it), and the submit panel's "tu fotógrafo ya
//     tiene acceso a esta selección" message is stale noise weeks or months
//     after the fact. In their place, `<DeliveredNote>` states what actually
//     matters now — the photos are unwatermarked (#89) and the ZIP is right
//     there — mirroring the mock's own `entregada` screen, which never shows
//     `.tray`/`.bar` either.
//
// TASK #222 — DELIVERED SPLITS INTO "CHOSEN FIRST" + A CLOSED ACCORDION
// =======================================================================
// Before this slice, `delivered` still fell into the SAME single flat `<ul>`
// as `proofing`/`selected` (right above), every asset interleaved in upload
// order regardless of `isSelected`. Once a gallery ships, the client wants
// only what they picked; making them scroll past everyone else's rejects to
// find their own photos is backwards for the one moment they are least
// interested in the discards. Scope is `delivered` ONLY — `proofing`'s
// whole point is seeing everything at once to decide, so splitting there
// would break the core flow (see epic #140).
//
// THE TRAP THIS SLICE EXISTS TO AVOID: a naive split is two `.map()` calls,
// and each callback's own `index` quietly becomes a PER-GROUP index while a
// lightbox fed the flat array still opens by NUMERIC INDEX into it — tapping
// the third chosen photo opens whatever asset happens to sit third in
// upload order instead. Every tile still renders correctly and nothing in a
// shallow test catches it; the only way to see it live is to tap a photo
// and notice a different one open. Fixed here by CONSTRUCTION, not
// discipline: the `lightbox` state below carries a GROUP TAG ("all" |
// "chosen" | "unchosen") next to the index, `renderTile()` is the single
// place that pairs a group's array with an index INTO THAT SAME ARRAY, and
// the array handed to `<ProofLightbox>` is looked up by that tag at render
// time — there is no path left where a group-local index reaches the wrong
// array.
//
// THREE DECISIONS, MADE AND NOT REOPENED HERE — see the task body for why:
//   1. The lightbox navigates only within the group it was opened from: two
//      independent index spaces, never one that spans both.
//   2. The corner position number (proof-tile.tsx's own `.tile__n`) restarts
//      at 01 per group. Preserving original positions would leave visible
//      gaps in the chosen grid that read as missing photos.
//   3. The accordion is closed on every render, with no persistence across
//      reloads — a plain, UNCONTROLLED `<details>` holds no state of its
//      own for this to even accidentally persist.
//
// TWO EDGE CASES, DECIDED:
//   - Zero unselected assets (the client chose everything): no accordion at
//     all, not an empty one — gated on `unchosenAssets.length > 0` below.
//   - Zero selected assets (delivered with nothing chosen — an admin
//     mistake, or a client who submitted an empty pick): not special-cased
//     in the split itself — every asset simply lands in `unchosenAssets`,
//     `chosenAssets` comes out empty, and the block that would have
//     rendered a bare, confusing empty `<ul>` renders one line of text
//     instead. The accordion below still follows decision 3: closed
//     regardless of whether there is anything above it.
//
// DESIGN SURFACE: this file follows design/system/client.html, not the
// admin design system (epic #140's own rule). That mock's `entregada`
// screen (:934-974) shows only the delivered finals with no chosen/rejected
// split, so it has no collapsible idiom of its own to match. The nearest
// STRUCTURAL precedent in this codebase is `selected-photos-list.tsx`'s
// native `<details>`/`<summary>` (task #216) — reused for the MECHANISM
// only (a native disclosure widget gets keyboard and screen-reader
// behaviour for free). Its ADMIN styling (the boxed `rounded-[6px] border
// p-4` panel) is deliberately NOT carried across; the summary below reuses
// this file's own client tokens instead (`border-line-2`, `text-fg-dim`),
// the same ones `<SelectedStateNote>` already uses a few hundred lines down.
import { useCallback, useMemo, useState } from "react";
import { DownloadAllButton } from "@/components/download-all-button";
import { ProofLightbox } from "@/components/proof-lightbox";
import { ProofTile } from "@/components/proof-tile";
import { SelectionCounter } from "@/components/selection-counter";
import { SelectionTray } from "@/components/selection-tray";
import { SubmitSelectionPanel } from "@/components/submit-selection-panel";
import { useProofUrls } from "@/components/use-proof-urls";
import { useSharedSelection, type GalleryStatus } from "@/components/use-shared-selection";
import type { Gallery } from "@/lib/db/schema";
import type { QuotaResult } from "@/lib/quota";
import {
  pickerLabelFor,
  claimedEntries,
  viewerPickOf,
  UNATTRIBUTED_PICKER_LABEL,
  type SelectionCounter as SelectionCounterData,
  type SelectionEntry,
  type SelectionEntryPick,
  type ViewerLock,
} from "@/lib/selection-snapshot";

// Re-exported, not re-declared: `GalleryStatus` and the fallback poll's
// cadence belong next to the status machine and the loop they pace
// (use-shared-selection.ts), but `@/components/proof-grid` is the import path
// every caller and proof-grid.test.tsx already had. Task #144 was not allowed
// to change a single test, so the path stays exactly where it was.
export type { GalleryStatus };
export { SELECTION_POLL_INTERVAL_MS } from "@/components/use-shared-selection";

export type ProofAsset = {
  id: string;
  originalFilename: string;
  proofWidth: number;
  proofHeight: number;
  isSelected: boolean;
  proofUrl: string;
  // Whether this asset's final is actually downloadable (task #28): selected
  // AND edited AND a final object exists — the SAME three-condition gate
  // `GET /api/assets/[assetId]/final` itself enforces (see that route's own
  // comment), computed server-side by the page that renders this component
  // (src/app/galleries/[publicSlug]/page.tsx) and handed down as a plain
  // boolean. Deliberately NOT the raw `finalKey` — same "the raw R2 key must
  // never reach the browser" discipline `WorkspaceAsset.hasFinal` already
  // follows in src/components/gallery-workspace.tsx. This is a UI hint ONLY:
  // the route re-checks all three conditions itself on every request, so a
  // stale or wrong value here can make the download button render when it
  // shouldn't (or not render when it should) but can never actually unlock a
  // final this session doesn't own or that isn't really ready.
  hasFinal: boolean;
  // Task #89: the presigned URL of this asset's UNWATERMARKED, browsing-sized
  // derivative, or `null` when this asset isn't showing one — either because
  // the gallery isn't delivered yet, or because this particular photo was
  // never selected/edited and therefore has no final to derive from. A
  // delivered gallery containing both kinds at once is the normal case, which
  // is why this is per-asset rather than one flag on the gallery.
  //
  // When present it REPLACES `proofUrl` as what the grid and the lightbox
  // display (see `useProofUrls`' seeded map) — the client paid, so the
  // watermark should be gone from what they look at, not only from what they
  // download. `proofUrl` is still carried on every asset regardless, as the
  // fallback that hook's `refreshUrl` drops back to if the display object
  // turns out not to exist.
  //
  // Same "UI hint, never the gate" disclaimer as `hasFinal` above: the bytes
  // behind this URL are private R2 objects, and the page that presigned it
  // (src/app/galleries/[publicSlug]/page.tsx) had already verified this
  // session owns the gallery. A wrong value here cannot unlock anything; it
  // can only make this component request a URL that 404s.
  displayUrl: string | null;
  // Task #223 — the photographer deliberately delivered this photo even
  // though the client never picked it. Used HERE for exactly one thing: which
  // side of #222's split the tile lands on (see `chosenAssets` below). A gift
  // that fell into the collapsed "no elegidas" accordion would be invisible
  // in the one gallery it was uploaded for.
  //
  // Not used to decide whether a download button renders — that is `hasFinal`
  // above, which the page already widened to account for extras. Two flags,
  // two questions, neither inferred from the other.
  isExtra: boolean;
};

// Task #222 — which array a `lightbox` index below is meant to be read
// against. "all" is the pre-#222, flat, `!isDelivered` case; "chosen" and
// "unchosen" are this slice's own two groups. See this file's own header
// comment for why this tag exists at all.
type LightboxGroup = "all" | "chosen" | "unchosen";

export function ProofGrid({
  galleryId,
  initialAssets,
  initialStatus,
  initialSubmittedAt,
  initialEntries,
  initialQuota,
  initialCounter,
  viewerId,
  viewAsId = null,
  actingClientId = null,
  readOnly = false,
  selectionTrayMode,
  allowsOriginalSelection,
  initialViewerLock = null,
  initialAdminLockedPickerIds = [],
  isAdminPreview = false,
  rollingDelivery = false,
  finalsOpen = initialStatus === "delivered",
  initialViewerSubmittedAt = null,
}: {
  // Task #25's submit route is keyed on this — see that route's own header
  // comment for why the internal id, not the page's `publicSlug`, is the
  // right identifier for a same-origin `fetch()` call.
  galleryId: string;
  initialAssets: ProofAsset[];
  initialStatus: GalleryStatus;
  initialSubmittedAt: string | null;
  // Task #95 / epic #250 S6: the shared selection as of the server render,
  // built by the SAME builder the live route and the PATCH route use. One
  // entry per asset somebody asked for, its claim, and every asker.
  initialEntries: SelectionEntry[];
  // The server's own quota and four-number counter for the first paint. The
  // client derives neither (epic #250 S6).
  initialQuota: QuotaResult;
  initialCounter: SelectionCounterData;
  // Epic #239 — per-client lock state as of the server render: the subject's
  // own lock and the ids the PHOTOGRAPHER locked. Seeds `useSharedSelection`;
  // every snapshot after replaces both wholesale.
  initialViewerLock?: ViewerLock | null;
  initialAdminLockedPickerIds?: string[];
  // Epic #250 S6 — the admin's view-as subject, forwarded to the hook's poll.
  viewAsId?: string | null;
  // Epic #239 — the photographer previewing this page. The submit route
  // refuses admins, so no working submit button is rendered for them.
  isAdminPreview?: boolean;
  // Epic #250 S7 — the client an admin acts on behalf of (decision 12). Null
  // for a client's own view and for an admin looking without a subject.
  actingClientId?: string | null;
  // Epic #250 S7 — an admin viewing WITHOUT a subject may look but not touch:
  // every pick control is disabled. See `useSharedSelection`'s own param.
  readOnly?: boolean;
  // Task #244 — opt-in rolling delivery (`galleries.rolling_delivery`): edited
  // finals show as soon as they are readable (even while `proofing`/
  // `selected`), picks split into "Por enviar" and "Pedidas", and "Enviar"
  // places an order instead of locking the viewer. `false` = every other
  // gallery, unchanged.
  rollingDelivery?: boolean;
  // Task #244 — whether this viewer may see finals at all: the PAGE's
  // `areFinalsOpenToClient` result (src/lib/final-access.ts), passed down so
  // this component never carries its own copy of the rule. Defaults to
  // "delivered", the pre-#244 meaning. An admin previewing a `draft` gallery
  // with the flag on gets `false` here: no finals UI.
  finalsOpen?: boolean;
  // Task #244 — the viewer's own last submit time, for "Último envío".
  initialViewerSubmittedAt?: string | null;
  // The subject's own id (the admin's view-as person when there is one), so
  // the tray can render their own picks as "Tú" rather than their own name
  // (see `pickerLabelFor`). Nothing is authorized by this value — it is a
  // display detail; every route this component calls resolves the acting
  // session server-side and would refuse a request regardless of what is
  // passed here.
  viewerId: string;
  // Task #204 — how <SelectionTray> lays out the SAME entries below: one flat
  // list (today's only behavior) or grouped one row per billed person. Purely
  // a presentation choice the admin sets on the gallery itself
  // (src/app/dashboard/galleries/actions.ts's `updateSelectionTrayMode`);
  // this component makes no decision about it, only threads it through.
  selectionTrayMode: Gallery["selectionTrayMode"];
  // Task #214 — the per-gallery switch that gates whether this gallery's
  // client may pick `original` at all (task #206's own per-photo control).
  // `false` for every gallery that existed before this column did — the
  // default that restores this app's pre-#206 behavior everywhere this flows
  // (schema.ts's own comment on `galleries.allowsOriginalSelection`). Threaded
  // straight through to every surface that renders a type control or an
  // originals line — <ProofTile>, <ProofLightbox>, <SelectionTray>,
  // <SelectionCounter> and <SubmitSelectionPanel> — none of which derive it
  // from `quota.originals` or from anything else already in hand: a gallery
  // with the flag off but a data anomaly leaving a stray `selectionKind:
  // "original"` row (should never happen once `updateAllowsOriginalSelection`
  // ships, but a display surface has to be robust to it, not just to the
  // happy path) must still render as if no originals exist at all — "absent,
  // not zeroed" applies to the FLAG's own truth, not only to the count.
  allowsOriginalSelection: boolean;
}) {
  // One map of presigned URLs, shared by the tray, every grid tile and the
  // lightbox — see use-proof-urls.ts's own header comment for why it is one
  // map and not one per surface.
  const { urls, refreshUrl } = useProofUrls(initialAssets);

  // Everything the gallery's shared selection consists of: this session's
  // toggles, other sessions' picks arriving live, the server-recomputed quota
  // and the submit lock. See use-shared-selection.ts.
  const {
    selectionById,
    quota,
    entries,
    counter,
    isLocked,
    isGalleryLocked,
    viewerLock,
    adminLockedPickerIds,
    submittedAt,
    viewerSubmittedAt,
    pendingIds,
    toggleError,
    isStale,
    toggleSelection,
    setSelectionKind,
    handleSubmitted,
  } = useSharedSelection({
    viewerId,
    viewAsId,
    actingClientId,
    readOnly,
    initialViewerLock,
    initialAdminLockedPickerIds,
    galleryId,
    initialAssets,
    initialStatus,
    initialSubmittedAt,
    initialEntries,
    initialQuota,
    initialCounter,
    rollingDelivery,
    initialViewerSubmittedAt,
  });

  // Task #28: a gallery only ever reaches `delivered` once (PLAN.md §2's
  // state machine has no path back out of it toward the client-visible
  // statuses), so — unlike the live `status`/`isLocked` the hook above tracks
  // — this never needs to flip after mount; `initialStatus` alone is enough
  // for this component's whole lifetime.
  //
  // Deliberately read off `initialStatus`, NOT the live `status`, even though
  // one now exists (task #95): the download affordances depend on per-asset
  // facts the SERVER computed at render time (`hasFinal`, `displayUrl`),
  // which a live status change cannot bring with it. A gallery that becomes
  // `delivered` while a client watches would otherwise sprout download
  // buttons for assets this page knows nothing about. It stays read-only
  // until the client loads the page again, which is when those facts arrive.
  // Whether a GIVEN asset's download button actually renders is
  // still per-asset (`asset.hasFinal` below): a delivered gallery can easily
  // contain unselected assets that were never edited and have no final at
  // all.
  //
  // Computed here, ABOVE the hooks that follow, rather than right before the
  // `return` (where it used to sit): task #222's group split below needs it
  // inside a `useMemo`, and the Rules of Hooks require every hook to run
  // unconditionally — i.e. before the `initialAssets.length === 0` early
  // return further down, not after it.
  const isDelivered = initialStatus === "delivered";
  // Task #244 — finals are readable on this page either because the gallery is
  // delivered or because it has rolling delivery on (the server only presigns
  // `displayUrl`/sets `hasFinal` accordingly). A UI hint; the routes re-check.
  const showsFinals = finalsOpen;

  // Task #222 — every asset's CURRENT `isSelected`, resolved the SAME way
  // each grid tile already resolved it inline before this slice
  // (`selectionById[id] ?? asset.isSelected`), computed once here instead of
  // per-tile. Also what the lightbox now renders in the `!isDelivered` case
  // (`renderTile`'s own "all" group below), replacing the ad-hoc
  // `initialAssets.map(...)` that used to get rebuilt inline on every render
  // of the lightbox itself.
  const displayAssets = useMemo(
    () =>
      initialAssets.map((asset) => ({
        ...asset,
        isSelected: selectionById[asset.id] ?? asset.isSelected,
      })),
    [initialAssets, selectionById],
  );

  // Task #222 — the split itself. `proofing`/`selected` get two empty
  // arrays and keep rendering the one flat grid unchanged (see the return
  // block below); `delivered` gets chosen-first, unchosen-collapsed. Order
  // within each group is preserved from `initialAssets` — this only
  // PARTITIONS, it never re-sorts, which is what keeps "position restarts
  // at 01 per group" meaning "in the order they were uploaded" rather than
  // some new ordering this slice would have to justify separately.
  //
  // "No selected photos at all" is not special-cased HERE: every asset
  // simply lands in `unchosenAssets` and `chosenAssets` comes out empty,
  // which the return block below renders as one line of text instead of a
  // bare empty grid — see that block's own comment.
  //
  // TASK #223 WIDENED THE PREDICATE from `isSelected` to "delivered to this
  // client" — picked by them, OR gifted by the photographer. Getting this
  // wrong is not cosmetic: an extra is `isSelected: false`, so under the
  // original predicate every gift photo landed inside a `<details>` that is
  // closed on every render (decision 3 above) — delivered, downloadable, and
  // effectively invisible. The top group is "your photos", and a gift is one
  // of the client's photos.
  //
  // The accordion keeps meaning exactly what it did: photos that are NOT
  // being delivered. It just stops being definable as "not selected".
  const { chosenAssets, unchosenAssets } = useMemo<{
    chosenAssets: ProofAsset[];
    unchosenAssets: ProofAsset[];
  }>(() => {
    if (!isDelivered) return { chosenAssets: [], unchosenAssets: [] };
    const chosen: ProofAsset[] = [];
    const unchosen: ProofAsset[] = [];
    for (const asset of displayAssets) {
      (asset.isSelected || asset.isExtra ? chosen : unchosen).push(asset);
    }
    return { chosenAssets: chosen, unchosenAssets: unchosen };
  }, [displayAssets, isDelivered]);

  // THE TRAP, closed (see this file's own header comment): the lightbox
  // opens by NUMERIC INDEX, and once the grid is more than one `.map()`,
  // that index only means something together with WHICH array it indexes
  // into. `group` is that second half of the address. Deliberately NOT
  // widened to carry the array itself: doing that would freeze a stale
  // snapshot at the moment a tile was tapped, and a toggle from inside the
  // (still-open, pre-delivery) lightbox would stop moving that asset
  // between the arrays the grid renders. The render block below looks up
  // the live array by tag instead, on every render.
  const [lightbox, setLightbox] = useState<{ group: LightboxGroup; index: number } | null>(null);

  // Epic #250 S7 — THE TOGGLE'S OWN TRUTH. `selectionById` (and its
  // `displayAssets` mirror) is the CLAIM: at least one person sent a pick. On a
  // shared board that is usually somebody else's, so reflecting it on the
  // viewer's button is the inversion this slice exists to remove. This map is
  // the viewer's own pick per asset, straight off `entries` (never
  // `assets.isSelected`).
  const viewerPickById = useMemo(() => {
    const own = new Map<string, SelectionEntryPick>();
    for (const entry of entries) {
      const pick = viewerPickOf(entry, viewerId);
      if (pick) own.set(entry.assetId, pick);
    }
    return own;
  }, [entries, viewerId]);
  // Epic #250 S7 — the lightbox needs each asset's full entry (claim + every
  // asker) to describe the viewer's own pick and its attribution.
  const entryById = useMemo(
    () => Object.fromEntries(entries.map((entry) => [entry.assetId, entry])),
    [entries],
  );

  // Task #206 — every asset's TYPE as the VIEWER asked for it, not the claim's
  // resolved kind: a cart that asked `original` must show Original pressed even
  // while the photo is unclaimed, and a degraded `edited` pick must not borrow
  // somebody else's resolved `edited`/`original`.
  const selectionKindById = useMemo(
    () => Object.fromEntries([...viewerPickById].map(([assetId, pick]) => [assetId, pick.kind])),
    [viewerPickById],
  );

  // Epic #239 / S6 — what THIS subject's controls reflect beyond their own
  // lock:
  //   - `claimedAssetIds`: every claimed entry, in server order. Feeds the
  //     "Pedida" label and the lightbox's claimed set. No rolling condition:
  //     a classic claim is still claimed.
  //   - `viewerSubmittedAssetIds`: entries where the SUBJECT's own pick was
  //     sent. That is the honest freeze (decision 8: a degraded pick stays
  //     removable). Never "somebody's lock" — nobody can edit anybody else's
  //     pick any more.
  //   - `ownPickCount`: every pick the subject has (sent or still to send),
  //     off the server's counter, never a client-side count. It gates the
  //     classic submit button, so leaving `toSend` out would make a gallery
  //     whose picks are all still carts impossible to send.
  const claimedAssetIds = useMemo(
    () => new Set(claimedEntries(entries).map((entry) => entry.assetId)),
    [entries],
  );
  const ownPickCount = counter.viewer
    ? counter.viewer.yours + counter.viewer.shared + counter.viewer.toSend
    : 0;
  const viewerSubmittedAssetIds = useMemo(
    () =>
      new Set(
        entries
          .filter((entry) => viewerPickOf(entry, viewerId)?.submittedAt != null)
          .map((entry) => entry.assetId),
      ),
    [entries, viewerId],
  );
  const frozenAssetIds = actingClientId !== null ? new Set<string>() : viewerSubmittedAssetIds;
  const unsentCount = counter.viewer?.toSend ?? 0;
  const readableAssetIds = useMemo(
    () =>
      new Set(
        finalsOpen ? initialAssets.filter((asset) => asset.hasFinal).map((asset) => asset.id) : [],
      ),
    [initialAssets, finalsOpen],
  );
  const lockedByAdmin =
    viewerLock !== null &&
    (viewerLock.lockedBy !== undefined
      ? viewerLock.lockedBy === "admin"
      : viewerLock.submittedAt === null);
  // The date the VIEWER sees as "enviada": their own time, not the gallery's
  // closing time (which is the LAST person's).
  const ownSubmittedAt = viewerLock ? viewerLock.submittedAt : submittedAt;

  // Task #95: the tray's accessible labels, and nothing else. Frozen off the
  // server-rendered props on purpose — a snapshot can name an asset this page
  // never rendered, and <SelectionTray> handles that explicitly rather than
  // this map pretending to know a filename it was never given.
  const filenamesByAssetId = useMemo(
    () =>
      Object.fromEntries(
        initialAssets.map((asset) => [asset.id, asset.originalFilename]),
      ) as Record<string, string>,
    [initialAssets],
  );

  // Task #222 — same "-1 means nothing to open" guard as before, now
  // resolved against `displayAssets` and setting the "all" group: this
  // callback only ever fires from <SelectionTray>'s `onOpenAsset`, which is
  // only rendered `!isDelivered` (see the tray's own render gate below), so
  // "all" — the flat, pre-#222 array — is always the right group here.
  const openAssetInLightbox = useCallback(
    (assetId: string) => {
      const index = displayAssets.findIndex((asset) => asset.id === assetId);
      // -1 for a pick whose asset this page never rendered — nothing to open,
      // and opening the lightbox at index -1 would blank it.
      if (index >= 0) setLightbox({ group: "all", index });
    },
    [displayAssets],
  );

  if (initialAssets.length === 0) {
    return (
      <p className="text-fg-dim text-[15px] leading-relaxed">
        Tu fotógrafo todavía no subió fotos para esta galería.
      </p>
    );
  }

  // Task #29: <DeliveredNote>'s own download-all affordance only makes sense
  // once there is at least one final to actually zip — same per-asset
  // `hasFinal` truth `showDownload` below already relies on for the
  // individual buttons. Task #148 widened this from a boolean ("is there at
  // least one") to the actual count, for that note's own "N fotos" copy
  // (client.html:941's own "15 fotos editadas..."). The route re-derives its
  // own set from the database on every request regardless of what this
  // renders — this is a UI hint only, same disclaimer as `hasFinal`'s own.
  const finalAssetCount = showsFinals ? initialAssets.filter((asset) => asset.hasFinal).length : 0;

  // Task #222 — the one place that builds a tile, used by all three grids
  // below (the flat one and this slice's own two). Pairs `group` with
  // `index` on every single call, which is what makes "the wrong array"
  // IMPOSSIBLE rather than merely avoided this one time — see this file's
  // own header comment on THE TRAP for why that distinction is the whole
  // point of this function existing.
  function renderTile(asset: ProofAsset, index: number, group: LightboxGroup) {
    const ownPick = viewerPickById.get(asset.id) ?? null;
    const isSelected = ownPick !== null;
    return (
      <ProofTile
        key={asset.id}
        asset={asset}
        position={index + 1}
        src={urls[asset.id] ?? asset.proofUrl}
        // Epic #250 S7 — the VIEWER's pick, never the claim. `asset.isSelected`
        // says "somebody sent one", which on a shared board is usually not me.
        isSelected={isSelected}
        isPending={pendingIds.has(asset.id)}
        isLocked={isLocked || readOnly || frozenAssetIds.has(asset.id)}
        showDownload={showsFinals && asset.hasFinal}
        orderLabel={
          // Precedence everywhere: Editada (final readable) > Por enviar (the
          // viewer's own unsent pick on a free photo) > Pedida (claimed by
          // anyone). No rolling gate any more: the order semantics are
          // mandatory (decision 10), the flag only gates finals.
          showsFinals && asset.hasFinal
            ? "Editada"
            : !isDelivered && ownPick?.state === "cart"
              ? "Por enviar"
              : !isDelivered && claimedAssetIds.has(asset.id)
                ? "Pedida"
                : null
        }
        onError={() => void refreshUrl(asset.id)}
        onOpen={() => setLightbox({ group, index })}
        // Sends the OPPOSITE of the viewer's own pick — where this used to send
        // `!asset.isSelected` (the claim), which deselected somebody else's
        // photo on rows 2 and 4.
        onToggleSelection={() => void toggleSelection(asset.id, !isSelected)}
        // Task #206 — the viewer's own kind, not the resolved claim. Only
        // meaningful while picked; the tile gates the control on that.
        selectionKind={selectionKindById[asset.id] ?? "edited"}
        onSetSelectionKind={(kind) => void setSelectionKind(asset.id, kind)}
        allowsOriginalSelection={allowsOriginalSelection}
        pickers={entryById[asset.id]?.picks ?? []}
        viewerId={viewerId}
        viewerPickState={ownPick?.state ?? null}
      />
    );
  }

  return (
    <>
      {/* Task #148: the tray is a view of a selection that can still change
          (who has picked what, so far) — once `delivered`, PLAN.md §2's state
          machine has no path back out of it, so there is nothing left to
          watch for. Retired here rather than merely disabled, same reasoning
          <DeliveredNote> below explains for the counter and the submit
          panel. */}
      {!isDelivered && (
        <SelectionTray
          entries={entries}
          urls={urls}
          filenamesByAssetId={filenamesByAssetId}
          viewerId={viewerId}
          mode={selectionTrayMode}
          isLocked={isLocked}
          isGalleryLocked={isGalleryLocked}
          adminLockedPickerIds={adminLockedPickerIds}
          lockedByAdmin={lockedByAdmin}
          rollingDelivery={rollingDelivery}
          readableAssetIds={readableAssetIds}
          lastSubmittedAt={viewerSubmittedAt}
          isStale={isStale}
          allowsOriginalSelection={allowsOriginalSelection}
          onOpenAsset={openAssetInLightbox}
          // The SAME `refreshUrl` the grid tiles and the lightbox use, sharing
          // the same `refreshedAssetIds` dedupe — see <SelectionTray>'s own
          // `onImageError` comment for why the tray needs it MORE than they do.
          onImageError={(assetId) => void refreshUrl(assetId)}
        />
      )}

      {isDelivered && <DeliveredNote galleryId={galleryId} finalAssetCount={finalAssetCount} />}

      {/* Task #244 — rolling delivery before `delivered`: the editadas that are
          already readable, with the zip of exactly those. Nothing here while
          no final exists yet. */}
      {rollingDelivery && showsFinals && !isDelivered && finalAssetCount > 0 && (
        <div className="mb-6">
          <p className="text-fg-dim text-sm">
            {finalAssetCount} foto{finalAssetCount === 1 ? "" : "s"} editada
            {finalAssetCount === 1 ? "" : "s"} ya disponible{finalAssetCount === 1 ? "" : "s"}, en
            alta resolución y sin marca de agua.
          </p>
          <div className="mt-3">
            <DownloadAllButton galleryId={galleryId} assetCount={finalAssetCount} />
          </div>
        </div>
      )}

      {/* Task #148: `selected` gets its own voice instead of reading as a
          wall of disabled controls — <SelectionCounter> stays visible here
          (still true, still useful context while the client waits) but
          without the sticky bottom bar or the submit button, since there is
          nothing left to act on. */}
      {!isDelivered && isLocked && (
        <div className="mb-4">
          {/* Task #264 — the same per-person counter the proofing bar shows:
              the `selected` view had the identical one-bill assumption. */}
          <SelectionCounter
            quota={quota}
            allowsOriginalSelection={allowsOriginalSelection}
            counter={counter}
            viewerId={viewerId}
          />
        </div>
      )}

      {!isDelivered && isLocked && (
        <SelectedStateNote
          quota={quota}
          counter={counter}
          viewerId={viewerId}
          submittedAt={ownSubmittedAt}
          isGalleryLocked={isGalleryLocked}
          lockedByAdmin={lockedByAdmin}
          ownPickCount={ownPickCount}
        />
      )}

      {/* A refused write (409 lock refusal, snapshot refresh already on its
          way) must stay readable after the viewer's own controls froze: the
          bottom bar that normally carries this message is gone once locked. */}
      {!isDelivered && isLocked && toggleError && (
        <p className="text-fg-dim mb-4 text-sm" role="status">
          {toggleError}
        </p>
      )}

      {/* Task #145 — the one instruction the redesigned tile needs, and the
          mock's own words for it (design/system/client.html:714). The pick
          control became an empty 48px circle with no label in it, so the
          screen has to say once what it does; without this line the only
          affordance is a bare ring. Hidden once `isLocked`, because there is
          then no circle to press and the sentence would be a lie.

          Lives here rather than in the page's header block
          (src/app/galleries/[publicSlug]/page.tsx), where the mock puts its
          `.lede`: that header renders for `selected` and `delivered` too, and
          only this component knows whether the selection is still open. */}
      {!isLocked && (
        <>
          <p className="text-fg-dim mb-3 text-sm">
            Toca una foto para verla grande. El círculo la elige.{" "}
            <strong className="text-fg font-normal">Cada persona elige las suyas</strong> — nadie
            más del grupo puede sacarlas, y si dos eligen la misma, cuenta una sola vez.
          </p>
          {counter.viewer !== null && !isDelivered && <ViewerCounterLine counter={counter} />}
        </>
      )}

      {isDelivered ? (
        <>
          {/* Task #222 — the chosen group, above the fold, unwrapped: this
              IS the point of the split, so it gets no ceremony beyond what
              the flat grid always had. */}
          {chosenAssets.length > 0 ? (
            <ul className="grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px]">
              {chosenAssets.map((asset, index) => renderTile(asset, index, "chosen"))}
            </ul>
          ) : (
            // Task #222's own decided edge case: a delivered gallery with
            // NOTHING chosen (an admin mistake, or a client whose submitted
            // pick was empty) renders no grid here at all, rather than a
            // bare, confusing empty `<ul>`. Nothing is lost — every asset
            // already fell into `unchosenAssets`, rendered below.
            <p className="text-fg-dim text-sm">No elegiste ninguna foto en esta galería.</p>
          )}

          {/* Task #222 — the rest, collapsed by default and every time: a
              plain, UNCONTROLLED `<details>` holds no open/closed state of
              its own to persist across a reload, which is what "closed by
              default" asked for literally. Structural precedent:
              selected-photos-list.tsx's own `<details>`/`<summary>` (task
              #216) — the MECHANISM only, not its admin styling; this reuses
              this file's own client tokens instead (`border-line-2`,
              `text-fg-dim`, the same ones `<SelectedStateNote>` below uses),
              since design/system/client.html's `entregada` screen has no
              collapsible idiom of its own to match — it never shows an
              unchosen photo at all (see this file's header comment).
              Rendered only when there is something to collapse: the mirror
              of the empty-chosen case above, zero unchosen means no
              accordion, not an empty one. */}
          {unchosenAssets.length > 0 && (
            <details className="border-line-2 mt-8 border-t pt-4">
              <summary className="text-fg-dim cursor-pointer text-sm">
                {unchosenAssets.length === 1
                  ? "Ver la foto que no elegiste"
                  : `Ver las ${unchosenAssets.length} fotos que no elegiste`}
              </summary>
              <ul className="mt-4 grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px]">
                {unchosenAssets.map((asset, index) => renderTile(asset, index, "unchosen"))}
              </ul>
            </details>
          )}
        </>
      ) : (
        /* client.html:180 (`repeat(2, 1fr)`, `gap: 2px`), :532 (three columns
           from 620px — Tailwind's `sm` is 640px, the nearest stop in the
           project's own scale, and no slice in this epic gets to invent a
           breakpoint) and :556 (four columns and a 3px gap at the desk).
           The near-zero gutter is the point rather than a detail: it buys the
           phone's two columns their width back, which is what makes a
           thumbnail big enough to decide on without opening it.

           `pb-32` only while the sticky bottom bar (below) is actually
           mounted — `selected` renders no bar either (see `!isLocked`
           below); `delivered` never reaches this branch anymore, task #222
           split it out above. */
        <ul
          className={`grid grid-cols-2 gap-[2px] sm:grid-cols-3 lg:grid-cols-4 lg:gap-[3px] ${
            !isLocked ? "pb-32" : ""
          }`}
        >
          {displayAssets.map((asset, index) => renderTile(asset, index, "all"))}
        </ul>
      )}

      {/* Task #147's own hardest problem, restated: the surcharge has to be
          impossible to not see BEFORE the client submits, on the phone,
          without scrolling back up — the whole reason <SelectionCounter> and
          <SubmitSelectionPanel> now share ONE bar fixed to the bottom of the
          viewport (design/system/client.html's own `.bar`, `position: fixed;
          inset: auto 0 0 0`) instead of sitting in the normal document flow
          above the grid, where 84 photos of scrolling could carry them both
          off-screen. Only while the selection can still be acted on
          (`!isLocked`) — `selected` and `delivered` render no bar at all,
          matching the mock's own `enviada`/`entregada` screens.

          `z-40`: above the tray's sticky `z-30` (selection-tray.tsx), below
          the lightbox's `z-50` (proof-lightbox.tsx) — the lightbox must
          always be able to cover this, this must always be able to cover the
          tray scrolling underneath it.

          DECLARED DEVIATION FROM THE MOCK: kept `fixed` at every breakpoint
          rather than switching to `position: sticky` at the mock's own
          1024px rule (client.html:562-566, "en una pantalla alta nada está
          fuera de alcance"). A fixed bar stays perfectly usable at the desk —
          it just does not fold back into the document flow there. Revisit if
          the owner finds it visually heavy on a large screen; nothing about
          the phone experience, the actual acceptance criterion, depends on
          it. */}
      {!isDelivered && !isLocked && (
        <div className="border-line-2 bg-bg/95 fixed inset-x-0 bottom-0 z-40 border-t px-4 pt-2 pb-[calc(8px+env(safe-area-inset-bottom,0px))] backdrop-blur-md min-[620px]:px-7 lg:px-12 lg:pt-3 lg:pb-[calc(12px+env(safe-area-inset-bottom,0px))]">
          <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 lg:flex-wrap">
            <SelectionCounter
              quota={quota}
              allowsOriginalSelection={allowsOriginalSelection}
              counter={counter}
              viewerId={viewerId}
              collapsible
            />
            <div className="flex items-center gap-3">
              {toggleError && <p className="text-danger text-xs">{toggleError}</p>}
              <SubmitSelectionPanel
                galleryId={galleryId}
                quota={quota}
                isLocked={isLocked}
                isGalleryLocked={isGalleryLocked}
                lockedByAdmin={lockedByAdmin}
                ownPickCount={ownPickCount}
                isAdminPreview={isAdminPreview}
                submittedAt={ownSubmittedAt}
                onSubmitted={handleSubmitted}
                allowsOriginalSelection={allowsOriginalSelection}
                rollingDelivery={rollingDelivery}
                unsentCount={unsentCount}
                lastSubmittedAt={viewerSubmittedAt}
                projection={counter.viewer?.projection ?? null}
              />
            </div>
          </div>
        </div>
      )}

      {/* `selected`'s own submit panel — still rendered (its locked branch is
          the "ya fue enviada, tu fotógrafo ya tiene acceso" message, task
          #25's own acceptance criterion), just in the normal document flow
          rather than the fixed bar above, since there is no button left to
          keep in reach. Not rendered at all once `delivered`: see
          <DeliveredNote>'s own comment for why that message goes stale. */}
      {!isDelivered && isLocked && (
        <div className="mt-6 flex justify-end">
          <SubmitSelectionPanel
            galleryId={galleryId}
            quota={quota}
            isLocked={isLocked}
            isGalleryLocked={isGalleryLocked}
            lockedByAdmin={lockedByAdmin}
            ownPickCount={ownPickCount}
            isAdminPreview={isAdminPreview}
            submittedAt={ownSubmittedAt}
            onSubmitted={handleSubmitted}
            allowsOriginalSelection={allowsOriginalSelection}
            rollingDelivery={rollingDelivery}
            unsentCount={unsentCount}
            lastSubmittedAt={viewerSubmittedAt}
            projection={counter.viewer?.projection ?? null}
          />
        </div>
      )}

      {lightbox && (
        <ProofLightbox
          // Task #222 — THE TRAP, closed: which array `lightbox.index` means
          // depends on which group it was opened from. Looked up by tag here
          // rather than carried as a snapshot inside `lightbox` itself — see
          // that state's own comment above for why a snapshot would be
          // wrong.
          assets={
            lightbox.group === "chosen"
              ? chosenAssets
              : lightbox.group === "unchosen"
                ? unchosenAssets
                : displayAssets
          }
          urls={urls}
          index={lightbox.index}
          // Task #146: the same server-recomputed quota <SelectionCounter>
          // above renders, so the full-screen view can say how many are
          // chosen without the client closing it to find out. Passed whole
          // rather than as a count, because the lightbox shows the included
          // number beside it and neither value is derived twice.
          quota={quota}
          onClose={() => setLightbox(null)}
          // Task #222 — stays inside the group it was opened from BY
          // CONSTRUCTION: this only ever updates `index`, never `group`, and
          // <ProofLightbox>'s own `hasNext`/`hasPrev` are bounded by
          // `assets.length` above — which is already just the one group's
          // array, never the full gallery's.
          onNavigate={(index) =>
            setLightbox((current) => (current ? { ...current, index } : current))
          }
          onImageError={(assetId) => void refreshUrl(assetId)}
          onToggleSelection={(assetId, nextSelected) => void toggleSelection(assetId, nextSelected)}
          pendingAssetIds={pendingIds}
          isLocked={isLocked || readOnly}
          lockedAssetIds={frozenAssetIds}
          // Epic #250 S7 — the lightbox's sent-pick freeze follows the tile's:
          // real for the pick's owner, absent while an admin acts on the
          // subject's behalf (see `frozenAssetIds` above).
          isActing={actingClientId !== null}
          isDelivered={showsFinals}
          selectionKindById={selectionKindById}
          onSetSelectionKind={(assetId, kind) => void setSelectionKind(assetId, kind)}
          allowsOriginalSelection={allowsOriginalSelection}
          entryById={entryById}
          viewerId={viewerId}
        />
      )}
    </>
  );
}

/** Epic #250 S7 — the four-number counter (decision 14), rendered as one meta
 * line under the instruction: "9 tuyas · 2 compartidas · 3 por enviar · 15
 * entre todos". Every number comes from the SERVER's `counter` — this
 * component never counts entries, because the partition invariant (every pick
 * of yours is in exactly one bucket) is the server's to keep. Always four
 * numbers, zeros included, so the line never reflows as numbers appear. */
function ViewerCounterLine({ counter }: { counter: SelectionCounterData }) {
  if (counter.viewer === null) return null;
  const { yours, shared, toSend } = counter.viewer;
  return (
    <p className="text-fg-mute mb-3 text-sm">
      <strong className="text-fg font-medium">
        {yours} {yours === 1 ? "tuya" : "tuyas"}
      </strong>
      {" · "}
      {shared} {shared === 1 ? "compartida" : "compartidas"}
      {" · "}
      {toSend} por enviar
      {" · "}
      {counter.group} entre todos
    </p>
  );
}

// Task #148 — `selected`'s own voice: "qué eligió, qué pasa ahora... y qué
// hacer si se equivocó" (that task's own body), mirroring
// design/system/client.html's `enviada` screen (:898-931) in CONTENT rather
// than its exact markup (that screen is a whole separate page in the mock;
// here it is a block inside the same one, additive to the tray/counter/grid
// this component already renders for a locked gallery — see the "THREE
// STATES" section of this file's own header comment for why additive was
// chosen over replacing the existing view).
//
// No invented turnaround time. The mock's own copy promises "entre una y
// dos semanas" — a number this app has no column for (`packages` carries a
// SESSION `durationLabel`, not an editing SLA) and inventing one here would
// be exactly the kind of claim this component cannot back up, the same
// standard <SubmitSelectionPanel>'s own header comment already holds itself
// to for "has access" vs. "was notified". This says only what is true:
// editing is in progress, the client is told by email when it's done.
function SelectedStateNote({
  quota,
  counter,
  viewerId,
  submittedAt,
  isGalleryLocked,
  lockedByAdmin,
  ownPickCount,
}: {
  quota: QuotaResult;
  counter: SelectionCounterData;
  /** Same prop <SelectionTray> already takes — the viewer's own picks read
   * "Tú" in the per-picker recap below too, for the same reason. */
  viewerId: string;
  /** The VIEWER's own submission time (epic #239), not the gallery's closing
   * time. `null` when an admin locked them. */
  submittedAt: string | null;
  /** Epic #239 — every active client is done and the gallery left `proofing`.
   * When `false` this note is shown to ONE locked person while the others are
   * still choosing, so it must not say the photographer has "la selección". */
  isGalleryLocked: boolean;
  /** Epic #239 — the photographer locked this person; they never submitted. */
  lockedByAdmin: boolean;
  /** Epic #239 — photos THIS person picked and sent, off the server counter. */
  ownPickCount: number;
}) {
  // Per-picker tally (task #94's shared gallery, not per-client): "Tú 9 ·
  // Beto 4 · Sara 2" (client.html:726, :848-850), off the SERVER's `people`
  // rows plus its "Sin registro" bucket — never a client-side count of the
  // entry list.
  const perPicker = useMemo(() => {
    const rows = counter.people.map((person) => ({
      key: person.userId,
      label: pickerLabelFor({ id: person.userId, label: person.label }, viewerId),
      count: person.units,
    }));
    if (counter.unattributed > 0) {
      rows.push({
        key: "unattributed",
        label: UNATTRIBUTED_PICKER_LABEL,
        count: counter.unattributed,
      });
    }
    return rows;
  }, [counter, viewerId]);

  return (
    <div className="border-line-2 mt-2 mb-6 rounded-sm border p-[18px]">
      <h2 className="font-serif text-lg">¿Qué pasa ahora?</h2>
      {isGalleryLocked ? (
        <p className="text-fg-dim mt-2 text-sm">
          Tu fotógrafo ya tiene la selección
          {submittedAt
            ? ` — la enviaste el ${new Date(submittedAt).toLocaleDateString("es-CO")}`
            : ""}{" "}
          y está editando {quota.selected} foto{quota.selected === 1 ? "" : "s"} en alta resolución
          y sin marca de agua. Te avisamos por correo apenas estén.
        </p>
      ) : (
        // Epic #239 — only THIS person is locked; the group is still choosing.
        // Says what is true: their own picks are with the photographer, nobody
        // else's are, and no editing/ETA claim for a gallery that is not done.
        <p className="text-fg-dim mt-2 text-sm">
          {lockedByAdmin
            ? "Tu fotógrafo cerró tu selección"
            : `Tu fotógrafo ya tiene tu selección${
                submittedAt
                  ? ` — la enviaste el ${new Date(submittedAt).toLocaleDateString("es-CO")}`
                  : ""
              }`}{" "}
          ({ownPickCount} foto{ownPickCount === 1 ? "" : "s"} tuya{ownPickCount === 1 ? "" : "s"}).
          Los demás todavía están eligiendo.
        </p>
      )}
      <p className="text-fg-dim mt-2 text-sm">
        ¿Te arrepentiste de alguna? {isGalleryLocked ? "La selección" : "Tu selección"} quedó
        cerrada, pero escríbele a tu fotógrafo y él la reabre.
      </p>
      {/* Only worth a breakdown once more than one person actually picked
          something — a solo client seeing "Tú: 15" would just be the same
          number repeated with no new information. */}
      {perPicker.length > 1 && (
        <dl className="mt-4 grid gap-2 text-sm">
          {perPicker.map(({ label, count }) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-fg-mute">{label}</dt>
              <dd className="tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// Task #148 — `delivered`'s own header, replacing the tray/counter/submit
// row this component retires once nothing about the selection can change
// anymore (see the "THREE STATES" section above). Mirrors the mock's own
// `entregada` copy (client.html:941: "15 fotos editadas, en alta resolución
// y sin marca de agua") rather than its full-bleed hero treatment
// (client.html:452-460) — DECLARED DEVIATION: a hero needs a chosen hero
// image, a scrim, and a decision about which component owns the gallery
// TITLE once it moves inside that hero (today `src/app/galleries/
// [publicSlug]/page.tsx` owns it, unconditionally, for all three statuses).
// That is a real design question, not a shortcut taken to save time, and
// answering it by fiat inside this slice risked exactly the kind of
// undiscussed cross-file ownership change this epic's own review has flagged
// before. Left for the owner to weigh in on; nothing about the stated
// acceptance criteria (the three states distinguish immediately, no
// watermark, both downloads work, the ZIP shows it takes a while) depends on
// the hero specifically.
function DeliveredNote({
  galleryId,
  finalAssetCount,
}: {
  galleryId: string;
  finalAssetCount: number;
}) {
  return (
    <div className="mb-6">
      <p className="text-fg-dim text-sm">
        {finalAssetCount} foto{finalAssetCount === 1 ? "" : "s"} editada
        {finalAssetCount === 1 ? "" : "s"}, en alta resolución y sin marca de agua — esto es lo que
        vas a volver a ver cuando quieras.
      </p>
      {finalAssetCount > 0 && (
        <div className="mt-3">
          <DownloadAllButton galleryId={galleryId} assetCount={finalAssetCount} />
        </div>
      )}
    </div>
  );
}
