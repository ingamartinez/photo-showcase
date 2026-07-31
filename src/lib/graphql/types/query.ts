// The root `Query` type (task #30) — the ONLY file in this schema allowed to
// call `builder.queryType()` (see ../builder.ts's own header comment for
// why).
//
// THE AUTHORIZATION RULE THIS FILE EXISTS TO PROTECT (the epic's own stated
// risk, task #6): a second API surface must not become a second, WEAKER set
// of authorization rules. Every field below calls the EXACT SAME ownership
// helpers the REST routes already call — `isGalleryOwner`
// (src/lib/gallery-access.ts) and `isGalleryVisibleToClient`
// (src/lib/galleries.ts) — rather than re-deriving "does this session own
// this gallery" as a fresh comparison here. Nothing in this file talks to
// `db` directly for that decision.
//
// BOTH FIELDS FAIL CLOSED BY RETURNING EMPTY, NOT BY THROWING: an
// unauthenticated caller, a caller asking for someone else's gallery, and a
// caller asking for a gallery id that does not exist all get back exactly
// the same shape a caller who is genuinely allowed to see nothing would get
// — `null` for `gallery`, `[]` for `galleries`. A GraphQL error here would
// leak, through its message or its mere presence, that SOMETHING exists at
// that id that the caller isn't allowed to see; collapsing every refusal
// case to "no data" (mirroring the 403-not-404-when-avoidable posture the
// selection route already takes for the same reason) means a client probing
// random ids learns nothing more than a client asking for their own.
import "server-only";

import { z } from "zod";
import { getGalleriesForClient, getGalleryDetail, isGalleryVisibleToClient } from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { builder } from "../builder";
import { getGalleryDetailsByIds } from "../gallery-details-by-ids";
import { GalleryType } from "./gallery";

const galleryIdSchema = z.uuid();

builder.queryType({
  fields: (t) => ({
    /**
     * A single gallery by id, or `null` if it does not exist, the caller is
     * signed out, the caller does not own it, or (non-admin only) it is a
     * `draft` gallery not yet visible to its own clients — same visibility
     * gate `isGalleryVisibleToClient` already gives the client-facing REST
     * page, admin bypass included via `isGalleryOwner`.
     */
    gallery: t.field({
      type: GalleryType,
      nullable: true,
      args: {
        id: t.arg.id({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        if (!ctx.session) return null;

        const idResult = galleryIdSchema.safeParse(String(args.id));
        if (!idResult.success) return null;
        const galleryId = idResult.data;

        // THE ownership check — admin bypass, soft-removed-client exclusion,
        // all inherited from the one shared implementation. Mutation-proven
        // in route.test.ts ("refuses a signed-in client who does not own the
        // gallery..."): removing this `if` lets a signed-in stranger read
        // any gallery by id.
        if (!(await isGalleryOwner(galleryId, ctx.session))) return null;

        const detail = await getGalleryDetail(galleryId);
        if (!detail) return null;

        // Gate 2 — visibility (non-admin only), identical to the selection
        // route's own second gate: a `draft` gallery is still being
        // assembled by the photographer and must not render for a client,
        // regardless of whether their session otherwise owns it.
        if (ctx.session.user.role !== "admin" && !isGalleryVisibleToClient(detail.status)) {
          return null;
        }

        return detail;
      },
    }),

    /**
     * Every gallery the signed-in session owns, or `[]` when signed out.
     *
     * Backed by `getGalleriesForClient` (src/lib/galleries.ts), which that
     * function's own header comment documents as having NO admin bypass by
     * design — an admin calling this gets back only galleries where their
     * OWN user id is attached (almost always none), never a studio-wide
     * listing. That is deliberate for this slice: a studio-wide admin
     * listing is task #31's job ("move gallery reads to GraphQL"), not this
     * one — task #30 is the server and the auth context, scoped to "reads
     * only: galleries and assets for the signed-in user".
     */
    galleries: t.field({
      type: [GalleryType],
      resolve: async (_root, _args, ctx) => {
        if (!ctx.session) return [];

        // Task #138: was `Promise.all(own.map((row) =>
        // getGalleryDetail(row.id)))` — one detail query PER owned gallery,
        // ~1 + 4N queries total for a client with N galleries. Replaced with
        // one batched query (`getGalleryDetailsByIds`) for every id at once,
        // so this field costs exactly two queries — this one and
        // `getGalleriesForClient`'s — no matter how many galleries the
        // caller owns. Task #154 folded `getGalleryDetailsByIds`'s
        // implementation into `src/lib/galleries.ts` itself, alongside
        // `getGalleryDetail` (both now share one `with`/mapping definition);
        // the `../gallery-details-by-ids` import path below just re-exports
        // it, kept as a stable indirection so this file and its own
        // query-count test didn't have to change.
        const own = await getGalleriesForClient(ctx.session.user.id);
        if (own.length === 0) return [];

        const details = await getGalleryDetailsByIds(own.map((row) => row.id));
        const detailById = new Map(details.map((detail) => [detail.id, detail]));

        // Re-applies `own`'s own order (getGalleriesForClient's recency
        // ordering) — `getGalleryDetailsByIds` makes no ordering promise of
        // its own (see that file's header comment) — and drops any id that
        // no longer resolves to a detail row, same "missing means absent,
        // not an error" stance the previous implementation took.
        return own
          .map((row) => detailById.get(row.id))
          .filter((detail): detail is NonNullable<typeof detail> => detail !== undefined);
      },
    }),
  }),
});
