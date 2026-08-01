import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-guards";
import {
  formatClientGalleryCardState,
  formatGalleryStatus,
  formatSessionDate,
  getGalleryDetailBySlug,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import { isAdminPreviewingClientGallery, isGalleryOwner } from "@/lib/gallery-access";
import { getGallerySelection } from "@/lib/gallery-selection";
import { readClientGalleryBySlug } from "@/lib/graphql/client-gallery-reads";
import { selectionTrayModeFromWire } from "@/lib/graphql/types/selection-tray-mode";
import { displayKey, getPresignedUrl, storedKey } from "@/lib/r2";
import { ClientPreviewBanner } from "@/components/client-preview-banner";
import { ProofGrid } from "@/components/proof-grid";

export const metadata: Metadata = {
  title: "Tu galería",
  // Every individual client's gallery is unlisted and reachable only by a
  // signed-in session that owns it — never indexed, same stance as
  // `/dashboard`.
  robots: { index: false, follow: false },
};

// Calls requireSession() itself, same as every other guarded page in this
// app — see src/lib/auth-guards.ts's header comment for why a page must
// never rely on an ancestor layout (src/app/galleries/layout.tsx here) as
// its only check. `requireSession()`, not `requireAdmin()`: this page is
// for the CLIENT who owns the gallery (an admin may also reach it, see the
// ownership check below, but the primary audience is a client, unlike
// everything under /dashboard).
//
// Route param is `publicSlug`, NOT the gallery's id — schema.ts's comment
// on `galleries.publicSlug` is explicit that the slug is the only
// identifier meant to ever appear in a client-facing URL (128 bits of
// randomness, unguessable by walking sequential-feeling ids). There is no
// format to validate up front the way `/dashboard/galleries/[galleryId]`
// validates a UUID: the read below simply resolves to `null` for any string
// that doesn't match a row, which this page turns into a 404.
export default async function ClientGalleryPage({
  params,
}: {
  params: Promise<{ publicSlug: string }>;
}) {
  const session = await requireSession();

  const { publicSlug } = await params;

  // Task #31: read through the GraphQL schema (`Query.galleryBySlug`),
  // executed IN PROCESS rather than over HTTP — see
  // src/lib/graphql/execute.ts's header for why, and what that path does and
  // does not include.
  //
  // AUTHORIZATION DID NOT MOVE OUT OF THIS PAGE SO MUCH AS GAIN A SECOND
  // ENFORCER. That resolver runs the SAME two gates this page used to run
  // inline, calling the SAME helpers: `isGalleryOwner` (src/lib/
  // gallery-access.ts — one of the gallery's own clients per task #94, or an
  // admin) and `isGalleryVisibleToClient` (src/lib/galleries.ts — a `draft`
  // gallery is still being assembled and is hidden even from the client who
  // owns it, admins excepted so the photographer can preview). Neither rule
  // is restated here, so neither can drift from the version every sibling
  // route uses. An unguessable slug is still NOT treated as proof of anything
  // (task #23's core security requirement): a signed-in client holding
  // another client's slug gets nothing back.
  const gallery = await readClientGalleryBySlug(publicSlug, session);

  if (!gallery) {
    // THE ONE THING GRAPHQL STRUCTURALLY CANNOT TELL THIS PAGE, and the
    // reason these two helpers are still called here. `galleryBySlug`
    // collapses "no such slug", "not yours" and "not visible yet" into a
    // single `null` on purpose — that is its no-existence-oracle design, see
    // src/lib/graphql/types/query.ts's header. This page needs the
    // distinction, because it has always answered 403 for a signed-in
    // non-owner and 404 for an unknown slug, and quietly turning the former
    // into the latter would change what a client sees.
    //
    // So the distinction is re-derived HERE, from the same two helpers, and
    // ONLY on the refusal path: a caller who is allowed to see the gallery
    // never reaches this block, so the happy path still costs exactly the
    // queries the resolver made. A refused caller pays for one extra read of
    // a gallery they were not allowed to see — the price of not encoding the
    // refusal reason into a field a browser can query.
    const refused = await getGalleryDetailBySlug(publicSlug);
    if (!refused) notFound();
    if (!(await isGalleryOwner(refused.id, session))) forbidden();
    // Exists, and this session owns it — so the only gate left for the
    // resolver to have failed is the client-visibility one, which this page
    // has always answered with a 404 rather than a 403: a client must not be
    // able to tell "your gallery isn't ready yet" from "no such gallery".
    notFound();
  }

  // Presigned at render time, for the INITIAL paint only — `getPresignedUrl`
  // is a local HMAC signature, not an R2 round trip, so doing this once per
  // asset per page load is cheap. Good for `PRESIGNED_URL_TTL_SECONDS` (5
  // minutes, src/lib/r2.ts) from this instant onward. See
  // src/components/proof-grid.tsx's header comment for the full write-up of
  // how a page left open past that TTL recovers without a hard reload —
  // this task's own acceptance criterion.
  //
  // Task #89: a DELIVERED gallery shows the unwatermarked, browsing-sized
  // derivative instead of the proof — the client paid, so the watermark
  // should be gone from what they look at, not only from what they download.
  // Decided here, once, at the gallery level, because a gallery's status is
  // the same for every asset in it.
  //
  // No admin carve-out on this one, deliberately, and it is the ONE place
  // this page's rule is narrower than `GET /api/assets/[assetId]/display`'s
  // own (which keeps the download gate's admin preview verbatim — see
  // src/lib/final-access.ts). This page renders the CLIENT'S view of the
  // gallery; an admin opening it is previewing exactly that, and a preview
  // that silently drops the watermark would show the photographer something
  // no client of theirs can see. The admin's own preview of an
  // undelivered final lives in the dashboard workspace, not here.
  const showsDeliveredPhotos = gallery.status === "delivered";
  const initialAssets = gallery.assets.map((asset) => {
    // Task #28's own acceptance criterion — "only assets that were selected
    // AND edited are downloadable" — computed here as a plain boolean, the
    // SAME allowlist discipline this mapping already follows for every other
    // field: `asset.finalKey` (the raw R2 key) is deliberately never in this
    // object at all, only ever this derived flag. `<GET
    // /api/assets/[assetId]/final>` (src/app/api/assets/[assetId]/final/route.ts)
    // re-checks all three conditions itself on every request regardless of
    // what this renders — this is a UI hint for which assets show a download
    // button, not a substitute for that route's own gate.
    const hasFinal = asset.isSelected && asset.isEdited && asset.finalKey !== null;

    return {
      id: asset.id,
      originalFilename: asset.originalFilename,
      proofWidth: asset.proofWidth,
      proofHeight: asset.proofHeight,
      isSelected: asset.isSelected,
      // `asset.proofKey` came off the `assets` table, which loses the
      // `R2Key` brand on the round trip through Postgres — see
      // `storedKey`'s own comment in src/lib/r2.ts. Task #31 added a GraphQL
      // hop in front of that round trip, which does not restore it either
      // (`Asset.proofKey` is a plain `String` over the wire), so `storedKey`
      // is if anything more load-bearing here than it was.
      proofUrl: getPresignedUrl(storedKey(asset.proofKey)),
      hasFinal,
      // Task #89. Presigned from `displayKey` — a pure function of
      // (galleryId, assetId), which is exactly why this needs no new column
      // (see src/lib/r2.ts's own comment on it). Per-asset, not per-gallery:
      // a delivered gallery routinely contains photos the client never
      // selected and the photographer never edited, and those keep showing
      // their watermarked proof. A MIXED gallery is the normal case, not an
      // edge case — `null` here is what makes those tiles fall back cleanly
      // rather than look broken.
      //
      // Optimistic: nothing is probed in R2 to confirm the object is really
      // there (that would be one round trip per asset per page load, forever,
      // for a question that is permanently "yes" once the backfill has run —
      // see `objectExists`'s own comment). If it genuinely is not there, the
      // <img> fails, <ProofGrid>'s refresh path asks
      // `GET /api/assets/[assetId]/display`, and THAT route's HEAD check
      // answers 404 so the grid falls back to the proof.
      displayUrl:
        showsDeliveredPhotos && hasFinal ? getPresignedUrl(displayKey(gallery.id, asset.id)) : null,
    };
  });

  // Task #95: the FIRST paint of the collaborative tray, from the SAME
  // function `GET /api/galleries/[galleryId]/selection` calls for every live
  // refresh afterwards — one query shape, so "what the server said at page
  // load" and "what the server says now" cannot drift into two different
  // answers. Read AFTER the ownership and visibility gates above, never
  // before: it returns other clients' names.
  //
  // A DIRECT call, deliberately left out of the GraphQL move (task #31): this
  // function is not in that schema and was not added to it. Same position the
  // presigned-URL calls above hold — see src/lib/graphql/
  // client-gallery-reads.ts's header for both.
  const initialPicks = await getGallerySelection(gallery.id);

  return (
    <>
      {/* Task #139: orientation, not permission — see
          `isAdminPreviewingClientGallery`'s own comment in
          src/lib/gallery-access.ts. Gated on the SAME session this page
          already resolved above, never re-derived. A real client never
          sees this: `session.user.role` here is populated server-side by
          `src/auth.ts`'s session callback, not anything a client could
          spoof to make it appear. */}
      {isAdminPreviewingClientGallery(session) && (
        <ClientPreviewBanner dashboardHref={`/dashboard/galleries/${gallery.id}`} />
      )}

      <div className="mb-10">
        {/* Task #181: the CLIENT's own word for the gallery's state, not the
            studio's internal workflow name — reuses
            `formatClientGalleryCardState`, the SAME mapping `/galleries`'
            index already renders (that function's own comment), rather than
            reimplementing a second copy that would only drift from it again.
            `formatGalleryStatus` stays for admin surfaces (the dashboard) —
            see that function's own comment.

            The `isGalleryVisibleToClient` branch below only ever executes
            for a status a real CLIENT can never see here at all: this page
            already gates `draft`/`archived` behind a 404 for a client
            (`readClientGalleryBySlug` above), so the ONLY session that can
            still reach this line with one of those two statuses is an ADMIN
            previewing an unpublished/archived gallery (task #139's bypass —
            see `isAdminPreviewingClientGallery` above). That admin is
            reading their OWN studio's word, on a page they know is a
            preview; `formatClientGalleryCardState` itself refuses to answer
            for those two statuses (see its own comment), so falling back to
            `formatGalleryStatus` here is what keeps that preview from
            crashing instead of quietly re-deriving the client mapping. */}
        {/* Task #149's own sweep: NOT globals.css's `.label` (0.22em) — that
            is home.html's own `.kicker` value, reused verbatim under a
            different name. `design/system/client.html`'s OWN `.kicker`
            (:117-120) specifies 0.18em, which is what this surface's eyebrow
            actually needs to render at. Inlined, not the shared class, so it
            cannot drift back to the marketing value silently. */}
        <span className="text-accent mb-2 block font-mono text-[11px] tracking-[0.18em] uppercase">
          {isGalleryVisibleToClient(gallery.status)
            ? formatClientGalleryCardState(gallery.status).label
            : formatGalleryStatus(gallery.status)}
        </span>
        <h1 className="max-w-[24ch] font-serif text-[clamp(28px,4vw,44px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
          {gallery.title}
        </h1>
        <p className="text-fg-mute mt-2 text-sm">
          Sesión: {formatSessionDate(gallery.sessionDate)}
        </p>
      </div>

      <ProofGrid
        galleryId={gallery.id}
        initialAssets={initialAssets}
        initialStatus={gallery.status}
        // Already an ISO string, not a `Date`: this builder registers no
        // `Date` scalar, so `Gallery.selectionSubmittedAt` resolves through
        // `.toISOString()` itself (src/lib/graphql/types/gallery.ts) — the
        // same conversion this line used to do, one layer down. `<ProofGrid>`
        // wanted a string either way.
        initialSubmittedAt={gallery.selectionSubmittedAt}
        initialPicks={initialPicks}
        // Display only — the tray renders this session's own picks as "Vos".
        // Nothing is authorized by it: every route <ProofGrid> calls resolves
        // the acting session server-side.
        viewerId={session.user.id}
        // Task #193 — `gallery.package.name` used to be passed through here
        // as `packageName`. The owner's decision, applying to every gallery
        // regardless of `termsOverridden`: a client must never be able to
        // read the package's name on their OWN gallery and cross-reference
        // it against `/contact`'s public price list to deduce they got a
        // deal different from the published one. See selection-counter.tsx's
        // and proof-grid.tsx's own comments for why this is unconditional,
        // not only for overridden galleries.
        includedPhotosSnapshot={gallery.includedPhotosSnapshot}
        extraPhotoPriceCopSnapshot={gallery.extraPhotoPriceCopSnapshot}
        // Task #204 — presentation only, an admin-set choice on the gallery
        // itself. `selectionTrayModeFromWire` undoes GraphQL's own
        // NAME-not-VALUE enum serialization — see that function's own
        // comment for why the field arrives as `"FLAT"`/`"BY_PERSON"` here
        // and not the `"flat"`/`"by-person"` every other consumer expects.
        selectionTrayMode={selectionTrayModeFromWire(gallery.selectionTrayMode)}
      />
    </>
  );
}
