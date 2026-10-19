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
import type { QuotaResult } from "@/lib/quota";
import { emptyShare } from "@/lib/quota-attribution";
import {
  type GalleryStatus,
  type SelectionCounter,
  type SelectionEntry,
  type SelectionKind,
  type SelectionSnapshot,
  type ViewerLock,
} from "@/lib/selection-snapshot";

export type { GalleryStatus };

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
    // Epic #250 S6 — who the unit is currently BILLED to, straight from the
    // route that just wrote it. This is attribution, not "who picked": under
    // the multi-pick model many people can ask for one photo and the unit has
    // exactly one holder. `null` for a legacy unit with no recorded owner.
    // Task #206 — the type the route just recorded, whether this response
    // came from a select/deselect (which resets it to `edited`) or a
    // type-only change.
    selectionKind: SelectionKind;
    // Task #244 — the order stamp the route left on the row.
    requestedAt?: string | null;
  };
  quota: QuotaResult;
  // Epic #250 S6 — the asset's entry and the gallery-wide counter from the
  // SAME builder the GET route uses, so a confirmed toggle can replace one
  // entry wholesale without waiting for a snapshot.
  entry: SelectionEntry | null;
  counter: SelectionCounter;
};

/** The shared-selection snapshot returned by `GET
 * /api/galleries/[galleryId]/selection`. The SERVER's view, in full — never
 * merged field-by-field with a local guess; see `applySnapshot` below. */

/** The two fields of `ProofAsset` (src/components/proof-grid.tsx) this hook
 * reads, and only for the FIRST paint's seed. Structural rather than an import
 * of `ProofAsset` itself for the same reason `ProofUrlAsset` is: the shared
 * selection is about asset ids and their flags, not about how a tile renders. */
export type SharedSelectionAsset = {
  id: string;
  isSelected: boolean;
};

// Epic #239 — the PATCH selection route's lock refusals. All of them mean "the
// board changed under you" (somebody just sent, an admin locked a person, a
// pick degraded), so the right response is a calm sentence AND a snapshot
// refresh so the controls catch up — not the generic "no se pudo actualizar"
// red flag.
//
// `pick_not_yours` / `foreignPickRefusal` are gone with task #249's single-owner
// model: a client's PATCH only addresses their OWN `asset_picks` row now, so
// there is no foreign pick left to name. `pick_locked` is gone for the same
// reason. `already_requested` keeps its tuteo copy verbatim.
const LOCK_REFUSALS: Record<string, string> = {
  client_selection_locked: "Tu selección ya está cerrada, así que no se puede cambiar.",
  gallery_locked: "La selección ya fue enviada, así que no se puede cambiar.",
  // Task #244 — an ordered ("pedida") pick is permanent for the client.
  already_requested: "Esta foto ya fue pedida; para quitarla escríbele a tu fotógrafo.",
  // Epic #250 S7 — the new per-pick refusals. A degraded pick may only move
  // from original to edited (decision 16); an admin must name a client; a
  // subject must still belong to the gallery.
  pick_degraded: "Otra persona ya la pidió, así que solo puedes cambiarla a editada.",
  admin_cannot_pick: "Elige un cliente antes de tocar una foto.",
  acting_client_not_member: "Esa persona ya no es parte de esta galería.",
};

/** The calm message for a 409 lock refusal, or `null` for any other failure.
 * Reads the body defensively: a non-JSON error is simply "not a lock refusal". */
async function lockRefusalMessage(response: Response): Promise<string | null> {
  if (response.status !== 409) return null;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return (body?.error && LOCK_REFUSALS[body.error]) || null;
}

/** Whether this viewer's controls are frozen.
 *
 * A gallery past `proofing` freezes everyone. For a CLIENT, their own lock
 * additionally freezes them while the others keep choosing. For an ADMIN acting
 * on behalf of a client (decision 12), the subject's lock is irrelevant — the
 * admin's write is the per-photo correction tool — but the gallery must still
 * be `proofing`, because `actOnBehalf` refuses anything else. This is the ONE
 * definition shared by the first paint, every snapshot and `handleSubmitted`. */
