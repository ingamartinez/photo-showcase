import { describe, expect, it } from "vitest";

describe("formatCop", () => {
  it("formats a whole-COP amount without decimals", async () => {
    const { formatCop } = await import("./format");
    // Intl inserts a non-breaking space between the symbol and the digits in
    // the "es-CO" locale — normalize whitespace instead of asserting the
    // exact byte, since that's an ICU implementation detail, not part of
    // this function's contract.
    expect(formatCop(5_000).replace(/\s/g, " ")).toBe("$ 5.000");
  });

  it("never renders a decimal point for a round amount", async () => {
    const { formatCop } = await import("./format");
    expect(formatCop(150_000)).not.toContain(",00");
  });
});

// Moved here from src/lib/clients.test.ts (task #49) — see this file's
// section comment on `formatClientGalleryCount` for why.
describe("formatClientGalleryCount", () => {
  it.each([
    [0, "Sin galerías todavía"],
    [1, "1 galería"],
    [2, "2 galerías"],
    [13, "13 galerías"],
  ])("formats %i as %s", async (galleryCount, expected) => {
    const { formatClientGalleryCount } = await import("./format");
    expect(formatClientGalleryCount(galleryCount)).toBe(expected);
  });
});

// Moved here from src/lib/galleries.test.ts (task #49/#90) — see this file's
// section comment on `formatStudioGalleryCount` for why.
describe("formatStudioGalleryCount", () => {
  it.each([
    [1, "1 galería"],
    [2, "2 galerías"],
    [13, "13 galerías"],
  ])("formats %i as %s", async (galleryCount, expected) => {
    const { formatStudioGalleryCount } = await import("./format");
    expect(formatStudioGalleryCount(galleryCount)).toBe(expected);
  });
});

// Moved here from src/lib/clients.test.ts (task #122) — see this file's
// section comment on `formatClientCount` for why.
describe("formatClientCount", () => {
  it.each([
    [1, "1 cliente"],
    [2, "2 clientes"],
    [13, "13 clientes"],
  ])("formats %i as %s", async (clientCount, expected) => {
    const { formatClientCount } = await import("./format");
    expect(formatClientCount(clientCount)).toBe(expected);
  });
});

// Moved here from src/lib/galleries.test.ts (task #122) — see this file's
// section comment on `formatPendingSelectionCount` for why.
describe("formatPendingSelectionCount", () => {
  it.each([
    [0, null],
    [1, "1 selección esperando"],
    [2, "2 selecciones esperando"],
    [5, "5 selecciones esperando"],
  ])("formats %s as %s", async (pendingCount, expected) => {
    const { formatPendingSelectionCount } = await import("./format");
    expect(formatPendingSelectionCount(pendingCount)).toBe(expected);
  });
});

// Task #130 review round 1: added when a review caught the `/dashboard` stat
// tiles calling `formatClientCount`/`formatStudioGalleryCount` (full
// sentences) for their own number line except at zero, where the page fell
// back to a literal `"0"` — three tiles in the same grid row, three
// different value shapes. This is the bare, locale-grouped digit every tile
// uses now, in every state.
describe("formatTileCount", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [13, "13"],
  ])("formats %i as %s", async (count, expected) => {
    const { formatTileCount } = await import("./format");
    expect(formatTileCount(count)).toBe(expected);
  });

  // The one behavior a bare `${count}` template literal would NOT give —
  // same reasoning `formatCop` above has for reaching for `Intl.NumberFormat`
  // instead of a template literal.
  it("groups thousands the moment a studio's count crosses three figures", async () => {
    const { formatTileCount } = await import("./format");
    expect(formatTileCount(1_234).replace(/\s/g, " ")).toBe("1.234");
  });
});

