"use client";

// Task #214 — the admin control for the per-gallery switch that gates
// whether the client's own gallery renders task #206's type control at all
// (proof-tile.tsx's own gate, `isSelected && !isLocked &&
// allowsOriginalSelection`). Lives in the SAME "Paquete" card as
// <EditGalleryTermsDialog>, right after it (dashboard page.tsx), NOT beside
// <SelectionTrayModeControl>'s own layout card further down — the owner's
// own framing (kanban #214) is explicit that this is not presentation like
// the tray layout, it decides whether a client can even SEE the cheaper
// "original" tariff, so it belongs with the commercial terms.
//
// TURNING IT ON has no side effect worth a dialog over — nothing is reset,
// nothing changes for any asset already picked, so this renders a single
// plain form with no confirmation, same "this is not ceremony-worthy"
// judgment `SelectionTrayModeControl`'s own header comment makes for its own
// single `<select>`.
//
// TURNING IT OFF is the one branch with a real side effect, and it is the
// owner's own explicit decision (task #214's kanban body, 2026-08-01): every
// asset still marked `selectionKind: "original"` resets to `"edited"`, in
// the SAME transaction as the flag flip (`updateAllowsOriginalSelection`,
// actions.ts). The confirmation dialog below is UX, not the gate — the
// server performs the reset unconditionally either way — but showing the
// admin a before/after preview FIRST is the owner's own stated requirement
// ("3 fotos vuelven a editada · el recargo baja de $ 16.000 a $ 10.000"),
// mirroring the SAME before/after shape <EditGalleryTermsDialog> already
// uses for the identical reason: a money-affecting change should not apply
// silently.
//
// NO DIALOG AT ALL when there is nothing to reset (`selectedOriginalCount`
// is 0) — an admin turning off a switch nobody has used yet does not need a
// preview of a reset that changes zero assets; the plain form submits
// directly, same as turning it on.
import { useActionState, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  updateAllowsOriginalSelection,
  type UpdateAllowsOriginalSelectionState,
} from "@/app/dashboard/galleries/actions";
import { formatCop } from "@/lib/format";
import { computeQuota } from "@/lib/quota";

const initialState: UpdateAllowsOriginalSelectionState = { status: "idle" };

export function AllowsOriginalSelectionControl({
  galleryId,
  allowsOriginalSelection,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
  originalPhotoPriceCopSnapshot,
  // The SAME split the page already derived from `gallery.assets`
  // (page.tsx's own `selectedEditedCount`/`selectedOriginalCount`, task
  // #210's precedent) — never recomputed here. This component never counts
  // assets itself.
  selectedEditedCount,
  selectedOriginalCount,
}: {
  galleryId: string;
  allowsOriginalSelection: boolean;
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  originalPhotoPriceCopSnapshot: number;
  selectedEditedCount: number;
  selectedOriginalCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateAllowsOriginalSelection, initialState);

  // Turning OFF while there is at least one real `original` pick is the
  // ONLY case that needs the confirmation dialog — see this file's header
  // comment. Turning ON, or turning OFF with nothing to reset, submits the
  // plain form directly.
  const needsConfirmation = allowsOriginalSelection && selectedOriginalCount > 0;

  // BOTH rows come from `computeQuota()` (src/lib/quota.ts), the SAME
  // pattern <EditGalleryTermsDialog> uses and for the identical reason: this
  // component never subtracts or multiplies anything itself. `before` is the
  // gallery's REAL current split; `after` simulates the reset the server is
  // about to apply — every original pick becomes an edited one, so the
  // edited count absorbs it and originals drops to 0.
  const before = computeQuota(selectedEditedCount, selectedOriginalCount, {
    includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot,
  });
  const after = computeQuota(selectedEditedCount + selectedOriginalCount, 0, {
    includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot,
  });

  const statusMessage =
    state.status === "error" ? (
      <p role="alert" className="text-sm text-[#e0796b]">
        {state.message}
      </p>
    ) : state.status === "updated" ? (
      <p role="status" className="text-accent-2 text-sm">
        Actualizado.
      </p>
    ) : null;

  if (!allowsOriginalSelection) {
    return (
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="galleryId" value={galleryId} />
        <input type="hidden" name="allowsOriginalSelection" value="true" />
        <span className="text-fg-mute text-xs tracking-wide uppercase">
          Selección de originales
        </span>
        <p className="text-fg-dim text-xs">
          Apagado — el cliente no puede elegir fotos originales, todas las adicionales son editadas.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 w-fit items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
        >
          {pending ? "Guardando…" : "Habilitar selección de originales"}
        </button>
        {statusMessage}
      </form>
    );
  }

  if (!needsConfirmation) {
    return (
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="galleryId" value={galleryId} />
        <input type="hidden" name="allowsOriginalSelection" value="false" />
        <span className="text-fg-mute text-xs tracking-wide uppercase">
          Selección de originales
        </span>
        <p className="text-fg-dim text-xs">
          Prendido — el cliente puede elegir, foto por foto, si quiere editada u original.
        </p>
        <button
          type="submit"
          disabled={pending}
          className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 w-fit items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
        >
          {pending ? "Guardando…" : "Deshabilitar selección de originales"}
        </button>
        {statusMessage}
      </form>
    );
  }

  // `needsConfirmation` is true here: at least one real `original` pick
  // exists, so turning the switch off resets it — the before/after preview
  // the owner's own decision requires.
  return (
    <div className="flex flex-col gap-2">
      <span className="text-fg-mute text-xs tracking-wide uppercase">Selección de originales</span>
      <p className="text-fg-dim text-xs">
        Prendido — el cliente puede elegir, foto por foto, si quiere editada u original.
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 w-fit items-center justify-center rounded-[5px] border px-4 text-sm transition-colors lg:min-h-6">
          Deshabilitar selección de originales
        </DialogTrigger>

        <DialogContent className="border-line-2 gap-5 border sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-fg text-lg font-medium">
              ¿Apagar la selección de originales?
            </DialogTitle>
            <DialogDescription className="text-fg-dim">
              {selectedOriginalCount} foto{selectedOriginalCount === 1 ? "" : "s"} original
              {selectedOriginalCount === 1 ? "" : "es"} ya elegida
              {selectedOriginalCount === 1 ? "" : "s"} vuelve
              {selectedOriginalCount === 1 ? "" : "n"} a editada
              {selectedOriginalCount === 1 ? "" : "s"} — recién al confirmar, no antes.
            </DialogDescription>
          </DialogHeader>

          {/* The exact before/after shape the owner asked for, textual: "N
              fotos vuelven a editada · el recargo baja de $ X a $ Y" — same
              `computeQuota`-only-reads discipline <EditGalleryTermsDialog>
              already follows. */}
          <div className="border-line-2 rounded-[6px] border p-3 text-sm">
            <p className="text-fg-dim">
              Hoy: {before.selectedEdited} editada{before.selectedEdited === 1 ? "" : "s"} ·{" "}
              {before.selectedOriginal} original{before.selectedOriginal === 1 ? "" : "es"} ·
              recargo {formatCop(before.surchargeCop)}
            </p>
            <p className="text-fg mt-1">
              Al confirmar: {after.selectedEdited} editada{after.selectedEdited === 1 ? "" : "s"} ·
              0 originales · recargo {formatCop(after.surchargeCop)}
            </p>
          </div>

          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="galleryId" value={galleryId} />
            <input type="hidden" name="allowsOriginalSelection" value="false" />
            <button
              type="submit"
              disabled={pending}
              className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Guardando…" : "Confirmar y apagar"}
            </button>
            {statusMessage}
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
