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

// Task #205 — every fixture below passes 0 originals: nothing in this app
// writes `assets.selectionKind` to anything but `edited` yet (task #206 is
// the slice that would), and `<SelectionCounter>` itself renders no
// originals breakdown row — see this component's own file for why that stays
// true even after this task (it only ever formats what `computeQuota` hands
// it, and nothing here asks it to show a new row).
const SNAPSHOT = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  originalPhotoPriceCopSnapshot: 2_000,
};

afterEach(() => {
  cleanup();
});

describe("SelectionCounter", () => {
  it("renders included, selected, extras and surcharge — task #24's exact shape", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

    const text = counterText();
    expect(text).toContain("incluidas 13");
    expect(text).toContain("seleccionadas 15");
    expect(text).toContain("extras 2");
    expect(text).toContain("$ 5.000");
    expect(text).toContain("$ 10.000");
  });

  // Task #193 — the owner's decision to strip the package's name off every
  // client-facing gallery, unconditionally (see this component's own header
  // comment for why "only on overridden galleries" would itself be a tell).
  //
  // THE TRAP THIS TEST GUARDS AGAINST (this task's own named defect, also
  // documented at #176): a bare `not.toContain("Estándar")` passes just as
  // well if <SelectionCounter> never rendered anything at all — it proves
  // nothing on its own. This asserts the REAL content renders FIRST
  // ("incluidas 13 · seleccionadas 15", the exact same positive assertion
  // the test above makes), and only THEN that the package's name is not
  // anywhere in that same, genuinely-mounted output.
  it("never renders the package's name, on a gallery that was never overridden", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

    // Positive control first: the component actually mounted and rendered
    // its real numbers — this is what makes the negative assertion below
    // mean something.
    const text = counterText();
    expect(text).toContain("incluidas 13");
    expect(text).toContain("seleccionadas 15");

    expect(screen.queryByText(/Estándar/)).toBeNull();
    expect(document.body.textContent).not.toContain("Estándar");
  });

  it("still shows all three parts (never hides the row) when nobody has selected anything yet", () => {
    const quota = computeQuota(0, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

    const text = counterText();
    expect(text).toContain("seleccionadas 0");
    expect(text).toContain("extras 0");
  });

  it("never blocks or scolds when far over the included count — just informs with the real numbers", () => {
    const quota = computeQuota(30, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

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
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    expect(screen.getByText(/fuera de la app/)).toBeDefined();
  });

  // The sentence SHAPE must not change with the count — a counter that only
  // grows a clause once `extras > 0` would dramatize the exact moment of
  // going over, which is precisely the "feels like a threat" failure task
  // #147's own body calls the hardest problem in the epic. Same "no charge"
  // reassurance renders whether the client is under or over the quota.
  it("keeps the same reassurance sentence whether under or over the included quota", () => {
    const under = computeQuota(5, 0, SNAPSHOT);
    const { unmount } = render(<SelectionCounter quota={under} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    unmount();

    const over = computeQuota(20, 0, SNAPSHOT);
    render(<SelectionCounter quota={over} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
  });

  // Task #205's own client-facing constraint: even though `QuotaResult` now
  // carries `originals`/`selectedOriginal`/`originalPhotoPriceCopSnapshot`,
  // this component renders no row mentioning originals at all — it must stay
  // absent, not merely zeroed, so a gallery with zero originals is visually
  // identical to what this component rendered before task #205.
  it("never renders anything about originals — no new row, no new word", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} />);

    expect(screen.queryByText(/original/i)).toBeNull();
  });
});
