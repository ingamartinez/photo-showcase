// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelectionCounter } from "./selection-counter";
import { computeQuota } from "@/lib/quota";
import { formatCop } from "@/lib/format";
import type { AttributionShare } from "@/lib/quota-attribution";
import { ANA, BETO, SARA, counter, person } from "@/test-support/selection-fixtures";

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
//
// TASK #214'S OWN TRAP, RECORDED SO IT ISN'T RE-MADE: every render below
// passes `allowsOriginalSelection={true}` — NOT `false` — even though this
// whole block is about zero originals. These tests guard the COUNT half of
// #206's rule ("zero originals -> no row"), and the switch being ON is what
// makes that the operative condition; setting it to `false` here would let
// the FLAG satisfy the precondition instead of the count, making the count
// branch these tests exist to pin unreachable — exactly what happened in
// review round 1 of this task. The flag's OWN "off -> no row regardless of
// count" behavior has its dedicated describe block further down
// ("allowsOriginalSelection is OFF"), which deliberately uses a NON-ZERO
// originals count so the two guards can never overlap or substitute for one
// another.
const SNAPSHOT = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

afterEach(() => {
  cleanup();
});

describe("SelectionCounter", () => {
  it("renders included, selected, extras and surcharge — task #24's exact shape", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

    const text = counterText();
    expect(text).toContain("seleccionadas 0");
    expect(text).toContain("extras 0");
  });

  it("never blocks or scolds when far over the included count — just informs with the real numbers", () => {
    const quota = computeQuota(30, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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
    const { unmount } = render(<SelectionCounter quota={under} allowsOriginalSelection={true} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
    unmount();

    const over = computeQuota(20, 0, SNAPSHOT);
    render(<SelectionCounter quota={over} allowsOriginalSelection={true} />);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
  });

  // Task #205's own client-facing constraint: even though `QuotaResult` now
  // carries `originals`/`selectedOriginal`/`originalPhotoPriceCopSnapshot`,
  // this component renders no row mentioning originals at all — it must stay
  // absent, not merely zeroed, so a gallery with zero originals is visually
  // identical to what this component rendered before task #205.
  it("never renders anything about originals — no new row, no new word", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

    expect(screen.queryByText(/original/i)).toBeNull();
  });

  // Task #206's own client-facing constraint: with zero originals, the
  // extras line's OWN digits must be byte-identical to what it showed before
  // this task — even though it now reads `extrasSurchargeCop` instead of
  // `surchargeCop` internally (src/lib/quota.ts's own comment on why those
  // are equal whenever `originals` is 0).
  it("shows the exact same extras line digits as before task #206, with zero originals", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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
      extraPhotoPriceTiersSnapshot: null,
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

    render(<SelectionCounter quota={quota} allowsOriginalSelection={true} />);

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
      extraPhotoPriceTiersSnapshot: null,
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

// Task #231 — volume tiers. The counter reads `quota.extraUnitPriceCop` (never
// the flat snapshot) and lists the frozen scale with the reached tier marked.
describe("SelectionCounter — volume tiers (task #231)", () => {
  const TIERS = [
    { minExtras: 1, priceCop: 15_000 },
    { minExtras: 3, priceCop: 13_000 },
    { minExtras: 5, priceCop: 11_000 },
    { minExtras: 10, priceCop: 10_000 },
  ];
  const TIERED = {
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 15_000,
    extraPhotoPriceTiersSnapshot: TIERS,
    originalPhotoPriceCopSnapshot: 2_000,
  };

  it("multiplies by the reached tier's unit price, not the flat snapshot", () => {
    render(<SelectionCounter quota={computeQuota(13 + 3, 0, TIERED)} allowsOriginalSelection />);

    const text = counterText();
    expect(text).toContain("extras 3 × $ 13.000 = $ 39.000");
    expect(text).not.toContain("$ 15.000 =");
  });

  it("lists every tier of the scale with its range label", () => {
    render(<SelectionCounter quota={computeQuota(13 + 3, 0, TIERED)} allowsOriginalSelection />);

    const items = screen.getAllByRole("listitem").map((li) => li.textContent?.replace(/\s+/g, " "));
    expect(items).toEqual([
      "1–2 fotos: $ 15.000 c/u",
      "3–4 fotos: $ 13.000 c/u",
      "5–9 fotos: $ 11.000 c/u",
      "10 o más fotos: $ 10.000 c/u",
    ]);
  });

  it.each([
    [1, 0],
    [2, 0],
    [3, 1],
    [4, 1],
    [5, 2],
    [9, 2],
    [10, 3],
    [14, 3],
  ])("with %i extras exactly tier #%i is the current one", (extras, tierIndex) => {
    render(
      <SelectionCounter quota={computeQuota(13 + extras, 0, TIERED)} allowsOriginalSelection />,
    );

    const items = screen.getAllByRole("listitem");
    const current = items.filter((li) => li.getAttribute("aria-current") === "true");
    expect(current).toEqual([items[tierIndex]]);
  });

  it("marks no tier while there are no extras yet, and quotes the first tier's price", () => {
    render(<SelectionCounter quota={computeQuota(5, 0, TIERED)} allowsOriginalSelection />);

    expect(
      screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-current") === "true"),
    ).toEqual([]);
    expect(counterText()).toContain("extras 0 × $ 15.000 = $ 0");
  });

  it("a flat-price gallery renders no scale at all — the UI stays as it was", () => {
    render(<SelectionCounter quota={computeQuota(15, 0, SNAPSHOT)} allowsOriginalSelection />);

    // `hidden: true` so a scale that rendered inside the collapsed detail
    // would still be found (role queries skip `hidden` subtrees by default).
    expect(screen.queryAllByRole("listitem", { hidden: true })).toEqual([]);
    expect(screen.queryByText(/Precio por foto extra/)).toBeNull();
    expect(counterText()).toContain("extras 2 × $ 5.000 = $ 10.000");
  });
});

// Task #236 — the mobile disclosure. jsdom applies no Tailwind, so `lg:` is
// invisible here: these tests pin the DEFAULT (below-lg) state and the
// markup contract (collapse class, aria wiring, live region placement).
describe("SelectionCounter — compact disclosure (task #236)", () => {
  const TIERED = {
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 15_000,
    extraPhotoPriceTiersSnapshot: [
      { minExtras: 1, priceCop: 15_000 },
      { minExtras: 3, priceCop: 13_000 },
    ],
    originalPhotoPriceCopSnapshot: 2_000,
  };

  it("starts collapsed: toggle says 'Ver detalle', aria-expanded=false, detail region hidden", () => {
    render(
      <SelectionCounter quota={computeQuota(16, 0, TIERED)} allowsOriginalSelection collapsible />,
    );

    const toggle = screen.getByRole("button", { name: "Ver detalle" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region).not.toBeNull();
    expect(region?.className.includes("max-lg:hidden")).toBe(true);
    // NOT the native `hidden` attribute: Tailwind's preflight makes
    // `[hidden]` display:none !important, which no `lg:` utility can beat, so
    // the detail would vanish on desktop (found in the 1280px visual check).
    expect(region?.hasAttribute("hidden")).toBe(false);
    // In the DOM (so `lg:block` can show it) but out of the accessibility
    // tree while collapsed.
    expect(region?.textContent).toContain("Precio por foto extra");
  });

  it("toggling expands the detail and flips the label and aria-expanded back and forth", () => {
    render(
      <SelectionCounter quota={computeQuota(16, 0, TIERED)} allowsOriginalSelection collapsible />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    const toggle = screen.getByRole("button", { name: "Ocultar detalle" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region?.className.includes("max-lg:hidden")).toBe(false);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/Todas las fotos extra se cobran/)).toBeDefined();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Ver detalle" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(region?.className.includes("max-lg:hidden")).toBe(true);
  });

  it("keeps the headline in the live region, OUTSIDE the hidden detail, and the toggle outside the live region", () => {
    render(
      <SelectionCounter quota={computeQuota(16, 0, TIERED)} allowsOriginalSelection collapsible />,
    );

    const headline = screen.getByText(/incluidas 13/);
    const live = headline.closest('[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(headline.closest(".max-lg\\:hidden")).toBeNull();
    // The hidden detail IS inside the same live region (desktop announces it).
    expect(live?.contains(document.querySelector(".max-lg\\:hidden"))).toBe(true);
    // The toggle is not: its label flipping must not be announced.
    expect(live?.contains(screen.getByRole("button", { name: "Ver detalle" }))).toBe(false);
  });

  it("shows the running extras amount next to the toggle only once there are extras, in its own live region", () => {
    const { unmount } = render(
      <SelectionCounter quota={computeQuota(10, 0, TIERED)} allowsOriginalSelection collapsible />,
    );
    const toggleRow = screen.getByRole("button", { name: "Ver detalle" }).parentElement;
    expect(toggleRow?.textContent).not.toMatch(/extras/);
    unmount();

    render(
      <SelectionCounter quota={computeQuota(16, 0, TIERED)} allowsOriginalSelection collapsible />,
    );
    // 3 extras at the 3+ tier: 3 × 13.000 = 39.000
    const row = screen.getByRole("button", { name: "Ver detalle" }).parentElement;
    expect(row?.textContent?.replace(/\s+/g, " ")).toContain("$ 39.000 en extras");
    expect(row?.querySelector('[aria-live="polite"]')?.textContent).toContain("en extras");

    // Expanded: the detail already states it, so the row stops repeating it.
    fireEvent.click(screen.getByRole("button", { name: "Ver detalle" }));
    expect(row?.textContent).not.toMatch(/extras/);
  });

  // The compact amount must never mislabel: with originals `surchargeCop` is
  // the TOTAL of both tariffs (src/lib/quota.ts), not "extras". Fixtures use
  // DISTINCT extras / originals / total amounts so a swapped field is visible.
  describe("compact amount with originals (price correctness)", () => {
    const compact = () =>
      screen
        .getByRole("button", { name: "Ver detalle" })
        .parentElement?.textContent?.replace(/\s+/g, " ") ?? "";

    it("originals > 0 and extras > 0: shows the TOTAL labelled 'en total', not extras or originals alone", () => {
      const quota = computeQuota(15, 3, SNAPSHOT);
      expect(quota.extrasSurchargeCop).toBeGreaterThan(0);
      expect(quota.originalsSurchargeCop).toBeGreaterThan(0);
      expect(
        new Set([quota.extrasSurchargeCop, quota.originalsSurchargeCop, quota.surchargeCop]).size,
      ).toBe(3);

      render(<SelectionCounter quota={quota} allowsOriginalSelection collapsible />);

      expect(compact()).toContain(`${formatCop(quota.surchargeCop)} en total`.replace(/\s+/g, " "));
      expect(compact()).not.toContain("en extras");
    });

    it("0 extras but originals > 0: the amount does not disappear — it is the originals total", () => {
      const quota = computeQuota(5, 2, SNAPSHOT);
      expect(quota.extras).toBe(0);
      expect(quota.surchargeCop).toBeGreaterThan(0);

      render(<SelectionCounter quota={quota} allowsOriginalSelection collapsible />);

      expect(compact()).toContain(`${formatCop(quota.surchargeCop)} en total`.replace(/\s+/g, " "));
    });

    it("no originals: shows extrasSurchargeCop labelled 'en extras'", () => {
      const quota = computeQuota(15, 0, SNAPSHOT);
      render(<SelectionCounter quota={quota} allowsOriginalSelection collapsible />);

      expect(compact()).toContain(
        `${formatCop(quota.extrasSurchargeCop)} en extras`.replace(/\s+/g, " "),
      );
    });

    it("allowsOriginalSelection off with a stray originals count: still labelled as extras", () => {
      const quota = computeQuota(15, 3, SNAPSHOT);
      render(<SelectionCounter quota={quota} allowsOriginalSelection={false} collapsible />);

      expect(compact()).toContain(
        `${formatCop(quota.extrasSurchargeCop)} en extras`.replace(/\s+/g, " "),
      );
      expect(compact()).not.toContain("en total");
    });
  });
});

describe("SelectionCounter — not collapsible (the `selected` view, task #236)", () => {
  it("shows the full detail with no toggle and no collapse class", () => {
    const { container } = render(
      <SelectionCounter
        quota={computeQuota(16, 0, {
          ...SNAPSHOT,
          extraPhotoPriceTiersSnapshot: [{ minExtras: 1, priceCop: 5_000 }],
        })}
        allowsOriginalSelection
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector(".max-lg\\:hidden")).toBeNull();
    expect(screen.getByText(/Precio por foto extra/)).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();
  });
});

// Task #264 — the per-person money breakdown. Every amount asserted below is
// the SERVER's own `share.surchargeCop` (handed in as a fixture), which is the
// point of the slice: the browser formats the split, it never derives it. The
// gallery total in "Entre todos" is `quota`, also handed in whole.
describe("SelectionCounter — per-person money (task #264)", () => {
  /** A share with only the fields the test cares about set. No maths: a test
   * that computed `extras * price` would agree with a component making the
   * same mistake. */
  function share(overrides: Partial<AttributionShare> = {}): AttributionShare {
    return {
      included: 0,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
      ...overrides,
    };
  }

  const labels = () => screen.getAllByRole("term").map((node) => node.textContent);
  const amounts = () =>
    screen
      .getAllByRole("definition")
      .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());

  // The terms that make the fixture's rows ADD UP to its quota: 6 edited
  // (4 included + 2 extras) and 1 original, over a 4-included pool. A fixture
  // that did not add up would make this test unable to tell a read total from
  // a summed one — that is T9's job, further down, on purpose.
  const MONEY_TERMS = {
    includedPhotosSnapshot: 4,
    extraPhotoPriceCopSnapshot: 5_000,
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
  };
  const MONEY_QUOTA = () => computeQuota(6, 1, MONEY_TERMS);

  const ANA_SHARE = share({
    included: 1,
    extras: 2,
    extrasSurchargeCop: 10_000,
    surchargeCop: 10_000,
  });
  const ANGELA_SHARE = share({ included: 2 });
  const BETO_SHARE = share({ originals: 1, originalsSurchargeCop: 2_000, surchargeCop: 2_000 });
  const LEGACY_SHARE = share({ included: 1 });

  function threeHolders(overrides: Parameters<typeof counter>[0] = {}) {
    return counter({
      group: 7,
      viewer: { yours: 3, shared: 0, toSend: 0 },
      people: [
        person(ANA, 3, ANA_SHARE),
        // Sorts BEFORE Beto only under a Spanish collation of the label, and
        // not first at all: "Tú" always leads.
        person({ id: "client-z", label: "Ángela" }, 2, ANGELA_SHARE),
        person(BETO, 1, BETO_SHARE),
      ],
      unattributed: 1,
      unattributedShare: LEGACY_SHARE,
      ...overrides,
    });
  }

  it("lists one row per person — you first, then by label, then 'Sin registro' last — with the server's own amounts", () => {
    render(
      <SelectionCounter
        quota={MONEY_QUOTA()}
        allowsOriginalSelection
        counter={threeHolders()}
        viewerId={ANA.id}
      />,
    );

    expect(labels()).toEqual(["Tú", "Ángela", "Beto", "Sin registro"]);
    expect(amounts()).toEqual([
      "3 fotos · 2 extras · $ 10.000",
      "2 fotos · 0 extras · $ 0",
      "1 foto · 0 extras · 1 original · $ 2.000",
      "1 foto · 0 extras · $ 0",
    ]);
    // The headline counts the group once, not the sum of rows.
    expect(screen.getByText(/incluidas 4/).textContent).toContain("seleccionadas 7 entre todos");
    // Task #269 — the gallery block is the SECOND level now: rows first, and
    // the pre-#264 block behind its own control. The assertions below are
    // about the same strings as before, opened one level deeper.
    fireEvent.click(screen.getByRole("button", { name: "Ver total de la galería" }));
    // The gallery's own block keeps its label and its number: 2 extras at
    // 5.000 plus 1 original at 2.000.
    expect(screen.getByText("Entre todos")).toBeDefined();
    expect(screen.getByText(/total \$ 12\.000/)).toBeDefined();
  });

  it("still gives the viewer a row when they hold nothing, and emphasises only that row", () => {
    render(
      <SelectionCounter
        quota={computeQuota(4, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={counter({
          group: 2,
          viewer: { yours: 0, shared: 0, toSend: 0 },
          people: [person(ANA, 0), person(BETO, 2, share({ included: 2 }))],
        })}
        viewerId={ANA.id}
      />,
    );

    expect(labels()).toEqual(["Tú", "Beto"]);
    expect(amounts()[0]).toBe("0 fotos · 0 extras · $ 0");
    const [own, other] = screen.getAllByRole("term");
    expect(own?.className).toContain("text-fg");
    expect(own?.className).toContain("font-medium");
    expect(other?.className ?? "").not.toContain("font-medium");
    const [ownAmount, otherAmount] = screen.getAllByRole("definition");
    expect(ownAmount?.className).toContain("font-medium");
    expect(otherAmount?.className ?? "").not.toContain("font-medium");
  });

  // THE REGRESSION GUARD. One holder of units IS the whole bill, so nothing
  // about this component's output may change for them — not a row, not the
  // headline, not a label. Byte equality against the same component rendered
  // without any counter at all is the strongest form this assertion can take.
  it("renders byte-identically to the pre-#264 output when a single person holds every unit", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);
    const solo = counter({
      group: 15,
      viewer: { yours: 15, shared: 0, toSend: 0 },
      people: [
        person(
          ANA,
          15,
          share({ included: 13, extras: 2, extrasSurchargeCop: 10_000, surchargeCop: 10_000 }),
        ),
      ],
    });

    const { container: wired, unmount } = render(
      <SelectionCounter quota={quota} allowsOriginalSelection counter={solo} viewerId={ANA.id} />,
    );
    const wiredText = wired.textContent;
    unmount();

    const { container: legacy } = render(
      <SelectionCounter quota={quota} allowsOriginalSelection />,
    );

    expect(wiredText).toBe(legacy.textContent);
    expect(screen.queryByRole("term")).toBeNull();
    expect(screen.queryByText(/entre todos/i)).toBeNull();
  });

  it("keeps the admin's solo view identical too — no subject, one holder", () => {
    const quota = computeQuota(15, 0, SNAPSHOT);
    const solo = counter({
      group: 15,
      viewer: null,
      people: [
        person(
          ANA,
          15,
          share({ included: 13, extras: 2, extrasSurchargeCop: 10_000, surchargeCop: 10_000 }),
        ),
      ],
    });

    const { container: wired, unmount } = render(
      <SelectionCounter quota={quota} allowsOriginalSelection counter={solo} viewerId={null} />,
    );
    const wiredText = wired.textContent;
    unmount();

    const { container: legacy } = render(
      <SelectionCounter quota={quota} allowsOriginalSelection />,
    );

    expect(wiredText).toBe(legacy.textContent);
    expect(screen.queryByRole("term")).toBeNull();
  });

  it("agrees with the person's own grammar: 1 foto · 1 extra · 1 original, never '1 fotos'", () => {
    const one = counter({
      group: 2,
      viewer: { yours: 1, shared: 1, toSend: 0 },
      people: [
        person(ANA, 1, share({ extras: 1, extrasSurchargeCop: 5_000, surchargeCop: 5_000 })),
        person(BETO, 1, share({ originals: 1, originalsSurchargeCop: 2_000, surchargeCop: 2_000 })),
      ],
    });
    const { unmount } = render(
      <SelectionCounter
        quota={computeQuota(1, 1, SNAPSHOT)}
        allowsOriginalSelection
        counter={one}
        viewerId={ANA.id}
      />,
    );
    expect(amounts()).toEqual([
      "1 foto · 1 extra · $ 5.000",
      "1 foto · 0 extras · 1 original · $ 2.000",
    ]);
    unmount();

    const many = counter({
      group: 4,
      viewer: { yours: 2, shared: 1, toSend: 0 },
      people: [person(ANA, 2), person(BETO, 2, share({ originals: 2 }))],
    });
    render(
      <SelectionCounter
        quota={computeQuota(4, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={many}
        viewerId={ANA.id}
      />,
    );
    expect(amounts()).toEqual([
      "2 fotos · 0 extras · $ 0",
      "2 fotos · 0 extras · 2 originales · $ 0",
    ]);
  });

  // "Absent, not zeroed" survives here too: the per-row originals segment is
  // hidden by the gallery's own switch AND by a zero count, never rendered as
  // "0 originales".
  it("hides the originals segment per row when the switch is off, and when a share has none", () => {
    const withOriginals = counter({
      group: 2,
      viewer: { yours: 1, shared: 1, toSend: 0 },
      people: [person(ANA, 1, BETO_SHARE), person(BETO, 1, BETO_SHARE)],
    });

    const { unmount } = render(
      <SelectionCounter
        quota={computeQuota(2, 0, SNAPSHOT)}
        allowsOriginalSelection={false}
        counter={withOriginals}
        viewerId={ANA.id}
      />,
    );
    expect(amounts()[0]).toBe("1 foto · 0 extras · $ 2.000");
    expect(screen.queryByText(/originales/)).toBeNull();
    unmount();

    render(
      <SelectionCounter
        quota={computeQuota(2, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={counter({
          group: 2,
          viewer: { yours: 1, shared: 1, toSend: 0 },
          people: [person(ANA, 1), person(BETO, 1)],
        })}
        viewerId={ANA.id}
      />,
    );
    expect(amounts()).toEqual(["1 foto · 0 extras · $ 0", "1 foto · 0 extras · $ 0"]);
    expect(screen.queryByText(/originales/)).toBeNull();
  });

  it("names the viewer's own amount in the folded bar, and leaves the solo wording alone", () => {
    const compact = () =>
      screen
        .getByRole("button", { name: "Ver detalle" })
        .parentElement?.textContent?.replace(/\s+/g, " ") ?? "";

    const { unmount } = render(
      <SelectionCounter
        quota={computeQuota(15, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={threeHolders()}
        viewerId={ANA.id}
        collapsible
      />,
    );
    expect(compact()).toContain("$ 10.000 a tu nombre");
    expect(compact()).not.toContain("en extras");
    unmount();

    render(
      <SelectionCounter
        quota={computeQuota(15, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={counter({
          group: 15,
          viewer: { yours: 15, shared: 0, toSend: 0 },
          people: [person(ANA, 15, ANA_SHARE)],
        })}
        viewerId={ANA.id}
        collapsible
      />,
    );
    expect(compact()).toContain(
      `${formatCop(computeQuota(15, 0, SNAPSHOT).extrasSurchargeCop)} en extras`.replace(
        /\s+/g,
        " ",
      ),
    );
    expect(compact()).not.toContain("a tu nombre");
  });

  // Review round 2, CRITICAL — THE ZERO-SHARE GUARD. The compact row names the
  // viewer's amount only when there IS an amount to name: a STRICTLY positive
  // `share.surchargeCop`. "$ 0 a tu nombre" points at money the reader does not
  // owe, so a zero viewer share keeps the gallery-wide wording the pre-#264
  // bar already had. This is the FOLDED, MULTI-ROW case that separates it from
  // the solo fallbacks above: two bill-holders, so the breakdown is on and the
  // viewer's own row renders at zero — while somebody ELSE holds the money.
  it("keeps the gallery-wide wording when the viewer's own share is $ 0 — never '$ 0 a tu nombre'", () => {
    const compact = () =>
      screen
        .getByRole("button", { name: "Ver detalle" })
        .parentElement?.textContent?.replace(/\s+/g, " ") ?? "";

    const billsAreSomeoneElses = counter({
      group: 5,
      viewer: { yours: 2, shared: 0, toSend: 0 },
      people: [
        // The viewer holds units but no money: both picks are included.
        person(ANA, 2),
        // Beto's extras are the whole bill.
        person(
          BETO,
          3,
          share({ included: 1, extras: 2, extrasSurchargeCop: 10_000, surchargeCop: 10_000 }),
        ),
      ],
    });

    const { unmount } = render(
      <SelectionCounter
        quota={computeQuota(15, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={billsAreSomeoneElses}
        viewerId={ANA.id}
        collapsible
      />,
    );

    // Positive controls: the breakdown IS on and the viewer's row IS there, at
    // zero, so the assertions below are about the guard and not about a
    // missing row or an unfolded bar.
    expect(labels()).toEqual(["Tú", "Beto"]);
    expect(amounts()).toEqual(["2 fotos · 0 extras · $ 0", "3 fotos · 2 extras · $ 10.000"]);
    expect(screen.getByRole("button", { name: "Ver detalle" })).toBeDefined();

    // No originals, extras > 0: the approved gallery-wide fallback.
    expect(compact()).toContain("$ 10.000 en extras");
    expect(compact()).not.toContain("a tu nombre");
    unmount();

    // With originals the fallback is the gallery's TOTAL, labelled "en total"
    // (2 extras at 5.000 + 1 original at 2.000) — still not the viewer's zero.
    const withOriginals = computeQuota(15, 1, SNAPSHOT);
    expect(withOriginals.surchargeCop).toBe(12_000);
    render(
      <SelectionCounter
        quota={withOriginals}
        allowsOriginalSelection
        counter={billsAreSomeoneElses}
        viewerId={ANA.id}
        collapsible
      />,
    );
    expect(compact()).toContain(
      `${formatCop(withOriginals.surchargeCop)} en total`.replace(/\s+/g, " "),
    );
    expect(compact()).not.toContain("a tu nombre");
  });

  // Review round 2 — the SPARSE wire the server actually sends: `people` lists
  // the holders of units, so a viewer who holds nothing is simply absent, not
  // present with zeros. The bar must still lead with "Tú · 0 fotos" (the
  // pre-#264 behavior for a viewer with nothing picked) and must not turn that
  // absence into a zero amount in the compact row.
  it("gives an absent-from-`people` viewer a zero row without naming a zero amount", () => {
    const compact = () =>
      screen
        .getByRole("button", { name: "Ver detalle" })
        .parentElement?.textContent?.replace(/\s+/g, " ") ?? "";

    render(
      <SelectionCounter
        quota={computeQuota(15, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={counter({
          group: 3,
          viewer: { yours: 0, shared: 0, toSend: 0 },
          people: [
            person(ANA, 2, share({ included: 2 })),
            person(BETO, 1, share({ extras: 1, extrasSurchargeCop: 5_000, surchargeCop: 5_000 })),
          ],
        })}
        viewerId={SARA.id}
        collapsible
      />,
    );

    // Sara is the viewer and is NOT in `people` — her name must never appear as
    // somebody else's row — yet "Tú" is still there, at zero, first.
    expect(labels()).toEqual(["Tú", "Ana", "Beto"]);
    expect(amounts()[0]).toBe("0 fotos · 0 extras · $ 0");
    expect(screen.queryByText("Sara")).toBeNull();

    expect(compact()).toContain("$ 10.000 en extras");
    expect(compact()).not.toContain("a tu nombre");
  });

  // THE POINT OF THE SLICE, as an assertion: the total is READ off `quota`,
  // not added up from the rows. The fixture's rows deliberately do NOT add up
  // to the quota's total (3.000 vs 16.000), so an implementation that summed
  // the rows — the tempting way to make the block "agree" — prints 3.000 and
  // fails here.
  it("prints the gallery total from `quota`, even when the rows do not add up to it", () => {
    // 9 edited over a 7-included pool = 2 extras at 5.000; 3 originals at
    // 2.000; total 16.000. The two rows below claim 1.000 + 2.000.
    const quota = computeQuota(9, 3, {
      ...SNAPSHOT,
      includedPhotosSnapshot: 7,
    });
    expect(quota.surchargeCop).toBe(16_000);

    render(
      <SelectionCounter
        quota={quota}
        allowsOriginalSelection
        counter={counter({
          group: 2,
          viewer: { yours: 1, shared: 1, toSend: 0 },
          people: [
            person(ANA, 1, share({ extras: 1, extrasSurchargeCop: 1_000, surchargeCop: 1_000 })),
            person(
              BETO,
              1,
              share({ originals: 1, originalsSurchargeCop: 2_000, surchargeCop: 2_000 }),
            ),
          ],
        })}
        viewerId={ANA.id}
      />,
    );

    // Task #269 — this block is the second level of the #269 disclosure, so
    // the test opens it exactly as a reader would before reading the total.
    fireEvent.click(screen.getByRole("button", { name: "Ver total de la galería" }));
    expect(screen.getByText(/total \$ 16\.000/)).toBeDefined();
    expect(screen.queryByText(/total \$ 3\.000/)).toBeNull();
    // Positive control: the rows rendered, so the assertion above is about a
    // mounted breakdown and not about an empty render.
    expect(amounts()).toEqual([
      "1 foto · 1 extra · $ 1.000",
      "1 foto · 0 extras · 1 original · $ 2.000",
    ]);
  });
});

// Task #269 — THE OWNER'S REPORT (2026-10-18), as assertions: the opened
// detail was a wall of per-person rows PLUS the whole gallery-pricing block,
// and expanding it on a phone pushed the grid and the bar around. The fix is
// two levels — rows behind "Ver detalle", the gallery's own block behind a
// SECOND control — with both living in the one bounded scroll region. Every
// test below pins one of those clauses; the mutation that matters is the one
// that puts the block back next to the rows, which turns T1 red.
describe("SelectionCounter — two-level money detail (task #269)", () => {
  function share(overrides: Partial<AttributionShare> = {}): AttributionShare {
    return {
      included: 0,
      extras: 0,
      originals: 0,
      extrasSurchargeCop: 0,
      originalsSurchargeCop: 0,
      surchargeCop: 0,
      ...overrides,
    };
  }

  const ANA_SHARE = share({
    included: 1,
    extras: 2,
    extrasSurchargeCop: 10_000,
    surchargeCop: 10_000,
  });
  // 2 extras at 5.000 plus 1 original at 2.000 — distinct amounts, so a
  // swapped/total-only read of the global block is visible.
  const TERMS = {
    includedPhotosSnapshot: 4,
    extraPhotoPriceCopSnapshot: 5_000,
    extraPhotoPriceTiersSnapshot: null,
    originalPhotoPriceCopSnapshot: 2_000,
  };
  const QUOTA = () => computeQuota(6, 1, TERMS);

  /** Two bill-holders: enough rows for the breakdown to be on, which is the
   * ONLY condition that opens the two-level structure. */
  const twoHolders = () =>
    counter({
      group: 4,
      viewer: { yours: 3, shared: 0, toSend: 0 },
      people: [person(ANA, 3, ANA_SHARE), person(BETO, 1)],
    });

  const toggle = (name: string) => screen.getByRole("button", { name });
  const regionFor = (button: HTMLElement) =>
    document.getElementById(button.getAttribute("aria-controls") ?? "");

  it("opens the detail to the person rows only — the gallery block is absent until its own control", () => {
    render(
      <SelectionCounter
        quota={QUOTA()}
        allowsOriginalSelection
        counter={twoHolders()}
        viewerId={ANA.id}
        collapsible
      />,
    );

    fireEvent.click(toggle("Ver detalle"));

    // Positive control: the rows really rendered.
    expect(screen.getAllByRole("term").map((node) => node.textContent)).toEqual(["Tú", "Beto"]);
    expect(
      screen
        .getAllByRole("definition")
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ")),
    ).toEqual(["3 fotos · 2 extras · $ 10.000", "1 foto · 0 extras · $ 0"]);

    // The wall is gone: no "Entre todos", no extras arithmetic, no tiers.
    // Absent from the DOM, not merely scrolled out of the box.
    expect(screen.queryByText("Entre todos")).toBeNull();
    expect(screen.queryByText(/^extras/)).toBeNull();
    expect(screen.queryByText(/no se cobra nada/)).toBeNull();
    expect(screen.queryByText(/total \$/)).toBeNull();

    const total = toggle("Ver total de la galería");
    expect(total.getAttribute("aria-expanded")).toBe("false");
    const controlled = regionFor(total);
    expect(controlled).not.toBeNull();
    expect(controlled?.textContent).toBe("");
  });

  it("the second control reveals the pre-#264 gallery block verbatim, without repeating the rows", () => {
    render(
      <SelectionCounter
        quota={QUOTA()}
        allowsOriginalSelection
        counter={twoHolders()}
        viewerId={ANA.id}
        collapsible
      />,
    );
    fireEvent.click(toggle("Ver detalle"));

    const total = toggle("Ver total de la galería");
    // jsdom does not move focus on click, so set it explicitly: this is the
    // "no focus loss" clause — the button must survive its own state change.
    total.focus();
    fireEvent.click(total);

    const open = toggle("Ocultar total");
    expect(open).toBe(total);
    expect(document.activeElement).toBe(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");

    // Same strings, same formatter, same order as before #269.
    expect(screen.getByText("Entre todos")).toBeDefined();
    expect(screen.getByText(/^extras 2 × \$ 5\.000 = \$ 10\.000/)).toBeDefined();
    expect(screen.getByText(/originales 1 × \$ 2\.000 = \$ 2\.000/)).toBeDefined();
    expect(screen.getByText(/total \$ 12\.000/)).toBeDefined();
    expect(screen.getByText(/no se cobra nada/)).toBeDefined();

    // The rows are NOT duplicated by the reveal: still exactly two.
    expect(screen.getAllByRole("term")).toHaveLength(2);

    // ...and it closes again, leaving the rows in place.
    fireEvent.click(open);
    expect(toggle("Ver total de la galería").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Entre todos")).toBeNull();
    expect(screen.getAllByRole("term")).toHaveLength(2);
  });

  it("keeps the single payer's detail exactly as it was — no rows, no second control", () => {
    const solo = counter({
      group: 15,
      viewer: { yours: 15, shared: 0, toSend: 0 },
      people: [
        person(
          ANA,
          15,
          share({ included: 13, extras: 2, extrasSurchargeCop: 10_000, surchargeCop: 10_000 }),
        ),
      ],
    });

    render(
      <SelectionCounter
        quota={computeQuota(15, 0, SNAPSHOT)}
        allowsOriginalSelection
        counter={solo}
        viewerId={ANA.id}
        collapsible
      />,
    );

    expect(screen.queryByRole("term")).toBeNull();
    expect(screen.queryByRole("button", { name: /total/i })).toBeNull();

    fireEvent.click(toggle("Ver detalle"));
    // Today's detail, immediately — no second level to walk through.
    expect(screen.getByText(/^extras 2 × \$ 5\.000 = \$ 10\.000/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /total/i })).toBeNull();
    expect(screen.queryByText("Entre todos")).toBeNull();
  });

  it("gives a zero-unit viewer next to a single holder the two-level detail: two rows, no global block, and a total control", () => {
    // Fix round 1 — the shape the first cut kept as an exception. `moneyRows`
    // here has TWO displayed rows (the viewer's own zero row next to Beto) even
    // though only Beto holds units. The second level is gated on the ROWS now:
    // the global block must not share the rows' disclosure, or a two-row detail
    // is the same wall with a different account holding the money.
    const quota = computeQuota(3, 0, SNAPSHOT);
    const { unmount } = render(
      <SelectionCounter
        quota={quota}
        allowsOriginalSelection
        counter={counter({
          group: 3,
          viewer: { yours: 0, shared: 0, toSend: 0 },
          people: [person(BETO, 3, share({ included: 3 }))],
        })}
        viewerId={ANA.id}
        collapsible
      />,
    );
    fireEvent.click(toggle("Ver detalle"));
    expect(screen.getAllByRole("term").map((node) => node.textContent)).toEqual(["Tú", "Beto"]);

    // Rows only: the global block is ABSENT, not merely scrolled out of view.
    expect(screen.queryByText("Entre todos")).toBeNull();
    expect(screen.queryByText(/^extras/)).toBeNull();
    expect(screen.queryByText(/no se cobra nada/)).toBeNull();

    // ...and the control that reveals it exists, closed.
    const total = toggle("Ver total de la galería");
    expect(total.getAttribute("aria-expanded")).toBe("false");
    const region = regionFor(total);
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("");

    // Opening it reveals the gallery arithmetic INSIDE that same region.
    fireEvent.click(total);
    expect(region?.contains(screen.getByText("Entre todos"))).toBe(true);
    expect(region?.contains(screen.getByText(/^extras 0 × \$ 5\.000/))).toBe(true);
    expect(screen.getAllByRole("term")).toHaveLength(2);
    unmount();

    // The same holds when the single holder is the unattributed bucket: two
    // rows ("Tú" + "Sin registro"), rows first, total behind its own control.
    render(
      <SelectionCounter
        quota={quota}
        allowsOriginalSelection
        counter={counter({
          group: 2,
          viewer: { yours: 0, shared: 0, toSend: 0 },
          unattributed: 2,
        })}
        viewerId={ANA.id}
        collapsible
      />,
    );
    fireEvent.click(toggle("Ver detalle"));
    expect(screen.getAllByRole("term").map((node) => node.textContent)).toEqual([
      "Tú",
      "Sin registro",
    ]);
    expect(screen.queryByText(/^extras 0 × \$ 5\.000/)).toBeNull();
    const legacyTotal = toggle("Ver total de la galería");
    const legacyRegion = regionFor(legacyTotal);
    fireEvent.click(legacyTotal);
    expect(legacyRegion?.contains(screen.getByText(/^extras 0 × \$ 5\.000/))).toBe(true);
  });

  it("allocates a FIXED height to the multi-person detail — no `max-h`, no breakpoint override, unchanged when the total opens", () => {
    // The review's own measurement of the first cut: `max-h-[40vh]` is a
    // CEILING, so below it the box still sized to its contents — opening the
    // total grew the bar 144px on a phone and 104px on a desktop. jsdom has no
    // layout engine, so this test cannot measure pixels; what it CAN pin is the
    // contract that makes the height content-independent in a browser: a
    // `h-`-prefixed allocation (not `max-h-`) with no breakpoint variant, the
    // same class string before and after the reveal, and the same class string
    // for a longer list of people.
    const { unmount } = render(
      <SelectionCounter
        quota={QUOTA()}
        allowsOriginalSelection
        counter={twoHolders()}
        viewerId={ANA.id}
        collapsible
      />,
    );
    fireEvent.click(toggle("Ver detalle"));

    const closedRegion = regionFor(toggle("Ocultar detalle"));
    expect(closedRegion).not.toBeNull();
    const classes = closedRegion?.className ?? "";
    const tokens = classes.split(/\s+/).filter(Boolean);

    // A height, allocated — and it is the only height rule in the class list,
    // so no `lg:` (or any other breakpoint) variant can change it later.
    expect(tokens.filter((token) => /(^|:)(h|max-h)-/.test(token))).toEqual([
      "h-[min(40vh,20rem)]",
    ]);
    expect(tokens).toContain("overflow-y-auto");
    expect(tokens).toContain("overscroll-contain");
    // The desktop escape hatch is exactly what turned the open detail into a
    // wall: with it, the region grew to its content at lg and up.
    expect(classes).not.toContain("lg:max-h-none");
    expect(classes).not.toContain("lg:overflow-visible");

    // Revealing the total must not touch the box the bar is sized by: same
    // element, and not one class added or removed.
    fireEvent.click(toggle("Ver total de la galería"));
    const openRegion = regionFor(toggle("Ocultar detalle"));
    expect(openRegion).toBe(closedRegion);
    expect(openRegion?.className).toBe(classes);
    unmount();

    // More people, same allocated height: only what scrolls inside changes.
    render(
      <SelectionCounter
        quota={QUOTA()}
        allowsOriginalSelection
        counter={counter({
          group: 9,
          viewer: { yours: 3, shared: 0, toSend: 0 },
          people: [
            person(ANA, 3, ANA_SHARE),
            person({ id: "client-b", label: "Beto" }, 1),
            person({ id: "client-c", label: "Carla" }, 1),
            person({ id: "client-d", label: "Diego" }, 1),
            person({ id: "client-e", label: "Elena" }, 1),
            person({ id: "client-f", label: "Fabián" }, 1),
          ],
        })}
        viewerId={ANA.id}
        collapsible
      />,
    );
    fireEvent.click(toggle("Ver detalle"));
    expect(screen.getAllByRole("term")).toHaveLength(6);
    expect(regionFor(toggle("Ocultar detalle"))?.className).toBe(classes);
  });

  // The non-collapsible caller (`selected`, normal flow) shares the same
  // two-level contract — it is the same wall on a desktop, just without the
  // fold. Its single-payer output stays the old one (asserted by the
  // byte-identical #264 tests above).
  it("applies the same two levels to the non-collapsible detail", () => {
    render(
      <SelectionCounter
        quota={QUOTA()}
        allowsOriginalSelection
        counter={twoHolders()}
        viewerId={ANA.id}
      />,
    );

    expect(screen.getAllByRole("term")).toHaveLength(2);
    expect(screen.queryByText("Entre todos")).toBeNull();

    fireEvent.click(toggle("Ver total de la galería"));
    expect(screen.getByText("Entre todos")).toBeDefined();
    expect(screen.getByText(/total \$ 12\.000/)).toBeDefined();
  });
});
