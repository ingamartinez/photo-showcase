"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createGallery, type CreateGalleryState } from "@/app/dashboard/galleries/actions";
import type { ClientForPicker } from "@/lib/clients";
import type { PackageForPicker } from "@/lib/packages";

const initialState: CreateGalleryState = { status: "idle" };

const inputClass =
  "border-line-2 focus-visible:border-accent text-fg placeholder:text-fg-mute rounded-sm border bg-transparent px-4 py-3 text-[15px] transition-colors outline-none";

export function GalleryForm({
  clients,
  packages,
}: {
  clients: ClientForPicker[];
  packages: PackageForPicker[];
}) {
  const [state, formAction, pending] = useActionState(createGallery, initialState);

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
    <form action={formAction} className="border-line-2 flex flex-col gap-5 rounded-sm border p-6">
      <span className="label text-fg-mute">Nueva galería</span>

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
            <span className="label text-fg-mute">Clientes (opcional)</span>
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
            <label htmlFor="clientIds" className="label text-fg-mute">
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
        <label htmlFor="packageId" className="label text-fg-mute">
          Paquete
        </label>
        <select
          id="packageId"
          name="packageId"
          required
          defaultValue=""
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

      <div className="flex flex-col gap-2">
        <label htmlFor="title" className="label text-fg-mute">
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
        <label htmlFor="sessionDate" className="label text-fg-mute">
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

      <button
        type="submit"
        disabled={pending || packages.length === 0}
        className="border-line-2 hover:border-accent hover:text-accent-2 rounded-sm border px-[18px] py-[12px] text-[13px] tracking-[0.1em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Guardando…" : "Crear galería"}
      </button>
    </form>
  );
}
