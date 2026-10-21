"use client";

// TASK #279 — the per-row "⋯" menu on the clients list.
//
// Pattern: src/components/gallery-client-row.tsx (the epic's mandated row-menu
// shape — a 44px trigger with `aria-label="Acciones para <nombre>"`, Radix
// building `aria-expanded`). One trigger per row, every action as a full-width
// menu row, never a second small button.
//
// THIS COMPONENT IS THE EXTENSION POINT FOR TASK #280 (delete client). Its
// "Eliminar" item lives in the single <DropdownMenuContent> below, next to
// "Editar", with `onSelect` flipping its own state; its confirmation, its own
// `useTransition` and its blocked message are the pieces task #280 added.
// Keep new actions' `pending` flags separate — one action's spinner must never
// disable another's item.
//
// It is a SIBLING of the <DropdownMenu>, never nested inside
// <DropdownMenuContent>: nesting a dialog in a menu's content is the known
// Radix stuck-`pointer-events` / lost-focus setup.
//
// ROOT-SHAPE NOTE (task #280). This component returns a FRAGMENT, not the one
// root element task #279 pinned: the blocked message has to be a DIRECT child
// of the row's <li>, because that <li> is a CSS grid and a message nested in a
// ~44px menu cell would be squeezed into a column instead of reading across the
// row. `col-span-full` is what puts it on its own full-width line below the
// cells at every breakpoint. The fragment therefore has ONE child in the normal
// case (the cell itself) and TWO only while a blocked message is on screen; the
// "one root" invariant is preserved in the only sense that mattered — the row
// never gains a stray grid child it did not mean to.
//
// The rest of this file's layout is layout-only (no chrome of its own): at the
// phone and 600px breakpoints the row's last grid area `more` holds the
// trigger; at >=1024px the row auto-places its children, so this component is
// just the last cell of the five the desk row has.
import { useCallback, useRef, useState, useTransition } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditClientDialog, type EditableClient } from "@/components/edit-client-dialog";
import { deleteClient } from "@/app/dashboard/clients/actions";

/** Announced after a successful edit, from OUTSIDE the dialog — the dialog
 * itself closes on success, so anything rendered inside it would unmount in
 * the same frame and a screen-reader user would hear nothing. */
const UPDATED_NOTICE = "Cliente actualizado.";

