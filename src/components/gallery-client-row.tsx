"use client";

// One row per ACTIVE client on the gallery detail page (task #97), plus a
// two-step "Quitar" affordance for the removal action and, since task #101,
// a "Reenviar acceso" affordance for the resend action.
//
// Task #273 changed the identity line from the "name · email" single
// truncated line #94 established to name stacked OVER email
// (design/system/dashboard.html:934-935), and the email is never truncated
// (`break-all`, mock :387) so it reads complete in a ~210px grid cell and its
// full text stays in the DOM for screen readers. A client with no name shows
// only the email — not the email twice.
//
// Task #133 (epic #125's mobile-first note): the row used to expose "Quitar"
// and "Reenviar acceso" as two adjacent, ~11px text buttons — "intocables con
// el pulgar" and, worse, sitting a thumb's-width away from a DESTRUCTIVE
// action. Both now live inside ONE 44px "Acciones" trigger (a shadcn/Radix
// <DropdownMenu>, the epic's own choice for a primitive that carries
// accessibility for free) instead of being individually reachable at a glance
// — the trigger itself is the only thing that has to hit the touch floor,
// because a menu's own rows are naturally full-width/tall, not two icons
// glued together.
//
// The removal confirmation names WHAT is about to happen, not just "¿estás
// seguro?" — the kanban task's own explicit requirement: removing a client
// from a DELIVERED gallery takes away photos they may have already paid for,
// and that must be said plainly before the admin confirms. `removable` hides
// the affordance entirely when the SERVER would refuse it anyway (the last
// active client on a gallery past `draft` — `removeGalleryClient`'s own
// `activeClientRuleViolation()` guard, src/lib/galleries.ts) — "hiding is UX,
// not authority" stance as every other guard in this app: the action itself
// re-checks this regardless of what `removable` is computed as here.
//
// Task #101's `resendable` follows the same "UX only, never the authority"
// stance — it is server-computed (`isGalleryVisibleToClient(gallery.status)`
// in page.tsx) and passed in as a plain boolean, rather than imported here,
// because this is a Client Component ("use client" below) and
// `isGalleryVisibleToClient` lives in a `server-only`-guarded module
// (src/lib/galleries.ts) that a Client Component cannot import at all.
// `resendGalleryAccessEmail` re-derives the same answer from the DB row
// regardless of what this component was told to render.
//
// TWO INDEPENDENT `useActionState` HOOKS, ONE PER FORM, EACH WITH ITS OWN
// `pending` — the trap a naive version of this row would fall into (and did,
// on this task's first, lost implementation attempt): sharing ONE `pending`
// flag between "Quitar" and "Reenviar" would disable "Confirmar" (the
// removal action's own submit button) while an unrelated resend is still in
// flight, and vice versa. The two actions do not touch the same data
// (`removeGalleryClient` writes `removedAt`; `resendGalleryAccessEmail`
// writes nothing at all) and have no reason to block each other in the UI.
//
// THE RESEND FORM HAS NO VISIBLE SUBMIT BUTTON. Its only trigger is the
// dropdown menu item's `onSelect`, which calls the form's own
// `requestSubmit()` through a ref — a `<DropdownMenu.Item>` renders a
// `role="menuitem"` element, never a `<button type="submit">`, so it cannot
// sit inside a `<form>` and rely on native submission the way the OLD
// standalone button did.
//
// THE MENU MUST NOT OUTLIVE ITS ROW (task #273, review round 1). Task #273's
// list hides the surplus rows by putting `hidden` on the `<li>` IT owns, and
// this menu is portalled into `document.body` (`dropdown-menu.tsx`:
// `DropdownMenuPrimitive.Portal`), so `display: none` never reached it: a
// menu opened on a row that a narrower viewport pushed behind "Ver todos"
// stayed open, keyboard-focusable and in the accessibility tree, and could
// still fire "Reenviar acceso" for a client who was no longer on screen.
// Unmounting rows would have fixed it too, and would have thrown away every
// row's `useActionState` — the guarantee the hide-instead-of-unmount choice
// exists to protect. Hiding the portal with CSS would have fixed the pixels
// and left the exact defect. So the LIST tells the ROW it is hidden and the
// row closes its own menu: coordination, not masking.
import {
  createContext,
  useActionState,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  removeGalleryClient,
  resendGalleryAccessEmail,
  type RemoveGalleryClientState,
  type ResendGalleryAccessEmailState,
} from "@/app/dashboard/galleries/actions";
import type { Gallery } from "@/lib/db/schema";
import {
  ClientSelectionMenuItems,
  GalleryClientSelection,
  hasClientSelectionActions,
  useClientSelectionController,
} from "@/components/gallery-client-selection";
import type { ClientSelectionView } from "@/lib/client-selection-state";
import type { AttributionDelta } from "@/lib/pick-plans";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Whether the `<li>` that contains this row is currently hidden, published
 * by `GalleryClientList` — the component that owns that `<li>`.
 *
 * A CONTEXT, because the list receives each row as an ALREADY-BUILT element
 * (`items: { id, row }`, built server-side with every server-computed prop
 * applied) and so cannot pass it a new prop; a render prop was ruled out by
 * the same shape (it would have to cross the server/client boundary).
 *
 * `focusDisclosure` is the focus hand-off: when a row hides while it owns the
 * menu, Radix would return focus to a trigger that is now `display: none`, so
 * the row asks the list to put focus on the disclosure that just hid it.
 *
 * The default value is "visible, nothing to hand off", so a row rendered on
 * its own — every existing test in `gallery-client-row.test.tsx` — behaves
 * exactly as it did before this context existed. */
