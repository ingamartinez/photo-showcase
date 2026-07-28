// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SelectionCounter } from "./selection-counter";
import { computeQuota } from "@/lib/quota";

// `@/lib/galleries` (transitively, via src/lib/db) pulls in a bare `import
// "server-only"` that jsdom cannot resolve even with `vi.mock("server-only",
// ...)` — see src/app/galleries/[publicSlug]/page.chrome.test.tsx's own
// comment on the same issue. Mocked wholesale here instead, with `formatCop`
// reimplemented against the exact same Intl call as the real one.
vi.mock("@/lib/galleries", () => ({
  formatCop: (amountCop: number) =>
    new Intl.NumberFormat("es-CO", {
      style: "currency",
      currency: "COP",
      maximumFractionDigits: 0,
    }).format(amountCop),
}));

afterEach(() => {
  cleanup();
});

describe("SelectionCounter", () => {
  it("renders the package name, included, selected, extras and surcharge — task #24's exact shape", () => {
    const quota = computeQuota(15, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });

    render(<SelectionCounter packageName="Estándar" quota={quota} />);

    const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
    expect(text).toContain("Estándar");
    expect(text).toContain("incluidas 13");
    expect(text).toContain("seleccionadas 15");
    expect(text).toContain("extras 2");
    expect(text).toContain("$ 5.000");
    expect(text).toContain("$ 10.000");
  });

  it("still shows all three parts (never hides the row) when nobody has selected anything yet", () => {
    const quota = computeQuota(0, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });

    render(<SelectionCounter packageName="Estándar" quota={quota} />);

    const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
    expect(text).toContain("seleccionadas 0");
    expect(text).toContain("extras 0");
  });

  it("never blocks or scolds when far over the included count — just informs with the real numbers", () => {
    const quota = computeQuota(30, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });

    render(<SelectionCounter packageName="Premium" quota={quota} />);

    const text = screen.getByText(/incluidas/).textContent?.replace(/\s+/g, " ");
    expect(text).toContain("seleccionadas 30");
    expect(text).toContain("extras 17");
    expect(text).toContain("$ 85.000");
  });
});
