import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guards";
import {
  activeClientRuleViolation,
  formatGalleryStatus,
  formatSessionDate,
  getGalleryDetail,
  getGalleryUnlockAudit,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import { getClientsForPicker } from "@/lib/clients";
import { formatBytes, formatCop } from "@/lib/format";
import { getGalleryArchiveSize } from "@/lib/gallery-archive-size";
import { getPresignedUrl, storedKey } from "@/lib/r2";
import { GalleryWorkspace } from "@/components/gallery-workspace";
import { PublishGalleryButton } from "@/components/publish-gallery-button";
import { UnlockSelectionPanel } from "@/components/unlock-selection-panel";
import { GalleryClientRow } from "@/components/gallery-client-row";
import { AttachGalleryClientsForm } from "@/components/attach-gallery-clients-form";

export const metadata: Metadata = {
  title: "Galería",
  // Admin workspace — never indexed, never followed. Same stance as every
  // other page under /dashboard.
  robots: { index: false, follow: false },
};

const galleryIdSchema = z.uuid();

// Calls requireAdmin() itself, same as every other page under /dashboard —
// see src/lib/auth-guards.ts's header comment for why a page must never rely
// on an ancestor layout as its only check.
export default async function GalleryDetailPage({
  params,
}: {
  params: Promise<{ galleryId: string }>;
}) {
  await requireAdmin();

  const { galleryId: rawGalleryId } = await params;
  const galleryIdResult = galleryIdSchema.safeParse(rawGalleryId);
  if (!galleryIdResult.success) notFound();

  const gallery = await getGalleryDetail(galleryIdResult.data);
  if (!gallery) notFound();

  // Task #97: every client NOT currently active on this gallery is a valid
  // "attach" candidate — this deliberately includes both clients never
  // attached at all AND previously-removed ones (re-attaching either one
  // goes through the exact same `attachGalleryClients` action; see that
  // action's own comment on the three membership cases it handles). A
  // dedicated query (`getClientsForPicker`, already used by the gallery
  // LIST page's own creation form) rather than folding this into
  // `getGalleryDetail` — that function's `GalleryDetail` type has no
  // business knowing about clients this gallery ISN'T attached to.
  const allClients = await getClientsForPicker();
  const activeClientIds = new Set(gallery.clients.map((client) => client.id));
  const eligibleClients = allClients.filter((client) => !activeClientIds.has(client.id));

  // Task #97, rewired by task #100: the SAME function each server action
  // consults (src/lib/galleries.ts's `activeClientRuleViolation`), asked the
  // exact same question the action will ask. Hiding an affordance the server
  // would refuse is UX, not the authority — every action re-checks
  // regardless of what is rendered here.
  //
  // Removal: would taking one away leave the gallery empty? `- 1` because
  // that is the count the removal would leave behind, matching
  // `removeGalleryClient`'s own call.
  const canRemoveAnyClient =
    activeClientRuleViolation({
      targetStatus: gallery.status,
      activeClientCount: gallery.clients.length - 1,
      action: "remove-client",
    }) === null;

  // Publishing: asked about the DESTINATION status (`proofing`), not the
  // gallery's current `draft` — see `publishGallery`'s own call for why.
  // Non-null means the publish button must not be offered, and this string
  // is the reason to show in its place. The server action produces the very
  // same sentence if anyone posts the form anyway.
  const publishBlockedReason = activeClientRuleViolation({
    targetStatus: "proofing",
    activeClientCount: gallery.clients.length,
    action: "publish",
  });

  // Task #101: whether "Reenviar acceso" should render on each client row.
  // The SAME predicate `resendGalleryAccessEmail` itself re-checks server
  // side — a `draft`/`archived` gallery has nothing a client could view yet,
  // so a resend control for one would mail a working magic link to a
  // gallery the client cannot open (see that action's own header comment).
  // Computed here, not inside <GalleryClientRow>, because that component is
  // a Client Component and `isGalleryVisibleToClient` lives in a
  // `server-only`-guarded module it cannot import — same reason `removable`
  // above is computed on this page rather than in the row itself.
  const canResendAccess = isGalleryVisibleToClient(gallery.status);

  // Task #73: the unlock audit trail (who/when/reason) is a SEPARATE, tiny
  // query — see src/lib/galleries.ts's own comment on
  // `getGalleryUnlockAudit` for why this is deliberately not folded into
  // `getGalleryDetail`/`GalleryDetail`. All-null for a gallery that has
  // never been unlocked — a real, reachable state this page must render
  // plainly (nothing shown at all, see below), not treat as missing data.
  const unlockAudit = await getGalleryUnlockAudit(gallery.id);

  // Task #92: the SAME question GET .../download-all's own pre-flight asks
  // ("how big would this gallery's zip be"), asked here instead so the
  // photographer — the one who can actually fix an oversized gallery —
  // finds out before a client clicks "descargar todo" and gets refused.
  // `null` when nothing is deliverable yet (the common case), which is also
  // what keeps this from ever issuing an R2 HEAD request on a gallery with
  // no finals — see that function's own header comment.
  const archiveSize = await getGalleryArchiveSize(gallery.assets);

  // Presigned URLs are generated here, at render time, for the INITIAL
  // paint only — `getPresignedUrl` is a local HMAC signature, not an R2
  // round trip, so doing this once per asset on every page load is cheap.
  // They are good for `PRESIGNED_URL_TTL_SECONDS` (5 minutes; src/lib/r2.ts)
  // from this instant. A photographer who leaves this page open longer than
  // that (uploading ~100 photos is not a 5-minute job) would otherwise see
  // thumbnails start 403ing partway through the session — <GalleryWorkspace>
  // is a client component that refreshes a URL on demand (its <img>
  // `onError` handler re-fetches from `/api/assets/[assetId]/proof`) rather
  // than polling all of them on a timer, so a long-open tab stays correct
  // without hammering the read route for assets nobody has scrolled past.
  const selectedCount = gallery.assets.filter((asset) => asset.isSelected).length;
  // Task #86 fix: this page used to also compute `pendingFinalsCount` here
  // and hand it to <DeliverGalleryButton> as a sibling prop — a snapshot
  // that never updated after an upload, while <GalleryWorkspace>'s own
  // live counter did, so the two disagreed the instant a photographer
  // uploaded a final without reloading. <GalleryWorkspace> now owns BOTH
  // the counter AND the button (see its own header comment), reading a
  // single live value instead of two computed at different times.
  const initialAssets = gallery.assets.map((asset) => ({
    id: asset.id,
    originalFilename: asset.originalFilename,
    proofWidth: asset.proofWidth,
    proofHeight: asset.proofHeight,
    isSelected: asset.isSelected,
    sortOrder: asset.sortOrder,
    // `asset.proofKey` came off the `assets` table, which loses the `R2Key`
    // brand on the round trip through Postgres — see `storedKey`'s own
    // comment in src/lib/r2.ts.
    proofUrl: getPresignedUrl(storedKey(asset.proofKey)),
    // Task #26: a boolean derived from `finalKey`, never the raw key itself
    // — see <GalleryWorkspace>'s own `WorkspaceAsset.hasFinal` comment.
    hasFinal: asset.finalKey !== null,
  }));

  return (
    <>
      <Link
        href="/dashboard/galleries"
        className="label text-fg-dim hover:text-accent-2 mb-6 inline-block transition-colors"
      >
        ← Galerías
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <span className="label text-accent mb-2 block">
            {formatGalleryStatus(gallery.status)}
          </span>
          <h1 className="max-w-[24ch] font-serif text-[clamp(28px,4vw,44px)] leading-[1.05] font-normal tracking-[-0.015em] text-balance">
            {gallery.title}
          </h1>
          {/* Task #139: the ONLY link from the panel to
              `/galleries/[publicSlug]` anywhere in the codebase — before
              this, reaching the client's own view meant hand-building the
              URL from the `publicSlug` column directly in the database (see
              this task's own body). Opens in a new tab: the admin keeps
              their dashboard tab, and the new tab is the ACTUAL preview,
              with the same watermark/visibility rules the client gets
              (page.tsx:88-95's own comment on why there is no admin
              carve-out there) — <ClientPreviewBanner> on that page is what
              tells the admin they landed in preview mode, not impersonation.

              Deliberately NOT `.label` (globals.css's mono, uppercase,
              0.22em-tracked eyebrow style) — epic #125's own done-when says
              no mono eyebrow survives under /dashboard, and this is a new
              control, not a pre-existing one left in place. Plain text
              instead. `min-h-11` (44px) for the epic's touch-target rule,
              even though #139 isn't in its enumerated list of slices that
              rule explicitly binds — this IS a /dashboard control. */}
          <Link
            href={`/galleries/${gallery.publicSlug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-dim hover:text-accent-2 mt-2 inline-flex min-h-11 items-center gap-1 text-sm transition-colors"
          >
            Ver como la ve el cliente
            <span aria-hidden="true">↗</span>
            <span className="sr-only">(abre en una pestaña nueva)</span>
          </Link>
          {/* Task #94: a gallery can have several clients now — one line
              per client so each name/email pair stays legible instead of
              being crammed onto one. Task #97: each line is now its own
              <GalleryClientRow>, adding the "Quitar" affordance.

              Task #100: ZERO clients is legitimate for a draft (the gallery
              was set up before the client record existed) and must read as a
              deliberate state, never as blank space. It is also the thing
              blocking publication, so the line says what to do next rather
              than only reporting the absence — the "agregá" pointer lands
              right above the attach form below. */}
          {gallery.clients.length === 0 ? (
            <p className="text-fg-mute mt-2 text-sm">
              Todavía sin cliente — agregá uno acá abajo para poder publicar la galería.
            </p>
          ) : (
            gallery.clients.map((client) => (
              <GalleryClientRow
                key={client.id}
                galleryId={gallery.id}
                client={client}
                status={gallery.status}
                removable={canRemoveAnyClient}
                resendable={canResendAccess}
              />
            ))
          )}
          <p className="text-fg-mute text-sm">Sesión: {formatSessionDate(gallery.sessionDate)}</p>

          {/* Task #97 — the product's first gallery-editing surface: attach
              one or more additional clients to a gallery that already
              exists, from the gallery's own page. */}
          <div className="border-line-2 mt-4 max-w-sm rounded-sm border p-4">
            <AttachGalleryClientsForm galleryId={gallery.id} eligibleClients={eligibleClients} />
          </div>
        </div>

        <div className="flex flex-col items-end gap-4">
          <dl className="border-line-2 grid grid-cols-2 gap-x-8 gap-y-2 rounded-sm border p-6 text-sm">
            <dt className="text-fg-mute">Paquete</dt>
            <dd>{gallery.package.name}</dd>
            <dt className="text-fg-mute">Fotos incluidas</dt>
            <dd>{gallery.includedPhotosSnapshot}</dd>
            <dt className="text-fg-mute">Foto extra</dt>
            <dd>{formatCop(gallery.extraPhotoPriceCopSnapshot)}</dd>
            <dt className="text-fg-mute">Fotos subidas</dt>
            <dd>{gallery.assets.length}</dd>
            <dt className="text-fg-mute">Seleccionadas</dt>
            <dd>{selectedCount}</dd>
            {/* Task #92: shown once there is at least one deliverable final
                — a draft/proofing gallery has nothing to size yet, and
                `archiveSize` is `null` for exactly that case (see
                getGalleryArchiveSize's own comment). Visible regardless of
                how close the gallery is to the ceiling — "the photographer
                can see a gallery's total final size without triggering a
                download" is this task's own first acceptance criterion, not
                only the warning below. */}
            {archiveSize && (
              <>
                <dt className="text-fg-mute">Peso de la descarga</dt>
                <dd>{formatBytes(archiveSize.totalBytes)}</dd>
              </>
            )}
          </dl>

          {/* Task #92: called out BEFORE the gallery crosses
              GET .../download-all's own ceiling (`ZIP32_MAX_TOTAL_BYTES`/
              `ZIP32_MAX_ENTRY_COUNT`, src/lib/zip-stream.ts) — not only once
              it already has. Same warning color as <AssetTile>'s own "Falta
              el final" state (src/components/asset-tile.tsx): both mean
              "the photographer, not the client, needs to act on this". */}
          {archiveSize && archiveSize.status !== "ok" && (
            <p className="max-w-xs text-right text-sm text-[#e0796b]">
              {archiveSize.status === "over"
                ? `Los finales de esta galería pesan ${formatBytes(archiveSize.totalBytes)} — la descarga completa ya no va a funcionar (el límite ronda los 4 GB). Subí exports más livianos o coordiná una entrega dividida.`
                : `Los finales de esta galería pesan ${formatBytes(archiveSize.totalBytes)} — la descarga completa no va a funcionar por encima de unos 4 GB. Considerá exports más livianos antes de que sea un problema.`}
            </p>
          )}

          {/* Guarded server-side by publishGallery() itself (draft-only,
              non-empty gallery, at least one active client) — hiding the
              button is UX, not the authority; see
              src/app/dashboard/galleries/actions.ts's isPublishable() and
              its `activeClientRuleViolation()` call.

              Task #100: a clientless draft gets the REASON in place of the
              button, not a silently missing control. */}
          {gallery.status === "draft" &&
            (publishBlockedReason ? (
              <p className="text-fg-mute max-w-xs text-right text-sm">{publishBlockedReason}</p>
            ) : (
              <PublishGalleryButton
                galleryId={gallery.id}
                clientEmails={gallery.clients.map((client) => client.email)}
              />
            ))}

          {/* Task #73: guarded server-side by unlockSelection() itself
              (selected-only) — hiding the panel once the gallery has moved
              past "selected" is UX, not the authority; see
              src/app/dashboard/galleries/actions.ts's isUnlockable(). */}
          {gallery.status === "selected" && <UnlockSelectionPanel galleryId={gallery.id} />}

          {/* Task #27's <DeliverGalleryButton> used to render HERE, as a
              sibling fed a server-rendered `pendingFinalsCount` snapshot —
              see task #86's fix comment on `<GalleryWorkspace>` below for
              why it now renders from inside that component instead, next to
              the SAME live counter it depends on. */}

          {/* The unlock audit trail (task #73) — who last unlocked this
              gallery's submitted selection, when, and their optional note.
              `unlockAudit` is all-null for a gallery that has never been
              unlocked, which is the common case, so this renders nothing
              at all rather than a "never unlocked" placeholder nobody
              needs to read. */}
          {unlockAudit?.unlockedAt && (
            <p className="text-fg-mute max-w-xs text-right text-xs">
              Desbloqueada el {unlockAudit.unlockedAt.toLocaleDateString("es-CO")}
              {unlockAudit.unlockedByEmail ? ` por ${unlockAudit.unlockedByEmail}` : ""}
              {unlockAudit.unlockReason ? ` — "${unlockAudit.unlockReason}"` : ""}
            </p>
          )}
        </div>
      </div>

      <div className="mt-12">
        <GalleryWorkspace
          galleryId={gallery.id}
          initialAssets={initialAssets}
          clientEmails={gallery.clients.map((client) => client.email)}
          canDeliver={gallery.status === "selected"}
        />
      </div>
    </>
  );
}
