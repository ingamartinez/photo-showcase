// The Postgres-backed pub/sub for task #114: pushing a "the shared selection
// of gallery X changed" signal to every open viewer of that gallery, in every
// app instance, without polling.
//
// ============================================================================
// WHY POSTGRES LISTEN/NOTIFY, AND WHAT #95 GOT WRONG ABOUT THIS APP
// ============================================================================
//
// GET /api/galleries/[galleryId]/selection's own header comment (task #95)
// rejected SSE with "this app has no event bus" — true when it was written
// (no `EventEmitter` anywhere, no Redis), but the conclusion doesn't follow:
// this app has run Postgres since Phase 0, and LISTEN/NOTIFY IS an event bus,
// already paid for, with zero new dependencies (`postgres` is already
// `^3.4.9`, and `sql.listen()`/`sql.notify()` are native to it). It is
// strictly BETTER than the in-process `EventEmitter` #95 also rejected, on
// the exact axis #95 used to reject it: a `NOTIFY` reaches every instance
// LISTENing on the channel, so nothing here silently breaks the day this app
// runs as more than one systemd process. See selection/route.ts's own header
// comment for the corrected record of that decision.
//
// ============================================================================
// DESIGN DECISIONS — recorded here, not left to be re-derived
// ============================================================================
//
// WHERE NOTIFY FIRES: from the APPLICATION write path (this module's
// `notifySelectionChanged`, called by the three places that can change what
// this signal represents — the PATCH toggle route, the submit route, and the
// admin unlock action), NOT from a Postgres trigger on `assets`/`galleries`.
// A trigger is the "can never be forgotten" option, but this app's entire
// testing strategy is unit tests against a MOCKED `@/lib/db` (every route
// test in this codebase — see selection/route.test.ts, the PATCH route's own
// suite, submit-selection's own suite), which cannot exercise a database
// trigger at all; a trigger's correctness would be provable only by hitting a
// real Postgres, which this app currently does nowhere in `bun run test`. An
// application call is a plain, mockable function call — visible in a diff,
// assertable in a unit test exactly like `sendSubmissionNotificationEmail` and
// every other "this write also has a side effect" call in this codebase — and
// the risk it trades away ("a future write path forgets to call it") is
// mitigated the same way `isGalleryOwner` and `computeQuota` already are: one
// function, called from the few places that need it, not re-derived per call
// site. If a fourth write path to the shared selection is ever added and
// forgets this call, the failure mode is a silent 30-second degrade to the
// fallback poll below (see proof-grid.tsx's own comment on
// `SELECTION_POLL_INTERVAL_MS`) — not a correctness bug, a staleness one,
// bounded and self-healing.
//
// FAN-OUT SHAPE: ONE Postgres LISTEN connection per app instance (this
// module's own module-scope singleton, established lazily on first
// subscriber), fanning out to N local SSE responses through an in-process
// `Map<galleryId, Set<listener>>` — NOT one LISTEN connection per viewer,
// which would burn through `max: 10` (src/lib/db/index.ts) with a handful of
// concurrent viewers. This is the whole point of using Postgres as the event
// bus rather than reinventing one: ONE real subscription per PROCESS, cheap
// local fan-out to as many browser tabs as are actually open.
//
// ONE GLOBAL CHANNEL, not one channel per gallery. Postgres has no limit on
// channel names, but a channel per gallery would mean calling
// `sql.listen()` (and therefore `LISTEN <name>`) for every gallery that ever
// gets a viewer, and `UNLISTEN` bookkeeping to avoid leaking channel
// subscriptions server-side as galleries stop being watched. A single channel
// with the gallery id AS the payload needs neither: the one `LISTEN` this
// module ever issues covers every gallery for the life of the process, and
// "which gallery" is resolved locally, in this module, against
// `listenersByGallery`. The payload is a bare UUID (36 bytes) — nowhere near
// Postgres's 8000-byte NOTIFY payload cap (task #114's own trap #1), which
// this module never gets close to because it never puts the actual
// selection snapshot on the channel at all. See below.
//
// NEVER THE SNAPSHOT, ONLY THE SIGNAL (trap #1). `notifySelectionChanged`
// sends nothing but the gallery id — no picks, no quota, no status. The
// client that receives the resulting SSE "changed" event re-fetches
// `GET /api/galleries/[galleryId]/selection` (the EXISTING, already-guarded
// route) for the actual data. This is not a corner cut for size: it is also
// what keeps ownership verification on ONE path (that route's own gates)
// instead of teaching a second endpoint to reconstruct the same check.
//
// NOTIFY IS NOT DURABLE (trap #2). A notification fired while nobody is
// LISTENing is gone, forever — there is no queue, no replay. Two situations
// produce exactly that gap, and both are handled the same way, deliberately:
//
//   1. A BROWSER TAB connects or reconnects. Handled in proof-grid.tsx: the
//      SSE stream's very first message on every connection (including a
//      reconnect) is `ready`, and the client treats every `ready` AFTER the
//      first one of this component's lifetime as "may have missed something,
//      refetch" — see that file's own comment on why the FIRST `ready` does
//      NOT trigger a refetch (the server-rendered page already gave a fresh
//      snapshot).
//
//   2. THIS PROCESS's own LISTEN connection drops and reconnects — a network
//      blip between this app and Postgres, or Postgres itself restarting.
//      Any `NOTIFY` fired in that gap is lost to EVERY browser tab this
//      process serves, not just one. `ensureListening` below passes an
//      `onlisten` callback to `pubsub.listen` for exactly this: postgres.js
//      invokes it on the FIRST subscribe AND on every automatic resubscribe
//      after a reconnect (verified by reading `node_modules/postgres/src/
//      index.js`'s own `onclose` handler, and empirically by
//      `scripts/verify-selection-listen-notify.ts`) — so treating "we just
//      (re)subscribed" as "broadcast a change to EVERY gallery currently
//      being watched" closes the gap without needing to know what, if
//      anything, was actually missed. Over-broadcasting costs one extra
//      cheap, idempotent GET per open tab; under-broadcasting after a
//      reconnect is a tab stuck on stale data with no signal telling it so.
//
// WHETHER POLLING SURVIVES: yes, as a long-interval FALLBACK — see
// `SELECTION_POLL_INTERVAL_MS` (renamed in spirit, not in export name, in
// proof-grid.tsx) — now 30s instead of #95's 5s. This is not "keep both
// forever to be safe": it is the answer to "what happens if the SSE
// transport itself is unhealthy in a way this module can't detect" — a
// corporate proxy that silently drops the stream without ever firing
// `error`, a browser extension, anything. Removing polling entirely would
// make that failure mode unbounded; a 30s backstop, active only in the
// statuses where the selection can still change (same `LIVE_SYNC_STATUSES`
// gate as before), bounds it while costing six times less than #95's own
// number in the case where the stream IS healthy and the fallback tick is
// pure waste.
import "server-only";

