"use client";

// The client's own view of a gallery's proofs (task #23): a responsive grid
// that reserves each tile's exact aspect ratio up front (no cumulative
// layout shift while images load) plus a lightbox for full-screen browsing
// with keyboard/swipe navigation.
//
// URL-expiry strategy — decided and written down here, not left implicit:
// presigned proof URLs are good for `PRESIGNED_URL_TTL_SECONDS` (5 minutes,
// src/lib/r2.ts) from the moment the server component that renders this
// page presigned them. A client is expected to leave this tab open past
// that (this is "browse your wedding photos", not a five-minute task,
// especially from bed on a phone) — so a page that only ever trusted its
// initial batch of URLs would start showing broken images partway through
// a normal session.
//
// The admin workspace (task #20, src/components/asset-tile.tsx) already
// solved the identical problem for its own grid with a per-tile <img
// onError> one-shot refetch against the SAME read route this app already
// has (`GET /api/assets/[assetId]/proof`, task #16) — that approach is
// reused here rather than inventing a batch-refresh-on-a-timer scheme: it
// only ever re-signs an asset that is actually on screen and actually
// stale, and needs no new endpoint.
//
// One deliberate difference from asset-tile.tsx: THIS surface renders the
// same asset in two different DOM nodes at once when the lightbox is open
// (the grid tile behind it, and the full-screen image) — the admin grid
// never does that. Refreshed-URL state therefore lives HERE, one level up,
// keyed by asset id, and is shared by both <ProofTile> and <ProofLightbox>
// for the same asset — so a URL that has already been refreshed by one
// surface doesn't need re-fetching by the other, and each asset is still
// only ever refreshed once (guarded by `refreshedAssetIds`), exactly like
// the admin version's `refreshedOnce` guard.
//
// Because the fix is "swap this one asset's src in place" rather than a
// hard reload, the client's scroll position and any open lightbox survive
// a stale-URL recovery untouched — the acceptance criterion this task
// calls out ("a stale page recovers... without a hard reload losing the
// client's place").
//
// Selection + live quota counter (task #24) live in THIS component, not a
// separate one, because the counter and the grid share the exact same
// selection state: toggling a tile must update the counter in the same
// render, and there is nowhere else both already meet. The counter's
// numbers, though, are never computed here — every response from `PATCH
// /api/assets/[assetId]/selection` (src/app/api/assets/[assetId]/selection/route.ts)
// already carries a freshly server-recomputed `quota` (via `computeQuota`,
// src/lib/quota.ts), and this component does nothing but store exactly
// that object in state and hand it to <SelectionCounter>. There is no local
// increment/decrement anywhere in this file — the acceptance criterion "the
// counter matches a server-side recomputation; the client cannot influence
// the numbers by editing anything" is satisfied by never giving the client
// anything to compute in the first place, not by re-deriving the same maths
// twice and hoping they stay in sync.
//
// THE LIVE, COLLABORATIVE LAYER (task #95) lives in this component too, for
// the same reason selection does: the tray, the grid, the counter and the
// submit panel are four views of ONE fact — the gallery's shared selection —
// and this is the only place all four already meet. See the "LIVE SYNC"
// section further down for the transport, the conflict rule and the submit
// lock; see `GET /api/galleries/[galleryId]/selection`'s own header comment
// for why that transport is polling and what it costs the droplet.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadAllButton } from "@/components/download-all-button";
import { DownloadFinalButton } from "@/components/download-final-button";
import { ProofLightbox } from "@/components/proof-lightbox";
import { SelectionCounter } from "@/components/selection-counter";
import { SelectionTray } from "@/components/selection-tray";
import {
  SubmitSelectionPanel,
  type SubmitSelectionOutcome,
} from "@/components/submit-selection-panel";
import { computeQuota, type QuotaResult } from "@/lib/quota";
import type { SelectionPick, SelectionPicker } from "@/lib/selection-snapshot";

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
  // display (see `urls`' initializer below) — the client paid, so the
  // watermark should be gone from what they look at, not only from what they
  // download. `proofUrl` is still carried on every asset regardless, as the
  // fallback `refreshUrl` below drops back to if the display object turns out
  // not to exist.
  //
  // Same "UI hint, never the gate" disclaimer as `hasFinal` above: the bytes
  // behind this URL are private R2 objects, and the page that presigned it
  // (src/app/galleries/[publicSlug]/page.tsx) had already verified this
  // session owns the gallery. A wrong value here cannot unlock anything; it
  // can only make this component request a URL that 404s.
  displayUrl: string | null;
};

