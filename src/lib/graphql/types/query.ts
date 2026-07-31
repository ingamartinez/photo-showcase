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
// EVERY FIELD FAILS CLOSED BY RETURNING EMPTY, NOT BY THROWING: an
// unauthenticated caller, a caller asking for someone else's gallery, and a
// caller asking for a gallery id that does not exist all get back exactly
// the same shape a caller who is genuinely allowed to see nothing would get
// — `null` for `gallery`/`galleryBySlug`, `[]` for `galleries`/`galleryList`.
// A GraphQL error here would leak, through its message or its mere presence,
// that SOMETHING exists at that id that the caller isn't allowed to see;
// collapsing every refusal case to "no data" (mirroring the
// 403-not-404-when-avoidable posture the selection route already takes for
// the same reason) means a client probing random ids learns nothing more
// than a client asking for their own.
//
// NOTE, because it is a real difference and not an oversight (task #31): the
// client-facing PAGE at `/galleries/[publicSlug]` answers 403 for a
// signed-in non-owner and 404 for an unknown slug, which this schema
// deliberately does not distinguish. That is not a weaker rule on either
// side — the page cannot learn the difference from `galleryBySlug`, so it
// re-derives it from the same two helpers on the refusal path only. See that
// page's own comment.
import "server-only";

import { z } from "zod";
import {
  getGalleriesForClient,
  getGalleryDetail,
  getGalleryDetailBySlug,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import { isGalleryOwner } from "@/lib/gallery-access";
import { builder } from "../builder";
import { getGalleryDetailsByIds } from "../gallery-details-by-ids";
import { GalleryType } from "./gallery";
import { GalleryListItemType } from "./gallery-list-item";

const galleryIdSchema = z.uuid();

// The client-facing slug (task #31). Deliberately NOT a base64url shape check
// against what `generateGallerySlug()` (src/lib/slug.ts) happens to emit
// today: `galleries.public_slug` is a plain `text` column, and pinning this
// resolver to the CURRENT generator's alphabet would silently stop resolving
// every existing gallery the day that generator's encoding changed — a much
// worse failure than the one it would prevent. What is rejected here is what
// cannot be a slug under ANY encoding: the empty string, and a value far
// longer than any slug this app mints (22 characters). The point is to refuse
// obvious junk without opening a database round trip for it, not to
// re-implement the generator.
const gallerySlugSchema = z.string().min(1).max(128);

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
     * The same gallery `gallery` returns, looked up by its client-facing
     * `publicSlug` instead of its id — task #31, added because
     * `/galleries/[publicSlug]` resolves against the slug and this schema had
     * no field that could answer it at all.
     *
     * IDENTICAL refusal behaviour to `gallery` above, and for the same
     * reasons: `null` when signed out, when the slug matches nothing, when
     * the caller does not own it (`isGalleryOwner`, admin bypass included),
     * and — for a non-admin — when it is not yet client-visible
     * (`isGalleryVisibleToClient`, so a `draft` stays hidden from its own
     * client). No GraphQL error in any of those cases, so the four are
     * indistinguishable from outside.
     *
     * ONE ORDERING DIFFERENCE from `gallery`, worth naming: `gallery` can
     * check ownership BEFORE reading anything, because the caller handed it
     * the gallery id. A slug is not an id, so this field has to resolve the
     * row first to learn which gallery ownership is even being asked about —
     * exactly the order the REST page it replaces already used. The cost is
     * one wasted read for a caller who turns out not to own the gallery; the
     * alternative would be a second query mapping slug to id, which is the
     * same read with extra steps. An unguessable slug is NOT treated as proof
     * of anything either way — see `getGalleryDetailBySlug`'s own comment in
     * src/lib/galleries.ts.
     */
    galleryBySlug: t.field({
      type: GalleryType,
      nullable: true,
      args: {
        publicSlug: t.arg.string({ required: true }),
      },
      resolve: async (_root, args, ctx) => {
        if (!ctx.session) return null;

        const slugResult = gallerySlugSchema.safeParse(args.publicSlug);
        if (!slugResult.success) return null;

        const detail = await getGalleryDetailBySlug(slugResult.data);
        if (!detail) return null;

        // THE ownership check — the same one `gallery` above makes, against
        // the gallery's OWN id as just read from the database, never anything
        // derived from the caller's argument beyond the slug lookup itself.
        if (!(await isGalleryOwner(detail.id, ctx.session))) return null;

        // Gate 2 — visibility (non-admin only), identical to `gallery`'s.
        if (ctx.session.user.role !== "admin" && !isGalleryVisibleToClient(detail.status)) {
          return null;
        }

        return detail;
      },
    }),

    /**
     * The signed-in client's own gallery INDEX — the light projection
     * `/galleries` renders (id, title, slug, status, session date, photo
     * count), or `[]` when signed out. Task #31.
     *
     * Scoped by exactly the same call `galleries` below makes,
     * `getGalleriesForClient(ctx.session.user.id)` — one function, one
     * ownership subquery, one `CLIENT_VISIBLE_STATUSES` filter, and (per that
     * function's own header comment) NO admin bypass: an admin asking this
     * gets only galleries their own id is attached to. The scoping rule is
     * therefore not duplicated between the two fields, only the projection
     * differs.
     *
     * WHY IT IS A SEPARATE FIELD from `galleries` rather than a thinner
     * selection on it: see ./gallery-list-item.ts's header. Short version —
     * Pothos resolves `Gallery` off a FIXED Drizzle projection, so asking
     * `galleries` for `assets { id }` alone still costs a second query and
     * every asset column of every gallery. This field costs exactly one
     * query and materialises no asset rows, which is what the page it serves
     * did before this schema existed. Proven, not asserted, in
     * src/app/galleries/page.query-count.test.ts.
     */
    galleryList: t.field({
      type: [GalleryListItemType],
      resolve: async (_root, _args, ctx) => {
        if (!ctx.session) return [];

        return getGalleriesForClient(ctx.session.user.id);
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
