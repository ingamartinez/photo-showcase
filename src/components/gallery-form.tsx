"use client";

import { useActionState } from "react";
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
  return (
    <form action={formAction} className="border-line-2 flex flex-col gap-5 rounded-sm border p-6">
      <span className="label text-fg-mute">Nueva galería</span>

      <div className="flex flex-col gap-2">
        <label htmlFor="clientIds" className="label text-fg-mute">
          Clientes
        </label>
        {/* Task #94: a gallery can now belong to several clients at once —
            a couple's own separate logins, a family, two businesses sharing
            a shoot. `multiple` + `required` means the browser itself refuses
            to submit with zero options selected; the server action
            (createGallery) re-checks this regardless, same "hiding/blocking
            in the UI is not the authority" stance as every other guard in
            this app. Hold Cmd/Ctrl (or Shift for a range) to pick more than
            one. */}
        <select
          id="clientIds"
          name="clientIds"
          multiple
          required
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
