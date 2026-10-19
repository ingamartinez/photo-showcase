import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-guards";
import { ArrowLeft } from "@/components/icons";
import {
  activeClientRuleViolation,
  formatGalleryStatus,
  formatSessionDate,
  getGalleryDetail,
  getGalleryUnlockAudit,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import { getClientsForPicker } from "@/lib/clients";
import { tierRangeLabel } from "@/lib/extra-price-tiers";
import { formatBytes, formatCop } from "@/lib/format";
import { getGalleryArchiveSize } from "@/lib/gallery-archive-size";
import { getPresignedUrl, storedKey } from "@/lib/r2";
import { cn } from "@/lib/utils";
import { GalleryWorkspace } from "@/components/gallery-workspace";
import { PublishGalleryButton } from "@/components/publish-gallery-button";
import { UnlockSelectionPanel } from "@/components/unlock-selection-panel";
import { GalleryClientRow } from "@/components/gallery-client-row";
import { GalleryClientList } from "@/components/gallery-client-list";
import { AttachGalleryClientsForm } from "@/components/attach-gallery-clients-form";
import { EditGalleryTermsDialog } from "@/components/edit-gallery-terms-dialog";
import { AllowsOriginalSelectionControl } from "@/components/allows-original-selection-control";
import { RollingDeliveryControl } from "@/components/rolling-delivery-control";
import { SelectionTrayModeControl } from "@/components/selection-tray-mode-control";
import { SelectedPhotosList } from "@/components/selected-photos-list";
import { ExtrasPersonAssignment } from "@/components/extras-person-assignment";
import type { Gallery } from "@/lib/db/schema";
import {
  EMPTY_PERSON_TALLY,
  toClientSelectionView,
  type ClientPersonTally,
} from "@/lib/client-selection-state";
import { getDashboardSelection } from "@/lib/gallery-selection";
import { previewOriginalsOff } from "@/lib/pick-plans";

export const metadata: Metadata = {
  title: "Galería",
  // Admin workspace — never indexed, never followed. Same stance as every
  // other page under /dashboard.
  robots: { index: false, follow: false },
};

const galleryIdSchema = z.uuid();

// The forward-flow state machine, in the order PLAN.md §2 describes it.
// `archived` is deliberately not a fifth step here — it is a side branch off
// `delivered`, not a fifth stage of the SAME sequence the mock's stepper
// draws (design/system/dashboard.html:917-925), and nothing in this app
// today ever moves a gallery there.
const WORKFLOW_STEPS = [
  "draft",
  "proofing",
  "selected",
  "delivered",
] as const satisfies readonly Gallery["status"][];

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

  // Epic #250 (#263): ONE read for the per-person numbers, the attribution and
  // the two before/after previews. It is `readPickState` + the same
  // `buildGallerySelection` the client's own tray uses, so the dashboard and
  // the client counter cannot disagree (see `partitionByPerson`'s test). A
  // draft has no picks to show, so its rows stay plain.
  const dashboardSelection = await getDashboardSelection(gallery);
  const personByUserId = new Map(
    dashboardSelection.people.map((person) => [person.userId, person]),
  );
  const memberByUserId = new Map(
    dashboardSelection.members.map((member) => [member.userId, member]),
  );
  const selectionByClientId = new Map(
    gallery.clients.map((client) => {
      const member = memberByUserId.get(client.id);
      const person: ClientPersonTally = personByUserId.get(client.id) ?? EMPTY_PERSON_TALLY;
      return [
        client.id,
        toClientSelectionView({
          lockedAt: member?.lockedAt ?? null,
          submittedAt: member?.submittedAt ?? null,
          person,
        }),
      ];
    }),
  );

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
  // Task #210 — the edited/original split <EditGalleryTermsDialog> needs for
  // its before/after preview, derived from THIS SAME `gallery.assets` array
  // (the one query `getGalleryDetail` already issued), the identical
  // "filter one already-fetched array, don't re-query" shape
  // `use-shared-selection.ts`'s own `initialPicks` split uses for the
  // client-facing counter. `selectedOriginalCount` first, `selectedCount -
  // selectedOriginalCount` for edited — never two separate filters that
  // could read the array at different moments, which is exactly the "two
  // reads subtracted" bug task #206 shipped and fixed elsewhere this same
  // day (see this page's own history above for the `pendingFinalsCount`
  // precedent on why one live source beats two computed at different
  // times).
  const selectedOriginalCount = gallery.assets.filter(
    (asset) => asset.isSelected && asset.selectionKind === "original",
  ).length;
  const selectedEditedCount = selectedCount - selectedOriginalCount;
  // Task #263 — decision 15: an original that already has a final can never be
  // re-labelled, and neither can a LEGACY unit with no recorded holder
  // (`planOriginalsOff` skips both, because `reresolveClaim`'s rule 2 forbids
  // moving a unit that has no basis). <AllowsOriginalSelectionControl>'s "Al
  // confirmar" therefore cannot be derived here from a count of what looks
  // revertible: that is the drift this fix round closed. It comes from
  // `previewOriginalsOff`, which runs the SAME planner
  // `updateAllowsOriginalSelection` executes — one definition for the dialog
  // and the write.
  //
  // The rows are the same already-fetched `gallery.assets` array the split
  // above reads (no second query). `planOriginalsOff` reads only `isSelected`,
  // `selectionKind`, `billedTo` and `finalKey`, so the arrival stamps it never
  // touches are `null` here — `GalleryDetailAsset` does not carry them, and the
  // gallery totals are counts and prices, not an ordering.
  const originalsOff = previewOriginalsOff(
    gallery.assets.map((asset) => ({
      id: asset.id,
      isSelected: asset.isSelected,
      selectionKind: asset.selectionKind,
      billedTo: asset.billedTo ?? null,
      billedAt: null,
      finalKey: asset.finalKey,
      selectedAt: null,
      requestedAt: asset.requestedAt ?? null,
    })),
    new Date(),
    {
      includedPhotosSnapshot: gallery.includedPhotosSnapshot,
      extraPhotoPriceCopSnapshot: gallery.extraPhotoPriceCopSnapshot,
      extraPhotoPriceTiersSnapshot: gallery.extraPhotoPriceTiersSnapshot,
      originalPhotoPriceCopSnapshot: gallery.originalPhotoPriceCopSnapshot,
    },
  );
  // Task #216 — the same `gallery.assets` filter as `selectedCount` above,
  // not a second read of a different shape: only `id`/`originalFilename`/
  // `selectionKind` survive the map, so <SelectedPhotosList> can never reach
  // an R2 key even by accident (see that component's own header comment on
  // why this apartado is text-only).
  // Task #263 — per-photo attribution. `pickers` is every person who SUBMITTED
  // a pick on the photo (billed or joined), holder first: the person filter
  // has to find a photo under the name of somebody who merely joined, which
  // `selectedBy` alone could never do. A cart/degraded pick is deliberately
  // NOT here — it is not sent yet (see <SelectedPhotosList>'s own comment).
  // `hasFinal` is `finalKey !== null`, the deliver gate's own predicate.
  const entryByAssetId = new Map(dashboardSelection.entries.map((entry) => [entry.assetId, entry]));
  const selectedPhotos = gallery.assets
    .filter((asset) => asset.isSelected)
    .map((asset) => ({
      id: asset.id,
      originalFilename: asset.originalFilename,
      selectionKind: asset.selectionKind,
      billedTo: asset.billedTo,
      pickers: (entryByAssetId.get(asset.id)?.picks ?? [])
        .filter((pick) => pick.state === "billed" || pick.state === "joined")
        .map((pick) => pick.userId),
      hasFinal: asset.finalKey !== null,
    }));
  // The person filter's options: every ACTIVE client (the rows this page shows
  // anyway) plus anybody who only appears as a picker/holder — a removed
  // member's submitted picks stay attributed to them (decision 17), and they
  // must still be findable in the list.
  const selectedPhotoPeople = [
    ...gallery.clients.map((client) => ({ id: client.id, label: client.name ?? client.email })),
    ...Object.entries(dashboardSelection.labels)
      .filter(([userId]) => !activeClientIds.has(userId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([userId, label]) => ({ id: userId, label })),
  ];
  // Task #223 — the gifted extras, built off the SAME already-fetched
  // `gallery.assets` array as `selectedPhotos` above (no second query), and
  // narrowed the same way: id, filename and the attribution, never an R2 key.
  const extraPhotos = gallery.assets
    .filter((asset) => asset.isExtra)
    .map((asset) => ({
      id: asset.id,
      originalFilename: asset.originalFilename,
      deliveredFor: asset.deliveredFor,
    }));
  // `name ?? email`, the app-wide person fallback — same expression
  // `SelectionPicker.label` uses (src/lib/gallery-selection.ts).
  const extraPeople = gallery.clients.map((client) => ({
    id: client.id,
    label: client.name ?? client.email,
  }));
  // Task #86 fix: this page used to also compute `pendingFinalsCount` here
  // and hand it to <DeliverGalleryButton> as a sibling prop — a snapshot
  // that never updated after an upload, while <GalleryWorkspace>'s own
  // live counter did, so the two disagreed the instant a photographer
  // uploaded a final without reloading. <GalleryWorkspace> now owns BOTH
  // the counter AND the button (see its own header comment), reading a
  // single live value instead of two computed at different times.
  //
  // Task #133 restructured this page's OWN markup around three zones — a
  // header (title, the state stepper, clients, and the grouped
  // state-transition actions), a reference panel (package/quota facts, the
  // client link), and <GalleryWorkspace> below, full width — but changed
  // NONE of the guards above: every one of them still asks the SAME
  // question of the SAME server-side function, only the JSX that renders
  // the answer moved.
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

  // Widened to `readonly string[]` before searching: `gallery.status` also
  // admits `"archived"`, which is not one of `WORKFLOW_STEPS`' four values by
  // design (see that constant's own comment) — `indexOf` on the narrow array
  // type would otherwise refuse to even compile a search for a value it can
  // never contain.
  const currentStepIndex = (WORKFLOW_STEPS as readonly string[]).indexOf(gallery.status);

  return (
    <>
      <Link
        href="/dashboard/galleries"
        className="text-fg-dim hover:text-accent-2 mb-4 inline-flex min-h-11 items-center gap-1 text-sm transition-colors lg:min-h-6"
      >
        <ArrowLeft className="shrink-0" />
        Galerías
      </Link>

      {/* Header zone (task #133): title, the state stepper, clients, and the
          grouped state-transition actions. Replaces the old
          `flex justify-between` layout, which put the publish/unlock
          actions in the SAME visual column as the package/quota `<dl>` — see
          the reference panel further down for where those facts moved. */}
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-5">
        <div className="min-w-0 lg:flex-1">
          <h1 className="text-fg max-w-[24ch] text-2xl leading-tight font-medium tracking-[-0.015em] text-balance">
            {gallery.title}
          </h1>

          {/* The state machine as the progression it actually is (PLAN.md
              §2). Scrolls horizontally on a phone (epic #125's own note on
              THIS screen) rather than wrapping into a shape that no longer
              reads as a sequence — design/system/dashboard.html:363-378. */}
          <ol
            aria-label="Estado de la galería"
            className="text-fg-mute mt-3 flex items-center gap-0 overflow-x-auto pb-1 text-xs"
          >
            {WORKFLOW_STEPS.map((step, index) => {
              // A gallery this page can never actually be on (`archived`)
              // resolves to `-1` — every step then reads as already done,
              // which is the closest honest reading of "past the forward
              // flow entirely" without inventing a fifth step for a branch
              // this stepper doesn't draw (see this file's own comment on
              // `WORKFLOW_STEPS`).
              const isDone = currentStepIndex === -1 || index < currentStepIndex;
              const isNow = index === currentStepIndex;
              return (
                <li
                  key={step}
                  // The stepper's own discriminating signal — review finding:
                  // a horizontal list of all four status words, with no
                  // programmatic marker for which one is CURRENT, cannot be
                  // told apart from a decorative list of labels either by a
                  // screen reader or by a test. `aria-current="step"` is the
                  // ARIA-sanctioned value for exactly this shape (a step in a
                  // process) — real, not just a test hook — and it means the
                  // sr-only "— estado actual" text below is no longer the
                  // ONLY thing carrying this fact.
                  aria-current={isNow ? "step" : undefined}
                  className="flex shrink-0 items-center gap-2"
                >
                  {index > 0 && <span aria-hidden="true" className="bg-line-2 h-px w-5" />}
                  <span
                    className={cn(
                      "flex items-center gap-1.5 whitespace-nowrap",
                      isNow && "text-accent-2 font-semibold",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        isNow ? "bg-accent" : isDone ? "bg-accent-2" : "bg-fg-mute",
                      )}
                    />
                    {formatGalleryStatus(step)}
                    {isNow && <span className="sr-only"> — estado actual</span>}
                  </span>
                </li>
              );
            })}
          </ol>

          <p className="text-fg-mute mt-3 text-sm">
            Sesión: {formatSessionDate(gallery.sessionDate)}
          </p>

          {/* Task #94: a gallery can have several clients now — one row per
              client so each name/email pair stays legible instead of being
              crammed onto one. Task #97: each line is now its own
              <GalleryClientRow>. Task #133: rows, not chips — see that
              component's own header comment for why "Reenviar acceso" and
              "Quitar" now live behind a single 44px "Acciones" trigger
              instead of sitting next to each other as two ~11px targets.

              Task #100: ZERO clients is legitimate for a draft (the gallery
              was set up before the client record existed) and must read as a
              deliberate state, never as blank space. It is also the thing
              blocking publication, so the line says what to do next rather
              than only reporting the absence — the "agrega" pointer lands
              right above the attach form below.

              Task #273: the rows below are a measured 2-row GRID
              (<GalleryClientList>), not a stack — it counts its own resolved
              columns and hides the surplus rows with `hidden`, so they are
              neither focusable nor announced, while each row stays MOUNTED
              and keeps its own `useActionState`. Everything about WHICH
              affordances a row may offer (`removable`, `resendable`,
              `selection`, `preview`) is still computed here, on the server;
              the list only places the already-built elements. The attach form
              stays OUTSIDE the list on purpose: it must remain reachable
              while the list is collapsed (it is where #100's "agrega uno acá
              abajo" points), and inside a grid cell its own height would
              inflate one of the two visible rows. */}
          <div className="mt-4">
            {gallery.clients.length === 0 ? (
              <p className="text-fg-mute text-sm">
                Todavía sin cliente — agrega uno acá abajo para poder publicar la galería.
              </p>
            ) : (
              <GalleryClientList
                items={gallery.clients.map((client) => ({
                  id: client.id,
                  row: (
                    <GalleryClientRow
                      galleryId={gallery.id}
                      client={client}
                      status={gallery.status}
                      removable={canRemoveAnyClient}
                      resendable={canResendAccess}
                      selection={
                        gallery.status === "draft" ? undefined : selectionByClientId.get(client.id)
                      }
                      preview={
                        gallery.status === "draft"
                          ? undefined
                          : dashboardSelection.previewByClient[client.id]
                      }
                    />
                  ),
                }))}
              />
            )}
          </div>

          {/* Task #97 — the product's first gallery-editing surface: attach
              one or more additional clients to a gallery that already
              exists, from the gallery's own page. */}
          <div className="border-line-2 mt-3 max-w-sm rounded-[6px] border p-4">
            <AttachGalleryClientsForm galleryId={gallery.id} eligibleClients={eligibleClients} />
          </div>

          {/* Grouped state-transition actions (task #133's own words:
              "actions are visually separated from reference data"). Publish
              and Unlock stay here, beside the title/clients this header
              zone owns.

              <DeliverGalleryButton> is deliberately NOT in this group — it
              rendered here as a sibling once (task #27), fed a
              server-computed `pendingFinalsCount` snapshot that went stale
              the instant a final was uploaded without a reload, and task
              #86 moved it inside <GalleryWorkspace> to read that count LIVE
              instead. Pulling it back up here for this restructure would
              silently reintroduce the exact bug #86 fixed — see
              <GalleryWorkspace>'s own header comment. */}
          {(gallery.status === "draft" || gallery.status === "selected") && (
            <div className="border-line-2 mt-6 flex flex-col items-start gap-3 rounded-[6px] border p-4">
              <span className="text-fg-mute text-xs tracking-wide uppercase">
                Qué puedes hacer ahora
              </span>
              {/* Guarded server-side by publishGallery() itself (draft-only,
                  non-empty gallery, at least one active client) — hiding the
                  button is UX, not the authority; see
                  src/app/dashboard/galleries/actions.ts's isPublishable()
                  and its `activeClientRuleViolation()` call.

                  Task #100: a clientless draft gets the REASON in place of
                  the button, not a silently missing control. */}
              {gallery.status === "draft" &&
                (publishBlockedReason ? (
                  <p className="text-fg-mute text-sm">{publishBlockedReason}</p>
                ) : (
                  <PublishGalleryButton
                    galleryId={gallery.id}
                    clientEmails={gallery.clients.map((client) => client.email)}
                  />
                ))}

              {/* Task #73: guarded server-side by unlockSelection() itself
                  (selected-only) — hiding the panel once the gallery has
                  moved past "selected" is UX, not the authority; see
                  src/app/dashboard/galleries/actions.ts's isUnlockable(). */}
              {gallery.status === "selected" && <UnlockSelectionPanel galleryId={gallery.id} />}
            </div>
          )}
        </div>

        {/* Reference panel (task #133): package/quota facts and the client
            link, separated from the actions above — the failure this
            restructure fixes is exactly the OLD layout mixing the two in one
            visual column. */}
        <aside className="flex w-full flex-col gap-4 lg:w-[300px] lg:shrink-0">
          <div className="border-line-2 rounded-[6px] border p-4">
            <span className="text-fg-mute mb-3 block text-xs tracking-wide uppercase">Paquete</span>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-mute">Paquete</dt>
              <dd className="text-right">{gallery.package.name}</dd>
              <dt className="text-fg-mute">Fotos incluidas</dt>
              <dd className="text-right">{gallery.includedPhotosSnapshot}</dd>
              <dt className="text-fg-mute">Foto extra</dt>
              <dd className="text-right">
                {gallery.extraPhotoPriceTiersSnapshot ? (
                  <ul>
                    {gallery.extraPhotoPriceTiersSnapshot.map((tier, i, tiers) => (
                      <li key={tier.minExtras}>
                        {tierRangeLabel(tiers, i)}: {formatCop(tier.priceCop)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  formatCop(gallery.extraPhotoPriceCopSnapshot)
                )}
              </dd>
              {/* Task #193 — the fotos-incluidas/foto-extra rows above are
                  always the gallery's EFFECTIVE terms (its own frozen
                  snapshots, never the live package), overridden or not; this
                  row is only what tells the photographer WHICH of the two it
                  is. Read straight off `gallery.termsOverridden`
                  (`galleries.terms_overridden`, schema.ts) — never re-derived
                  by comparing the snapshots above against the package's
                  current row, which is exactly the trap that column exists
                  to avoid. */}
              <dt className="text-fg-mute">Términos</dt>
              <dd
                className={cn(
                  "text-right",
                  gallery.termsOverridden && "text-accent-2 font-semibold",
                )}
              >
                {gallery.termsOverridden ? "Personalizados" : "Del paquete"}
              </dd>
              <dt className="text-fg-mute">Fotos subidas</dt>
              <dd className="text-right">{gallery.assets.length}</dd>
              <dt className="text-fg-mute">Seleccionadas</dt>
              <dd className="text-right">{selectedCount}</dd>
              {/* Task #92: shown once there is at least one deliverable
                  final — a draft/proofing gallery has nothing to size yet,
                  and `archiveSize` is `null` for exactly that case (see
                  getGalleryArchiveSize's own comment). Visible regardless of
                  how close the gallery is to the ceiling — "the
                  photographer can see a gallery's total final size without
                  triggering a download" is this task's own first acceptance
                  criterion, not only the warning below. */}
              {archiveSize && (
                <>
                  <dt className="text-fg-mute">Peso de la descarga</dt>
                  <dd className="text-right">{formatBytes(archiveSize.totalBytes)}</dd>
                </>
              )}
            </dl>

            {/* Task #200: the only place a gallery's own commercial terms
                can be changed after creation. Deliberately OUTSIDE the
                `<dl>` above (a `<dt>`/`<dd>` grid, not a place to hang a
                dialog trigger) rather than crammed into the "Términos" `<dd>`
                itself. `selectedEditedCount`/`selectedOriginalCount` are the
                SAME split derived above from the "Seleccionadas" row's own
                `gallery.assets` — never recomputed here or inside the
                dialog (task #210). */}
            <div className="mt-3 flex justify-end">
              <EditGalleryTermsDialog
                galleryId={gallery.id}
                status={gallery.status}
                includedPhotosSnapshot={gallery.includedPhotosSnapshot}
                extraPhotoPriceCopSnapshot={gallery.extraPhotoPriceCopSnapshot}
                extraPhotoPriceTiersSnapshot={gallery.extraPhotoPriceTiersSnapshot}
                originalPhotoPriceCopSnapshot={gallery.originalPhotoPriceCopSnapshot}
                selectedEditedCount={selectedEditedCount}
                selectedOriginalCount={selectedOriginalCount}
              />
            </div>

            {/* Task #214 — the switch itself, right after the terms dialog
                and inside this SAME "Paquete" card, not in
                <SelectionTrayModeControl>'s own layout card below: the owner
                was explicit that this decides money (whether a client can
                even see the cheaper "original" tariff), not presentation.
                Its "Al confirmar" numbers come from `previewOriginalsOff`
                (`@/lib/pick-plans`) — the SAME planner the server action
                executes — so the dialog cannot promise a reset the write will
                not perform. */}
            <div className="border-line-2 mt-3 border-t pt-3">
              <AllowsOriginalSelectionControl
                galleryId={gallery.id}
                allowsOriginalSelection={gallery.allowsOriginalSelection}
                originalsOff={originalsOff}
              />
            </div>

            {/* Task #92: called out BEFORE the gallery crosses
                GET .../download-all's own ceiling (`ZIP32_MAX_TOTAL_BYTES`/
                `ZIP32_MAX_ENTRY_COUNT`, src/lib/zip-stream.ts) — not only
                once it already has. Same warning color as <AssetTile>'s own
                "Falta el final" state (src/components/asset-tile.tsx): both
                mean "the photographer, not the client, needs to act on
                this". */}
            {archiveSize && archiveSize.status !== "ok" && (
              <p className="text-danger mt-3 text-xs">
                {archiveSize.status === "over"
                  ? `Los finales de esta galería pesan ${formatBytes(archiveSize.totalBytes)} — la descarga completa ya no va a funcionar (el límite ronda los 4 GB). Sube exports más livianos o coordina una entrega dividida.`
                  : `Los finales de esta galería pesan ${formatBytes(archiveSize.totalBytes)} — la descarga completa no va a funcionar por encima de unos 4 GB. Considera exports más livianos antes de que sea un problema.`}
              </p>
            )}
          </div>

          {/* Task #204 — the tray layout the client's own gallery uses for
              "Fotos elegidas". Its own card, separate from "Paquete" above:
              this is presentation, not a commercial term (schema.ts's own
              comment on `galleries.selectionTrayMode`), so it deliberately
              does not share the `<dl>`/terms-editing card those facts live
              in. Changeable in ANY gallery status — no gate here mirrors one
              in `updateSelectionTrayMode` because there isn't one to hide. */}
          <div className="border-line-2 rounded-[6px] border p-4">
            <SelectionTrayModeControl
              galleryId={gallery.id}
              selectionTrayMode={gallery.selectionTrayMode}
            />
          </div>

          {/* Task #244 — opt-in rolling delivery, changeable at any status.
              Its own card: it is a delivery policy, not a commercial term
              and not tray presentation. */}
          <div className="border-line-2 rounded-[6px] border p-4">
            <RollingDeliveryControl
              galleryId={gallery.id}
              rollingDelivery={gallery.rollingDelivery}
            />
          </div>

          {/* Task #139: the ONLY link from the panel to
              `/galleries/[publicSlug]` anywhere in the codebase — before
              this, reaching the client's own view meant hand-building the
              URL from the `publicSlug` column directly in the database (see
              this task's own body). Opens in a new tab: the admin keeps
              their dashboard tab, and the new tab is the ACTUAL preview,
              with the same watermark/visibility rules the client gets
              (page.tsx's own comment further down on why there is no admin
              carve-out) — <ClientPreviewBanner> on that page is what tells
              the admin they landed in preview mode, not impersonation.

              Task #133 gives this its own reference panel — "Enlace del
              cliente" in the mock (design/system/dashboard.html:1044-1052) —
              instead of a bare link under the title, so the door #139 built
              reads as a fact about the gallery (its own permanent address),
              not a stray action. Deliberately NOT `.label` (globals.css's
              mono, uppercase, 0.22em-tracked eyebrow style) for the LINK
              itself — epic #125's own done-when says no mono eyebrow
              survives under /dashboard, and this is a new control, not a
              pre-existing one left in place. `min-h-11` (44px) for the
              epic's touch-target rule on phone widths. */}
          <div className="border-line-2 rounded-[6px] border p-4">
            <span className="text-fg-mute mb-2 block text-xs tracking-wide uppercase">
              Enlace del cliente
            </span>
            <p className="text-fg-dim mb-2 font-mono text-xs break-all">
              alejoframes.com/galleries/{gallery.publicSlug}
            </p>
            <Link
              href={`/galleries/${gallery.publicSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg-dim hover:text-accent-2 inline-flex min-h-11 items-center gap-1 text-sm transition-colors lg:min-h-6"
            >
              Ver como la ve el cliente
              <span aria-hidden="true">↗</span>
              <span className="sr-only">(abre en una pestaña nueva)</span>
            </Link>
          </div>

          {/* The unlock audit trail (task #73) — who last unlocked this
              gallery's submitted selection, when, and their optional note.
              `unlockAudit` is all-null for a gallery that has never been
              unlocked, which is the common case, so this renders nothing
              at all rather than a "never unlocked" placeholder nobody
              needs to read. */}
          {unlockAudit?.unlockedAt && (
            <p className="text-fg-mute text-xs">
              Desbloqueada el {unlockAudit.unlockedAt.toLocaleDateString("es-CO")}
              {unlockAudit.unlockedByEmail ? ` por ${unlockAudit.unlockedByEmail}` : ""}
              {unlockAudit.unlockReason ? ` — "${unlockAudit.unlockReason}"` : ""}
            </p>
          )}
        </aside>
      </div>

      <SelectedPhotosList items={selectedPhotos} people={selectedPhotoPeople} />

      {/* Task #223 — only in `by-person` mode; see the component's own header
          for why offering this in `flat` mode would be asking for a decision
          with no effect. */}
      {gallery.selectionTrayMode === "by-person" && (
        <ExtrasPersonAssignment extras={extraPhotos} people={extraPeople} />
      )}

      <div className="mt-10">
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
