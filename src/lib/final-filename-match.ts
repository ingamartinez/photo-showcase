// Bulk-finals filename matcher — task #217: "quiero subir las fotos en bulk
// y hacer el mapeo a las que seleccionaron", proposed as PURE logic so the
// component (src/components/finals-bulk-uploader.tsx) only ever has to
// render whatever this returns, never re-derive it.
//
// THE RISK THIS FILE EXISTS TO GUARD: `assets.originalFilename` is NOT a
// key — the `assets` table (schema.ts) declares no unique index on it, and
// this repo already has that fact written down twice as a KNOWN condition,
// not a hypothesis: src/lib/natural-sort.ts's own header ("two memory cards
// both starting their own numbering at DSC_0001.JPG") and
// download-all/route.ts's `buildZipEntryFilename` comment. A wrong mapping
// here does not fail loudly — it hands a client someone else's photo, and
// the photographer only finds out when the client complains. So this module
// NEVER guesses: every ambiguous case is reported, never resolved, and the
// caller (the review screen) is what decides whether to exclude it from the
// automatic batch — see that component's own header for the UI half of this
// contract.
//
// THE OWNER'S OWN MAPPING RULE (kanban #217 body, verbatim): "el sufijo y la
// extension pueden cambiar. pero el nombre se mantiene." `DSC_0123.JPG`
// (the proof) can come back as `DSC_0123.jpg`, `DSC_0123-Edit.jpg`, or
// `DSC_0123_final.jpeg` — the base name is fixed, only a SUFFIX and the
// extension may change.
//
// NORMALIZATION IS DELIBERATELY MINIMAL: extension-strip + `toLowerCase()`,
// nothing else. This is NOT `slugifyForFilename` (final/route.ts,
// download-all/route.ts) — that helper does NFKD normalization, strips
// diacritics, and collapses every run of non-alphanumeric characters into a
// single hyphen. That is exactly aggressive enough to fabricate a match
// between two filenames that are not actually the same photo (e.g. it would
// collapse two otherwise-different names sharing punctuation into the same
// slug). The strip-extension logic mirrors the two existing copies
// (final/route.ts's own `stripExtension`, duplicated again in
// download-all/route.ts, both on purpose per their own comments) — a third
// copy here, not a shared import, matching that established precedent
// rather than inventing a fourth semantics.

export type SelectedAsset = {
  id: string;
  originalFilename: string;
};

/** One proposed pairing: `asset` gets `fileName` (found at `fileIndex` in
 * the caller's own file list) uploaded as its final. */
export type FinalMatch = {
  asset: SelectedAsset;
  fileIndex: number;
  fileName: string;
};

/** Every reason a candidate pairing gets pulled OUT of the automatic batch.
 * A discriminated union, not a bare string: each variant carries exactly the
 * assets/files the reviewer needs to show the photographer WHY, with no
 * further lookup required. */
export type AmbiguousMatch =
  | {
      reason: "duplicate_asset_basename";
      // Two or more SELECTED assets whose normalized basename collides —
      // the "two memory cards" case. Whichever of these matched a file, all
      // of them did, and none of those matches is trustworthy.
      assets: SelectedAsset[];
    }
  | {
      reason: "file_matches_multiple_assets";
      fileIndex: number;
      fileName: string;
      assets: SelectedAsset[];
    }
  | {
      reason: "asset_matches_multiple_files";
      asset: SelectedAsset;
      fileIndexes: number[];
      fileNames: string[];
    };

export type FinalMatchPlan = {
  /** Unambiguous pairings — the ONLY thing the review screen's confirm
   * button is allowed to upload. */
  matches: FinalMatch[];
  /** Every pairing excluded from `matches`, with why. */
  ambiguous: AmbiguousMatch[];
  /** Chosen files that matched no selected asset at all. */
  unmatchedFiles: { fileIndex: number; fileName: string }[];
  /** Selected assets that matched no chosen file at all — "qué falta
   * exportar", reported with the same weight as the reverse case (rule e of
   * the task body). */
  assetsWithoutFile: SelectedAsset[];
};

/** Non-alphanumeric characters allowed to separate an asset's base filename
 * from an appended suffix. This set is what turns `DSC_0123` + `-Edit` into
 * a real suffix match while refusing `DSC_012` + `3` (i.e. `DSC_0123`) — the
 * character right after the shared prefix is `3`, which is alphanumeric and
 * therefore never a valid suffix start. */
const SUFFIX_SEPARATORS = new Set(["-", "_", " ", "(", "."]);

/** Strips a filename's extension (the part after the LAST `.`), same
 * semantics as the two existing copies in the API routes (see this file's
 * own header) — a leading dot is never treated as an extension. */
function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function normalizeBasename(filename: string): string {
  return stripExtension(filename).toLowerCase();
}

/** True when `fileBasename` is `assetBasename` plus a suffix that starts
 * with one of `SUFFIX_SEPARATORS` — an exact-length match is handled by the
 * caller's separate exact-match pass, never here. */
function isSuffixMatch(assetBasename: string, fileBasename: string): boolean {
  if (fileBasename.length <= assetBasename.length) return false;
  if (!fileBasename.startsWith(assetBasename)) return false;
  const nextChar = fileBasename.charAt(assetBasename.length);
  return SUFFIX_SEPARATORS.has(nextChar);
}

type Candidate = { assetId: string; fileIndex: number };

/**
 * Proposes a mapping from `fileNames` (a bulk file selection) onto
 * `selectedAssets` (the gallery's currently-selected assets only — an
 * unselected asset can never receive a final, `final/route.ts`'s own
 * `asset_not_selected` gate). Never guesses: every ambiguous pairing is
 * reported in `ambiguous`, not silently resolved by order, date, or
 * proximity, and excluded from `matches`.
 */