function computeIsLocked(
  status: GalleryStatus,
  viewerLock: ViewerLock | null,
  actingClientId: string | null,
): boolean {
  if (SUBMITTED_STATUSES.has(status)) return true;
  if (actingClientId !== null) return status !== "proofing";
  return viewerLock !== null;
}

/** Task #244 — under rolling delivery a CLIENT-SUBMITTED lock (submitted_at
 * set) is a classic-flow leftover, not a lock: submitting there is an order,
 * and turning the flag on migrates such members (updateRollingDelivery). The
 * client must never render the classic "enviada/cerrada" state for one, even
 * from a stale snapshot. An ADMIN lock (submitted_at null) is a real lock. */
function effectiveViewerLock(lock: ViewerLock | null, rolling: boolean): ViewerLock | null {
  // `lockedBy` is computed by the server; never guessed from `submittedAt`.
  return rolling && lock !== null && lock.lockedBy === "client" ? null : lock;
}

export function useSharedSelection({
  galleryId,
  initialAssets,
  initialStatus,
  initialSubmittedAt,
  initialEntries,
  initialQuota,
  initialCounter,
  initialViewerLock = null,
  initialAdminLockedPickerIds = [],
  viewAsId = null,
  actingClientId = null,
  readOnly = false,
  rollingDelivery = false,
  initialViewerSubmittedAt = null,
}: {
  galleryId: string;
  initialAssets: SharedSelectionAsset[];
  initialStatus: GalleryStatus;
  initialSubmittedAt: string | null;
  initialEntries: SelectionEntry[];
  initialQuota: QuotaResult;
  initialCounter: SelectionCounter;
  viewerId: string;
  initialViewerLock?: ViewerLock | null;
  initialAdminLockedPickerIds?: string[];
  /** Epic #250 S6 — the admin's view-as subject, forwarded to the live poll. */
  viewAsId?: string | null;
  /** Epic #250 S7 — the client the admin acts on behalf of. Present on BOTH
   * PATCH bodies, and only for an admin: a client sending it is a 400 at the
   * route, so `null` means "the key is absent". */
  actingClientId?: string | null;
  /** Epic #250 S7 — an admin viewing WITHOUT a subject (the "Nadie (solo
   * mirar)" option). Every pick control is disabled and the hook refuses to
   * issue a write; the route would answer `admin_cannot_pick` anyway. */
  readOnly?: boolean;
  rollingDelivery?: boolean;
  initialViewerSubmittedAt?: string | null;
}) {
  // `is_selected` per asset — under epic #250 that means CLAIMED (at least one
  // sent pick), not "this viewer picked it". It still feeds the delivered
  // split and the legacy response shape; the tile's own toggle reads the
  // viewer's pick off `entries` instead (task #262). Seeded from the initial
  // server-rendered paint, then only ever overwritten by a confirmed response
  // — never flipped locally before the round trip, so what this renders can
  // never drift from what the database actually holds.
  const [selectionById, setSelectionById] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialAssets.map((asset) => [asset.id, asset.isSelected])),
  );
  // The server's own quota for the first paint (epic #250 S6). There is no
  // local arithmetic anywhere in this file: every accepted snapshot and every
  // toggle response replaces this whole object with the server's recomputation.
  const [quota, setQuota] = useState<QuotaResult>(initialQuota);
  // Task #95: the shared, ATTRIBUTED selection — the tray's whole content.
  // Seeded from the server render, then replaced WHOLESALE by each accepted
  // snapshot (never merged field by field) plus the one local edit a
  // confirmed toggle of this session's own makes; see `applySnapshot` and
  // `toggleSelection` below. Each entry is claimed-or-carted with its askers;
  // one entry per asset is the wire unit (epic #250 S6).
  const [entries, setEntries] = useState<SelectionEntry[]>(initialEntries);
  // The server's four-number counter. The client never derives any of it.
  const [counter, setCounter] = useState<SelectionCounter>(initialCounter);

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
  // Epic #239 — the lock is now TWO facts. `isGalleryLocked` is the gallery
  // being past `proofing` (everybody is done, or it was delivered). The
  // VIEWER's own lock is `viewerLock` from the server snapshot: non-null means
  // this person submitted (or an admin locked them) and may not change picks
  // even though the gallery is still `proofing` for the others. Never derive
  // "viewer submitted" from `galleries.selectionSubmittedAt`: reopening does
  // not clear it, `viewerLock` is the truth.
  const [viewerLock, setViewerLock] = useState<ViewerLock | null>(
    effectiveViewerLock(initialViewerLock, rollingDelivery),
  );
  // Only PHOTOGRAPHER locks are listed now (S5 never writes a client lock).
  const [adminLockedPickerIds, setAdminLockedPickerIds] = useState<string[]>(
    initialAdminLockedPickerIds,
  );
  const [viewerSubmittedAt, setViewerSubmittedAt] = useState<string | null>(
    initialViewerSubmittedAt,
  );
  const isGalleryLocked = SUBMITTED_STATUSES.has(status);
  const isViewerLocked = viewerLock !== null;
  // What every control gates on: a closed gallery, this viewer's own lock, or
  // (for an admin acting on behalf of somebody) any non-proofing status. See
  // `computeIsLocked`.
  const isLocked = computeIsLocked(status, viewerLock, actingClientId);
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
  // THE CONFLICT THIS EXISTS FOR: two tabs (or two people) writing the same
  // pick at once. Since epic #250 a pick is a (person, photo) pair, so one
  // client can no longer remove somebody else's — the race is one person's
  // tabs against the server's own resolution (a send degrading an unsent pick,
  // an admin correction, an escalation). Every write still reaches the server;
  // one is simply last, and whatever the database holds after that is the
  // answer — there is no merge and no "last-writer-wins on the client". Every
  // viewer, including the one whose click LOST, ends up rendering the row the
  // server actually holds. Getting this wrong is worse than not building the
  // feature: two people would each be looking at a different "shared"
  // selection, and one of them would quote the wrong surcharge.
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
  // version of this one photo". The snapshot replaces `entries`, `counter`,
  // `selectionById`, `quota`, `status` and `submittedAt` together, as one
  // consistent view. A
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

  const applySnapshot = useCallback(
    (snapshot: SelectionSnapshot, issuedAtClock: number) => {
      // Condition 1 — see the section comment above.
      if (pendingIdsRef.current.size > 0) return;
      // Condition 2.
      if (issuedAtClock <= lastLocalWriteClockRef.current) return;

      setStatus(snapshot.status);
      const nextViewerLock = effectiveViewerLock(snapshot.viewerLock ?? null, rollingDelivery);
      isLockedRef.current = computeIsLocked(snapshot.status, nextViewerLock, actingClientId);
      setViewerLock(nextViewerLock);
      setAdminLockedPickerIds(snapshot.adminLockedPickerIds ?? []);
      setSubmittedAt(snapshot.submittedAt);
      setViewerSubmittedAt(snapshot.viewerSubmittedAt ?? null);
      setEntries(snapshot.entries ?? []);
      setCounter(
        snapshot.counter ?? {
          // A pre-S6 server (or a test double) has no counter. Deriving a
          // gallery-only fallback is honest: there is no subject to describe.
          group: snapshot.quota?.selected ?? 0,
          viewer: null,
          people: [],
          unattributed: 0,
          // Task #264 — the wire carries money per person; an absent
          // counter has nobody to attribute it to.
          unattributedShare: emptyShare(),
        },
      );

      const pickedAssetIds = new Set(
        snapshot.entries.filter((entry) => entry.claim !== null).map((entry) => entry.assetId),
      );
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
    },
    [rollingDelivery, actingClientId],
  );

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
      const response = await fetch(
        `/api/galleries/${galleryId}/selection${
          viewAsId ? `?viewAs=${encodeURIComponent(viewAsId)}` : ""
        }`,
      );
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
  }, [galleryId, applySnapshot, viewAsId]);
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

  const toggleSelection = useCallback(
    async (assetId: string, nextSelected: boolean) => {
      // An admin looking without a subject may not write at all (decision 12).
      if (readOnly) return;
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
      let refreshAfter = false;
      try {
        const response = await fetch(`/api/assets/${assetId}/selection`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selected: nextSelected,
            ...(actingClientId ? { actingClientId } : {}),
          }),
        });
        if (!response.ok) {
          const lockMessage = await lockRefusalMessage(response);
          if (lockMessage) {
            setToggleError(lockMessage);
            refreshAfter = true;
          } else {
            setToggleError("No se pudo actualizar la selección.");
          }
          return;
        }
        const body = (await response.json()) as SelectionResponse;
        // The asset's own confirmed flag — no sequencing needed, see
        // `quotaSequenceRef`'s own comment above for why.
        setSelectionById((prev) => ({ ...prev, [body.asset.id]: body.asset.isSelected }));

        // Epic #250 S6 — the asset's whole entry (its claim and every person's
        // pick on it) comes back from the server, so the local merge replaces
        // that one entry wholesale. Reconstructing it from a single `pick`
        // would drop somebody else's cart sitting on the same photo. The next
        // accepted snapshot replaces the whole list anyway.
        setEntries((prev) => {
          const index = prev.findIndex((entry) => entry.assetId === body.asset.id);
          if (!body.entry) return prev.filter((entry) => entry.assetId !== body.asset.id);
          if (index === -1) return [...prev, body.entry];
          return prev.map((entry) => (entry.assetId === body.asset.id ? body.entry! : entry));
        });

        // This session now holds a write the server has confirmed. Any snapshot
        // ISSUED at or before this moment is a photograph of the past and must
        // not be applied over it — see the LIVE SYNC section above.
        lastLocalWriteClockRef.current = quotaSequenceRef.current;

        // The server's own recomputed quota and counter — only applied if no
        // LATER-issued toggle's response (or accepted snapshot) has already been
        // applied. See the header comment on `quotaSequenceRef` above.
        if (sequence > appliedQuotaSequenceRef.current) {
          appliedQuotaSequenceRef.current = sequence;
          setQuota(body.quota);
          if (body.counter) setCounter(body.counter);
        }
      } catch {
        setToggleError("No se pudo conectar.");
      } finally {
        pendingIdsRef.current.delete(assetId);
        setPendingIds(new Set(pendingIdsRef.current));
        // After the pending guard is released, or the snapshot this asks for
        // would be dropped by LIVE SYNC condition 1.
        if (refreshAfter) requestRefresh();
      }
    },
    [requestRefresh, actingClientId, readOnly],
  );

  // Task #206 — set an ALREADY-selected pick's type, reusing every mechanism
  // `toggleSelection` above already built rather than inventing a second
  // channel (the task body's own instruction): the same `pendingIdsRef` guard
  // (so a type change and a toggle can never race on the SAME asset — both
  // key off `assetId`), the same `quotaSequenceRef`/`appliedQuotaSequenceRef`
  // ordering (so a type change and a live snapshot, or two type changes,
  // apply in issue order and never let a stale one win), and the same
  // `lastLocalWriteClockRef` stamp (so a snapshot issued before this commit
  // cannot flip the tray's local view back for one interval). The ONLY
  // difference from `toggleSelection` is the request body and which fields
  // of the response this writes back.
  const setSelectionKind = useCallback(
    async (assetId: string, kind: SelectionKind) => {
      // Same read-only refusal as `toggleSelection`.
      if (readOnly) return;
      // Same UX-only mirror of the server-side lock as `toggleSelection` — see
      // that callback's own comment.
      if (isLockedRef.current) return;
      if (pendingIdsRef.current.has(assetId)) return;
      pendingIdsRef.current.add(assetId);
      setPendingIds(new Set(pendingIdsRef.current));
      setToggleError(null);

      const sequence = ++quotaSequenceRef.current;
      let refreshAfter = false;
      try {
        const response = await fetch(`/api/assets/${assetId}/selection`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            selectionKind: kind,
            ...(actingClientId ? { actingClientId } : {}),
          }),
        });
        if (!response.ok) {
          const lockMessage = await lockRefusalMessage(response);
          if (lockMessage) {
            setToggleError(lockMessage);
            refreshAfter = true;
          } else {
            setToggleError("No se pudo actualizar el tipo de foto.");
          }
          return;
        }
        const body = (await response.json()) as SelectionResponse;

        // `isSelected` is unchanged by a type-only write (the route's own
        // guarantee — see its `asset_not_selected` guard), but writing it back
        // here costs nothing and keeps this handler symmetric with
        // `toggleSelection`'s own "trust only the response" stance.
        setSelectionById((prev) => ({ ...prev, [body.asset.id]: body.asset.isSelected }));
        // Epic #250 S6 — replace this asset's entry wholesale.
        setEntries((prev) => {
          const index = prev.findIndex((entry) => entry.assetId === body.asset.id);
          if (!body.entry) return prev.filter((entry) => entry.assetId !== body.asset.id);
          if (index === -1) return [...prev, body.entry];
          return prev.map((entry) => (entry.assetId === body.asset.id ? body.entry! : entry));
        });

        lastLocalWriteClockRef.current = quotaSequenceRef.current;
        if (sequence > appliedQuotaSequenceRef.current) {
          appliedQuotaSequenceRef.current = sequence;
          setQuota(body.quota);
          if (body.counter) setCounter(body.counter);
        }
      } catch {
        setToggleError("No se pudo conectar.");
      } finally {
        pendingIdsRef.current.delete(assetId);
        setPendingIds(new Set(pendingIdsRef.current));
        if (refreshAfter) requestRefresh();
      }
    },
    [requestRefresh, actingClientId, readOnly],
  );

  // <SubmitSelectionPanel>'s success callback — this session's OWN
  // submission. Epic #250 S5 made EVERY submit an order that never locks, so
  // there is ONE path here: record the send time, apply the server's quota,
  // follow the gallery to `selected` only when the server says this submission
  // closed it, and ask for a full snapshot (a send rewrites many entries at
  // once, so the snapshot is the honest refresh).
  const handleSubmitted = useCallback(
    (outcome: SubmitSelectionOutcome) => {
      // A rolling idempotent 200 (`already_submitted`, no `requestedCount`)
      // stamped nothing, so it must not pretend this person just sent.
      const stamped = !rollingDelivery || outcome.requestedCount !== undefined;
      if (outcome.submittedAt && stamped) setViewerSubmittedAt(outcome.submittedAt);
      if (outcome.gallerySelected) {
        isLockedRef.current = true;
        setStatus("selected");
        setSubmittedAt(outcome.submittedAt);
      }
      setQuota(outcome.quota);
      lastLocalWriteClockRef.current = ++quotaSequenceRef.current;
      appliedQuotaSequenceRef.current = quotaSequenceRef.current;
      requestRefresh();
    },
    [requestRefresh, rollingDelivery],
  );

  return {
    viewerSubmittedAt,
    selectionById,
    quota,
    entries,
    counter,
    status,
    isLocked,
    isGalleryLocked,
    isViewerLocked,
    viewerLock,
    adminLockedPickerIds,
    submittedAt,
    pendingIds,
    toggleError,
    isStale,
    toggleSelection,
    setSelectionKind,
    handleSubmitted,
  };
}
