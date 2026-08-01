import { describe, expect, it } from "vitest";
import { compareByFilenameNatural } from "./natural-sort";

function itemFor(originalFilename: string, id = originalFilename) {
  return { id, originalFilename };
}

describe("compareByFilenameNatural", () => {
  // Task #199's own explicit trap: a test using only single-digit filenames
  // (IMG_1 vs IMG_2) passes under a plain lexicographic comparator too, and
  // proves nothing about the numeric-aware behavior this function exists
  // for. IMG_10 vs IMG_2 is the case where the two comparators disagree —
  // `"IMG_10".localeCompare("IMG_2")` is negative (lexicographic: '1' < '2'),
  // which is backwards from how a photographer reads a numbered sequence.
  it("orders IMG_2 before IMG_10 (natural, not lexicographic)", () => {
    const result = [itemFor("IMG_10.JPG"), itemFor("IMG_2.JPG")].sort(compareByFilenameNatural);

    expect(result.map((item) => item.originalFilename)).toEqual(["IMG_2.JPG", "IMG_10.JPG"]);
  });

  it("orders a full natural sequence correctly, not lexicographically", () => {
    const shuffled = [
      itemFor("IMG_100.JPG"),
      itemFor("IMG_1.JPG"),
      itemFor("IMG_20.JPG"),
      itemFor("IMG_3.JPG"),
    ];

    const result = shuffled.sort(compareByFilenameNatural).map((item) => item.originalFilename);

    expect(result).toEqual(["IMG_1.JPG", "IMG_3.JPG", "IMG_20.JPG", "IMG_100.JPG"]);
  });

  // Criterion #5: `.JPG` and `.jpg` sort together, not grouped by case.
  it("treats .JPG and .jpg as equal-case, interleaving by the numeric-aware name alone", () => {
    const shuffled = [itemFor("img_2.jpg"), itemFor("IMG_1.JPG"), itemFor("IMG_3.JPG")];

    const result = shuffled.sort(compareByFilenameNatural).map((item) => item.originalFilename);

    expect(result).toEqual(["IMG_1.JPG", "img_2.jpg", "IMG_3.JPG"]);
  });

  // Trap called out in the kanban body: two assets sharing a filename (two
  // memory cards, each starting their own numbering) must not depend on
  // whatever order the database happens to return them in.
  it("breaks a filename tie deterministically by id, not by input order", () => {
    const a = itemFor("DSC_0001.JPG", "id-b");
    const b = itemFor("DSC_0001.JPG", "id-a");

    // Regardless of which one is passed first...
    expect([a, b].sort(compareByFilenameNatural).map((item) => item.id)).toEqual(["id-a", "id-b"]);
    expect([b, a].sort(compareByFilenameNatural).map((item) => item.id)).toEqual(["id-a", "id-b"]);
  });

  it("returns 0 for two identical (filename, id) entries", () => {
    const a = itemFor("IMG_1.JPG", "same-id");
    const b = itemFor("IMG_1.JPG", "same-id");

    expect(compareByFilenameNatural(a, b)).toBe(0);
  });
});