// Hand-rolled, not imported from `@/lib/db/schema`'s `Gallery["status"]`:
// even a type-only import is erased at compile time and technically safe
// to bundle, but this file's own header comment already tells the story of
// ONE import off the wrong module breaking the production build (task #24's
// review) — duplicating five string literals here costs nothing and removes
// any need to reason about it ever again. Keep in sync with
// `galleryStatus` in schema.ts.
export type GalleryStatus = "draft" | "proofing" | "selected" | "delivered" | "archived";

// A gallery is no longer accepting toggles or a fresh submission once it has
// left `proofing` — see the submit route's own REOPEN POLICY comment
// (src/app/api/galleries/[galleryId]/submit-selection/route.ts) for why only
// an admin, not the client, can undo this.
const SUBMITTED_STATUSES = new Set<GalleryStatus>(["selected", "delivered", "archived"]);

// The statuses in which the shared selection can still CHANGE, and therefore
// the only ones worth spending a request on (task #95):
//
//   - `proofing` — anybody attached can pick, deselect or submit.
//   - `selected` — nobody can pick, but an ADMIN can unlock it back to
//     `proofing` (task #73), and every open tab should reopen when they do
//     rather than staying stuck read-only until someone reloads.
//
// `draft` never reaches a client at all, and `delivered`/`archived` are
// terminal — PLAN.md §2's state machine has no path back out of `delivered`
// toward the selectable statuses, so a client leaving a delivered gallery
// open for an hour to look at their photos issues ZERO polls. That is the
// single biggest saving in this design and it costs one `Set`.
const LIVE_SYNC_STATUSES = new Set<GalleryStatus>(["proofing", "selected"]);

// 5 seconds. Chosen against the actual use — two or three people in the same
// room or on the same call, arguing about which photos to keep — where the
// gap between "she picked it" and seeing it is already conversational. Faster
// buys nothing a human notices here; slower starts to feel broken when
// somebody says "listo, ya la puse". See the route's own header comment for
// what this cadence costs the droplet.
// Exported ONLY so proof-grid.test.tsx can drive the live-sync tests against
// the real cadence instead of a hand-copied literal that could silently drift
// from it — the same reason the PATCH selection route exports
// `SELECTION_LOCKED_STATUSES`.
export const SELECTION_POLL_INTERVAL_MS = 5_000;

// How many polls in a row must fail before the tray admits it is stale. One
// blip on a phone connection is not news and a red line every time a lift
// door closes would train the client to ignore it; two consecutive failures
// is ~10s of silence, which IS news.
const STALE_AFTER_CONSECUTIVE_FAILURES = 2;

type SelectionResponse = {
  asset: {
    id: string;
    isSelected: boolean;
    selectedAt: string | null;
    // Task #95: who the server recorded as the picker, straight from the
    // route that just wrote it — see that route's own comment.
    pickedBy: SelectionPicker | null;
  };
  quota: QuotaResult;
};

/** The shared-selection snapshot returned by `GET
 * /api/galleries/[galleryId]/selection`. The SERVER's view, in full — never
 * merged field-by-field with a local guess; see `applySnapshot` below. */
type SelectionSnapshot = {
  status: GalleryStatus;
  submittedAt: string | null;
  quota: QuotaResult;
  picks: SelectionPick[];
};

