"use client";

// Bulk final upload — task #217: "quiero subir las fotos en bulk y hacer el
// mapeo a las que seleccionaron: esto arregla el problema de tener que ir
// foto por foto a subir la original." Before this, uploading N finals meant
// N separate clicks on N separate tiles (asset-tile.tsx's own per-asset
// "Subir final" control, task #26 — kept alive on purpose, see below).
//
// THE MAPPING IS PROPOSED, NEVER TRUSTED BLINDLY: `matchFinalFiles`
// (src/lib/final-filename-match.ts) is the pure logic that decides which
// chosen file goes to which selected asset, and its own header explains WHY
// this can never guess (`assets.originalFilename` carries no unique
// constraint — two memory cards can both start at DSC_0001.JPG). This
// component's whole job is to show that proposal BEFORE a single byte
// uploads (the review screen below), and to upload only what the matcher
// itself marked unambiguous. Anything ambiguous, or any file/asset left
// over, stays on screen with why — and stays reachable through the
// per-tile control this component does NOT replace.
//
// NO NEW ROUTE: every upload still goes through
// POST /api/assets/[assetId]/final — the same route asset-tile.tsx's own
// per-tile control already calls (see final/route.ts's own header — it
// already does everything a bulk upload needs: processes, writes both R2
// objects, and updates `finalKey`/`isEdited`). The only thing this
// component adds client-side is "loop with a pre-shown mapping" instead of
// "one at a time, hand-picked".
//
// STRICTLY SEQUENTIAL — ONE REQUEST IN FLIGHT AT A TIME, NEVER
// `Promise.all`. Same reasoning as proof-uploader.tsx's own header, made
// worse here: `request.formData()` buffers the whole multipart body in the
// droplet process (`photoshowcase.service`'s `MemoryMax=768M`, shared with
// findash), and `processDisplay`'s own mutex (`runExclusive`,
// src/lib/images.ts) already serializes that pass process-wide (task #218
// deleted the route's OTHER sharp pass, `processFinal`, entirely — the final
// is now stored byte-for-byte) — concurrent requests would just queue there,
// still holding their raw bytes resident. Finals make this worse than
// proofs: their cap is 80 MB (`MAX_FINAL_UPLOAD_BYTES`, final/route.ts)
// against the proofs route's 50 MB — a parallel batch of finals is a much
// faster way to exceed the droplet's memory cap than a parallel batch of
// proofs ever was.
//
// UPLOAD GATE: the file picker below narrows `accept` to `image/jpeg` only
// (task #218) — the server-side route now rejects anything else with a 415,
// tightened specifically because the final is stored byte-for-byte and needs
// its `.jpg`/`image/jpeg` shape guaranteed (see final/route.ts's own
// comment). `accept` is a hint, not a gate — a photographer can still pick a
// non-JPEG file past it on some OSes/browsers, which is exactly what the
// server check exists to catch; this narrowing only saves a round trip for
// the common case of picking the wrong export by mistake.
import { useState } from "react";
import type { WorkspaceAsset } from "@/components/gallery-workspace";
import {
  matchFinalFiles,
  type AmbiguousMatch,
  type FinalMatchPlan,
} from "@/lib/final-filename-match";

type UploadItemStatus = "pending" | "uploading" | "done" | "error";

type UploadItem = {
  assetId: string;
  originalFilename: string;
  fileName: string;
  status: UploadItemStatus;
  error?: string;
};

function setItemStatus(
  items: UploadItem[],
  index: number,
  status: UploadItemStatus,
  error?: string,
): UploadItem[] {
  return items.map((item, i) => (i === index ? { ...item, status, error } : item));
}

function statusLabel(item: UploadItem): string {
  switch (item.status) {
    case "pending":
      return "En cola";
    case "uploading":
      return "Subiendo…";
    case "done":
      return "Listo";
    case "error":
      return item.error ?? "Error";
  }
}

