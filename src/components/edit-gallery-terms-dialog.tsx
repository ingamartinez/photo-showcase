"use client";

// Task #200 — the admin control for editing an EXISTING gallery's commercial
// terms. Follows the same trigger-behind-a-dialog shape
// dashboard-gallery-create-dialog.tsx already established (see that file's
// own "WHY THERE IS NOT A SINGLE `app-*` UTILITY BELOW THE TRIGGER" — the
// SAME reasoning applies here: <DialogContent> portals to `document.body`,
// outside `[data-surface="app"]`, so this file stays on brand tokens and
// literal Tailwind values, never `app-*`).
//
// UNLIKE that dialog, this one does NOT auto-close on success. Two owner
// decisions this task made (see actions.ts's own header comment on
// `updateGalleryTerms` for the fuller record) make the "close + announce
// outside the portal" trap that dialog's own review caught moot here:
//
//   - There is no state gate, so there is no "the button disappears once
//     this succeeds" transition to protect an announcement across.
//   - The success message ("Términos actualizados.") renders INSIDE the
//     still-open dialog, in the same DOM node the rest of the form already
//     occupies — a screen reader reading the form has it in the same place
//     it was already focused, not torn out from under it. The admin closes
//     manually (Escape, the overlay, or <DialogContent>'s own × button).
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
  updateGalleryTerms,
  type UpdateGalleryTermsState,
} from "@/app/dashboard/galleries/actions";
import { formatCop } from "@/lib/format";
import { computeQuota } from "@/lib/quota";
import type { Gallery } from "@/lib/db/schema";

const initialState: UpdateGalleryTermsState = { status: "idle" };

// Same literal stand-ins as gallery-form.tsx's own `inputClass` — this form
// renders through the identical portal, outside `[data-surface="app"]`, for
// the identical reason (see this file's own header comment above).
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

