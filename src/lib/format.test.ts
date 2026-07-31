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