import { pubsub } from "@/lib/db";

/** One global channel for every gallery's selection-changed signal — see the
 * "FAN-OUT SHAPE" note above for why one channel with the gallery id as
 * payload, not one channel per gallery. */
const SELECTION_CHANGED_CHANNEL = "photoshowcase_selection_changed";

type ChangeListener = () => void;

/** Every gallery currently being watched by at least one SSE response in
 * THIS process, and the local callbacks to fan a NOTIFY out to. Module-scope
 * on purpose: this is the local half of "one LISTEN connection per app
 * instance, not per viewer" — every SSE route handler in this process shares
 * this one map instead of each opening its own subscription. */
const listenersByGallery = new Map<string, Set<ChangeListener>>();

/** Guards against calling `pubsub.listen()` more than once per process.
 * Strictly speaking postgres.js's OWN internal `listen.sql` singleton
 * (`node_modules/postgres/src/index.js`) already de-duplicates repeated
 * calls to `.listen()` with the same channel name onto one dedicated
 * connection — but relying on that internal behavior here would make this
 * module's own "one subscription" claim depend on reading postgres.js's
 * source rather than being true by this module's own construction. Kept
 * `null` until the first subscriber arrives — lazily, not at module load —
 * so importing this module (which every write path and the SSE route does)
 * never opens a database connection on its own; see src/lib/db/index.ts's
 * own file for why this codebase never does DB work at module scope. */
