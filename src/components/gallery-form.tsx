"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { createGallery, type CreateGalleryState } from "@/app/dashboard/galleries/actions";
import type { ClientForPicker } from "@/lib/clients";
import type { PackageForPicker } from "@/lib/packages";

const initialState: CreateGalleryState = { status: "idle" };

// Task #135 sweep: rendered ONLY inside <DashboardGalleryCreateDialog>'s
// <DialogContent>, which portals to `document.body` — outside
// `[data-surface="app"]` (see that file's header comment on "WHY THERE IS
// NOT A SINGLE `app-*` UTILITY BELOW THE TRIGGER"). `--app-radius-sm` and
// `--app-text-base` are declared under that attribute and would resolve to
// nothing here, so this stays on brand tokens and plain Tailwind scales
// rather than the app-surface ones — `rounded-[5px]`/`text-sm` (14px) are
// literal stand-ins for the values `--app-radius-sm`/`--app-text-base`
// carry, chosen so a phone/desk field and a dialog field read as the same
// size without this form being able to reach the token that says so.
const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-[5px] border bg-transparent px-4 py-3 text-sm transition-colors outline-none";

export function GalleryForm({
  clients,
  packages,
  onCreated,
}: {
  clients: ClientForPicker[];
  packages: PackageForPicker[];
  // Task #131 moved this form into a dialog
  // (src/components/dashboard-gallery-create-dialog.tsx). This is the ONLY
  // thing the form learns about that move, and it is optional: rendered on its
  // own — which is how every test in gallery-form.test.tsx renders it — the
  // component behaves exactly as it did before, success message included.
  // The ticket's trap, verbatim: "Moving it into a dialog means changing where
  // it renders, not rewriting it. If it needs to know it is in a dialog (to
  // close on success), pass that in; do not fork it."
  onCreated?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createGallery, initialState);

  // Task #193 — tracked only so the "Fotos incluidas" override field can
  // show the CHOSEN package's own quota as its placeholder (what the
  // photographer is starting from), never submitted itself. Nothing here is
  // trusted server-side: `createGallery` re-reads the package's live row by
  // `packageId` on its own (this file's own comment above `<select
  // packageId>` further down never changed) — this state exists purely to
  // drive a UI hint.
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const selectedPackage = packages.find((pkg) => String(pkg.id) === selectedPackageId);

  // Narrowed to a boolean on purpose: `state` is a fresh object on every
  // action result, so depending on it directly would re-fire this on an error
  // -> error transition too. `created` only ever flips false -> true.
  const created = state.status === "created";
  useEffect(() => {
    if (created) onCreated?.();
  }, [created, onCreated]);

  // Same reset behavior as ClientForm: React 19 blanks uncontrolled fields in
  // a <form action={fn}> synchronously at submit time, success or error
  // alike (see client-form.tsx's comment).
  //
  // Unlike ClientForm, this one does NOT feed the submitted values back
  // through `defaultValue` after a rejected submit (task #50 added that
  // there). `createGallery` does have errors a photographer corrects and
  // resubmits — a whitespace-only title, an invalid or withdrawn package, an
  // unknown client id — so the papercut exists here too. It is simply not
  // fixed yet, and no task has asked for it: restoring `<select multiple>`
  // and `<select>` state costs materially more than the three text inputs
  // ClientForm has, because `defaultValue` on a multi-select is an array of
  // option values rather than one string. Worth its own slice, not a silent
  // ride-along on #50.
  return (
    // Task #131: the card chrome (`border p-6`) and the "Nueva galería"
    // eyebrow both moved OUT of here — the dialog that now wraps this form
    // supplies its own padding and its own <DialogTitle> with that exact
    // wording, and rendering either twice would put a box inside a box and the
    // same heading above itself.
    <form action={formAction} className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        {/* Task #94: a gallery can belong to several clients at once — a
            couple's own separate logins, a family, two businesses sharing a
            shoot. Hold Cmd/Ctrl (or Shift for a range) to pick more than one.

            Task #100 dropped this select's `required`: the shoot happens
            before the paperwork, and the photographer must be able to set the
            session up and upload proofs before the client record exists. An
            unexplained optional field reads as a bug, so the note below says
            what picking nobody actually means — the gallery stays a draft
            until it has someone to publish to. The server action
            (createGallery) accepts an empty selection, and publishing is what
            refuses it; same "the UI is not the authority" stance as every
            other guard in this app.

            The heading below is a <label htmlFor> ONLY in the branch that
            actually renders a `#clientIds` control. In the empty branch there
            is no form control to label — a `<label htmlFor>` pointing at an
            id that does not exist is a broken association a screen reader
            will follow to nothing, so that branch uses a plain <span>. */}
        {clients.length === 0 ? (
          <>
            {/* Task #135 sweep: `.label` (globals.css's mono, uppercase,
                0.22em-tracked eyebrow) doesn't survive under /dashboard —
                epic #125's own done-when. Same plain-text replacement
                attach-gallery-clients-form.tsx already established. */}
            <span className="text-fg-mute text-xs tracking-wide uppercase">
              Clientes (opcional)
            </span>
            <p className="text-fg-dim text-sm leading-relaxed">
              Todavía no cargaste ningún cliente. Podés crear la galería igual y agregarle el
              cliente cuando exista — hasta entonces queda en borrador.{" "}
              <Link href="/dashboard/clients" className="text-accent-2 underline">
                Ir a clientes
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <label htmlFor="clientIds" className="text-fg-mute text-xs tracking-wide uppercase">
              Clientes (opcional)
            </label>
            <select
              id="clientIds"
              name="clientIds"
              multiple
              size={Math.min(6, Math.max(3, clients.length))}
              aria-invalid={state.status === "error"}
              aria-describedby={state.status === "error" ? "gallery-form-error" : undefined}
              className={inputClass}
            >
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name ?? client.email}
                </option>
              ))}
            </select>
            <p className="text-fg-dim text-sm leading-relaxed">
              Podés dejarlo vacío y agregar el cliente después — sin cliente no vas a poder publicar
              la galería.
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="packageId" className="text-fg-mute text-xs tracking-wide uppercase">
          Paquete
        </label>
        <select
          id="packageId"
          name="packageId"
          required
          defaultValue=""
          onChange={(event) => setSelectedPackageId(event.target.value)}
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "gallery-form-error" : undefined}
          className={inputClass}
        >
          <option value="" disabled>
            Elegí un paquete
          </option>
          {packages.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name} · {pkg.includedPhotos} fotos incluidas
            </option>
          ))}
        </select>
      </div>

      {/* Task #193 (widened by #205 to a third field) — all OPTIONAL, all
          fall back to the chosen package's own terms when left blank
          (createGallery's own `??` against these fields, actions.ts). None
          is `required`: the untouched default has to reproduce today's
          create-a-gallery flow bit for bit.

          `PackageForPicker` (src/lib/packages.ts) deliberately omits the
          package's LIVE `extraPhotoPriceCop`/`originalPhotoPriceCop` — its
          own header comment explains why widening it would let live terms
          leak back into the app. The included-photos placeholder below is
          safe precisely because `includedPhotos` is the one live field that
          type already exposes; the extra-photo-price and original-photo-price
          fields each get a static hint instead of a real number, rather than
          widening that type for a placeholder. */}
      <div className="flex flex-col gap-2">
        <label htmlFor="includedPhotos" className="text-fg-mute text-xs tracking-wide uppercase">
          Fotos incluidas (opcional)
        </label>
        <input
          id="includedPhotos"
          name="includedPhotos"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder={
            selectedPackage
              ? `Vacío = ${selectedPackage.includedPhotos} (del paquete)`
              : "Vacío = del paquete"
          }
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "gallery-form-error" : undefined}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="extraPhotoPriceCop"
          className="text-fg-mute text-xs tracking-wide uppercase"
        >
          Precio foto extra, COP (opcional)
        </label>
        <input
          id="extraPhotoPriceCop"
          name="extraPhotoPriceCop"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="Vacío = precio del paquete"
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "gallery-form-error" : undefined}
          className={inputClass}
        />
      </div>

      {/* Task #205 — same optional/inherit-from-package shape as the two
          fields above, for the new original-photo price. Same reason
          `extraPhotoPriceCop` above uses a static placeholder instead of a
          live number: `PackageForPicker` (src/lib/packages.ts) deliberately
          omits every LIVE price, and widening it for one placeholder is how
          those prices leak back into the app (that type's own header
          comment). */}
      <div className="flex flex-col gap-2">
        <label
          htmlFor="originalPhotoPriceCop"
          className="text-fg-mute text-xs tracking-wide uppercase"
        >
          Precio foto original, COP (opcional)
        </label>
        <input
          id="originalPhotoPriceCop"
          name="originalPhotoPriceCop"
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          placeholder="Vacío = precio del paquete"
          aria-invalid={state.status === "error"}
          aria-describedby={state.status === "error" ? "gallery-form-error" : undefined}
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="title" className="text-fg-mute text-xs tracking-wide uppercase">
          Título
        </label>
        <input
          id="title"
          name="title"
          type="text"
          required
          placeholder="Boda Ana y Beto"
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="sessionDate" className="text-fg-mute text-xs tracking-wide uppercase">
          Fecha de la sesión
        </label>
        <input id="sessionDate" name="sessionDate" type="date" required className={inputClass} />
      </div>

      {state.status === "error" && (
        <p id="gallery-form-error" role="alert" className="text-sm text-[#e0796b]">
          {state.message}
        </p>
      )}
      {state.status === "created" && (
        <p role="status" className="text-accent-2 text-sm">
          Galería creada.
        </p>
      )}

      {/* Task #135 sweep: this used to be the marketing CTA — uppercase,
          0.1em-tracked, 13px, the same button shape as the public site's
          hero/header buttons. Portaled, like `inputClass` above, so this
          reads brand tokens and a literal radius, not `app-*`. */}
      <button
        type="submit"
        disabled={pending || packages.length === 0}
        className="border-line-2 hover:bg-bg-2 hover:border-fg-mute inline-flex min-h-11 items-center justify-center rounded-[5px] border px-4 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Crear galería"}
      </button>
    </form>
  );
}
