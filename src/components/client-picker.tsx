"use client";

// Task #247 — ONE searchable client picker for every place the dashboard asks
// "which clients?". Before this, `gallery-form.tsx`,
// `attach-gallery-clients-form.tsx` and `flash-clients-panel.tsx` each rendered
// a native `<select multiple>`, which grows into a wall of options the moment
// the studio has more than a handful of clients and offers no way to search.
//
// This file is the only picker. Each call site keeps its own label, its own
// empty state and its own action; only the control itself is shared.
//
// WHY THE POPOVER IS PORTALED AND `modal`
// Two of the three call sites are plain pages, but `gallery-form.tsx` renders
// inside `<DashboardGalleryCreateDialog>`'s `<DialogContent>`, which is itself
// portaled and carries `overflow-y-auto max-h-[85vh]` (see that file). A list
// rendered in place would be clipped by it, so the content portals to
// `document.body`. Once it is out of the dialog's subtree, the dialog's own
// scroll lock and focus trap are the active ones over a list they do not
// contain; `modal` gives the popover its own `RemoveScroll` and pushes a second
// `FocusScope` onto Radix's stack, which pauses the dialog's for as long as the
// list is open. On the two page-level call sites `modal` costs nothing a picker
// needs — an outside click still closes it.
//
// WHY THE HIDDEN INPUTS ARE NOT IN THE PORTAL
// `Popover.Content` portals to `document.body`, i.e. OUTSIDE the owning
// `<form>`. Anything rendered in there is never submitted. So the selected ids
// are emitted as `<input type="hidden" name={name}>` next to the trigger — in
// the form — and the portalled content only ever mutates React state. This is
// the failure mode that would look perfect on screen and post nothing.
//
// WHY IT LISTENS FOR THE FORM'S `reset` EVENT
// React 19 blanks a `<form action={fn}>`'s uncontrolled fields by calling
// `form.reset()` at submit time, success or error alike (see
// `gallery-form.tsx`'s comment on this). That dom call fires a `reset` event,
// which resets DOM fields — but React state is invisible to it, so without the
// listener below a rejected submit would blank every text input and leave the
// picker still showing the previous selection. Listening for `reset` on the
// owning form is what makes this control behave like the native field it
// replaces, without the parent having to know it exists. (`HTMLButtonElement
// .form` resolves that form for us; no context, no prop.)
//
// Task #135's token rule still applies: this file is not named `dashboard-*`
// and does not live under `src/app/dashboard/**`, so task #175's ESLint rule
// correctly refuses `app-*` utilities here even though it only ever renders
// inside that scope. Brand tokens and literal values only — and the portal is
// outside `[data-surface="app"]` anyway, where `--app-*` would resolve to
// nothing at all.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ClientForPicker } from "@/lib/clients";

// The repo's own accent-insensitive comparison idiom, same as
// `src/lib/flash-download.ts` and the final-asset route: decompose (NFKD),
// drop the combining marks, lowercase.
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Owner amendment on task #247 (2026-10-17): the search matches **name OR
 * email** for every client. A named client must still be findable by their
 * email — this supersedes the plan's literal `name ?? email` reading, which
 * would have hidden `ana@example.com` behind "Ana Pérez".
 */
function matchesQuery(client: ClientForPicker, needle: string): boolean {
  if (needle.length === 0) return true;
  return [client.name, client.email].some(
    (value) => value !== null && normalizeForSearch(value).includes(needle),
  );
}

// Same shape as the call sites' own field/button classes (they are portaled or
// app-scope-free for the same reason), plus the layout a combobox trigger
// needs. `py-3`/`text-sm` keeps the height the `<select>` had, so the three
// forms keep their vertical rhythm; `min-h-11` is epic #125's touch floor.
const triggerClass =
  "border-line-2 focus-visible:border-accent text-fg inline-flex min-h-11 w-full items-center justify-between gap-2 rounded-[5px] border bg-transparent px-4 py-3 text-left text-sm transition-colors outline-none";

// 44px on touch, 24px (WCAG 2.2 SC 2.5.8) on pointer widths — epic #125's
// rule 1 from #129, expressed as `min-height` only, never as a `max-width`
// media query.
const rowClass =
  "flex min-h-11 w-full cursor-default items-center gap-2 rounded-[3px] px-2 text-left text-sm lg:min-h-6";