export const GalleryClientRowVisibilityContext = createContext<{
  hidden: boolean;
  focusDisclosure: () => void;
}>({ hidden: false, focusDisclosure: () => {} });

const initialRemoveState: RemoveGalleryClientState = { status: "idle" };
const initialResendState: ResendGalleryAccessEmailState = { status: "idle" };

const REMOVE_WARNING_BY_STATUS: Record<Gallery["status"], string> = {
  draft:
    "Todavía no se publicó esta galería — el cliente no perdió acceso a nada porque nunca lo tuvo.",
  proofing: "Va a perder el acceso para ver y elegir sus fotos.",
  selected: "Va a perder el acceso a la galería, aunque ya haya enviado su selección.",
  delivered:
    "Va a perder el acceso para ver y descargar las fotos entregadas — incluso si ya las pagó.",
  archived: "Va a perder el acceso a esta galería.",
};

export function GalleryClientRow({
  galleryId,
  client,
  status,
  removable,
  resendable,
  selection,
  preview,
}: {
  galleryId: string;
  client: { id: string; name: string | null; email: string };
  status: Gallery["status"];
  removable: boolean;
  resendable: boolean;
  /** Epic #239 (#242): this person's pick count and lock state. Omitted = the
   * panel is not rendered (draft galleries). */
  selection?: ClientSelectionView;
  /** Epic #250 (#263): this person's lock / remove-picks before/after, from
   * `getDashboardSelection(...).previewByClient[client.id]`. Passed straight
   * through — the row never computes money. */
  preview?: { lock: AttributionDelta; removePicks: AttributionDelta };
}) {
  const [removeState, removeFormAction, removePending] = useActionState(
    removeGalleryClient,
    initialRemoveState,
  );
  const [resendState, resendFormAction, resendPending] = useActionState(
    resendGalleryAccessEmail,
    initialResendState,
  );
  const [confirming, setConfirming] = useState(false);
  const resendFormRef = useRef<HTMLFormElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  // `open` is CONTROLLED (it was uncontrolled before task #273's review round
  // 1) for exactly one reason: the list can then force it closed the moment
  // this row is hidden, which unmounts the portal and takes its items out of
  // the focus order and the accessibility tree. `onOpenChange` still keeps the
  // `!rowIsHidden` guard so a forced close can never leave the menu armed to
  // pop open again on expand.
  const [actionsOpen, setActionsOpen] = useState(false);
  const { hidden: rowIsHidden, focusDisclosure } = useContext(GalleryClientRowVisibilityContext);
  const actionsMenuOpen = actionsOpen && !rowIsHidden;

  // Adjusting state during RENDER, which is React's own documented pattern for
  // "this state is invalid now that the input changed". Doing it in an effect
  // would paint one frame with the orphaned menu still mounted (and trip
  // `react-hooks/set-state-in-effect`). This is what stops a forced close from
  // leaving the menu armed to pop open again when the row is expanded.
  if (rowIsHidden && actionsOpen) setActionsOpen(false);

  // `useLayoutEffect`, not `useEffect`: it has to read `document.activeElement`
  // BEFORE the browser's layout drops focus off a `display: none` subtree,
  // which is the whole point of it.
  //
  // The menu direction needs no code here: `actionsMenuOpen` above is false the
  // moment the row is hidden, so the portal unmounts in that same commit and
  // `onCloseAutoFocus` below (see `DropdownMenuContent`) hands focus to the
  // disclosure instead of letting Radix return it to a hidden trigger.
  //
  // This effect is the INLINE direction: if focus was on one of this row's own
  // controls (an open "Quitar → Confirmar", say) it is on a `display: none`
  // element as of this commit. Read it now, while it is still there, and move
  // it to the control that hid the row rather than letting it fall to `<body>`.
  useLayoutEffect(() => {
    if (!rowIsHidden) return;
    const active = document.activeElement;
    if (active === null || !rowRef.current?.contains(active)) return;
    focusDisclosure();
  }, [rowIsHidden, focusDisclosure]);
  // Epic #239 (#242): lock / unlock / remove-picks share one controller; its
  // entries live in the ⋯ menu below, its state line and prompts inline.
  const selectionController = useClientSelectionController();

  if (removeState.status === "removed") {
    return (
      <p className="text-fg-mute text-sm line-through decoration-1">
        {client.name ? `${client.name} · ${client.email}` : client.email} — quitado.
      </p>
    );
  }

  const displayName = client.name ?? client.email;
  const hasSelectionActions = hasClientSelectionActions(status, selection);
  const hasActions = resendable || removable || hasSelectionActions;

  return (
    // `h-full` so bordered boxes sharing a grid row (task #273) are equally
    // tall: a stretched grid item has a definite height, so it resolves.
    <div
      ref={rowRef}
      className="border-line-2 flex h-full flex-col gap-2 rounded-[6px] border py-1.5 pr-1.5 pl-3"
    >
      <div className="flex min-h-11 items-center justify-between gap-3 lg:min-h-8">
        <div className="min-w-0">
          {client.name && <p className="text-sm break-words">{client.name}</p>}
          <p className="text-fg-mute text-xs break-all">{client.email}</p>
        </div>

        {/* `.client-item__more`, design/system/dashboard.html:388-393 — the
            ONE 44px control this row exposes; everything it opens is a full-
            width menu row, not a second small target. */}
        {hasActions && (
          <DropdownMenu
            open={actionsMenuOpen}
            onOpenChange={(open) => setActionsOpen(open && !rowIsHidden)}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Acciones para ${displayName}`}
                className="text-fg-dim hover:bg-bg-2 hover:text-fg flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[6px] text-[17px] transition-colors lg:min-h-6 lg:min-w-6 lg:text-sm"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              // Radix's default is to return focus to the trigger when the
              // menu closes. When the menu closed because its ROW was hidden,
              // that trigger is `display: none` and cannot take focus, so the
              // best case is that focus silently falls to `<body>` — a
              // keyboard user stranded mid-page. Prevent the restore and land
              // on the disclosure instead: it is still there, it is what hid
              // the row, and it is the way back.
              onCloseAutoFocus={(event) => {
                if (!rowIsHidden) return;
                event.preventDefault();
                focusDisclosure();
              }}
            >
              {selection && hasSelectionActions && (
                <ClientSelectionMenuItems
                  galleryStatus={status}
                  selection={selection}
                  controller={selectionController}
                />
              )}
              {resendable && (
                <DropdownMenuItem
                  disabled={resendPending}
                  onSelect={() => resendFormRef.current?.requestSubmit()}
                >
                  {resendPending ? "Reenviando…" : "Reenviar acceso"}
                </DropdownMenuItem>
              )}
              {removable && (
                // `variant="destructive"` is shadcn's OWN semantic
                // (`--destructive`, the oklch red #127 wired up for
                // `aria-invalid` and this exact prop) — a deliberate choice,
                // not an accident that happens to pair it with this screen's
                // `#e0796b`/`--app-danger` warning family (epic #125's rule
                // 2: the two reds must never sit side by side without being
                // chosen on purpose). They don't here: this menu item is
                // reachable only via the trigger's OWN popover, never
                // rendered next to the below-image `#e0796b` confirm warning
                // at the same time — the destructive-red menu item closes
                // before that warning ever appears. Using the primitive's
                // own destructive styling on a shadcn primitive is the
                // simplest correct choice; inventing a third red to match
                // `#e0796b` here would be the accident this rule warns
                // against, not the fix for it.
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
                  Quitar
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {selection && (
        <GalleryClientSelection
          galleryId={galleryId}
          clientId={client.id}
          galleryStatus={status}
          selection={selection}
          preview={preview}
          controller={selectionController}
        />
      )}

      {/* No visible submit control — see this file's header comment on why
          the menu item above triggers this via a ref instead of a native
          submit button. */}
      {resendable && (
        <form ref={resendFormRef} action={resendFormAction}>
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
        </form>
      )}

      {removable && confirming && (
        <form action={removeFormAction} className="flex flex-col items-start gap-2 pb-1">
          <input type="hidden" name="galleryId" value={galleryId} />
          <input type="hidden" name="clientId" value={client.id} />
          <p className="text-danger text-xs">{REMOVE_WARNING_BY_STATUS[status]}</p>
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={removePending}
              className="text-danger min-h-11 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-6"
            >
              {removePending ? "Quitando…" : "Confirmar"}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-fg-dim hover:text-accent-2 min-h-11 text-sm transition-colors lg:min-h-6"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {removeState.status === "error" && (
        <p role="alert" className="text-danger pb-1 text-xs">
          {removeState.message}
        </p>
      )}

      {(resendState.status === "resend_email_failed" || resendState.status === "throttled") && (
        <p role="alert" className="text-danger pb-1 text-xs">
          {resendState.message}
        </p>
      )}
      {resendState.status === "resent" && (
        <p role="status" className="text-accent-2 pb-1 text-xs">
          {resendState.message}
        </p>
      )}
    </div>
  );
}
