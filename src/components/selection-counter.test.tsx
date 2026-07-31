// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SelectionCounter } from "./selection-counter";
import { computeQuota } from "@/lib/quota";

// No `@/lib/format` mock needed: unlike `@/lib/galleries`, it has no
// `server-only`/`@/lib/db` import for jsdom to choke on — see that module's
// own header comment for exactly why it was split out. The real `formatCop`
// runs here.

// Task #147 split the counter into two lines (see that file's own header
// comment): "incluidas/seleccionadas" and "extras/surcharge/no charge" no
// longer live in the same text node, so a single `getByText` cannot see
// both halves at once. This combines them the same way a sighted reader
// would — reading the whole block top to bottom — rather than pinning each
// line's own text query, which would make the two lines free to disagree
// with each other unnoticed.
function counterText(): string {
  const first = screen.getByText(/incluidas/).textContent ?? "";
  const second = screen.getByText(/^extras/).textContent ?? "";
  return `${first} ${second}`.replace(/\s+/g, " ");
}

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

    const text = counterText();
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

    const text = counterText();
    expect(text).toContain("seleccionadas 0");
    expect(text).toContain("extras 0");
  });

  it("never blocks or scolds when far over the included count — just informs with the real numbers", () => {
    const quota = computeQuota(30, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });

    render(<SelectionCounter packageName="Premium" quota={quota} />);

    const text = counterText();
    expect(text).toContain("seleccionadas 30");
    expect(text).toContain("extras 17");
    expect(text).toContain("$ 85.000");
  });

  // Task #147's own acceptance criterion: it must be clear the surcharge is
  // settled outside the app and never charged here — and it must be clear
  // EVERY time this renders, not only in the submit confirmation dialog
  // (<SubmitSelectionPanel>'s own copy, which fires once at the very end of
  // a session that can run twenty minutes).
  it("states plainly, on every render, that the app never charges — not only at submit time", () => {
    const quota = computeQuota(15, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });

    render(<SelectionCounter packageName="Estándar" quota={quota} />);

    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    expect(screen.getByText(/fuera de la app/)).toBeDefined();
  });

  // The sentence SHAPE must not change with the count — a counter that only
  // grows a clause once `extras > 0` would dramatize the exact moment of
  // going over, which is precisely the "feels like a threat" failure task
  // #147's own body calls the hardest problem in the epic. Same "no charge"
  // reassurance renders whether the client is under or over the quota.
  it("keeps the same reassurance sentence whether under or over the included quota", () => {
    const under = computeQuota(5, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });
    const { unmount } = render(<SelectionCounter packageName="Estándar" quota={under} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    unmount();

    const over = computeQuota(20, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });
    render(<SelectionCounter packageName="Estándar" quota={over} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
  });
});