export function EditGalleryTermsDialog({
  galleryId,
  status,
  includedPhotosSnapshot,
  extraPhotoPriceCopSnapshot,
  originalPhotoPriceCopSnapshot,
  // `count(assets where is_selected)` — the SAME number the page already
  // derived for the "Seleccionadas" row (page.tsx's own `selectedCount`),
  // passed straight through rather than recomputed here. This component
  // never counts assets itself.
  //
  // Task #205 — this stays a single total, not split into edited/original
  // counts: nothing in this slice writes `assets.selectionKind` to anything
  // but `edited` (task #206 is the slice that would let a client pick
  // `original`), so every selected asset a gallery can have today IS an
  // edited pick. Passed to `computeQuota` below as the edited count with 0
  // originals — the same "0 originals" invariant `use-shared-selection.ts`
  // and the selection routes all currently hold.
  selectedCount,
}: {
  galleryId: string;
  status: Gallery["status"];
  includedPhotosSnapshot: number;
  extraPhotoPriceCopSnapshot: number;
  originalPhotoPriceCopSnapshot: number;
  selectedCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateGalleryTerms, initialState);

  // Controlled, not `defaultValue`: the before/after preview below has to
  // react to every keystroke, not only to what was last submitted. Reset
  // from the gallery's own CURRENT effective snapshot every time the dialog
  // opens — never left showing a previous session's typed-but-abandoned
  // values.
  const [includedPhotosInput, setIncludedPhotosInput] = useState(String(includedPhotosSnapshot));
  const [extraPhotoPriceInput, setExtraPhotoPriceInput] = useState(
    String(extraPhotoPriceCopSnapshot),
  );
  const [originalPhotoPriceInput, setOriginalPhotoPriceInput] = useState(
    String(originalPhotoPriceCopSnapshot),
  );

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setIncludedPhotosInput(String(includedPhotosSnapshot));
      setExtraPhotoPriceInput(String(extraPhotoPriceCopSnapshot));
      setOriginalPhotoPriceInput(String(originalPhotoPriceCopSnapshot));
    }
  }

  // Task #200's own criterion 8: the notice only makes sense once a client
  // MAY already have seen these terms. `draft` is the one status with no
  // client-facing view of this gallery at all (src/lib/galleries.ts's
  // `isGalleryVisibleToClient`) — nothing has been shown to anyone yet, so
  // there is nothing to warn about changing.
  const showBeforeAfter = status !== "draft";

  // Mirrors `requiredNonNegativeInt`'s own validation shape (actions.ts) —
  // this is a UI preview gate, not a substitute for that schema. An input
  // mid-edit (empty, negative, or a stray decimal) simply suppresses the
  // "Va a ver" row rather than showing a preview built from a value the
  // server would reject anyway.
  const parsedIncludedPhotos = Number(includedPhotosInput);
  const parsedExtraPhotoPrice = Number(extraPhotoPriceInput);
  const parsedOriginalPhotoPrice = Number(originalPhotoPriceInput);
  const hasValidPreviewInputs =
    includedPhotosInput.trim() !== "" &&
    extraPhotoPriceInput.trim() !== "" &&
    originalPhotoPriceInput.trim() !== "" &&
    Number.isInteger(parsedIncludedPhotos) &&
    parsedIncludedPhotos >= 0 &&
    Number.isInteger(parsedExtraPhotoPrice) &&
    parsedExtraPhotoPrice >= 0 &&
    Number.isInteger(parsedOriginalPhotoPrice) &&
    parsedOriginalPhotoPrice >= 0;

  // BOTH rows come from `computeQuota()` (src/lib/quota.ts) — the ONE place
  // this app's quota maths lives. This component never subtracts or
  // multiplies anything itself: if it did, it could drift from what
  // `/galleries/[publicSlug]` actually shows the client, which is the only
  // number that matters here.
  //
  // `selectedCount` is passed as the edited count with 0 originals — see
  // this component's own prop comment above for why. `originalPhotoPriceCopSnapshot`
  // still flows through `computeQuota` and back out on `before`/`after` (it's
  // a passthrough field on `QuotaResult`), which is what lets the preview
  // below show the NEW original price without this component doing its own
  // arithmetic.
  const before = computeQuota(selectedCount, 0, {
    includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot,
    originalPhotoPriceCopSnapshot,
  });
  const after = hasValidPreviewInputs
    ? computeQuota(selectedCount, 0, {
        includedPhotosSnapshot: parsedIncludedPhotos,
        extraPhotoPriceCopSnapshot: parsedExtraPhotoPrice,
        originalPhotoPriceCopSnapshot: parsedOriginalPhotoPrice,
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger className="text-fg-dim hover:text-accent-2 text-xs underline transition-colors">
        Editar términos
      </DialogTrigger>

      <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-fg text-lg font-medium">Editar términos</DialogTitle>
          <DialogDescription className="text-fg-dim">
            Se guardan al instante, en cualquier estado de la galería. La app no le avisa al cliente
            — coordinalo por fuera.
          </DialogDescription>
        </DialogHeader>

        <form action={formAction} className="flex flex-col gap-5">
          <input type="hidden" name="galleryId" value={galleryId} />

          <div className="flex flex-col gap-2">
            <label
              htmlFor="edit-terms-included-photos"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Fotos incluidas
            </label>
            <input
              id="edit-terms-included-photos"
              name="includedPhotos"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              required
              value={includedPhotosInput}
              onChange={(event) => setIncludedPhotosInput(event.target.value)}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "edit-terms-error" : undefined}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="edit-terms-extra-photo-price"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Precio foto extra, COP
            </label>
            <input
              id="edit-terms-extra-photo-price"
              name="extraPhotoPriceCop"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              required
              value={extraPhotoPriceInput}
              onChange={(event) => setExtraPhotoPriceInput(event.target.value)}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "edit-terms-error" : undefined}
              className={inputClass}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label
              htmlFor="edit-terms-original-photo-price"
              className="text-fg-mute text-xs tracking-wide uppercase"
            >
              Precio foto original, COP
            </label>
            <input
              id="edit-terms-original-photo-price"
              name="originalPhotoPriceCop"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              required
              value={originalPhotoPriceInput}
              onChange={(event) => setOriginalPhotoPriceInput(event.target.value)}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "edit-terms-error" : undefined}
              className={inputClass}
            />
          </div>

          {showBeforeAfter && (
            <div className="border-line-2 rounded-[6px] border p-3 text-sm">
              <p className="text-fg-mute mb-2 text-xs tracking-wide uppercase">
                Esta galería ya salió de borrador
              </p>
              {/* Unconditional once `showBeforeAfter` is true: this row
                  describes the gallery's CURRENT, already-saved terms, so it
                  never depends on whatever is mid-typed below it.

                  Task #205 review finding: this used to append
                  "· original $X" to this SAME sentence, which reads as
                  "the client sees this today" — untrue. No client sees
                  anything about the original-photo price until task #206
                  lets them actually pick one; today `originalPhotoPriceCopSnapshot`
                  only ever multiplies against 0 originals. The original price
                  gets its OWN sentence below, worded as what it IS (the
                  currently-saved price, an admin-only fact) rather than as
                  something the client is shown. */}
              <p className="text-fg-dim">
                El cliente ve hoy: {before.includedPhotosSnapshot} incluidas · {before.extras}{" "}
                extras · {formatCop(before.surchargeCop)}
              </p>
              <p className="text-fg-dim">
                Precio foto original vigente: {formatCop(before.originalPhotoPriceCopSnapshot)} — el
                cliente todavía no lo ve.
              </p>
              {/* Conditional on `after` being a valid parse of what is
                  CURRENTLY typed — an empty or malformed field mid-edit
                  hides this row rather than showing a preview built from a
                  value the server would reject anyway (see
                  `hasValidPreviewInputs` above). */}
              {after && (
                <>
                  <p className="text-fg mt-1">
                    Va a ver: {after.includedPhotosSnapshot} incluidas · {after.extras} extras ·{" "}
                    {formatCop(after.surchargeCop)}
                  </p>
                  <p className="text-fg mt-1">
                    Nuevo precio foto original: {formatCop(after.originalPhotoPriceCopSnapshot)} —
                    el cliente todavía no lo ve.
                  </p>
                </>
              )}
            </div>
          )}

          {state.status === "error" && (
            <p id="edit-terms-error" role="alert" className="text-sm text-[#e0796b]">
              {state.message}
            </p>
          )}
          {state.status === "updated" && (
            <p role="status" className="text-accent-2 text-sm">
              Términos actualizados.
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Guardando…" : "Guardar términos"}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
