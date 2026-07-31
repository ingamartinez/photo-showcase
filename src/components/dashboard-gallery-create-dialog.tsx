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

/** Announced when a gallery is created, from OUTSIDE the dialog. Deliberately
 * not the string <GalleryForm> renders inside itself ("Galería creada."), so
 * the two are never ambiguous to a query — and because out here there is a
 * second, useful thing to say: the list behind the dialog already has the row
 * (`createGallery` calls `revalidatePath("/dashboard/galleries")`). */
const CREATED_NOTICE = "Galería creada. Ya aparece en la lista.";

export function DashboardGalleryCreateDialog({
  clients,
  packages,
}: {
  clients: ClientForPicker[];
  packages: PackageForPicker[];
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");

  // Stable identities so <GalleryForm>'s effect does not re-fire on every
  // render of a dialog that is already closed.
  const handleCreated = useCallback(() => {
    setNotice(CREATED_NOTICE);
    setOpen(false);
  }, []);
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    // Cleared on OPEN, never on close. A live region only announces when its
    // text CHANGES, so two identical successes in a row would be one
    // announcement and one silent no-op; clearing here guarantees every
    // creation is a "" -> text transition. Clearing on CLOSE instead would
    // wipe the announcement in the same commit that made it.
    if (next) setNotice("");
  }, []);

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
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
        :222). Measured in a browser at 320/390/768/1024/1280px: 44px at all
        five, full-bleed below 600px and 146.8px above it.

        No focus styling here on purpose — globals.css:472-474 already gives
        every focusable element the mock's own 2px brass outline
        (dashboard.html:113). An outline is not the "brass as a hover/focus
        wash" the epic forbids, and re-declaring it per control is how two
        focus rings end up disagreeing.
      */}
        <DialogTrigger className="bg-accent text-app-base hover:bg-accent-2 inline-flex min-h-[var(--app-tap)] w-full items-center justify-center gap-[7px] rounded-[var(--app-radius-sm)] px-4 font-semibold text-[#14100A] transition-colors min-[600px]:w-auto">
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          Nueva galería
        </DialogTrigger>

        <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-fg text-lg font-medium">Nueva galería</DialogTitle>
            {/* Task #100's ordering, said in the dialog that replaced the panel
              which used to say it. Copy from design/system/dashboard.html:766-769. */}
            <DialogDescription className="text-fg-dim">
              Podés armarla antes de tener el cliente cargado — la sesión pasa, los archivos salen
              de la tarjeta, y el cliente se agrega después.
            </DialogDescription>
          </DialogHeader>

          {/* Task #100 again, and it survives the move: this renders with ZERO
            clients in the studio. <GalleryForm> puts the "todavía no cargaste
            ningún cliente" guidance (and the link to /dashboard/clients)
            inside the client field itself. Nothing here may resurrect the
            "cargá un cliente primero" block the owner asked to remove. */}
          <GalleryForm clients={clients} packages={packages} onCreated={handleCreated} />
        </DialogContent>
      </Dialog>

      {/*
        THE CONFIRMATION LIVES OUT HERE, AND THAT IS THE WHOLE POINT.

        <GalleryForm> renders its own `role="status"` "Galería creada." inside
        the form. Inside a dialog that closes on success, that paragraph mounts
        and unmounts in the same frame — Radix unmounts the portal's children —
        so a screen-reader user submitted the form and got nothing back. Review
        of #131 caught it; it is the exact failure mode this slice's own thesis
        (task #75: the accessible signal has to survive the redesign) exists to
        refuse, and #7 reuses this component's shape, so it gets fixed at the
        pattern rather than at the instance.

        Two properties make this work, and BOTH are load-bearing:

        1. IT IS OUTSIDE <Dialog>. `<Dialog>` (Radix's Root) renders no DOM of
           its own, but <DialogContent> renders through a portal into
           `document.body`. Anything inside it dies with the dialog. This
           element is a sibling of the whole Dialog, in the page tree, so
           closing cannot take the announcement with it.

        2. IT IS ALWAYS MOUNTED, EMPTY WHEN THERE IS NOTHING TO SAY. A live
           region has to be in the accessibility tree BEFORE its text changes:
           inserting a `role="status"` node and its content in one commit is
           the classic way to ship a live region that never announces. So this
           <p> is unconditional and only its text content varies. Do not
           "tidy" it into `{notice && <p …>}` — that is the bug, not the
           cleanup, and dashboard-gallery-create-dialog.test.tsx fails if
           anyone does.

        `sr-only` rather than visible, on purpose. The sighted confirmation is
        the row itself: `createGallery` revalidates /dashboard/galleries, so
        the new gallery is at the top of the list the moment the dialog is out
        of the way (it sorts by recency of activity — see @/lib/galleries).
        This is the same fact in the channel that cannot see it. A visible
        toast would be a second, dismissible source of truth for something the
        list already states, and the mock has none
        (design/system/dashboard.html has no notification surface).
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
    </>
  );
}
