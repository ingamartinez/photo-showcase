"use client";

// THE GALLERY'S SHARED SELECTION, as one client tab sees it: this session's
// own toggles, everybody else's, the quota counter's numbers, and the submit
// lock. Lifted out of <ProofGrid> by task #144 (a purely structural split —
// nothing here changed behaviour, and the reasoning below moved with the code
// it describes rather than being summarised).
//
// Selection + live quota counter (task #24) live in ONE place, not two,
// because the counter and the grid share the exact same selection state:
// toggling a tile must update the counter in the same render, and there is
// nowhere else both already meet. The counter's numbers, though, are never
// computed here — every response from `PATCH
// /api/assets/[assetId]/selection` (src/app/api/assets/[assetId]/selection/route.ts)
// already carries a freshly server-recomputed `quota` (via `computeQuota`,
// src/lib/quota.ts), and this hook does nothing but store exactly
// that object in state and hand it back to <ProofGrid> for <SelectionCounter>.
// There is no local increment/decrement anywhere in this file — the acceptance
// criterion "the counter matches a server-side recomputation; the client cannot
// influence the numbers by editing anything" is satisfied by never giving the
// client anything to compute in the first place, not by re-deriving the same
// maths twice and hoping they stay in sync.
//
// THE LIVE, COLLABORATIVE LAYER (task #95, transport corrected in task #114)
// lives here too, for the same reason selection does: the tray, the grid, the
// counter and the submit panel are four views of ONE fact — the gallery's
// shared selection — and this is the only place all four already meet. See the
// "LIVE SYNC" section further down for the conflict rule and the submit lock
// (unchanged since #95) and the "PUSH TRANSPORT" section right after it for
// task #114's SSE wiring; see
// `GET /api/galleries/[galleryId]/selection`'s own header comment for the
// corrected transport decision and what each piece costs the droplet.
//
// (Task #144 note for anyone arriving from a cross-reference: PLAN.md §2,
// src/lib/selection-events.ts and the selection route all point at
// "proof-grid.tsx's LIVE SYNC / PUSH TRANSPORT sections". Those sections are
// THIS FILE now — same text, moved whole with the code.)
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubmitSelectionOutcome } from "@/components/submit-selection-panel";
import { computeQuota, type QuotaResult } from "@/lib/quota";
import type { SelectionPick, SelectionPicker } from "@/lib/selection-snapshot";

// Hand-rolled, not imported from `@/lib/db/schema`'s `Gallery["status"]`:
// even a type-only import is erased at compile time and technically safe
// to bundle, but proof-grid.tsx's own header comment already tells the story of
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

// 30 seconds — task #114 changed both the VALUE and the JOB of this constant.
// Under #95 this WAS the transport: every update, from any session, arrived
// on the next tick, at most 5s away. Task #114 replaced that with a push
// transport (see the "PUSH TRANSPORT" section below): the normal case is now
// "well under a second", carried by an SSE stream fed off Postgres
// LISTEN/NOTIFY. This constant is now the FALLBACK — a backstop for the one
// failure mode the stream cannot self-report (a proxy or extension that
// silently drops an `EventSource` without ever firing its `error` handler),
// active the whole time the stream is meant to be open, independent of
// whether it currently is. 30s was chosen, not 5s: the normal case no longer
// depends on this number's size at all, so there is nothing to buy by
// keeping it short, and every tick that fires while the stream IS healthy is
// pure waste — a sixth of #95's own request volume in exactly the case where
// it still fires for real. See the selection route's own header comment for
// the full "whether polling survives" reasoning.
// Exported ONLY so proof-grid.test.tsx can drive the live-sync tests against
// the real cadence instead of a hand-copied literal that could silently drift
// from it — the same reason the PATCH selection route exports
// `SELECTION_LOCKED_STATUSES`. That test imports it from proof-grid.tsx, which
// re-exports it (task #144): the constant moved here with the loop it paces,
// and the import path callers already had stayed where it was.
export const SELECTION_POLL_INTERVAL_MS = 30_000;

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

/** The two fields of `ProofAsset` (src/components/proof-grid.tsx) this hook
 * reads, and only for the FIRST paint's seed. Structural rather than an import
 * of `ProofAsset` itself for the same reason `ProofUrlAsset` is: the shared
 * selection is about asset ids and their flags, not about how a tile renders. */
