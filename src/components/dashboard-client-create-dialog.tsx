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
import { ClientForm } from "@/components/client-form";

// Task #132: the creation form used to occupy a permanent 360px column beside
// the clients list (`lg:grid-cols-[1fr_360px]`). It now lives behind this
// trigger, which is what reclaims that width for the table — same move task
// #131 made for <GalleryForm>, and this file is that one's shape, not a
// reinvention of it. Read dashboard-gallery-create-dialog.tsx's own header
// comment for the two facts every dialog on this surface leans on; restated
// here only where THIS file's own code depends on them.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NOT A SINGLE `app-*` UTILITY BELOW THE TRIGGER.
//
// <DialogContent> renders through <DialogPortal>, i.e. into `document.body`.
// `document.body` is OUTSIDE the dashboard shell, and the whole app-surface
// token layer is scoped to `[data-surface="app"]` on that shell's root element
// (src/app/dashboard/layout.tsx, and globals.css's block comment). So inside
// the portal `--app-text-base`, `--app-raised`, `--app-tap` and friends are
// simply not declared: `text-app-base` there compiles to
// `font-size: var(--app-text-base)`, which is invalid at computed-value time
// and paints NOTHING — and ESLint cannot see this one because this file
// matches `src/components/dashboard-*` and is allowed the `app-*` prefix.
// This form is built entirely out of BRAND tokens already (see
// client-form.tsx), so the fix costs nothing: use `text-fg` / `border-line-2`
// / `bg-popover` inside the portal, and reserve `app-*` for the TRIGGER, which
// is not portaled — it renders in the page head, inside the shell.
// ---------------------------------------------------------------------------

/** Announced when a client is created, from OUTSIDE the dialog. Deliberately
 * not the string <ClientForm> renders inside itself ("Cliente agregado."), so
 * the two are never ambiguous to a query — and because out here there is a
 * second, useful thing to say: the list behind the dialog already has the row
 * (`createClient` calls `revalidatePath("/dashboard/clients")`). */
const CREATED_NOTICE = "Cliente agregado. Ya aparece en la lista.";

export function DashboardClientCreateDialog() {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");

  // Stable identities so <ClientForm>'s effect does not re-fire on every
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
        (design/system/dashboard.html:220-229 / :865): brass fill with #14100A
        ink — one of the five places brass is a FILL rather than a hover wash
        (globals.css's --color-accent-foreground comment lists them). Full
        width on a phone, auto from 600px up.

        Not <Button> from @/components/ui: this is the one control on the
        screen and it needs the same four overrides
        <DashboardGalleryCreateDialog> already pays for. `min-h-[var(--app-tap)]`
        is the 44px touch floor. No focus styling here on purpose —
        globals.css:472-474 already gives every focusable element the mock's
        own 2px brass outline.
      */}
        <DialogTrigger className="bg-accent text-app-base hover:bg-accent-2 inline-flex min-h-[var(--app-tap)] w-full items-center justify-center gap-[7px] rounded-[var(--app-radius-sm)] px-4 font-semibold text-[#14100A] transition-colors min-[600px]:w-auto">
          <Plus aria-hidden="true" className="size-4 shrink-0" />
          Nuevo cliente
        </DialogTrigger>

        <DialogContent className="border-line-2 max-h-[85vh] gap-5 overflow-y-auto border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-fg text-lg font-medium">Nuevo cliente</DialogTitle>
            <DialogDescription className="text-fg-dim">
              El correo es la identidad del cliente (PLAN.md §4) — con ese mismo correo va a iniciar
              sesión cuando le publiques una galería.
            </DialogDescription>
          </DialogHeader>

          <ClientForm onCreated={handleCreated} />
        </DialogContent>
      </Dialog>

      {/*
        THE CONFIRMATION LIVES OUT HERE, AND THAT IS THE WHOLE POINT.

        <ClientForm> renders its own `role="status"` "Cliente agregado." inside
        the form. Inside a dialog that closes on success, that paragraph mounts
        and unmounts in the same frame — Radix unmounts the portal's children —
        so a screen-reader user submitted the form and got nothing back. The
        exact failure mode #131's review caught for <GalleryForm>; fixed at the
        pattern there, reused here rather than re-discovered.

        Two properties make this work, and BOTH are load-bearing:

        1. IT IS OUTSIDE <Dialog>. <DialogContent> renders through a portal
           into `document.body`. Anything inside it dies with the dialog. This
           element is a sibling of the whole Dialog, in the page tree, so
           closing cannot take the announcement with it.

        2. IT IS ALWAYS MOUNTED, EMPTY WHEN THERE IS NOTHING TO SAY. A live
           region has to be in the accessibility tree BEFORE its text changes:
           inserting a `role="status"` node and its content in one commit is
           the classic way to ship a live region that never announces. So this
           <p> is unconditional and only its text content varies. Do not
           "tidy" it into `{notice && <p …>}` — that is the bug, not the
           cleanup.

        `sr-only` rather than visible, on purpose. The sighted confirmation is
        the row itself: `createClient` revalidates /dashboard/clients, so the
        new client is at the top of the list the moment the dialog is out of
        the way (it sorts by recency, newest first — see @/lib/clients). This
        is the same fact in the channel that cannot see it.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
    </>
  );
}