export function ProofGrid({
  galleryId,
  initialAssets,
  initialStatus,
  initialSubmittedAt,
  initialPicks,
  viewerId,
  packageName,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
}: {
  // Task #25's submit route is keyed on this — see that route's own header
  // comment for why the internal id, not the page's `publicSlug`, is the
  // right identifier for a same-origin `fetch()` call.
  galleryId: string;
  initialAssets: ProofAsset[];
  initialStatus: GalleryStatus;
  initialSubmittedAt: string | null;
  // Task #95: the shared, attributed selection as of the server render, built
  // by the SAME `getGallerySelection()` the live route calls — see that
  // module's header comment for why one function feeds both. Only the FIRST
  // paint comes from here; every refresh afterwards replaces it wholesale
  // with a fresh snapshot.
  initialPicks: SelectionPick[];
  // The signed-in user's own id, so the tray can render their own picks as
  // "Vos" rather than their own name (see `pickerLabelFor`). Nothing is
  // authorized by this value — it is a display detail; every route this
  // component calls resolves the acting session server-side and would refuse
  // a request regardless of what is passed here.
  viewerId: string;
  // The gallery's own frozen commercial terms (schema.ts's
  // `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`) — passed
  // through from the server component that renders this page
  // (src/app/galleries/[publicSlug]/page.tsx), never re-fetched from the
  // live `packages` row here. Only needed for the INITIAL paint's quota
  // (before any toggle has happened yet); every toggle after that replaces
  // the whole `quota` state with the server's own recomputation, which
  // already carries these same numbers back.
  packageName: string;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
}) {
  // Task #89: seeded from the DISPLAY url when the page provided one, falling
  // back to the proof. Seeding this ONE map — rather than teaching <ProofTile>
  // and <ProofLightbox> each to prefer a different field — is what makes the
  // unwatermarked image appear in the grid AND the lightbox from a single
  // change: both surfaces already read this map, keyed by asset id, and have
  // done since task #23.
  const [urls, setUrls] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialAssets.map((asset) => [asset.id, asset.displayUrl ?? asset.proofUrl]),
    ),
  );
  // A Set (not state) — which assets have already been refreshed doesn't
  // need to trigger a re-render on its own, only the `urls` update it
  // causes does.
  const refreshedAssetIds = useRef<Set<string>>(new Set());
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // `is_selected` per asset. Seeded from the initial server-rendered paint,
  // then only ever overwritten by a toggle response's own `asset.isSelected`
  // — never flipped locally before the round trip confirms it, so what this
  // renders can never drift from what the database actually holds.
  const [selectionById, setSelectionById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.isSelected])),
  );
  const [quota, setQuota] = useState<QuotaResult>(() =>
    computeQuota(initialAssets.filter((asset) => asset.isSelected).length, {
      includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot,
    }),
  );
  // Task #95: the shared, ATTRIBUTED selection — the tray's whole content.
  // Seeded from the server render, then replaced WHOLESALE by each accepted
  // snapshot (never merged field by field) plus the one local edit a
  // confirmed toggle of this session's own makes; see `applySnapshot` and
  // `toggleSelection` below.
  const [picks, setPicks] = useState<SelectionPick[]>(initialPicks);

  // Task #25 + #95: the gallery's status, now LIVE rather than fixed at
  // mount. It was a one-way `isLocked` boolean that only `handleSubmitted`
  // could ever flip; it is the status itself now, because the submit lock has
  // to arrive from OTHER sessions too — "one client submits, every other open
  // session becomes read-only without a reload" is task #95's own acceptance
  // criterion, and the most damaging failure this screen can have is a
  // collaborator cheerfully picking into a gallery somebody else already
  // closed.
  //
  // The SERVER remains the real authority (the PATCH selection route's
  // `SELECTION_LOCKED_STATUSES` and the submit route's own status gate);
  // this only decides what this component renders — see
  // <SubmitSelectionPanel>'s own header comment for the same disclaimer.
  // Because it tracks the server's status rather than latching, it converges
  // in BOTH directions: an admin unlocking a submitted selection (task #73)
  // reopens every open tab on the next tick, which used to need a reload.
  const [status, setStatus] = useState<GalleryStatus>(initialStatus);
  const isLocked = SUBMITTED_STATUSES.has(status);
  const [submittedAt, setSubmittedAt] = useState<string | null>(initialSubmittedAt);
  // `toggleSelection` below is a `useCallback` with an EMPTY dependency
  // array (deliberate — see its own existing comments on why the guards
  // inside it are refs, not state), so it would otherwise only ever see the
  // `isLocked` value from the render it was first created in. Mirrored into
  // a ref, updated at every call site that can flip the status
  // (`handleSubmitted` and `applySnapshot` below), the same "ref for
  // synchronous truth, state for rendering" split `pendingIdsRef` already
  // uses.
  const isLockedRef = useRef(isLocked);

  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  // The ACTUAL guard against a same-asset double toggle — `pendingIds`
  // (state, above) only disables the button visually and lags one render
  // behind; a second click issued before that render commits would not see
  // it. This ref is mutated synchronously and read at the very top of
  // `toggleSelection`, so the early return below is a real guard "by
  // design", not an incidental side effect of the UI being disabled.
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const [toggleError, setToggleError] = useState<string | null>(null);

  // Monotonic counter, incremented once per REQUEST at ISSUE time (not at
  // response time) — by every toggle AND, since task #95, by every live poll,
  // deliberately the same counter so the two can be ordered against each
  // other at all (see `applySnapshot`).
  //
  // Its original job: keeping the live counter honest when two
  // toggles land on DIFFERENT assets and their responses resolve OUT OF
  // ORDER (a normal occurrence on a phone connection, not an edge case):
  // toggling asset A, then asset B, with B's response arriving before A's,
  // must still leave the counter showing B's numbers (the LAST thing
  // actually issued), not A's (the last thing to ARRIVE) — otherwise the
  // client reads a stale, lower count as if it were current, right before
  // closing the tab and quoting the wrong surcharge over WhatsApp. Every
  // response's own sequence number is compared against the highest sequence
  // number applied so far; a response from an earlier-issued request that
  // arrives after a later one is applied is discarded rather than
  // overwriting the newer number. `selectionById` needs no equivalent guard:
  // `pendingIdsRef` already prevents two in-flight requests for the SAME
  // asset, so each asset's own key can only ever be written by its own
  // single in-flight request at a time.
  const quotaSequenceRef = useRef(0);
  const appliedQuotaSequenceRef = useRef(0);

  // ==========================================================================
  // LIVE SYNC (task #95) — how this component converges on SERVER TRUTH
  // ==========================================================================
  //
  // THE CONFLICT THIS EXISTS FOR: A deselects a photo while B selects it. Both
  // clicks reach the server; one of them is simply last, and whatever the
  // database holds after that is the answer — there is no merge, no
  // "last-writer-wins on the client", and no attempt to reconcile two local
  // intentions. Every viewer, including the one whose click LOST, ends up
  // rendering the row the server actually holds. Getting this wrong is worse
  // than not building the feature: two people would each be looking at a
  // different "shared" selection, and one of them would quote the wrong
  // surcharge.
  //
  // Which means the ONLY interesting question is: when a snapshot the server
  // sent and a local mutation this session made disagree, which wins? The
  // snapshot always wins EXCEPT when it is provably older than a local write
  // the server has already confirmed — because in that one case the snapshot
  // is not a competing truth, it is a photograph of the past, and applying it
  // would flip the client's own just-confirmed pick back for one interval
  // before flipping it forward again. Two conditions, both conservative:
  //
  //   1. If ANY toggle is in flight, the snapshot is dropped entirely. That
  //      request's own response is fresher by construction, and it is about to
  //      arrive. A dropped tick costs 5 seconds of staleness; a merged one
  //      costs a wrong tray.
  //   2. If the snapshot was ISSUED at or before the clock value at which this
  //      session's last confirmed write landed, it is dropped. Deliberately
  //      over-conservative — a snapshot issued after the write was issued but
  //      before it committed is indistinguishable from one issued before it,
  //      so both are discarded.
  //
  // Note what is NOT in that list: there is no per-asset merge, no "keep my
  // version of this one photo". The snapshot replaces `picks`, `selectionById`,
  // `quota`, `status` and `submittedAt` together, as one consistent view. A
  // half-applied snapshot is how a tray and a counter start disagreeing.
  const lastLocalWriteClockRef = useRef(0);
  // The tray's honesty flag: how many polls in a row have failed. Not state —
  // only the derived `isStale` needs to re-render.
  const consecutiveFailuresRef = useRef(0);
  const [isStale, setIsStale] = useState(false);
  // One poll at a time. A tick that lands while the previous request is still
  // outstanding (a slow connection, a suspended tab waking up) is skipped
  // rather than queued — the next tick is 5 seconds away and carries strictly
  // fresher data than the one that would have been queued.
  const pollInFlightRef = useRef(false);

  const applySnapshot = useCallback((snapshot: SelectionSnapshot, issuedAtClock: number) => {
    // Condition 1 — see the section comment above.
    if (pendingIdsRef.current.size > 0) return;
    // Condition 2.
    if (issuedAtClock <= lastLocalWriteClockRef.current) return;

    setStatus(snapshot.status);
    isLockedRef.current = SUBMITTED_STATUSES.has(snapshot.status);
    setSubmittedAt(snapshot.submittedAt);
    setPicks(snapshot.picks);

    const pickedAssetIds = new Set(snapshot.picks.map((pick) => pick.assetId));
    // Rebuilt from the keys THIS COMPONENT knows about, not from the
    // snapshot's own list: an asset the photographer uploaded after this page
    // was server-rendered exists in the snapshot but has no tile here and no
    // presigned URL, so inventing a key for it would put a permanently broken
    // entry in `selectionById`. The tray renders such a pick as a labelled
    // placeholder instead (see <SelectionTray>), which is the honest outcome
    // until the client next loads the page.
    setSelectionById((prev) => {
      const next: Record<string, boolean> = {};
      for (const assetId of Object.keys(prev)) next[assetId] = pickedAssetIds.has(assetId);
      return next;
    });

    // Same counter the toggles use, so a toggle issued AFTER this snapshot
    // still overwrites its quota when it lands, and one issued before does
    // not.
    appliedQuotaSequenceRef.current = issuedAtClock;
    setQuota(snapshot.quota);
  }, []);

  const poll = useCallback(async () => {
    if (pollInFlightRef.current) return;
    pollInFlightRef.current = true;
    const issuedAtClock = ++quotaSequenceRef.current;
    try {
      const response = await fetch(`/api/galleries/${galleryId}/selection`);
      if (!response.ok) {
        // A 403/404 here means this session lost access while the tab was open
        // (removed from the gallery, task #97) — treated exactly like a
        // network failure on purpose: the tray goes stale-but-honest rather
        // than blanking. It has no authority to revoke anything itself, and
        // every route it could still call re-checks ownership on its own.
        consecutiveFailuresRef.current += 1;
        if (consecutiveFailuresRef.current >= STALE_AFTER_CONSECUTIVE_FAILURES) setIsStale(true);
        return;
      }
      const snapshot = (await response.json()) as SelectionSnapshot;
      consecutiveFailuresRef.current = 0;
      setIsStale(false);
      applySnapshot(snapshot, issuedAtClock);
    } catch {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= STALE_AFTER_CONSECUTIVE_FAILURES) setIsStale(true);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [galleryId, applySnapshot]);

  useEffect(() => {
    // Nothing about the shared selection can change in a terminal status, so
    // nothing is spent watching it — see LIVE_SYNC_STATUSES.
    if (!LIVE_SYNC_STATUSES.has(status)) return;

    // Deliberately NO poll on mount: the server component that rendered this
    // page already provided the current snapshot, and asking again a
    // millisecond later would be one wasted request per page load, per
    // viewer, forever.
    const interval = setInterval(() => {
      // A backgrounded tab is the common case on a phone — the client puts it
      // down mid-argument — and it is worth nothing to keep polling for a
      // screen nobody is looking at. The visibility listener below catches
      // them straight back up when they return, so this loses no correctness.
      if (typeof document !== "undefined" && document.hidden) return;
      void poll();
    }, SELECTION_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [status, poll]);

  const toggleSelection = useCallback(async (assetId: string, nextSelected: boolean) => {
    // UX-only mirror of the PATCH route's own server-side lock — a click
    // that somehow still reaches here (a stale render, a race with
    // `handleSubmitted` below) would get refused with a 409 anyway; this
    // just avoids firing the request at all once the UI already knows the
    // answer.
    if (isLockedRef.current) return;
    if (pendingIdsRef.current.has(assetId)) return;
    pendingIdsRef.current.add(assetId);
    setPendingIds(new Set(pendingIdsRef.current));
    setToggleError(null);

    const sequence = ++quotaSequenceRef.current;
    try {
      const response = await fetch(`/api/assets/${assetId}/selection`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected: nextSelected }),
      });
      if (!response.ok) {
        setToggleError("No se pudo actualizar la selección.");
        return;
      }
      const body = (await response.json()) as SelectionResponse;
      // The asset's own confirmed flag — no sequencing needed, see this
      // block's own comment above for why.
      setSelectionById((prev) => ({ ...prev, [body.asset.id]: body.asset.isSelected }));

      // Task #95: the tray moves the photo the instant the server confirms
      // it, not one poll interval later — waiting up to 5 seconds to see your
      // OWN click take effect would read as the app being broken. Every field
      // written here comes from the response (`isSelected`, `selectedAt`,
      // `pickedBy`), never guessed: this is the same row the route just wrote,
      // reported back by the route that wrote it. The next accepted snapshot
      // replaces the whole list anyway.
      //
      // Removed-then-appended on select rather than sorted: the server orders
      // by `selected_at` ascending, and a pick made now IS the newest, so
      // appending reproduces the server's own order without re-sorting a list
      // whose other timestamps this component never re-reads.
      setPicks((prev) => {
        const without = prev.filter((pick) => pick.assetId !== body.asset.id);
        if (!body.asset.isSelected) return without;
        return [
          ...without,
          {
            assetId: body.asset.id,
            selectedAt: body.asset.selectedAt,
            pickedBy: body.asset.pickedBy,
          },
        ];
      });

      // This session now holds a write the server has confirmed. Any snapshot
      // ISSUED at or before this moment is a photograph of the past and must
      // not be applied over it — see the LIVE SYNC section above.
      lastLocalWriteClockRef.current = quotaSequenceRef.current;

      // The server's own recomputed quota — only applied if no LATER-issued
      // toggle's response (or accepted snapshot) has already been applied. See
      // the header comment on `quotaSequenceRef` above.
      if (sequence > appliedQuotaSequenceRef.current) {
        appliedQuotaSequenceRef.current = sequence;
        setQuota(body.quota);
      }
    } catch {
      setToggleError("No se pudo conectar.");
    } finally {
      pendingIdsRef.current.delete(assetId);
      setPendingIds(new Set(pendingIdsRef.current));
    }
  }, []);

  // Which assets were rendered with a DISPLAY url rather than a proof url
  // (task #89), captured ONCE from the server-rendered props. `refreshUrl`
  // below is a `useCallback` with an empty dependency array — deliberately,
  // like `toggleSelection` above — so it cannot read `initialAssets` directly
  // without either going stale or dragging the whole array into its
  // dependencies. A lazily-initialized ref gives it a stable, render-count-
  // independent answer instead. Safe to freeze at first render: whether an
  // asset HAS a display derivative is decided by the gallery's status and the
  // photographer's uploads, neither of which changes without a page load.
  const displayAssetIds = useRef<Set<string> | null>(null);
  if (displayAssetIds.current === null) {
    displayAssetIds.current = new Set(
      initialAssets.filter((asset) => asset.displayUrl !== null).map((asset) => asset.id),
    );
  }

  const refreshUrl = useCallback(async (assetId: string) => {
    if (refreshedAssetIds.current.has(assetId)) return;
    refreshedAssetIds.current.add(assetId);
    try {
      // Task #89: an asset showing its unwatermarked derivative must be
      // re-signed against THAT object, not the proof — asking `/proof` here
      // would silently put the watermark back on a delivered photo the first
      // time its URL aged past PRESIGNED_URL_TTL_SECONDS.
      //
      // Two-step, in this order, because the display route can legitimately
      // answer 404 for a reason the proof route cannot: a final uploaded
      // BEFORE task #89 shipped has no display object in R2 until
      // `bun run backfill:display` has run, and that route does a HEAD check
      // rather than handing back a presigned URL for something absent (see
      // its own comment). Falling back to the proof then is a DEGRADED but
      // correct outcome — the client sees the watermarked version of a photo
      // they own, not a broken tile — and it fails in the protective
      // direction, which is the right way for this particular thing to fail.
      if (displayAssetIds.current?.has(assetId)) {
        const displayResponse = await fetch(`/api/assets/${assetId}/display`);
        if (displayResponse.ok) {
          const body = (await displayResponse.json()) as { url: string };
          setUrls((prev) => ({ ...prev, [assetId]: body.url }));
          return;
        }
      }

      const response = await fetch(`/api/assets/${assetId}/proof`);
      if (!response.ok) return;
      const body = (await response.json()) as { url: string };
      setUrls((prev) => ({ ...prev, [assetId]: body.url }));
    } catch {
      // Leave the broken thumbnail as-is; nothing else to try here — same
      // fallback as asset-tile.tsx's handleImgError.
    }
  }, []);

  // <SubmitSelectionPanel>'s success callback — this session's OWN
  // submission. Also replaces `quota` wholesale with the submit route's own
  // recomputation, same "never trust a number this component didn't get
  // handed by the server" stance `toggleSelection` already follows above,
  // and covers the idempotent "already_submitted" outcome identically to a
  // fresh "submitted" one — both mean "the gallery is locked, here is the
  // real quota", which is all this component needs to know.
  //
  // Task #95: this is no longer the ONLY way the lock can arrive — a snapshot
  // reporting somebody ELSE's submission does the same thing (see
  // `applySnapshot`). `"selected"` is the status the submit route transitions
  // to, and setting it here rather than a separate boolean is what keeps the
  // two paths from being able to disagree. The write clock is stamped for the
  // same reason a toggle stamps it: a snapshot issued before this submission
  // committed must not reopen the UI for one interval.
  const handleSubmitted = useCallback((outcome: SubmitSelectionOutcome) => {
    isLockedRef.current = true;
    setStatus("selected");
    setSubmittedAt(outcome.submittedAt);
    setQuota(outcome.quota);
    lastLocalWriteClockRef.current = ++quotaSequenceRef.current;
    appliedQuotaSequenceRef.current = quotaSequenceRef.current;
  }, []);

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

  const openAssetInLightbox = useCallback(
    (assetId: string) => {
      const index = initialAssets.findIndex((asset) => asset.id === assetId);
      // -1 for a pick whose asset this page never rendered — nothing to open,
      // and opening the lightbox at index -1 would blank it.
      if (index >= 0) setLightboxIndex(index);
    },
    [initialAssets],
  );

  if (initialAssets.length === 0) {
    return (
      <p className="text-fg-dim text-[15px] leading-relaxed">
        Tu fotógrafo todavía no subió fotos para esta galería.
      </p>
    );
  }

  // Task #28: a gallery only ever reaches `delivered` once (PLAN.md §2's
  // state machine has no path back out of it toward the client-visible
  // statuses), so — unlike `status`/`isLocked` above — this never needs to
  // flip after mount; `initialStatus` alone is enough for this component's
  // whole lifetime.
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
  const isDelivered = initialStatus === "delivered";
  // Task #29: the button only makes sense once there is at least one final
  // to actually zip — same per-asset `hasFinal` truth `showDownload` below
  // already relies on for the individual buttons, just reduced to "is there
  // at least one". The route re-derives this exact set itself from the
  // database on every request (see its own comment); this is a UI hint only,
  // same disclaimer as `hasFinal`'s own.
  const hasAnyFinal = isDelivered && initialAssets.some((asset) => asset.hasFinal);

  return (
    <>
      {/* Task #95 — the owner's request, literally: the chosen photos live in
          a list at the TOP of the page, in the same thumbnail style as the
          grid, saying who chose each one. Rendered above the counter and the
          grid, always, including before anybody has picked anything: see
          <SelectionTray>'s own header comment for why it does not appear on
          first pick. */}
      <SelectionTray
        picks={picks}
        urls={urls}
        filenamesByAssetId={filenamesByAssetId}
        viewerId={viewerId}
        isLocked={isLocked}
        isStale={isStale}
        onOpenAsset={openAssetInLightbox}
        // The SAME `refreshUrl` the grid tiles and the lightbox use, sharing
        // the same `refreshedAssetIds` dedupe — see <SelectionTray>'s own
        // `onImageError` comment for why the tray needs it MORE than they do.
        onImageError={(assetId) => void refreshUrl(assetId)}
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <SelectionCounter packageName={packageName} quota={quota} />
        <div className="flex items-center gap-3">
          {toggleError && <p className="text-xs text-[#e0796b]">{toggleError}</p>}
          {hasAnyFinal && <DownloadAllButton galleryId={galleryId} />}
        </div>
      </div>

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {initialAssets.map((asset, index) => {
          const isSelected = selectionById[asset.id] ?? asset.isSelected;
          return (
            <ProofTile
              key={asset.id}
              asset={asset}
              src={urls[asset.id] ?? asset.proofUrl}
              isSelected={isSelected}
              isPending={pendingIds.has(asset.id)}
              isLocked={isLocked}
              showDownload={isDelivered && asset.hasFinal}
              onError={() => void refreshUrl(asset.id)}
              onOpen={() => setLightboxIndex(index)}
              onToggleSelection={() => void toggleSelection(asset.id, !isSelected)}
            />
          );
        })}
      </ul>

      <div className="mt-6 flex justify-end">
        <SubmitSelectionPanel
          galleryId={galleryId}
          quota={quota}
          isLocked={isLocked}
          submittedAt={submittedAt}
          onSubmitted={handleSubmitted}
        />
      </div>

      {lightboxIndex !== null && (
        <ProofLightbox
          assets={initialAssets.map((asset) => ({
            ...asset,
            isSelected: selectionById[asset.id] ?? asset.isSelected,
          }))}
          urls={urls}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onImageError={(assetId) => void refreshUrl(assetId)}
          onToggleSelection={(assetId, nextSelected) => void toggleSelection(assetId, nextSelected)}
          pendingAssetIds={pendingIds}
          isLocked={isLocked}
          isDelivered={isDelivered}
        />
      )}
    </>
  );
}

