"use client";

import { useCallback, useState } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { GalleryForm } from "@/components/gallery-form";
import type { ClientForPicker } from "@/lib/clients";
import type { PackageForPicker } from "@/lib/packages";

// Task #131: the creation form used to occupy a permanent 360px column beside
// the gallery list (`lg:grid-cols-[1fr_360px]`). It now lives behind this
// trigger, which is what reclaims that width for the table.
//
// The form itself was MOVED, not rewritten (the ticket's own trap): this file
// changes WHERE <GalleryForm> renders and nothing about what it renders. The
// single thing it had to learn is that it is inside a dialog, and it learns it
// through one optional callback (`onCreated`) rather than a fork.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NOT A SINGLE `app-*` UTILITY BELOW THE TRIGGER. Verified, and
// it will bite #7 and #132-#134 the same way if it is not written down.
//
// <DialogContent> renders through <DialogPortal>, i.e. into `document.body`.
// `document.body` is OUTSIDE the dashboard shell, and the whole app-surface
// token layer is scoped to `[data-surface="app"]` on that shell's root element
// (src/app/dashboard/layout.tsx, and globals.css's block comment). So inside
// the portal `--app-text-base`, `--app-raised`, `--app-tap` and friends are
// simply not declared: `text-app-base` there compiles to
// `font-size: var(--app-text-base)`, which is invalid at computed-value time
// and paints NOTHING — the same silent failure mode task #175's ESLint rule
// exists to catch on the marketing site, except ESLint cannot see this one
// because this file matches `src/components/dashboard-*` and is allowed the
// prefix.
//
// Two ways out, and the second is deliberately not taken:
//   1. Use brand tokens inside the portal (--bg-2/--fg/--line-2 via
//      `bg-popover`, `text-fg`, `border-line-2`). Costs nothing here: the
//      form this dialog wraps is already built entirely out of brand tokens.
//   2. Put `data-surface="app"` on <DialogContent> to re-establish the scope
//      inside the portal. Rejected for now — globals.css states that the
//      attribute is set in ONE place, and quietly growing that to "one place
//      plus every portal" is a decision for a slice that actually needs app
//      density inside a dialog, taken on purpose and written down there.
// The TRIGGER is not portaled — it renders in the page head, inside the
// shell — so it does use the app scale.
// ---------------------------------------------------------------------------

export function DashboardGalleryCreateDialog({
  clients,
  packages,
}: {
  clients: ClientForPicker[];
  packages: PackageForPicker[];
}) {
  const [open, setOpen] = useState(false);
  // Stable identity so <GalleryForm>'s effect does not re-fire on every render
  // of a dialog that is already closed.
  const close = useCallback(() => setOpen(false), []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/*
        A plain trigger button styled to the mock's `.btn--primary`
        (design/system/dashboard.html:220-229): brass fill with #14100A ink —
        one of the five places brass is a FILL rather than a hover wash
        (globals.css's --color-accent-foreground comment lists them). Full
        width on a phone, auto from 600px up (dashboard.html:216-217, :473-475).

        Not <Button> from @/components/ui: this is the one control on the
        screen and it needs four overrides (height, radius, hover colour, full
        width) to reach the mock, at which point the primitive is carrying
        nothing. Epic #125's rule is that shadcn is adopted for the primitives
        that bring accessibility for free — Dialog, below, is exactly that; a
        button element already is one.

        `min-h-[var(--app-tap)]` is the 44px touch floor (dashboard.html:72,
        :222). Measured at 390px in this slice: 44px.
      */}
      <DialogTrigger className="bg-accent text-app-base hover:bg-accent-2 focus-visible:ring-accent inline-flex min-h-[var(--app-tap)] w-full items-center justify-center gap-[7px] rounded-[var(--app-radius-sm)] px-4 font-semibold text-[#14100A] transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--app-ground)] focus-visible:outline-none min-[600px]:w-auto">
        <Plus aria-hidden="true" className="size-4 shrink-0" />
        Nueva galería
      </DialogTrigger>

      <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-fg text-lg font-medium">Nueva galería</DialogTitle>
          {/* Task #100's ordering, said in the dialog that replaced the panel
              which used to say it. Copy from design/system/dashboard.html:766-769. */}
          <DialogDescription className="text-fg-dim">
            Podés armarla antes de tener el cliente cargado — la sesión pasa, los archivos salen de
            la tarjeta, y el cliente se agrega después.
          </DialogDescription>
        </DialogHeader>

        {/* Task #100 again, and it survives the move: this renders with ZERO
            clients in the studio. <GalleryForm> puts the "todavía no cargaste
            ningún cliente" guidance (and the link to /dashboard/clients)
            inside the client field itself. Nothing here may resurrect the
            "cargá un cliente primero" block the owner asked to remove. */}
        <GalleryForm clients={clients} packages={packages} onCreated={close} />
      </DialogContent>
    </Dialog>
  );
}
