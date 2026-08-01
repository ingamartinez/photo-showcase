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

// Every fixture in THIS describe block passes 0 originals on purpose: the
// owner's own restriction (added after #206 was written) is that a gallery
// where nobody marked an original renders EXACTLY as it did before this
// slice — see the "originals breakdown" describe block below for the
// `originals > 0` cases.
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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

    const text = counterText();
    expect(text).toContain("seleccionadas 0");
    expect(text).toContain("extras 0");
  });

  it("never blocks or scolds when far over the included count — just informs with the real numbers", () => {
    const quota = computeQuota(30, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

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
    const { unmount } = render(<SelectionCounter quota={under} allowsOriginalSelection={false} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    unmount();

    const over = computeQuota(20, 0, SNAPSHOT);
    render(<SelectionCounter quota={over} allowsOriginalSelection={false} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
  });

  // Task #205's own client-facing constraint: even though `QuotaResult` now
  // carries `originals`/`selectedOriginal`/`originalPhotoPriceCopSnapshot`,
  // this component renders no row mentioning originals at all — it must stay
  // absent, not merely zeroed, so a gallery with zero originals is visually
  // identical to what this component rendered before task #205.
  it("never renders anything about originals — no new row, no new word", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

    expect(screen.queryByText(/original/i)).toBeNull();
  });

  // Task #206's own client-facing constraint: with zero originals, the
  // extras line's OWN digits must be byte-identical to what it showed before
  // this task — even though it now reads `extrasSurchargeCop` instead of
  // `surchargeCop` internally (src/lib/quota.ts's own comment on why those
  // are equal whenever `originals` is 0).
  it("shows the exact same extras line digits as before task #206, with zero originals", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

    const text = counterText();
    expect(text).toContain("extras 2 × $ 5.000 = $ 10.000");
  });
});

describe("SelectionCounter — the two-tariff breakdown (task #206)", () => {
  // Criterion 3/8's positive case — both summands non-zero, neither a
  // multiple of the other, so a component that dropped either term (or
  // showed the wrong total) would be caught.
  it("shows edited extras, originals and the total as three separate, legible lines once there are any originals", () => {
    const snapshot = {
      includedPhotosSnapshot: 7,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
    };
    // 9 edited -> 2 over 7 -> 10_000. 3 originals -> 6_000. Total 16_000.
    const quota = computeQuota(9, 3, snapshot);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

    expect(screen.getByText(/extras 2 × \$ 5\.000 = \$ 10\.000/)).toBeDefined();
    expect(screen.getByText(/originales 3 × \$ 2\.000 = \$ 6\.000/)).toBeDefined();
    expect(screen.getByText(/total \$ 16\.000/)).toBeDefined();
  });

  // The trap the task body names explicitly: marking a photo original must
  // never read as saving money.
  it("states plainly that an original never saves quota, always adds to the total", () => {
    const quota = computeQuota(5, 2, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

    expect(screen.getByText(/nunca ahorra cuota, siempre suma/)).toBeDefined();
  });

  // The "no se cobra nada" reassurance must still appear somewhere once
  // originals are on screen — task #147's own standing requirement, now
  // carried by the TOTAL line instead of the extras line.
  it("still states the app never charges, even with originals present", () => {
    const quota = computeQuota(5, 2, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    expect(screen.getByText(/fuera de la app/)).toBeDefined();
  });

  // The governing constraint's own regression guard: ZERO originals renders
  // NO row mentioning them at all — not "0 originales — $0". A fixture with
  // `originals: 1` distinguishes this from the pre-existing "never renders
  // anything about originals" test above (which fixes originals at 0).
  it("renders no originals row at all when originals is exactly zero, even with extras present", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

    expect(screen.queryByText(/originales/)).toBeNull();
    expect(screen.queryByText(/^total /)).toBeNull();
  });
});

describe("SelectionCounter — allowsOriginalSelection is OFF (task #214)", () => {
  // Criterion 3 of task #214's own mutation-proof list, and the case a bare
  // `quota.originals > 0` check would get wrong: a NON-ZERO originals count
  // (a data anomaly this display surface must still be robust to — see
  // proof-grid.tsx's own comment on why the prop is not derived from the
  // count) must still render NO row about it while the gallery's own switch
  // is off. "Absent, not zeroed" applies to the FLAG here, not only to the
  // count.
  it("renders no originals row even with a genuinely non-zero originals count, while the switch is off", () => {
    const quota = computeQuota(9, 3, {
      includedPhotosSnapshot: 7,
      extraPhotoPriceCopSnapshot: 5_000,
      originalPhotoPriceCopSnapshot: 2_000,
    });

    render(<SelectionCounter quota={quota} allowsOriginalSelection={false} />);

    expect(screen.queryByText(/originales/)).toBeNull();
    expect(screen.queryByText(/^total /)).toBeNull();
    // Positive control: the extras line still renders its own real digits —
    // this proves the component genuinely mounted, not that it rendered
    // nothing at all.
    expect(screen.getByText(/extras 2 × \$ 5\.000 = \$ 10\.000/)).toBeDefined();
  });
});
