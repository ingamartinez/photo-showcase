// Filename helpers for flash downloads (epic #232, slice #234). ASCII-only
// output by construction, so safe in `Content-Disposition` and zip entry names.
function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extensionFromKey(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot >= 0 && dot < key.length - 1 ? key.slice(dot + 1).toLowerCase() : "jpg";
}

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function flashZipFilename(title: string): string {
  return `${slugify(title) || "galeria"}-fotos.zip`;
}

/** Name for one photo (download or zip entry); `used` dedupes within a zip. */
export function flashPhotoFilename(
  originalFilename: string,
  finalKey: string,
  used: Set<string> = new Set(),
): string {
  const base = slugify(stripExtension(originalFilename)) || "foto";
  const ext = extensionFromKey(finalKey);
  let candidate = `${base}.${ext}`;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}.${ext}`;
  used.add(candidate);
  return candidate;
}