function ProofTile({
  asset,
  src,
  isSelected,
  isPending,
  isLocked,
  showDownload,
  onError,
  onOpen,
  onToggleSelection,
}: {
  asset: ProofAsset;
  src: string;
  isSelected: boolean;
  isPending: boolean;
  // Task #25: once submitted, every toggle button renders disabled — UX
  // only, see this file's own `toggleSelection`/`isLockedRef` comment for
  // the real, server-side gate this mirrors.
  isLocked: boolean;
  // Task #28: `<ProofGrid>`'s own `isDelivered && asset.hasFinal` — see that
  // component's header comment on `ProofAsset.hasFinal` for why this is a UI
  // hint only, never the real gate.
  showDownload: boolean;
  onError: () => void;
  onOpen: () => void;
  onToggleSelection: () => void;
}) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Ver ${asset.originalFilename}`}
        className="focus-visible:ring-accent block w-full rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        {/* Aspect ratio reserved from `proofWidth`/`proofHeight` BEFORE the
            image ever arrives — this is what makes the grid load with zero
            cumulative layout shift, the columns this task's acceptance
            criterion is about. */}
        <div
          className="bg-bg-2 relative overflow-hidden rounded-sm"
          style={{ aspectRatio: `${asset.proofWidth} / ${asset.proofHeight}` }}
        >
          {/* Plain <img>, not next/image: same reasoning as asset-tile.tsx —
              proof URLs are short-lived, private, presigned R2 URLs whose
              query string is never stable between two loads of the same
              asset. `alt=""` because the filename is already announced by
              the enclosing button's aria-label; a second announcement here
              would be redundant. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            onError={onError}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
          />
        </div>
      </button>

      {/* A sibling of the "open lightbox" button above, not nested inside
          it — a nested button would be invalid HTML (buttons can't nest) and
          would also make this click bubble into `onOpen`. Positioned on top
          of the tile only visually, via absolute placement on the `relative`
          <li>. Never blocks or scolds going over quota (task #24) — this
          control does exactly one thing, flip this one asset's selection,
          regardless of how many are already selected. */}
      <button
        type="button"
        onClick={onToggleSelection}
        disabled={isPending || isLocked}
        aria-pressed={isSelected}
        aria-label={
          isSelected
            ? `Quitar de seleccionadas: ${asset.originalFilename}`
            : `Seleccionar: ${asset.originalFilename}`
        }
        className={`absolute top-2 right-2 z-10 rounded-full px-2 py-1 text-xs font-medium shadow transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          isSelected ? "bg-accent text-bg" : "bg-bg/85 text-fg hover:bg-bg"
        }`}
      >
        {isSelected ? "✓ Seleccionada" : "Seleccionar"}
      </button>

      {/* Bottom-right, not on top of the selection badge above — task #28's
          own affordance, shown only once the gallery is delivered AND this
          specific asset actually has a final (see <ProofGrid>'s own
          `showDownload` computation). */}
      {showDownload && (
        <div className="absolute right-2 bottom-2 z-10">
          <DownloadFinalButton assetId={asset.id} originalFilename={asset.originalFilename} />
        </div>
      )}
    </li>
  );
}