// Task #92: the gallery detail page's archive-size warning
// (`@/lib/gallery-archive-size`) is the one caller today.
describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [1024, "1.0 KB"],
    [1536, "1.5 KB"],
    [20 * 1024 * 1024, "20.0 MB"],
    [4.1 * 1024 * 1024 * 1024, "4.1 GB"],
  ])("formats %s bytes as %s", async (bytes, expected) => {
    const { formatBytes } = await import("./format");
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("never scales past GB — the largest unit this app's numbers ever need", async () => {
    const { formatBytes } = await import("./format");
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1024.0 GB");
  });
});

// Task #276 — the gallery list's filtered header, pager range and position.
describe("formatFilteredGalleryCount", () => {
  it.each([
    [3, 63, "3 de 63 galerías"],
    [1, 1, "1 de 1 galería"],
    [0, 5, "0 de 5 galerías"],
  ])("formats %i of %i as %s", async (matching, total, expected) => {
    const { formatFilteredGalleryCount } = await import("./format");
    expect(formatFilteredGalleryCount(matching, total)).toBe(expected);
  });
});

describe("formatGalleryPageRange", () => {
  it("uses a real en dash between the bounds", async () => {
    const { formatGalleryPageRange } = await import("./format");
    const range = formatGalleryPageRange(26, 50, 63);

    expect(range).toBe("Mostrando 26\u201350 de 63");
    // The code point, not just the glyph: a hyphen would be a different
    // character that renders similarly at small sizes.
    expect(range.codePointAt(range.indexOf("2") + 2)).toBe(0x2013);
  });
});

describe("formatPageOf", () => {
  it.each([
    [1, 3, "Página 1 de 3"],
    [2, 3, "Página 2 de 3"],
  ])("formats page %i of %i as %s", async (page, pageCount, expected) => {
    const { formatPageOf } = await import("./format");
    expect(formatPageOf(page, pageCount)).toBe(expected);
  });
});

// Task #280 — the refusal shown when a client cannot be deleted. One test per
// branch of the agreement table: singular/plural on EACH noun, the flash clause
// appearing only when a flash membership exists, and the two sentences never
// bleeding into each other.
describe("formatClientDeleteBlocked", () => {
  const cases: [
    string,
    { galleries: number; flashGalleries: number; pickedGalleries: number },
    string,
  ][] = [
    [
      "one gallery",
      { galleries: 1, flashGalleries: 0, pickedGalleries: 0 },
      "No se puede eliminar: tiene 1 galería activa. Primero quítale el acceso desde cada una.",
    ],
    [
      "several galleries",
      { galleries: 2, flashGalleries: 0, pickedGalleries: 0 },
      "No se puede eliminar: tiene 2 galerías activas. Primero quítale el acceso desde cada una.",
    ],
    [
      "one flash gallery, named as flash",
      { galleries: 0, flashGalleries: 1, pickedGalleries: 0 },
      "No se puede eliminar: tiene 1 galería flash activa. Primero quítale el acceso desde cada una.",
    ],
    [
      "several flash galleries",
      { galleries: 0, flashGalleries: 3, pickedGalleries: 0 },
      "No se puede eliminar: tiene 3 galerías flash activas. Primero quítale el acceso desde cada una.",
    ],
    [
      "both kinds, plural agreement across the pair",
      { galleries: 1, flashGalleries: 1, pickedGalleries: 0 },
      "No se puede eliminar: tiene 1 galería y 1 galería flash activas. Primero quítale el acceso desde cada una.",
    ],
    [
      "picks in one gallery",
      { galleries: 0, flashGalleries: 0, pickedGalleries: 1 },
      "No se puede eliminar: conserva fotos pedidas en 1 galería de las que ya se le quitó el acceso. Eliminarlo borraría esos pedidos.",
    ],
    [
      "picks in several galleries",
      { galleries: 0, flashGalleries: 0, pickedGalleries: 4 },
      "No se puede eliminar: conserva fotos pedidas en 4 galerías de las que ya se le quitó el acceso. Eliminarlo borraría esos pedidos.",
    ],
  ];

  it.each(cases)("formats %s", async (_label, counts, expected) => {
    const { formatClientDeleteBlocked } = await import("./format");
    expect(formatClientDeleteBlocked(counts)).toBe(expected);
  });
});
