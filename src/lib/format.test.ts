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
