import type { Metadata } from "next";
import { forbidden, notFound } from "next/navigation";
import { requireSession } from "@/lib/auth-guards";
import {
  formatGalleryStatus,
  formatSessionDate,
  getGalleryDetailBySlug,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import { getPresignedUrl } from "@/lib/r2";
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
// validates a UUID: `getGalleryDetailBySlug` below simply returns `null`
// for any string that doesn't match a row, which this page already turns
// into a 404.
export default async function ClientGalleryPage({
  params,
}: {
  params: Promise<{ publicSlug: string }>;
}) {
  const session = await requireSession();

  const { publicSlug } = await params;
  const gallery = await getGalleryDetailBySlug(publicSlug);
  if (!gallery) notFound();

  // Ownership: the gallery's own client, or an admin — the same rule
  // src/lib/asset-access.ts's loadOwnedAsset() applies per-asset, applied
  // here at the gallery level since this page resolves ONE gallery
  // directly, not an asset. An unguessable slug in the URL is NOT treated
  // as proof of anything by itself (task #23's core security requirement,
  // restated after the route was corrected to use the slug instead of the
  // id: the slug only stops enumeration, it is not authorization) —
  // ownership is decided from the gallery row's own `clientId` against the
  // SESSION only. A signed-in client who obtains another client's slug
  // still gets a real 403 here, not a redirect and not a 404 that would let
  // them fish for which slugs resolve to a real gallery.
  const isAdmin = session.user.role === "admin";
  const isOwner = isAdmin || gallery.client.id === session.user.id;
  if (!isOwner) forbidden();

  // A draft gallery is still being assembled by the photographer — never
  // shown to a client even when their own session legitimately owns it. See
  // isGalleryVisibleToClient's own comment in src/lib/galleries.ts. Admins
  // bypass this so the photographer can preview a gallery before publishing
  // it, the same "admin sees everything" stance loadOwnedAsset takes.
  if (!isAdmin && !isGalleryVisibleToClient(gallery.status)) notFound();

  // Presigned at render time, for the INITIAL paint only — `getPresignedUrl`
  // is a local HMAC signature, not an R2 round trip, so doing this once per
  // asset per page load is cheap. Good for `PRESIGNED_URL_TTL_SECONDS` (5
  // minutes, src/lib/r2.ts) from this instant onward. See
  // src/components/proof-grid.tsx's header comment for the full write-up of
  // how a page left open past that TTL recovers without a hard reload —
  // this task's own acceptance criterion.
  const initialAssets = gallery.assets.map((asset) => ({
    id: asset.id,
    originalFilename: asset.originalFilename,
    proofWidth: asset.proofWidth,
    proofHeight: asset.proofHeight,
    isSelected: asset.isSelected,
    proofUrl: getPresignedUrl(asset.proofKey),
    // Task #28's own acceptance criterion — "only assets that were selected
    // AND edited are downloadable" — computed here as a plain boolean, the
    // SAME allowlist discipline this mapping already follows for every other
    // field: `asset.finalKey` (the raw R2 key) is deliberately never in this
    // object at all, only ever this derived flag. `<GET
    // /api/assets/[assetId]/final>` (src/app/api/assets/[assetId]/final/route.ts)
    // re-checks all three conditions itself on every request regardless of
    // what this renders — this is a UI hint for which assets show a download
    // button, not a substitute for that route's own gate.
    hasFinal: asset.isSelected && asset.isEdited && asset.finalKey !== null,
  }));

  return (
    <>
      <div className="mb-10">
        <span className="label text-accent mb-2 block">{formatGalleryStatus(gallery.status)}</span>
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
        initialSubmittedAt={
          gallery.selectionSubmittedAt ? gallery.selectionSubmittedAt.toISOString() : null
        }
        packageName={gallery.package.name}
        includedPhotosSnapshot={gallery.includedPhotosSnapshot}
        extraPhotoPriceCopSnapshot={gallery.extraPhotoPriceCopSnapshot}
      />
    </>
  );
}
