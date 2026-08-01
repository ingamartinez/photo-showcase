// Natural (numeric-aware) comparator for `assets.originalFilename` — task
// #199's "Ordenar por nombre de archivo" button. The owner's own framing was
// "como en mi Lightroom": IMG_2.JPG has to sort before IMG_10.JPG, which a
// plain lexicographic comparison gets backwards — `"IMG_10".localeCompare("IMG_2")`
// is NEGATIVE (the character '1' sorts before '2'), so a bare `.sort()` or an
// option-less `localeCompare` puts IMG_10 first. `Intl.Collator`'s
// `numeric: true` option is what fixes that: it compares embedded digit runs
// by their numeric value instead of character-by-character.
//
// `sensitivity: "base"` on top of that makes `.JPG` and `.jpg` sort together
// (case does not participate in the comparison at all) — real libraries mix
// extension casing depending on which app/camera wrote the file, and nothing
// about "sort by name" should silently group all-caps extensions apart from
// lowercase ones.
//
// INSTANTIATED ONCE, AT MODULE SCOPE. Constructing an `Intl.Collator` does
// real locale-data work; this comparator runs inside `.sort()`'s O(n log n)
// comparisons, so building a fresh one per call would repeat that work on
// every single comparison instead of once per gallery sort.
const filenameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export type NaturalSortable = {
  id: string;
  originalFilename: string;
};

/**
 * Orders `NaturalSortable`s by `originalFilename`, natural/numeric-aware and
 * case-insensitive on the extension, with a deterministic tie-break on `id`.
 *
 * TIE-BREAK ON ID, NOT LEFT AT 0: two assets in the same gallery can share an
 * original filename — two memory cards both starting their own numbering at
 * DSC_0001.JPG, say (`download-all/route.ts`'s own zip-entry-naming logic
 * already accounts for this same possibility, independently). Without a
 * deterministic tie-break, sorting the same array twice with a comparator
 * that returns 0 for a tie is not guaranteed to reproduce the same order —
 * `Array.prototype.sort`'s stability guarantee is only with respect to the
 * INPUT order it was given, which two independent reads of the same gallery
 * are not guaranteed to share. Without this, a photographer pressing the
 * button twice could watch two identically-named photos swap places for no
 * visible reason.
 */
export function compareByFilenameNatural(a: NaturalSortable, b: NaturalSortable): number {
  const byFilename = filenameCollator.compare(a.originalFilename, b.originalFilename);
  if (byFilename !== 0) return byFilename;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