export function matchFinalFiles(
  selectedAssets: SelectedAsset[],
  fileNames: string[],
): FinalMatchPlan {
  const assetById = new Map(selectedAssets.map((asset) => [asset.id, asset] as const));
  const assetBasenames = new Map<string, string>();
  const basenameGroups = new Map<string, string[]>();
  for (const asset of selectedAssets) {
    const basename = normalizeBasename(asset.originalFilename);
    assetBasenames.set(asset.id, basename);
    const group = basenameGroups.get(basename);
    if (group) {
      group.push(asset.id);
    } else {
      basenameGroups.set(basename, [asset.id]);
    }
  }

  const fileBasenames = fileNames.map(normalizeBasename);

  // Exact match always wins (rule b). Suffix matching (rule c) only ever
  // considers an asset or a file that had NO exact candidate at all —
  // "sólo si no hubo exacto".
  const exactCandidates: Candidate[] = [];
  for (const asset of selectedAssets) {
    const assetBasename = assetBasenames.get(asset.id)!;
    fileBasenames.forEach((fileBasename, fileIndex) => {
      if (fileBasename === assetBasename) {
        exactCandidates.push({ assetId: asset.id, fileIndex });
      }
    });
  }
  const assetsWithExact = new Set(exactCandidates.map((c) => c.assetId));
  const filesWithExact = new Set(exactCandidates.map((c) => c.fileIndex));

  const suffixCandidates: Candidate[] = [];
  for (const asset of selectedAssets) {
    if (assetsWithExact.has(asset.id)) continue;
    const assetBasename = assetBasenames.get(asset.id)!;
    fileBasenames.forEach((fileBasename, fileIndex) => {
      if (filesWithExact.has(fileIndex)) return;
      if (isSuffixMatch(assetBasename, fileBasename)) {
        suffixCandidates.push({ assetId: asset.id, fileIndex });
      }
    });
  }

  const candidates = [...exactCandidates, ...suffixCandidates];

  const candidatesByAsset = new Map<string, Candidate[]>();
  const candidatesByFile = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const forAsset = candidatesByAsset.get(candidate.assetId);
    if (forAsset) forAsset.push(candidate);
    else candidatesByAsset.set(candidate.assetId, [candidate]);
    const forFile = candidatesByFile.get(candidate.fileIndex);
    if (forFile) forFile.push(candidate);
    else candidatesByFile.set(candidate.fileIndex, [candidate]);
  }

  const ambiguous: AmbiguousMatch[] = [];
  // Seeded with every duplicate-basename asset up front (rule d, first
  // bullet) — this exclusion holds even for the (impossible in practice,
  // guarded anyway) case where only one of a colliding pair produced a
  // candidate.
  const ambiguousAssetIds = new Set<string>();
  const ambiguousFileIndexes = new Set<number>();

  for (const group of basenameGroups.values()) {
    if (group.length <= 1) continue;
    for (const id of group) ambiguousAssetIds.add(id);
    const touchedFiles = group.flatMap((id) => candidatesByAsset.get(id) ?? []);
    if (touchedFiles.length === 0) continue; // nothing matched either — just "sin archivo", not a reviewable ambiguity
    for (const candidate of touchedFiles) ambiguousFileIndexes.add(candidate.fileIndex);
    ambiguous.push({
      reason: "duplicate_asset_basename",
      assets: group.map((id) => assetById.get(id)!),
    });
  }

  for (const [fileIndex, fileCandidates] of candidatesByFile) {
    if (fileCandidates.length <= 1) continue;
    ambiguousFileIndexes.add(fileIndex);
    const assetIds = fileCandidates.map((c) => c.assetId);
    for (const id of assetIds) ambiguousAssetIds.add(id);
    ambiguous.push({
      reason: "file_matches_multiple_assets",
      fileIndex,
      fileName: fileNames[fileIndex]!,
      assets: assetIds.map((id) => assetById.get(id)!),
    });
  }

  for (const [assetId, assetCandidates] of candidatesByAsset) {
    if (assetCandidates.length <= 1) continue;
    ambiguousAssetIds.add(assetId);
    const fileIndexes = assetCandidates.map((c) => c.fileIndex);
    for (const idx of fileIndexes) ambiguousFileIndexes.add(idx);
    ambiguous.push({
      reason: "asset_matches_multiple_files",
      asset: assetById.get(assetId)!,
      fileIndexes,
      fileNames: fileIndexes.map((idx) => fileNames[idx]!),
    });
  }

  const matches: FinalMatch[] = candidates
    .filter(
      (candidate) =>
        !ambiguousAssetIds.has(candidate.assetId) && !ambiguousFileIndexes.has(candidate.fileIndex),
    )
    .map((candidate) => ({
      asset: assetById.get(candidate.assetId)!,
      fileIndex: candidate.fileIndex,
      fileName: fileNames[candidate.fileIndex]!,
    }));

  const matchedFileIndexes = new Set(candidates.map((c) => c.fileIndex));
  const matchedAssetIds = new Set(candidates.map((c) => c.assetId));

  const unmatchedFiles = fileNames
    .map((fileName, fileIndex) => ({ fileIndex, fileName }))
    .filter(({ fileIndex }) => !matchedFileIndexes.has(fileIndex));

  const assetsWithoutFile = selectedAssets.filter((asset) => !matchedAssetIds.has(asset.id));

  return { matches, ambiguous, unmatchedFiles, assetsWithoutFile };
}
