"use client";

// The collaborative selection tray (task #95) — the owner's own request,
// verbatim in intent: "when a photo is selected it moves into a list at the
// TOP of the page, in the same thumbnail style as the grid, saying who chose
// it, in real time, so several clients can collaborate properly."
//
// Purely presentational. It computes nothing, fetches nothing, and owns no
// state: `<ProofGrid>` holds the single source of truth for the shared
// selection (seeded server-side, then converged on the server's own snapshot
// every tick — see that component's polling section) and hands this the
// already-decided list. Same discipline as <SelectionCounter>, and for the
// same reason: two components deriving "what is selected" independently is
// exactly the class of bug kanban #86 was.
//
// NO PRESENCE. The owner asked for attribution of PICKS, not "who is online"
// (task #95 is explicit). There is no viewer list here, no green dot, and
// nothing in the transport reports that a session merely has the page open.
//
// THUMBNAILS COME FROM THE GRID'S OWN PRESIGNED URL MAP, passed in as `urls`.
// This component never fetches an image URL and never sees an R2 key — R2
// objects stay private and there is exactly ONE way to obtain bytes for an
// asset, the one `<ProofGrid>` already owns. A pick whose asset is not in the
// map (an asset uploaded after this page was rendered, which an admin can do
// while a gallery is still `proofing`) renders as a labelled placeholder
// rather than a broken image: stale-but-honest, and it resolves itself the
// next time the client loads the page.
//
// ALWAYS VISIBLE, decided rather than defaulted. The tray renders even when
// nobody has picked anything yet, showing what it is for. Two reasons: the
// collaboration surface is the point of this screen and a client who never
// sees it before their first pick has no idea their partner's picks will
// appear there; and a tray that materialises on the first pick would shove
// the entire grid down the page at the exact moment the client is aiming at
// a thumbnail.
import {
  pickerLabelFor,
  type SelectionPick,
  UNATTRIBUTED_PICKER_LABEL,
} from "@/lib/selection-snapshot";

export function SelectionTray({
  picks,
  urls,
  filenamesByAssetId,
  viewerId,
  isLocked,
  isStale,
  onOpenAsset,
}: {
  /** The shared selection, oldest pick first — exactly what the server last
   * said, never a locally-derived list. */
  picks: SelectionPick[];
  /** `<ProofGrid>`'s own presigned URL map, keyed by asset id. Shared, not
   * copied, so a URL already refreshed by a grid tile is already refreshed
   * here. */
  urls: Record<string, string>;
  /** For the accessible label on each thumbnail. Same map the grid builds
   * from its server-rendered assets. */
  filenamesByAssetId: Record<string, string>;
  /** The signed-in user's own id, so their picks read "Vos" — see
   * `pickerLabelFor`. `null` is tolerated (nothing renders as "Vos") rather
   * than required, so this component stays renderable without a session in
   * tests. */
  viewerId: string | null;
  /** Whether the selection is closed. Mirrors `<ProofGrid>`'s `isLocked`,
   * which converges on the SERVER's gallery status every tick — the tray is
   * where a collaborator finds out that somebody else already submitted. */
  isLocked: boolean;
  /** Whether the live connection is currently failing. The tray keeps showing
   * the last snapshot it got and says so — stale-but-honest beats
   * silently-wrong, task #95's own acceptance criterion. */
  isStale: boolean;
  onOpenAsset: (assetId: string) => void;
}) {
  return (
    <section
      aria-label="Fotos elegidas"
      className="border-bg-2 mb-6 rounded-sm border p-4"
      // Announced politely: a pick landing from ANOTHER session is a change
      // the client did not cause, which is precisely the case a screen reader
      // user would otherwise never learn about. `polite`, not `assertive` —
      // it must not interrupt someone mid-navigation of the grid.
      aria-live="polite"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-serif text-lg">Fotos elegidas</h2>
        {isLocked ? (
          <p className="text-fg-mute text-xs">La selección ya fue enviada.</p>
        ) : (
          <p className="text-fg-mute text-xs">Se actualiza sola con lo que elijan los demás.</p>
        )}
      </div>

      {isStale && (
        // Never hides or clears the list — the picks below are the last thing
        // the server actually said, and saying "these may be out of date" is
        // strictly more useful than an empty box or a confident lie.
        <p className="mb-3 text-xs text-[#e0796b]">
          Se perdió la conexión: esta lista puede estar desactualizada.
        </p>
      )}

      {picks.length === 0 ? (
        <p className="text-fg-dim text-[15px] leading-relaxed">
          Todavía no eligieron ninguna foto. Las que elijan van a aparecer acá, con el nombre de
          quién las eligió.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-3">
          {picks.map((pick) => (
            <TrayItem
              key={pick.assetId}
              pick={pick}
              src={urls[pick.assetId]}
              originalFilename={filenamesByAssetId[pick.assetId]}
              viewerId={viewerId}
              onOpen={() => onOpenAsset(pick.assetId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TrayItem({
  pick,
  src,
  originalFilename,
  viewerId,
  onOpen,
}: {
  pick: SelectionPick;
  /** `undefined` when this pick's asset was not in the page's initial render
   * — see this file's header comment on why that is a real, honest state. */
  src: string | undefined;
  originalFilename: string | undefined;
  viewerId: string | null;
  onOpen: () => void;
}) {
  const label = pickerLabelFor(pick.pickedBy, viewerId);
  const filename = originalFilename ?? "una foto";

  return (
    <li className="w-24">
      <button
        type="button"
        onClick={onOpen}
        // Not "deselect": the tray is a view of the shared selection, and the
        // one control that changes it stays on the tile in the grid, where
        // it has been since task #24. Clicking here opens the lightbox — the
        // useful thing to do with "somebody picked this one" is look at it.
        aria-label={`Ver ${filename}, elegida por ${label}`}
        className="focus-visible:ring-accent block w-full rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
      >
        <div className="bg-bg-2 relative aspect-square overflow-hidden rounded-sm">
          {src === undefined ? (
            <span className="text-fg-mute absolute inset-0 flex items-center justify-center px-1 text-center text-[10px] leading-tight">
              Recargá para verla
            </span>
          ) : (
            // Plain <img>, not next/image — same reasoning as the grid's own
            // tiles: these are short-lived, private, presigned R2 URLs whose
            // query string is never stable between two loads.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
          )}
        </div>
        <p
          className={`mt-1 truncate text-[11px] ${
            label === UNATTRIBUTED_PICKER_LABEL ? "text-fg-mute italic" : "text-fg-dim"
          }`}
          title={label}
        >
          {label}
        </p>
      </button>
    </li>
  );
}