export function ClientRowActions({ client }: { client: EditableClient }) {
  const [editOpen, setEditOpen] = useState(false);
  const [notice, setNotice] = useState("");
  // Its OWN transition, never one shared with the edit dialog:
  // gallery-client-row.tsx:43-50 records why a shared pending flag is a bug
  // (one action's spinner disables the other's item and reads as "still
  // saving" when nothing is in flight).
  const [deletePending, startDelete] = useTransition();
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Every open and every close goes through here — the menu item, Radix's own
  // dismiss, and the success close. There is no second `setEditOpen` call
  // anywhere in this file, which is the invariant the clearing below depends
  // on (review round 1 caught a direct `setEditOpen(true)` from the menu item).
  const handleOpenChange = useCallback((next: boolean) => {
    setEditOpen(next);
    // Cleared on OPEN, never on close: a live region only announces when its
    // text CHANGES, so two identical successes in a row would otherwise be one
    // announcement and one silent no-op. Clearing on close would wipe the
    // announcement in the same commit that made it (same reasoning as
    // dashboard-client-create-dialog.tsx).
    if (next) setNotice("");
  }, []);

  const handleUpdated = useCallback(() => {
    setNotice(UPDATED_NOTICE);
    // Closing goes through the same handler as every other open-state write,
    // so there is exactly ONE place that can move the dialog's `open`. It does
    // not clear here: this handler only clears on OPEN.
    handleOpenChange(false);
  }, [handleOpenChange]);

  // Delete: `window.confirm`, which is this repo's destructive-confirmation
  // precedent (flash-gallery-controls.tsx:53, flash-photo-grid.tsx:24,
  // asset-tile.tsx:157). No new modal — epic #278's decision 1 reserves "type
  // the title" for galleries only, and a client is not a gallery.
  //
  // The email is appended whenever a name exists because two clients CAN share
  // a name while the email is the unique identity (`users_email_idx`), and this
  // confirmation is the last thing between the photographer and an irreversible
  // delete of the wrong row.
  const confirmAndDelete = useCallback(() => {
    const label = client.name ? `${client.name} (${client.email})` : client.email;
    if (!window.confirm(`¿Eliminar a ${label}? No se puede deshacer.`)) return;

    // Cleared on every attempt that actually proceeds, so a stale block never
    // sits next to a new outcome. On success nothing local happens at all:
    // `deleteClient` revalidates `/dashboard/clients` and the row unmounts with
    // its own data. No `router.refresh()` — that would be a second source of
    // truth for the same re-render (and a `next/navigation` import this
    // component does not otherwise need).
    setDeleteMessage(null);
    startDelete(async () => {
      const result = await deleteClient(client.id);
      if (!result.ok) setDeleteMessage(result.message);
    });
  }, [client.email, client.id, client.name]);

  // The element focused when the dialog opened was a menu item that no longer
  // exists, so Radix's default close behaviour would drop focus to `<body>`.
  // Hand it to the row's own trigger instead.
  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    triggerRef.current?.focus();
  }, []);

  return (
    // A FRAGMENT, not one root element — see the ROOT-SHAPE NOTE at the top.
    // Two children only while a blocked message is on screen; the cell below is
    // always exactly one grid child of the row's <li>.
    <>
      <div className="self-center justify-self-end [grid-area:more] lg:[grid-area:auto]">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* `.client-item__more`, design/system/dashboard.html:388-393 —
                copied from gallery-client-row.tsx so the same control looks the
                same on both lists: a 44px phone target, compact on the desk. */}
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Acciones para ${client.name ?? client.email}`}
              className="text-fg-dim hover:bg-bg-2 hover:text-fg flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[6px] text-[17px] transition-colors lg:min-h-6 lg:min-w-6 lg:text-sm"
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Through `handleOpenChange`, NOT `setEditOpen(true)` directly.
                That handler is the only place the previous success notice is
                cleared, and a controlled dialog never calls its own
                `onOpenChange` when the PARENT changes the `open` prop — so a
                direct set would leave `notice` untouched across a reopen, and
                the next save would rewrite the same string into the live region
                (a no-op for assistive technology). See the two-cycle test. */}
            <DropdownMenuItem onSelect={() => handleOpenChange(true)}>Editar</DropdownMenuItem>
            {/* `variant="destructive"` follows gallery-client-row.tsx:280-297,
                including its two-reds reasoning: this item is only ever
                reachable through the trigger's own popover, and the menu closes
                before the message below it can appear. */}
            <DropdownMenuItem
              variant="destructive"
              disabled={deletePending}
              onSelect={confirmAndDelete}
            >
              {deletePending ? "Eliminando…" : "Eliminar"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <EditClientDialog
          client={client}
          open={editOpen}
          onOpenChange={handleOpenChange}
          onUpdated={handleUpdated}
          onCloseAutoFocus={handleCloseAutoFocus}
        />

        {/*
          Always mounted, empty when there is nothing to say: a live region has
          to be in the accessibility tree BEFORE its text changes, or the
          insertion and the announcement happen in one commit and never announce.
          `sr-only` is absolutely positioned, so it adds no layout space and the
          cell stays a single grid cell.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {notice}
        </p>
      </div>

      {/*
        The blocked message, and it has to STAY on screen (task #280: "tiene que
        quedar en pantalla para leerlo y actuar") — an `alert()` would be gone
        before it could be read, so it is never that. `role="alert"` + `text-danger`
        is the repo's in-repo error shape (gallery-client-row.tsx:349-352).
        `col-span-full` is what makes it a full-width line under the row's cells
        instead of a fifth cell in a ~44px column.
      */}
      {deleteMessage && (
        <p role="alert" className="text-danger col-span-full pb-1 text-xs">
          {deleteMessage}
        </p>
      )}
    </>
  );
}
