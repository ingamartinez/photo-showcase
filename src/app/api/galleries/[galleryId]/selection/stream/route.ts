// GET /api/galleries/[galleryId]/selection/stream — task #114: an SSE stream
// that tells every open session of ONE gallery "the shared selection just
// changed", pushed off Postgres LISTEN/NOTIFY instead of a poll interval. See
// `../route.ts`'s own header comment for the corrected transport decision
// (that file used to argue this app had no way to build this at all — it was
// wrong about that, and says so now) and `src/lib/selection-events.ts`'s own
// header comment for the pub/sub design this route is a thin wrapper around.
//
// ============================================================================
// WHAT THIS ROUTE DOES, AND — AS IMPORTANTLY — WHAT IT DOES NOT DO
// ============================================================================
//
// It never sends the selection itself. Every message this stream emits is a
// bare signal (`ready` on connect/reconnect, `changed` when a write landed) —
// never picks, never a status, never a quota. Task #114's own trap #1: a
// Postgres NOTIFY payload is capped at 8000 bytes, and pushing the snapshot
// through it would also mean re-deriving this route's OWN ownership check on
// a second endpoint instead of reusing `../route.ts`'s. So the client that
// receives `changed` does exactly what a poll tick already did: `fetch` the
// SAME `GET /api/galleries/[galleryId]/selection` route — see
// src/components/proof-grid.tsx's SSE wiring for the client half.
//
// It never trusts an unbounded connection to survive un-nudged. Bun kills an
// idle stream after 10 seconds without traffic on it (found empirically by
// scripts/measure-selection-transport.ts, task #95) — `HEARTBEAT_INTERVAL_MS`
// below sends a comment line well under that ceiling for as long as this
// response stays open, keeping the connection "not idle" from Bun's own point
// of view regardless of whether anything real happened. Caddy's own idle
// timeout sits in front of this on the droplet and has NOT been verified from
// this environment — see this task's own acceptance criteria for why that is
// stated as a limitation rather than papered over.
//
// It gets the SAME guard as every other route that touches this gallery's
// data — `withApiSession`, then `isGalleryOwner`, then the non-admin
// visibility gate, byte-for-byte the same three gates `../route.ts` runs, in
// the same order, for the same reason: a live channel is a data path, and "it
// only carries a content-free signal" is not an excuse to invent a lighter
// check. A signed-in stranger with a gallery id must not even learn that this
// gallery HAS a live channel, let alone receive its signals.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries } from "@/lib/db/schema";
import { withApiSession } from "@/lib/auth-guards";
import { isGalleryVisibleToClient } from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { subscribeToSelectionChanges } from "@/lib/selection-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const galleryIdSchema = z.uuid();

// 8 seconds — comfortably under Bun's own 10-second idle-stream ceiling (see
// this file's header comment), with margin for GC pauses or a slow tick
// under load. Not configurable; nothing about this number is gallery- or
// viewer-specific.
const HEARTBEAT_INTERVAL_MS = 8_000;

function errorResponse(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status });
}

// Unauthenticated -> 401 JSON, never a redirect (see auth-guards.ts).
// `withApiSession()` (task #54) runs that check unconditionally before this
// handler ever executes — there is no branch here to forget to return.
export const GET = withApiSession(async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ galleryId: string }> },
  session,
): Promise<NextResponse> {
  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) {
    return errorResponse("invalid_gallery_id", 400);
  }
  const galleryId = galleryIdResult.data;

  const [gallery] = await db.select().from(galleries).where(eq(galleries.id, galleryId)).limit(1);
  if (!gallery) {
    return errorResponse("gallery_not_found", 404);
  }

  // Gate 1 — ownership. Byte-for-byte the same check, same order, same
  // 403-not-404, as the polling route right next to this one — see that
  // route's own comment for why "just a signal" does not earn a lighter
  // check, and route.test.ts (this route's own suite) for the mutation proof.
  const isAdmin = session.user.role === "admin";
  if (!(await isGalleryOwner(gallery.id, session))) {
    return errorResponse("forbidden", 403);
  }

  // Gate 2 — visibility (non-admin only). Same 404 the page, the polling
  // route and both selection-mutating routes already use for a `draft`
  // gallery a client cannot see yet.
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) {
    return errorResponse("gallery_not_found", 404);
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };

      // The FIRST thing this stream ever says, on every connection including
      // a reconnect. Trap #2 (NOTIFY is not durable): the client's own SSE
      // wiring treats every `ready` AFTER the first one of its lifetime as
      // "something may have happened while I was gone, refetch" — see
      // proof-grid.tsx's own comment for why the very first `ready` does NOT
      // trigger that refetch (the server-rendered page already did).
      send("ready", "1");

      // Registers this response with the process-wide fan-out — see
      // src/lib/selection-events.ts's own header comment for why this is a
      // local `Map` entry, not a second Postgres connection: "one LISTEN
      // connection per app instance, not per viewer" is enforced THERE, not
      // here.
      unsubscribe = await subscribeToSelectionChanges(galleryId, () => {
        send("changed", "1");
      });

      // Real traffic on the socket, not merely configuration — see this
      // file's header comment on Bun's 10-second idle-stream kill. An SSE
      // comment line (`:` prefix) is invisible to `EventSource`'s own
      // `message`/named-event listeners, so this never reaches
      // proof-grid.tsx as a spurious "changed".
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // The controller is already closed (the client disconnected
          // between the previous tick and this one) — `cancel()` below is
          // about to run and clear this interval; nothing to do here but not
          // throw out of a timer callback.
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      // Runs when the client disconnects (tab closed, navigation, the
      // browser's own EventSource reconnect tearing down the old socket)
      // AND when this route's own module is torn down. Both `unsubscribe`
      // and clearing the heartbeat MUST happen here — an entry left in
      // `listenersByGallery` pointing at a closed stream's `enqueue` is an
      // unbounded leak for as long as the process runs, one per dropped
      // connection this never fires for.
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      // Any buffering proxy between this response and the browser (Caddy
      // included, though its own SSE behavior has NOT been verified from
      // this environment — see this file's header comment) would otherwise
      // hold the whole response until it closes, defeating the entire point
      // of a push transport. This header is the standard opt-out for
      // nginx-family proxies; Caddy's own `reverse_proxy` does not buffer by
      // default, but this is sent regardless as a documented, harmless
      // no-op if that ever changes.
      "X-Accel-Buffering": "no",
    },
  });
});
