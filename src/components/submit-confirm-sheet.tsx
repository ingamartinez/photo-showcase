"use client";

// The confirmation sheet between "Enviar" and the irreversible POST (task
// #268, S13). It replaces the native `window.confirm()` the panel used to
// open: the owner's mock has a real sheet (`design/system/client.html:840-872`),
// and the question it answers is no longer only "are you sure" but "what
// happens TO YOU" — the projection comes from the same `planCartClaim` the
// submit executes, so these rows cannot promise something the write will not
// do.
//
// Radix Dialog directly (`radix-ui`), not `@/components/ui/dialog`: the UI
// dialog is dressed for the dashboard's palette, while the client surface
// uses the mock's own tokens — the same precedent as `photo-viewer.tsx`.
//
// Mobile is a bottom sheet in the thumb zone; from `sm` it becomes a centred
// card. `sm` is 640px and the mock's breakpoint is 620px; `photo-viewer.tsx`
// already made that translation for this same surface.
import { useEffect, useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { formatCop } from "@/lib/format";
import type { SubmitProjection } from "@/lib/selection-snapshot";

/** Background scroll lock kept as this component's OWN guarantee rather than
 * delegated to the primitive: Radix's lock arrives through a sidecar that is
 * not loaded under JSDOM (same reason and shape as `photo-viewer.tsx`). */
function useScrollLock() {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);
}

function SheetBody({
  unsentCount,
  includedPhotos,
  projection,
  onConfirm,
  onOpenChange,
}: {
  unsentCount: number;
  includedPhotos: number;
  projection: SubmitProjection | null;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  useScrollLock();
  const cancelRef = useRef<HTMLButtonElement>(null);

  const photos = unsentCount === 1 ? "1 foto" : `${unsentCount} fotos`;
  const title = unsentCount === 1 ? "¿Envías esta foto?" : `¿Envías estas ${unsentCount}?`;

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[rgba(7,7,9,0.62)]" />
      <DialogPrimitive.Content
        // INITIAL FOCUS IS THE WAY OUT (task #268). Enter on the trigger must
        // never land on the irreversible button; Radix has already focused
        // the first focusable control by the time this fires, so it is
        // redirected rather than left alone.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        className="bg-bg-2 border-line-2 fixed inset-x-0 bottom-0 z-50 rounded-t-[14px] border-t px-4 pt-6 pb-[calc(24px+env(safe-area-inset-bottom,0px))] outline-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:w-[calc(100%-48px)] sm:max-w-[460px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[10px] sm:border sm:pb-6"
      >
        <span className="text-fg-mute font-mono text-[11px] tracking-[0.16em] uppercase">
          Antes de enviar
        </span>
        <DialogPrimitive.Title className="text-fg mt-2 font-serif text-[26px] leading-tight font-normal">
          {title}
        </DialogPrimitive.Title>

        <dl className="mt-4 grid gap-[9px] text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-fg-mute">Vas a enviar</dt>
            <dd className="text-fg tabular-nums">{photos}</dd>
          </div>
          {projection && (
            <>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-mute">Pasan a tu nombre</dt>
                <dd className="text-fg tabular-nums">{projection.passToYou}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-mute">Ya las pidió otra persona</dt>
                <dd className="text-fg tabular-nums">{projection.alreadyRequested}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-fg-mute">
                  Extra sobre las {includedPhotos} incluidas, al enviar
                </dt>
                <dd className="text-accent-2 tabular-nums">
                  {projection.after.extras} × {formatCop(projection.extraUnitPriceCop)} ={" "}
                  {formatCop(projection.after.extrasSurchargeCop)}
                </dd>
              </div>
              {projection.after.originals > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-fg-mute">Originales, al enviar</dt>
                  <dd className="text-fg tabular-nums">
                    {projection.after.originals}{" "}
                    {projection.after.originals === 1 ? "original" : "originales"} ·{" "}
                    {formatCop(projection.after.originalsSurchargeCop)}
                  </dd>
                </div>
              )}
              {projection.after.originals > 0 && projection.after.extras > 0 && (
                <div className="flex justify-between gap-4">
                  <dt className="text-fg-mute">Total, al enviar</dt>
                  <dd className="text-accent-2 tabular-nums">
                    {formatCop(projection.after.surchargeCop)}
                  </dd>
                </div>
              )}
            </>
          )}
        </dl>

        <DialogPrimitive.Description className="border-accent mt-[22px] border-l-2 pl-[15px]">
          <p className="text-fg-dim text-sm">
            <b className="text-accent-2 font-medium">Lo que envíes ya no lo puedes sacar tú.</b> Si
            te arrepientes, escríbele a tu fotógrafo.
          </p>
          <p className="text-fg-dim mt-2 text-sm">
            Puedes seguir eligiendo y enviar más después. Si alguien envía la misma antes que tú,
            queda a su nombre. Cuando todos hayan enviado y no quede nada por enviar, la selección
            se cierra sola.
          </p>
        </DialogPrimitive.Description>

        <div className="mt-6 grid gap-[10px] sm:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
            className="border-accent bg-accent hover:border-accent-2 hover:bg-accent-2 text-ink inline-flex min-h-12 items-center justify-center rounded-[3px] border px-5 text-sm font-semibold tracking-[0.02em] transition-colors"
          >
            {unsentCount === 1 ? "Sí, enviar la foto" : `Sí, enviar las ${unsentCount}`}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onOpenChange(false)}
            className="border-line-2 text-fg hover:border-accent hover:text-accent-2 inline-flex min-h-12 items-center justify-center rounded-[3px] border px-5 text-sm tracking-[0.02em] transition-colors"
          >
            Seguir eligiendo
          </button>
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SubmitConfirmSheet({
  open,
  onOpenChange,
  unsentCount,
  includedPhotos,
  projection,
  onConfirm,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unsentCount: number;
  /** `quota.includedPhotosSnapshot` — the frozen customer terms. */
  includedPhotos: number;
  /** The viewer's own projection. `null` only when nobody is the subject, in
   * which case the panel renders no trigger at all (defensive). */
  projection: SubmitProjection | null;
  onConfirm: () => void;
  /** The existing "Enviar las N" button. `<Trigger asChild>` means Radix
   * returns focus to it on close, and a disabled trigger never opens. */
  trigger: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      {/* Mounted only while open, so the scroll lock exists exactly as long as
          the sheet does. */}
      {open && (
        <SheetBody
          unsentCount={unsentCount}
          includedPhotos={includedPhotos}
          projection={projection}
          onConfirm={onConfirm}
          onOpenChange={onOpenChange}
        />
      )}
    </DialogPrimitive.Root>
  );
}
