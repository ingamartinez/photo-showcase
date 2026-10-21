"use client";

// TASK #279 — the per-row "⋯" menu on the clients list.
//
// Pattern: src/components/gallery-client-row.tsx (the epic's mandated row-menu
// shape — a 44px trigger with `aria-label="Acciones para <nombre>"`, Radix
// building `aria-expanded`). One trigger per row, every action as a full-width
// menu row, never a second small button.
//
// THIS COMPONENT IS THE EXTENSION POINT FOR TASK #280 (delete client). Its
// "Eliminar" item goes INTO the single <DropdownMenuContent> below, next to
// "Editar", with `onSelect` flipping its own state; its confirmation and
// blocked message render as siblings inside this root, near the live region.
// Keep new actions' `pending` flags separate — one action's spinner must never
// disable another's item.
//
// It is a SIBLING of the <DropdownMenu>, never nested inside
// <DropdownMenuContent>: nesting a dialog in a menu's content is the known
// Radix stuck-`pointer-events` / lost-focus setup.
//
// The rest of this file's layout is layout-only (no chrome of its own): at the
// phone and 600px breakpoints the row's last grid area `more` holds the
// trigger; at >=1024px the row auto-places its children, so this component is
// just the last cell of the five the desk row has.
import { useCallback, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EditClientDialog, type EditableClient } from "@/components/edit-client-dialog";

/** Announced after a successful edit, from OUTSIDE the dialog — the dialog
 * itself closes on success, so anything rendered inside it would unmount in
 * the same frame and a screen-reader user would hear nothing. */
const UPDATED_NOTICE = "Cliente actualizado.";

export function ClientRowActions({ client }: { client: EditableClient }) {
  const [editOpen, setEditOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);

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
    setEditOpen(false);
  }, []);

  // The element focused when the dialog opened was a menu item that no longer
  // exists, so Radix's default close behaviour would drop focus to `<body>`.
  // Hand it to the row's own trigger instead.
  const handleCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    triggerRef.current?.focus();
  }, []);

  return (
    // EXACTLY ONE root element: the row goes from four grid children to five,
    // never six. Everything else this component needs (the dialog, the live
    // region) lives inside it, and the dialog additionally portals out.
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
          <DropdownMenuItem onSelect={() => setEditOpen(true)}>Editar</DropdownMenuItem>
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
        root stays a single grid cell.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {notice}
      </p>
    </div>
  );
}