export function ClientPicker({
  id,
  name,
  label,
  clients,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  /** Trigger id — the rendered `<label htmlFor>` points here. */
  id: string;
  /** Hidden-input name; every call site passes "clientIds". */
  name: string;
  /** The call site's own label text, verbatim. */
  label: string;
  clients: ClientForPicker[];
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Every id below is derived from the call site's own trigger id, so two
  // pickers on one page can never collide.
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listboxId = `${id}-listbox`;
  const optionId = (clientId: string) => `${id}-opt-${clientId}`;

  // Never sorted, never widened: `clients` arrives already ordered by
  // `getClientsForPicker`, and iterating it below (rather than the selection
  // set) is what makes the emitted ids follow that same order.
  const needle = normalizeForSearch(query.trim());
  const filtered = useMemo(
    () => clients.filter((client) => matchesQuery(client, needle)),
    [clients, needle],
  );

  // Emitted ids, derived from `clients` — so an id that is no longer in the
  // list (the page revalidated and this client stopped being eligible) simply
  // disappears instead of posting something the server would reject.
  const emittedIds = useMemo(
    () => clients.filter((client) => selected.has(client.id)).map((client) => client.id),
    [clients, selected],
  );

  // The count is computed from the ids that will actually post, never from the
  // raw selection: "a counter that lies is worse than one that is absent"
  // (epic #125, rule 2 out of #174). If a hidden input does not exist for it,
  // the trigger must not claim it.
  const countLabel =
    emittedIds.length === 0
      ? "Elegir clientes"
      : emittedIds.length === 1
        ? "1 cliente seleccionado"
        : `${emittedIds.length} clientes seleccionados`;

  const activeOptionId = filtered[activeIndex] ? optionId(filtered[activeIndex]!.id) : undefined;

  // The count lives in `aria-describedby` rather than in the trigger's text:
  // the `<label htmlFor>` we render IS the trigger's accessible name (labels win
  // over element content in the accname computation), so text painted inside
  // the button would never be announced as part of it.
  const describedBy = [valueId, ariaDescribedBy].filter(Boolean).join(" ");

  function toggle(clientId: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setActiveIndex(0);
    }
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      // Select, never submit: the search input lives in the portal, outside
      // the form, and this `preventDefault` covers the rest.
      event.preventDefault();
      const active = filtered[activeIndex];
      if (active) toggle(active.id);
    }
  }

  // See this file's header. `form.reset()` is what React 19 runs after a
  // submit, and it is the ONLY thing that clears the selection — closing and
  // reopening the popover keeps it, exactly like a native multi-select.
  useEffect(() => {
    const form = triggerRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setSelected(new Set<string>());
      setQuery("");
      setActiveIndex(0);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  // jsdom implements no `scrollIntoView`, so the optional call is required —
  // an unguarded one throws in every test that opens the list.
  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeOptionId]);

  return (
    <>
      <label htmlFor={id} id={labelId} className="text-fg-mute text-xs tracking-wide uppercase">
        {label}
      </label>

      <PopoverPrimitive.Root modal open={open} onOpenChange={handleOpenChange}>
        <PopoverPrimitive.Trigger
          type="button"
          id={id}
          ref={triggerRef}
          aria-invalid={ariaInvalid}
          aria-describedby={describedBy}
          className={triggerClass}
        >
          <span id={valueId} className="truncate">
            {countLabel}
          </span>
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 opacity-60" />
        </PopoverPrimitive.Trigger>

        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            // Explicit rather than leaning on FocusScope's "first tabbable",
            // so a future button inside the content cannot steal the focus.
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              searchRef.current?.focus();
            }}
            className="bg-popover text-popover-foreground border-line-2 z-50 flex max-h-(--radix-popover-content-available-height) w-(--radix-popover-trigger-width) flex-col rounded-[5px] border p-1 shadow-md"
          >
            <input
              ref={searchRef}
              // `type="text"`, not `type="search"`: the criterion is "the
              // search is a textbox", and `type="search"` maps to the
              // `searchbox` role instead.
              type="text"
              autoComplete="off"
              aria-label="Buscar cliente"
              placeholder="Buscar cliente"
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
              className="border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute mb-1 min-h-11 w-full rounded-[5px] border bg-transparent px-2 text-sm transition-colors outline-none lg:min-h-9"
            />

            <ul
              role="listbox"
              id={listboxId}
              aria-multiselectable="true"
              aria-labelledby={labelId}
              className="flex max-h-64 flex-col overflow-y-auto"
            >
              {filtered.map((client) => {
                const isSelected = selected.has(client.id);
                const isActive = filtered[activeIndex]?.id === client.id;
                return (
                  <li
                    key={client.id}
                    role="option"
                    id={optionId(client.id)}
                    aria-selected={isSelected}
                    data-active={isActive}
                    // Keeping focus in the search input is what makes
                    // `aria-activedescendant` meaningful; without this the
                    // click would steal it and the arrow keys would stop.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggle(client.id)}
                    className={cn(
                      rowClass,
                      "hover:bg-muted data-[active=true]:bg-muted select-none",
                    )}
                  >
                    <CheckIcon
                      aria-hidden="true"
                      className={cn("size-4 shrink-0", isSelected ? "visible" : "invisible")}
                    />
                    <span className="min-w-0 truncate">{client.name ?? client.email}</span>
                  </li>
                );
              })}
              {filtered.length === 0 && (
                // Never `role="option"` — there is nothing to select here, and
                // a listbox whose only option is "no matches" tells AT there is
                // a choice to make.
                <li role="presentation" className="text-fg-mute px-2 py-2 text-sm">
                  Ningún cliente coincide.
                </li>
              )}
            </ul>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>

      {/* Inside the form, unlike everything in the portal above. Iterating
          `clients` gives native-`<select>` option order for free and keeps
          stale ids out of the submission. */}
      {emittedIds.map((clientId) => (
        <input key={clientId} type="hidden" name={name} value={clientId} />
      ))}
    </>
  );
}