/** Several ambiguity reasons list assets/files that can legitimately share
 * the EXACT same displayed name — "duplicate_asset_basename" is precisely
 * the case of two selected assets whose `originalFilename` is identical
 * (the "two memory cards" scenario), and once that pairing also ambiguates
 * a file (`file_matches_multiple_assets`), that reason's own `assets` list
 * carries the same literal string twice. Showing it twice ("coincide con
 * varias fotos elegidas (DSC_0001.JPG, DSC_0001.JPG)") tells the
 * photographer nothing they didn't already know from the first name — de-
 * duplicated, order preserved. */
function dedupeNames(names: string[]): string[] {
  return [...new Set(names)];
}

/** Spanish, one-line explanation of WHY a pairing was excluded — the
 * reviewer's whole job is to make this legible without the photographer
 * having to reason about the matcher's own rules. */
function ambiguousReasonText(entry: AmbiguousMatch): string {
  switch (entry.reason) {
    case "duplicate_asset_basename": {
      const names = dedupeNames(entry.assets.map((asset) => asset.originalFilename));
      return `${names.join(" / ")}: mismo nombre entre fotos elegidas, no se puede distinguir cuál es cuál.`;
    }
    case "file_matches_multiple_assets": {
      const names = dedupeNames(entry.assets.map((asset) => asset.originalFilename));
      return names.length === 1
        ? `${entry.fileName} coincide con varias fotos elegidas que comparten el nombre ${names[0]}.`
        : `${entry.fileName} coincide con varias fotos elegidas (${names.join(", ")}).`;
    }
    case "asset_matches_multiple_files": {
      const names = dedupeNames(entry.fileNames);
      return names.length === 1
        ? `${entry.asset.originalFilename} coincide con varios archivos con el mismo nombre (${names[0]}).`
        : `${entry.asset.originalFilename} coincide con varios archivos (${names.join(", ")}).`;
    }
  }
}