export type SharedSelectionAsset = {
  id: string;
  isSelected: boolean;
};

export function useSharedSelection({
  galleryId,
  initialAssets,
  initialStatus,
  initialSubmittedAt,
  initialPicks,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
}: {
  galleryId: string;
  initialAssets: SharedSelectionAsset[];
  initialStatus: GalleryStatus;
  initialSubmittedAt: string | null;
  initialPicks: SelectionPick[];
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
}) {
  // `is_selected` per asset. Seeded from the initial server-rendered paint,
  // then only ever overwritten by a toggle response's own `asset.isSelected`
  // — never flipped locally before the round trip confirms it, so what this
  // renders can never drift from what the database actually holds.
  const [selectionById, setSelectionById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.isSelected])),
  );
  // Task #205 — this hook only ever knows `isSelected`, never
  // `selectionKind` (`SharedSelectionAsset` doesn't carry it, and every
  // asset this app can produce today is `edited` — task #206 is the slice
  // that would let a client pick `original` at all). Seeded here as 0
  // originals; every quota AFTER this first paint comes straight from the
  // server's own recomputation (the PATCH/GET routes, both of which read the
  // gallery's real `originalPhotoPriceCopSnapshot`), never recomputed
  // locally again.
  const [quota, setQuota] = useState<QuotaResult>(() =>
    computeQuota(initialAssets.filter((asset) => asset.isSelected).length, 0, {
      includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot,
      originalPhotoPriceCopSnapshot: 0,
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
  // this only decides what <ProofGrid> renders — see
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
  // LIVE SYNC (task #95) — how this hook converges on SERVER TRUTH
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
  //      arrive. A dropped fetch costs one fallback-interval's worth of
  //      staleness at most (see `requestRefresh` below for why it is usually
  //      far less); a merged one costs a wrong tray.
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
  //
  // WHAT "ISSUE CLOCK" MEANS FOR A PUSHED EVENT (task #114, worked out BEFORE
  // writing the SSE wiring below, per that task's own instruction): NOTHING
  // NEW. An SSE `changed`/`ready` message is not a snapshot and is never
  // compared against `lastLocalWriteClockRef` itself — it carries no data at
  // all (see `src/lib/selection-events.ts`'s own header comment on why the
  // channel payload is never the selection). All it does is call
  // `requestRefresh()` below, which — like the old `setInterval` tick it now
  // shares a code path with — turns into a call to `poll()`, and `poll()`
  // mints the clock value AT THE MOMENT IT ACTUALLY ISSUES THE FETCH
  // (`++quotaSequenceRef.current`, unchanged from #95). So a push-triggered
  // fetch's issue clock is stamped exactly like an interval-triggered one
  // always was: at fetch-issue time, not at "notification received" time,
  // not at "server wrote the row" time. Conditions 1 and 2 above therefore
  // need no new case for "a snapshot that arrived because of a push" — by
  // the time `applySnapshot` ever sees one, it is indistinguishable from a
  // snapshot the old 5-second interval would have fetched, just fetched
  // sooner. Getting this wrong (comparing against, say, the moment the
  // `changed` event was RECEIVED, or trusting a clock value carried on the
  // wire) would have reopened exactly the ordering hole #95's two conditions
  // exist to close; not inventing a second clock concept is what keeps them
  // closed.
  const lastLocalWriteClockRef = useRef(0);
  // The tray's honesty flag: how many FETCHES (interval, visibility-wake, or
  // push-triggered — all go through `poll()`) in a row have failed. Not
  // state — only the derived `isStale` needs to re-render.
  const consecutiveFailuresRef = useRef(0);
  const [isStale, setIsStale] = useState(false);
  // One poll at a time. A trigger that lands while a fetch is still
  // outstanding does not queue a SECOND concurrent request — see
  // `requestRefresh` below for what it does instead, which is new in task
  // #114 (under #95's pure-interval design, the next TICK was always at most
  // 5s away and a dropped one was cheap; under push, a `changed` event
  // arriving mid-fetch and being silently dropped would mean waiting for the
  // NEXT push or the 30s fallback, which is the freshness regression
  // `requestRefresh` exists to close).
  const pollInFlightRef = useRef(false);
  // Set when something asked for a refresh WHILE a fetch was already in
  // flight — see `requestRefresh`.
  const pendingRefreshRef = useRef(false);

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
    // Rebuilt from the keys THIS HOOK knows about, not from the
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

  // Holds the LATEST `poll` — see the comment on its own assignment below for
  // why `poll`'s `finally` block re-triggers itself through this ref rather
  // than calling `poll()` by name: a `useCallback` that closes over its own
  // name (`poll` calling `poll()`) is a self-reference the React Compiler
  // cannot preserve manual memoization through (`react-hooks/preserve-
  // manual-memoization`, discovered by `bun run lint` failing on exactly
  // this), even though it is perfectly valid, ordinary JavaScript at
  // runtime. A ref sidesteps it: `pollRef.current` is a stable identity the
  // compiler has no opinion about, assigned fresh after every definition of
  // `poll` below, so the indirection changes nothing about WHEN or WHETHER
  // the retry fires, only how the compiler sees it.
  const pollRef = useRef<() => Promise<void>>(async () => {});

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

      // A poll that SUCCEEDED is not on its own evidence that what the client
      // is looking at is current — `applySnapshot` may be about to discard it.
      // Clearing the staleness warning here unconditionally would mean the
      // tray actively asserts freshness in exactly the window where it is
      // ignoring every update: a PATCH hanging on a flaky connection keeps
      // `pendingIdsRef` non-empty, every snapshot arriving meanwhile is
      // dropped by condition 1, and the client would be told the list is live
      // while it is frozen. "Stale-but-honest beats silently-wrong" is this
      // task's own acceptance criterion, and that is the wrong side of it.
      //
      // Deliberately mirrors condition 1 ONLY, not condition 2. A snapshot
      // dropped for being older than a confirmed local write is not staleness
      // — in that case the client is looking at something the server already
      // acknowledged, which is FRESHER than the snapshot being discarded, so
      // clearing the warning is correct there.
      //
      // Safe to read `pendingIdsRef` twice (here and inside `applySnapshot`):
      // there is no `await` between the two reads, so they run in the same
      // synchronous continuation and cannot disagree.
      //
      // The counters are left ALONE rather than incremented when a snapshot is
      // dropped — nothing failed, the network is fine, and counting this as a
      // failure would eventually raise a connection warning that is simply not
      // true.
      if (pendingIdsRef.current.size === 0) {
        consecutiveFailuresRef.current = 0;
        setIsStale(false);
      }
      applySnapshot(snapshot, issuedAtClock);
    } catch {
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= STALE_AFTER_CONSECUTIVE_FAILURES) setIsStale(true);
    } finally {
      pollInFlightRef.current = false;
      // Task #114: something asked for a refresh WHILE this fetch was in
      // flight (almost always a `changed` push racing the 30s fallback tick,
      // or two pushes arriving close together) — issue exactly one more
      // fetch right away rather than making it wait for the next trigger.
      // Without this, that race would silently fall back to the 30-second
      // fallback interval for freshness instead of the sub-second push path,
      // which is the whole point of task #114.
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        void pollRef.current();
      }
    }
  }, [galleryId, applySnapshot]);
  // Kept current in an effect, not assigned during render: refs must not be
  // written while rendering (`react-hooks/refs`) — an effect runs in the
  // commit phase, still well before any async `fetch` this hook issues
  // could resolve and read `pollRef.current`.
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  // The single entry point every trigger — the 30s fallback interval, the
  // tab-visibility wake-up, and every SSE message below — calls to ask for a
  // fresh fetch. `poll()` itself already no-ops a second concurrent call
  // (`pollInFlightRef`); this wraps that with the queue-one-more behavior
  // task #114 needs (see `pendingRefreshRef`'s own comment above) that plain
  // polling under #95 never had to care about, because its next trigger was
  // always just one fixed interval away.
  const requestRefresh = useCallback(() => {
    if (pollInFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    void poll();
  }, [poll]);

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
      requestRefresh();
    }, SELECTION_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (!document.hidden) requestRefresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [status, requestRefresh]);

  // ==========================================================================
  // PUSH TRANSPORT (task #114) — the SSE stream this hook listens to,
  // and what it does with each message
  // ==========================================================================
  //
  // ONE `EventSource` per mounted `<ProofGrid>` (one per browser tab, which is
  // the correct unit — see src/lib/selection-events.ts's own header comment
  // for why the SHARING happens server-side, one Postgres LISTEN connection
  // per app instance feeding every tab, not client-side). Opened whenever the
  // gallery is in a status the shared selection can still change in (the same
  // `LIVE_SYNC_STATUSES` gate the fallback interval uses), and left open
  // regardless of tab visibility — unlike the fallback poll, an idle SSE
  // connection costs nothing to hold (no request, no response body until a
  // message actually arrives), and this app's own realistic concurrency (two
  // to five viewers per gallery, per task #114's own kanban body) makes that
  // a non-issue even summed across every open tab.
  //
  // TWO named events, matching `./stream/route.ts`'s own two `send()` calls,
  // and nothing else — no generic `onmessage`, because this stream never
  // sends an anonymous message:
  //
  //   `ready` — sent as the FIRST thing on every connection, including every
  //   automatic reconnect `EventSource` performs on its own after a drop. The
  //   FIRST `ready` of this hook's lifetime is a no-op: the
  //   server-rendered page already handed this component a fresh snapshot a
  //   moment earlier, and refetching immediately would be exactly the
  //   wasted-request-per-mount #95's own polling design was already careful
  //   to avoid (see the interval effect above). Every SUBSEQUENT `ready` —
  //   which can only mean the connection just re-established after having
  //   been down — triggers `requestRefresh()`: a NOTIFY fired while this tab
  //   was disconnected is gone for good (Postgres NOTIFY is not durable), so
  //   the only honest thing to do on reconnect is treat it exactly like
  //   "something may have changed" and re-fetch, per this task's own
  //   acceptance criterion.
  //
  //   `changed` — sent every time the server's own LISTEN connection hears a
  //   NOTIFY for this gallery. Always triggers `requestRefresh()`
  //   immediately; this is the whole reason this stream exists.
  //
  // `EventSource` itself, not a hand-rolled `fetch` + `ReadableStream` reader:
  // it is the standard browser API for exactly this (one-way, text, an
  // established retry protocol), and — the specific reason it earns its
  // keep here over rolling the reconnect logic by hand — it reconnects with
  // its own backoff on ANY drop (network blip, server restart, Caddy timeout)
  // with zero code in this hook, which is also precisely why task
  // #114's acceptance criteria call out testing that path explicitly rather
  // than trusting it silently: see proof-grid.test.tsx's own "reconnect"
  // tests, which drive a fake `EventSource` through a `ready`/close/`ready`
  // sequence to prove the SECOND `ready` refetches and the first did not.
  useEffect(() => {
    if (!LIVE_SYNC_STATUSES.has(status)) return;
    // Defensive, not a real-world branch: every browser this app ships to
    // supports `EventSource`. Guards a test environment (jsdom has no
    // built-in `EventSource`) and any future non-browser render target from
    // throwing on `new EventSource(...)` — in either case this still works,
    // just on the 30s fallback poll alone rather than push, which is a
    // staleness regression, not a correctness one.
    if (typeof EventSource === "undefined") return;

    let hasReceivedReady = false;
    const source = new EventSource(`/api/galleries/${galleryId}/selection/stream`);

    source.addEventListener("ready", () => {
      if (!hasReceivedReady) {
        // The very first `ready` of this connection's life: the SSR snapshot
        // is already fresh, so this is deliberately a no-op — see the
        // section comment above.
        hasReceivedReady = true;
        return;
      }
      // A SECOND (or later) `ready` can only be a reconnect: `EventSource`
      // only ever sends one `ready` per underlying connection, and this
      // stream sends `ready` as the first thing on every connection it
      // opens.
      requestRefresh();
    });
    source.addEventListener("changed", () => requestRefresh());

    return () => {
      source.close();
    };
  }, [galleryId, status, requestRefresh]);

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
      // The asset's own confirmed flag — no sequencing needed, see
      // `quotaSequenceRef`'s own comment above for why.
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
      // whose other timestamps this hook never re-reads.
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

  // <SubmitSelectionPanel>'s success callback — this session's OWN
  // submission. Also replaces `quota` wholesale with the submit route's own
  // recomputation, same "never trust a number this hook didn't get
  // handed by the server" stance `toggleSelection` already follows above,
  // and covers the idempotent "already_submitted" outcome identically to a
  // fresh "submitted" one — both mean "the gallery is locked, here is the
  // real quota", which is all this needs to know.
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

  return {
    selectionById,
    quota,
    picks,
    status,
    isLocked,
    submittedAt,
    pendingIds,
    toggleError,
    isStale,
    toggleSelection,
    handleSubmitted,
  };
}
