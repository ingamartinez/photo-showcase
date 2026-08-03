import { describe, expect, it } from "vitest";
import { matchFinalFiles, type SelectedAsset } from "./final-filename-match";

function asset(id: string, originalFilename: string): SelectedAsset {
  return { id, originalFilename };
}

describe("matchFinalFiles", () => {
  it("matches a file whose base name is exactly equal, ignoring extension and case", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_0123.JPG")], ["dsc_0123.jpeg"]);
    expect(plan.matches).toEqual([
      { asset: asset("a1", "DSC_0123.JPG"), fileIndex: 0, fileName: "dsc_0123.jpeg" },
    ]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unmatchedFiles).toEqual([]);
    expect(plan.assetsWithoutFile).toEqual([]);
  });

  it("matches a file carrying a suffix after the asset's base name, separated by a non-alphanumeric character", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_0123.JPG")], ["DSC_0123-Edit.jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({ asset: asset("a1", "DSC_0123.JPG"), fileIndex: 0 });
  });

  // Mutation target #1: removing the separator requirement from
  // `isSuffixMatch` (treating ANY prefix as a suffix match) makes this pass
  // incorrectly — DSC_012 would match DSC_0123.
  it("does NOT match DSC_012 against DSC_0123 — the character after the shared prefix is alphanumeric, not a separator", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_012.JPG")], ["DSC_0123.JPG"]);
    expect(plan.matches).toEqual([]);
    expect(plan.unmatchedFiles).toEqual([{ fileIndex: 0, fileName: "DSC_0123.JPG" }]);
    expect(plan.assetsWithoutFile).toEqual([asset("a1", "DSC_012.JPG")]);
  });

  // Mutation target #2: if the duplicate-basename detection is disabled (it
  // matches anyway instead of flagging ambiguity), the FIRST assertion below
  // goes red (`matches` would contain a pairing instead of being empty).
  //
  // Note: because a1/a2 share the exact same normalized base name, the one
  // file that matches either of them necessarily matches BOTH — so this
  // scenario also trips the independent "a file matched multiple assets"
  // rule. Both reasons are asserted, deliberately: this is the real shape a
  // photographer would see, not a trimmed-down version of it.
  it("marks BOTH assets ambiguous when two selected assets share a normalized base name, even though a file matches both exactly", () => {
    const a1 = asset("a1", "DSC_0001.JPG");
    const a2 = asset("a2", "DSC_0001.JPG");
    const plan = matchFinalFiles([a1, a2], ["DSC_0001.jpg"]);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toEqual([
      { reason: "duplicate_asset_basename", assets: [a1, a2] },
      {
        reason: "file_matches_multiple_assets",
        fileIndex: 0,
        fileName: "DSC_0001.jpg",
        assets: [a1, a2],
      },
    ]);
    expect(plan.unmatchedFiles).toEqual([]);
    expect(plan.assetsWithoutFile).toEqual([]);
  });

  it("marks a file ambiguous when it matches two different selected assets with DIFFERENT base names, both via a valid suffix", () => {
    const a1 = asset("a1", "IMG.JPG");
    const a2 = asset("a2", "IMG_1.JPG");
    const plan = matchFinalFiles([a1, a2], ["IMG_1-Edit.jpg"]);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toEqual([
      {
        reason: "file_matches_multiple_assets",
        fileIndex: 0,
        fileName: "IMG_1-Edit.jpg",
        assets: [a1, a2],
      },
    ]);
    expect(plan.unmatchedFiles).toEqual([]);
    expect(plan.assetsWithoutFile).toEqual([]);
  });

  it("marks an asset ambiguous when two different files both match it (e.g. two competing exports)", () => {
    const a1 = asset("a1", "DSC_0123.JPG");
    const plan = matchFinalFiles([a1], ["DSC_0123-Edit.jpg", "DSC_0123-Edit-2.jpg"]);
    expect(plan.matches).toEqual([]);
    expect(plan.ambiguous).toEqual([
      {
        reason: "asset_matches_multiple_files",
        asset: a1,
        fileIndexes: [0, 1],
        fileNames: ["DSC_0123-Edit.jpg", "DSC_0123-Edit-2.jpg"],
      },
    ]);
  });

  it("reports files that matched no selected asset at all as unmatched, without dropping them silently", () => {
    const a1 = asset("a1", "DSC_0001.JPG");
    const plan = matchFinalFiles([a1], ["DSC_0001.jpg", "DSC_9999.jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.unmatchedFiles).toEqual([{ fileIndex: 1, fileName: "DSC_9999.jpg" }]);
  });

  it("reports selected assets that matched no file at all as assetsWithoutFile, without dropping them silently", () => {
    const a1 = asset("a1", "DSC_0001.JPG");
    const a2 = asset("a2", "DSC_0002.JPG");
    const plan = matchFinalFiles([a1, a2], ["DSC_0001.jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.assetsWithoutFile).toEqual([a2]);
  });

  // Review-caught gap (#217 secundario 3): only `-` and `_` were exercised
  // among the five characters in `SUFFIX_SEPARATORS` — reducing the set to
  // just those two left the suite green. One test per remaining separator.
  it("matches a suffix separated by a space", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_0123.JPG")], ["DSC_0123 final.jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({ asset: asset("a1", "DSC_0123.JPG"), fileIndex: 0 });
  });

  it("matches a suffix separated by an opening parenthesis", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_0123.JPG")], ["DSC_0123(1).jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({ asset: asset("a1", "DSC_0123.JPG"), fileIndex: 0 });
  });

  it("matches a suffix separated by a dot — e.g. DSC_0123.final.jpg, only the LAST dot is stripped as the extension", () => {
    const plan = matchFinalFiles([asset("a1", "DSC_0123.JPG")], ["DSC_0123.final.jpg"]);
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0]).toMatchObject({ asset: asset("a1", "DSC_0123.JPG"), fileIndex: 0 });
  });

  // Review-caught gap (#217 secundario 4): the asset-side precedence guard
  // (`assetsWithExact`, skipping an asset that already has an exact match
  // before even trying a suffix pass) is covered above ("prefers an exact
  // match…"), but the FILE-side guard (`filesWithExact`, refusing to let a
  // file that already has an exact match with one asset ALSO suffix-match a
  // different asset) had no test of its own.
  it("does not let a file that already has an exact match steal a suffix match with a different asset", () => {
    const a1 = asset("a1", "IMG_1.JPG");
    const a2 = asset("a2", "IMG.JPG");
    const plan = matchFinalFiles([a1, a2], ["IMG_1.jpg"]);
    // Without the file-side guard, "IMG_1.jpg" would ALSO suffix-match a2
    // ("img" + "_1" — "_" is a valid separator), turning a1's clean exact
    // match into a false "file matches multiple assets" ambiguity.
    expect(plan.matches).toEqual([{ asset: a1, fileIndex: 0, fileName: "IMG_1.jpg" }]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.assetsWithoutFile).toEqual([a2]);
  });

  it("prefers an exact match over a suffix match for the same asset when both are present among different files", () => {
    const a1 = asset("a1", "DSC_0123.JPG");
    const plan = matchFinalFiles([a1], ["DSC_0123-Edit.jpg", "DSC_0123.jpg"]);
    // Both candidate files are valid, non-conflicting shapes for DSC_0123 —
    // one is exact, one is a suffix. Since the asset only gets a candidate
    // from ITS exact match (suffix pass is skipped entirely once an exact
    // exists for that asset), there is no ambiguity: the suffix-only file is
    // simply unmatched.
    expect(plan.matches).toEqual([{ asset: a1, fileIndex: 1, fileName: "DSC_0123.jpg" }]);
    expect(plan.unmatchedFiles).toEqual([{ fileIndex: 0, fileName: "DSC_0123-Edit.jpg" }]);
    expect(plan.ambiguous).toEqual([]);
  });

  it("returns an empty plan for no assets and no files", () => {
    const plan = matchFinalFiles([], []);
    expect(plan).toEqual({ matches: [], ambiguous: [], unmatchedFiles: [], assetsWithoutFile: [] });
  });
});
