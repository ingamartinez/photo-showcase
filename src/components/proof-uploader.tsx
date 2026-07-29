"use client";

// Multi-file upload against the ONE-FILE-PER-REQUEST route from task #15
// (src/app/api/galleries/[galleryId]/proofs/route.ts) — that route's own
// header comment explains why it never accepts a batch: `request.formData()`
// buffers the whole multipart body up front, so this component, not the
// server, is what "loops over the file list".
//
// Concurrency: strictly sequential (one in-flight request at a time), not a
// small bounded batch. Two reasons this is the safer choice, not just the
// simpler one, for a droplet whose `photoshowcase.service` caps at
// `MemoryMax=768M` and shares the box with findash:
//   - Each request buffers its ENTIRE body (up to `MAX_UPLOAD_BYTES`, 50 MB,
//     though a real export is closer to 8 MB) resident in the server process
//     for the request's lifetime. N concurrent requests means N such bodies
//     resident at once — a batch size chosen "small" is still a multiplier
//     on the single biggest cost this route has.
//   - `processProof`'s own mutex (src/lib/images.ts's `runExclusive`)
//     already serializes the decode/watermark step process-wide. Firing
//     several requests concurrently would not shorten the CPU-bound part of
//     the pipeline at all — those requests would just queue there while
//     STILL holding their raw bytes in memory, which is strictly worse than
//     not having sent them yet.
// Sequential upload was measured against ~100 synthetic files during this
// task's own verification (see the task's final report for the observed RSS
// peak) specifically because "guess, don't measure" is exactly what task #20
// calls out as unacceptable here.
import { useRef, useState } from "react";
import type { WorkspaceAsset } from "@/components/gallery-workspace";

type UploadItemStatus = "pending" | "uploading" | "done" | "error";

type UploadItem = {
  name: string;
  status: UploadItemStatus;
  error?: string;
};

type UploadedAssetResponse = {
  asset: {
    id: string;
    proofKey: string;
    width: number;
    height: number;
    sortOrder: number;
    originalFilename: string;
  };
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
      return "Lista";
    case "error":
      return item.error ?? "Error";
  }
}

/** Fetches a fresh presigned URL for a just-uploaded asset from the read
 * route (task #16) — the upload response only ever returns the R2 KEY (see
 * the proofs route's response shape), never a URL, so this is the same
 * request any other viewer of this proof would make. Returns "" on failure
 * rather than throwing: a thumbnail that fails to load once is recoverable
 * (<AssetTile>'s own `onError` retries it), losing the whole upload result
 * over a presign hiccup is not. */
async function fetchProofUrl(assetId: string): Promise<string> {
  try {
    const response = await fetch(`/api/assets/${assetId}/proof`);
    if (!response.ok) return "";
    const body = (await response.json()) as { url: string };
    return body.url;
  } catch {
    return "";
  }
}

export function ProofUploader({
  galleryId,
  onUploaded,
}: {
  galleryId: string;
  onUploaded: (asset: WorkspaceAsset) => void;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setBusy(true);
    setItems(files.map((file) => ({ name: file.name, status: "pending" })));

    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      setItems((prev) => setItemStatus(prev, index, "uploading"));

      try {
        const formData = new FormData();
        formData.set("file", file);
        const response = await fetch(`/api/galleries/${galleryId}/proofs`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setItems((prev) =>
            setItemStatus(prev, index, "error", body.error ?? `Error ${response.status}`),
          );
          // Deliberately `continue`, not `break`: task #20's acceptance
          // criterion is that ONE bad file must not lose the rest of the
          // batch — a photographer uploading 100 photos will not enjoy
          // starting over because file #37 was corrupt.
          continue;
        }

        const body = (await response.json()) as UploadedAssetResponse;
        const proofUrl = await fetchProofUrl(body.asset.id);

        setItems((prev) => setItemStatus(prev, index, "done"));
        onUploaded({
          id: body.asset.id,
          originalFilename: body.asset.originalFilename,
          proofWidth: body.asset.width,
          proofHeight: body.asset.height,
          isSelected: false,
          sortOrder: body.asset.sortOrder,
          proofUrl,
          // A freshly uploaded proof is never selected yet (see the line
          // above), so it can never already have a final either — task #26.
          hasFinal: false,
        });
      } catch {
        setItems((prev) => setItemStatus(prev, index, "error", "No se pudo conectar."));
      }
    }

    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="border-line-2 flex flex-col gap-4 rounded-sm border p-6">
      <span className="label text-fg-mute">Subir fotos</span>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={busy}
        onChange={(event) => {
          if (event.target.files) void handleFiles(event.target.files);
        }}
        className="text-fg-dim text-[15px]"
      />
      {items.length > 0 && (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto text-sm">
          {items.map((item, index) => (
            <li key={`${item.name}-${index}`} className="flex items-center justify-between gap-3">
              <span className="text-fg-dim truncate">{item.name}</span>
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
      )}
    </div>
  );
}