let listening: Promise<void> | null = null;

function ensureListening(): Promise<void> {
  if (listening) return listening;

  listening = pubsub
    .listen(
      SELECTION_CHANGED_CHANNEL,
      (galleryId) => {
        const listeners = listenersByGallery.get(galleryId);
        if (!listeners) return;
        for (const listener of listeners) listener();
      },
      () => {
        // Fires on the FIRST subscribe AND on every automatic resubscribe
        // after the dedicated LISTEN connection reconnects — see this file's
        // header comment on trap #2's second case. Broadcasting to every
        // CURRENTLY watched gallery is deliberately broader than "just the
        // one gallery a NOTIFY might have named": a reconnect means this
        // process cannot know what it missed, for which galleries, so the
        // only honest response is "treat all of them as possibly changed".
        for (const listeners of listenersByGallery.values()) {
          for (const listener of listeners) listener();
        }
      },
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      // If the VERY FIRST `.listen()` call itself fails (Postgres unreachable
      // at that moment — a narrow window, since every other query in this
      // app already needs the same database), do not cache the failure
      // forever: reset to `null` so the NEXT subscriber retries fresh rather
      // than every future viewer, for the rest of this process's life,
      // immediately re-throwing the same stale rejection. This does not need
      // its own backoff/retry loop — the next SSE connection IS the retry,
      // and the 30s fallback poll (proof-grid.tsx) already covers this
      // process during the gap regardless of whether pushed updates ever
      // start working.
      listening = null;
      throw error;
    });

  return listening;
}

/**
 * Registers `onChange` to run every time gallery `galleryId`'s shared
 * selection changes (a toggle, a submit, an admin unlock) OR the server's own
 * LISTEN connection has just (re)subscribed — see this file's header comment
 * for why the latter counts too. `onChange` carries no data on purpose (trap
 * #1): it is a "go re-fetch" signal, not the fetch itself.
 *
 * Returns an `unsubscribe` function. The caller (the SSE route below) MUST
 * call it when the response is cancelled — an open `Set` entry pointing at a
 * closed stream's `enqueue` is a memory leak with no upper bound for as long
 * as the process runs.
 */
export async function subscribeToSelectionChanges(
  galleryId: string,
  onChange: ChangeListener,
): Promise<() => void> {
  await ensureListening();

  let listeners = listenersByGallery.get(galleryId);
  if (!listeners) {
    listeners = new Set();
    listenersByGallery.set(galleryId, listeners);
  }
  listeners.add(onChange);

  return () => {
    const current = listenersByGallery.get(galleryId);
    if (!current) return;
    current.delete(onChange);
    if (current.size === 0) listenersByGallery.delete(galleryId);
  };
}

/**
 * Signals every app instance's LISTENing connection that gallery
 * `galleryId`'s shared selection changed. Called from the three write paths
 * that can change it: `PATCH /api/assets/[assetId]/selection` (a toggle),
 * `POST /api/galleries/[galleryId]/submit-selection` (the submit lock), and
 * `unlockSelection` (src/app/dashboard/galleries/actions.ts, the admin
 * reopen). The payload is the bare gallery id — see this file's header
 * comment on trap #1 for why nothing else ever goes on this channel.
 *
 * Deliberately fire-and-forget from every call site (`void
 * notifySelectionChanged(...)`, never `await`ed inline with the response):
 * the write that matters (the `UPDATE`) has already committed by the time
 * this runs, and a NOTIFY that is slow or that fails outright must never turn
 * a successful mutation into a failed response, or add its own latency to
 * one. The fallback poll (30s, see proof-grid.tsx) is the backstop if this
 * particular signal never arrives.
 */
export async function notifySelectionChanged(galleryId: string): Promise<void> {
  await pubsub.notify(SELECTION_CHANGED_CHANNEL, galleryId);
}