export function FinalsBulkUploader({
  selectedAssets,
  onFinalUploaded,
}: {
  // The gallery's currently SELECTED assets — matching against anything
  // else is pointless, `final/route.ts`'s own `asset_not_selected` gate
  // (409) refuses every one of them. <GalleryWorkspace> only renders this
  // component once this list is non-empty (see that file's own comment on
  // why: "con cero elegidas no hay a que mapear").
  selectedAssets: WorkspaceAsset[];
  onFinalUploaded: (assetId: string) => void;
}) {
  const [plan, setPlan] = useState<FinalMatchPlan | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);

  if (selectedAssets.length === 0) return null;

  function resetInput(input: HTMLInputElement | null) {
    if (input) input.value = "";
  }

  function handleFilesChosen(fileList: FileList, input: HTMLInputElement | null) {
    const files = Array.from(fileList);
    resetInput(input);
    if (files.length === 0) return;

    const fileNames = files.map((file) => file.name);
    const assetInputs = selectedAssets.map((asset) => ({
      id: asset.id,
      originalFilename: asset.originalFilename,
    }));
    const nextPlan = matchFinalFiles(assetInputs, fileNames);
    setPlan(nextPlan);
    setPendingFiles(files);
    setItems(
      nextPlan.matches.map((match) => ({
        assetId: match.asset.id,
        originalFilename: match.asset.originalFilename,
        fileName: match.fileName,
        status: "pending",
      })),
    );
  }

  function handleCancel() {
    setPlan(null);
    setPendingFiles([]);
    setItems([]);
  }

  // The ONE place that talks to POST /api/assets/[assetId]/final for a
  // bulk batch — a `for`/`await` loop, not `Promise.all`, see the file
  // header for why. A failed file marks its own item `error` and
  // `continue`s: the acceptance criterion (#9) is that one bad file never
  // costs the photographer the rest of a batch they may have spent minutes
  // building.
  async function handleConfirm() {
    if (!plan || busy || plan.matches.length === 0) return;
    setBusy(true);

    for (let index = 0; index < plan.matches.length; index++) {
      const match = plan.matches[index]!;
      const file = pendingFiles[match.fileIndex];
      setItems((prev) => setItemStatus(prev, index, "uploading"));

      if (!file) {
        // Defensive only — `fileIndex` always comes straight out of the
        // same `pendingFiles` array the plan was computed from, so this
        // should be unreachable. Treated as this item's own error rather
        // than thrown, so it cannot take the rest of the loop down.
        setItems((prev) => setItemStatus(prev, index, "error", "Archivo no encontrado."));
        continue;
      }

      try {
        const formData = new FormData();
        formData.set("file", file);
        const response = await fetch(`/api/assets/${match.asset.id}/final`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setItems((prev) =>
            setItemStatus(prev, index, "error", body.error ?? `Error ${response.status}`),
          );
          continue;
        }

        setItems((prev) => setItemStatus(prev, index, "done"));
        onFinalUploaded(match.asset.id);
      } catch {
        setItems((prev) => setItemStatus(prev, index, "error", "No se pudo conectar."));
      }
    }

    setBusy(false);
  }

  const doneCount = items.filter((item) => item.status === "done").length;

  return (
    <div className="border-line-2 flex flex-col gap-3 rounded-[6px] border border-dashed p-4">
      <span className="text-fg text-sm font-medium">Subir finales en lote</span>
      <span className="text-fg-dim text-xs">
        Elegí varios archivos exportados de una vez — se proponen las coincidencias por nombre antes
        de subir nada.
      </span>

      {!plan && (
        <label
          className={
            "border-line-2 hover:border-accent flex min-h-9 w-fit cursor-pointer items-center rounded-[4px] border px-3 text-xs font-semibold tracking-[0.04em] uppercase transition-colors"
          }
        >
          Elegir archivos
          <input
            type="file"
            accept="image/jpeg"
            multiple
            className="sr-only"
            onChange={(event) => {
              if (event.target.files) handleFilesChosen(event.target.files, event.target);
            }}
          />
        </label>
      )}

      {plan && (
        <div className="flex flex-col gap-3">
          {/* The review screen — task #217's actual requirement, shown
              BEFORE a single request goes out. */}
          <p className="text-fg-dim text-xs">
            {plan.matches.length} emparejada{plan.matches.length === 1 ? "" : "s"},{" "}
            {plan.unmatchedFiles.length} archivo{plan.unmatchedFiles.length === 1 ? "" : "s"} sin
            destino, {plan.assetsWithoutFile.length} elegida
            {plan.assetsWithoutFile.length === 1 ? "" : "s"} sin archivo
            {plan.ambiguous.length > 0
              ? `, ${plan.ambiguous.length} ambigüedad${plan.ambiguous.length === 1 ? "" : "es"}.`
              : "."}
          </p>

          {plan.ambiguous.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-[#e0796b]">
              {plan.ambiguous.map((entry, index) => (
                <li key={index}>{ambiguousReasonText(entry)}</li>
              ))}
            </ul>
          )}

          {plan.unmatchedFiles.length > 0 && (
            <p className="text-fg-mute text-xs">
              Sin destino: {plan.unmatchedFiles.map((file) => file.fileName).join(", ")}
            </p>
          )}
          {plan.assetsWithoutFile.length > 0 && (
            <p className="text-fg-mute text-xs">
              Sin archivo:{" "}
              {plan.assetsWithoutFile.map((asset) => asset.originalFilename).join(", ")}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy || plan.matches.length === 0}
              onClick={() => void handleConfirm()}
              className="border-line-2 hover:border-accent min-h-9 rounded-[4px] border px-3 text-xs font-semibold tracking-[0.04em] uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              Confirmar y subir {plan.matches.length}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleCancel}
              className="text-fg-dim min-h-9 text-xs underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>

          {items.length > 0 && (
            <>
              <p className="text-fg-mute text-xs">
                {doneCount} de {items.length} subidas
              </p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
                {items.map((item, index) => (
                  <li
                    key={`${item.assetId}-${index}`}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-fg-dim truncate">
                      {item.originalFilename} ← {item.fileName}
                    </span>
                    <span
                      className={
                        item.status === "error"
                          ? "text-[#e0796b]"
                          : item.status === "done"
                            ? "text-accent-2"
                            : "text-fg-mute"
                      }
                    >
                      {statusLabel(item)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
