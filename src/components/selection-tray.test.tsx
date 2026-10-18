// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { groupPicksByPicker, SelectionTray } from "./selection-tray";
import type { SelectionEntry, SelectionKind } from "@/lib/selection-snapshot";
import { entry as fixtureEntry, pick as fixturePick } from "@/test-support/selection-fixtures";

type SelectionPick = {
  assetId: string;
  selectedAt: string | null;
  pickedBy: { id: string; label: string } | null;
  selectionKind: SelectionKind;
  requestedAt?: string | null;
};

function pick(overrides: Partial<SelectionPick> = {}): SelectionPick {
  return {
    assetId: "a1",
    selectedAt: "2026-07-30T12:00:00.000Z",
    pickedBy: { id: "client-b", label: "Beto Ruiz" },
    // Task #206 — the domain's own default; tests exercising the type badge
    // override this explicitly.
    selectionKind: "edited",
    ...overrides,
  };
}

function entryFor(pick: SelectionPick): SelectionEntry {
  return {
    assetId: pick.assetId,
    claim: {
      claimedAt: pick.selectedAt,
      resolvedKind: pick.selectionKind,
      billedTo: pick.pickedBy,
      charge: "included",
    },
    picks: pick.pickedBy
      ? [
          {
            userId: pick.pickedBy.id,
            label: pick.pickedBy.label,
            kind: pick.selectionKind,
            pickedAt: pick.selectedAt ?? "2026-07-30T12:00:00.000Z",
            submittedAt: pick.selectedAt,
            state: "billed",
          },
        ]
      : [],
  };
}

function entriesFrom(picks: SelectionPick[]): SelectionEntry[] {
  return picks.map(entryFor);
}

type TrayOverrides = Partial<ComponentProps<typeof SelectionTray>> & { picks?: SelectionPick[] };

function renderTray(overrides: TrayOverrides = {}) {
  const { picks = [], ...rest } = overrides;
  return render(
    <SelectionTray
      entries={entriesFrom(picks)}
      urls={{ a1: "https://r2.example.com/a1", a2: "https://r2.example.com/a2" }}
      filenamesByAssetId={{ a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" }}
      viewerId="client-a"
      // Task #204 — default to `flat`, today's only behavior. The by-person
      // describe block below overrides this explicitly per test.
      mode="flat"
      isLocked={false}
      isStale={false}
      // Task #214 — default ON: most tests in this file predate the switch
      // and exercise the type line directly. The tests exercising the switch
      // itself override this explicitly.
      allowsOriginalSelection={true}
      onOpenAsset={() => {}}
      onImageError={() => {}}
      {...rest}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SelectionTray", () => {
  it("stays visible with an explanation before anybody has picked anything", () => {
    // Decided rather than defaulted (task #95): a tray that materialised on
    // the first pick would shove the grid down the page at the exact moment
    // the client is aiming at a thumbnail, and a client who never sees it
    // beforehand has no idea their partner's picks will appear there.
    renderTray({ picks: [] });

    expect(screen.getByRole("region", { name: "Fotos elegidas" })).toBeDefined();
    expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
  });

  it("shows each pick's thumbnail from the grid's own presigned URL map", () => {
    // Never a URL of its own: R2 objects stay private and there is exactly
    // one way to obtain bytes for an asset.
    const { container } = renderTray({ picks: [pick({ assetId: "a1" })] });

    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://r2.example.com/a1");
  });

  it("asks for a fresh presigned URL when a thumbnail fails to load", () => {
    // Presigned URLs live 5 minutes; this feature exists for a group spending
    // twenty arguing about photos. A pick arriving from another session at
    // minute six, whose grid tile is below the fold, has never been fetched by
    // the grid and so has never errored there — the tray is the FIRST surface
    // to notice it is stale, and without this it would just show a broken
    // thumbnail for the rest of the session.
    const onImageError = vi.fn();
    const { container } = renderTray({ picks: [pick({ assetId: "a1" })], onImageError });

    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(onImageError).toHaveBeenCalledWith("a1");
  });

  it("attributes another client's pick by name", () => {
    renderTray({ picks: [pick({ pickedBy: { id: "client-b", label: "Beto Ruiz" } })] });

    expect(screen.getByText("Beto Ruiz")).toBeDefined();
  });

  it("attributes the viewer's own pick as 'Tú'", () => {
    renderTray({ picks: [pick({ pickedBy: { id: "client-a", label: "Ana Pérez" } })] });

    expect(screen.getByText("Tú")).toBeDefined();
    expect(screen.queryByText("Ana Pérez")).toBeNull();
  });

  it("admits it does not know, rather than guessing, for a pick with no attribution", () => {
    renderTray({ picks: [pick({ pickedBy: null })] });

    expect(screen.getByText("Sin registro")).toBeDefined();
  });

  it("names the picker in each thumbnail's accessible label, not only visually", () => {
    renderTray({ picks: [pick({ assetId: "a1", pickedBy: { id: "client-b", label: "Beto" } })] });

    expect(
      screen.getByRole("button", { name: "Ver IMG_0001.JPG, elegida por Beto" }),
    ).toBeDefined();
  });

  it("renders the picks in the order it was given, oldest first", () => {
    renderTray({
      picks: [
        pick({ assetId: "a1", pickedBy: { id: "client-b", label: "Beto" } }),
        pick({ assetId: "a2", pickedBy: { id: "client-a", label: "Ana" } }),
      ],
    });

    const labels = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent);
    expect(labels).toEqual(["Beto", "Tú"]);
  });

  it("opens the lightbox for the clicked pick rather than changing the selection", async () => {
    // The one control that changes the shared selection stays on the tile in
    // the grid, where it has been since task #24 — the tray is a view.
    const onOpenAsset = vi.fn();
    renderTray({ picks: [pick({ assetId: "a2" })], onOpenAsset });

    await userEvent.click(screen.getByRole("button", { name: /IMG_0002\.JPG/ }));

    expect(onOpenAsset).toHaveBeenCalledWith("a2");
  });

  it("degrades to a labelled placeholder, not a broken image, for a pick this page never rendered", () => {
    // An asset the photographer uploaded after this page was rendered is in
    // the snapshot but has no presigned URL here. Stale-but-honest.
    const { container } = renderTray({ picks: [pick({ assetId: "unknown-asset" })] });

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.getByText(/recarga para verla/i)).toBeDefined();
  });

  it("says the selection is already submitted once the gallery is locked", () => {
    renderTray({ picks: [pick()], isLocked: true });

    expect(screen.getByText(/la selección ya fue enviada/i)).toBeDefined();
    expect(screen.queryByText(/se actualiza sola/i)).toBeNull();
  });

  it("warns that the list may be out of date when the live connection is failing — WITHOUT hiding it", () => {
    // Stale-but-honest beats silently-wrong (task #95's own acceptance
    // criterion): the picks below the warning are the last thing the server
    // actually said, and blanking them would be strictly less useful.
    renderTray({ picks: [pick({ pickedBy: { id: "client-b", label: "Beto" } })], isStale: true });

    expect(screen.getByText(/se perdió la conexión/i)).toBeDefined();
    expect(screen.getByText("Beto")).toBeDefined();
  });

  it("shows no connection warning while the live channel is healthy", () => {
    renderTray({ picks: [pick()], isStale: false });

    expect(screen.queryByText(/se perdió la conexión/i)).toBeNull();
  });

  it("announces changes politely, so a pick arriving from another session is not silent", () => {
    const { container } = renderTray({ picks: [pick()] });

    expect(container.querySelector("section")?.getAttribute("aria-live")).toBe("polite");
  });

  it("shows no empty scroll box alongside the explanatory message when nobody has picked yet", () => {
    // Criterion #7: the message is enough on its own — an empty scrollable
    // box next to it would read as broken, not as "nothing here yet".
    const { container } = renderTray({ picks: [] });

    expect(screen.getByText(/todavía no eligieron ninguna foto/i)).toBeDefined();
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector(".overflow-y-auto")).toBeNull();
  });
});

describe("SelectionTray — collapsible tray with a height-capped list (task #203)", () => {
  /** Builds N picks with distinct asset ids, all attributed to the same
   * (short-named) picker — the row-height guarantee under test comes from
   * <TrayItem>'s `truncate` label, not from any particular name, so a real
   * name is not the point here. */
  function manyPicks(count: number): SelectionPick[] {
    return Array.from({ length: count }, (_, index) =>
      pick({ assetId: `asset-${index}`, pickedBy: { id: "client-b", label: "Beto Ruiz" } }),
    );
  }

  it("starts expanded, showing the list, with the toggle announcing that state", () => {
    renderTray({ picks: [pick()] });

    expect(screen.getByRole("listitem")).toBeDefined();
    expect(screen.getByRole("button", { name: "Ocultar" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("collapsing removes the list from the accessibility tree and the tab order, not just visually", async () => {
    const user = userEvent.setup();
    const { container } = renderTray({ picks: [pick({ assetId: "a1" })] });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    // Not queryable by role at all — this is how Testing Library surfaces
    // "excluded from the accessibility tree", which is the actual criterion,
    // not merely "not visible on screen".
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar" }).getAttribute("aria-expanded")).toBe(
      "false",
    );

    // The `hidden` attribute is what does the work here — jsdom correctly
    // computes `display: none` for it (verified separately), which is the
    // property real browsers use to keep a subtree out of the tab order.
    // jsdom's own `.focus()` does not go on to enforce that (a known jsdom
    // gap: it does not implement the "is being rendered" check the actual
    // focusing steps require), so this asserts the attribute directly
    // instead of leaning on a `.focus()` call jsdom would let succeed anyway.
    const listRegion = container.querySelector("li")?.closest("[hidden]");
    expect(listRegion).not.toBeNull();
  });

  it("re-expanding restores the list to the accessibility tree", async () => {
    const user = userEvent.setup();
    renderTray({ picks: [pick({ assetId: "a1" })] });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));
    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(screen.getByRole("listitem")).toBeDefined();
  });

  it("keeps a visible pick counter in the header so aria-live still has something to announce while collapsed", async () => {
    // Criteria #4 and #5: the header counter is what survives the collapse,
    // so a pick arriving from ANOTHER session while the tray is folded still
    // changes something inside the aria-live="polite" region.
    const user = userEvent.setup();
    const { container, rerender } = renderTray({ picks: [pick({ assetId: "a1" })] });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    const section = container.querySelector("section") as HTMLElement;
    expect(section.getAttribute("aria-live")).toBe("polite");
    // Same reasoning as the "2" assertion below: `closest("[hidden]")` is
    // what proves the counter lives outside the collapsed region, not just
    // that "1" appears somewhere in the section's (hidden-inclusive) text.
    expect(screen.getByText("1").closest("[hidden]")).toBeNull();

    rerender(
      <SelectionTray
        entries={entriesFrom([
          pick({ assetId: "a1" }),
          pick({ assetId: "a2", pickedBy: { id: "client-c", label: "Caro" } }),
        ])}
        urls={{ a1: "https://r2.example.com/a1", a2: "https://r2.example.com/a2" }}
        filenamesByAssetId={{ a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" }}
        viewerId="client-a"
        mode="flat"
        isLocked={false}
        isStale={false}
        allowsOriginalSelection={true}
        onOpenAsset={() => {}}
        onImageError={() => {}}
      />,
    );

    // The counter changed (this is the announcement)... `textContent`
    // includes text from `display:none` subtrees, so merely finding "2"
    // somewhere in the section proves nothing about WHERE it lives — the 50
    // hidden picks' own labels are in that same string. The real claim is
    // that the counter that changed is NOT inside the collapsed (`hidden`)
    // region, i.e. it survived on the still-visible header.
    expect(screen.getByText("2").closest("[hidden]")).toBeNull();
    // ...while the list itself stayed folded away, exactly as the client
    // left it — a pick from someone else must not force it back open.
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("keeps the stale-connection warning visible even while the tray is collapsed", async () => {
    // Criterion #8: this warning is about trusting what's on screen at all,
    // which matters MORE while collapsed, not less. `getByText` alone does
    // NOT prove that — it matches text inside a `hidden`/`display:none`
    // subtree just as readily as visible text, so a regression that moved
    // this warning INSIDE the collapsible region would still pass a bare
    // `toBeDefined()`. Asserting there is no `[hidden]` ancestor is what
    // actually pins it outside the fold.
    const user = userEvent.setup();
    renderTray({ picks: [pick()], isStale: true });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    expect(screen.getByText(/se perdió la conexión/i).closest("[hidden]")).toBeNull();
  });

  it("caps the scrollable list to two rows worth of height with 50 picks — not a class check, an actual measured height", () => {
    // Criterion #2, the one that actually proves the production bug is
    // fixed, and the easiest one to fake (task body's own warning: a
    // `toHaveClass("max-h-...")` assertion is true regardless of which
    // element it landed on and proves nothing). This mocks
    // `getBoundingClientRect` to stand in for jsdom's absent layout engine —
    // sanctioned explicitly by the task — then asserts the actual computed
    // `maxHeight`, in pixels, that the scroll container ends up with.
    //
    // Task #208: a UNIFORM mock here (every element reporting the same box)
    // cannot tell "measured the first `<li>`" from "measured the scroll
    // `<div>` or the `<ul>` itself" — a reviewer proved this by pointing the
    // flat measurement at `list.parentElement` instead of the first item and
    // watching this exact test stay green. Per-element-type mocks, same
    // treatment as #204's own by-person fix below (:805): the real row lands
    // only on `HTMLLIElement`, every OTHER element type gets an implausibly
    // large height, so measuring the wrong node produces an unmistakably
    // wrong cap instead of a coincidentally-close one.
    const rowHeightPx = 120; // stand-in for one real item + its label
    const wrongElementHeightPx = 4_000;
    vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: rowHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: rowHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
    const wrongElementRect = {
      height: wrongElementHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: wrongElementHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
    // Both the scroll `<div>` AND the `<ul>` itself — either one is "the
    // wrong element" if a regression measured it instead of the first `<li>`.
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);
    vi.spyOn(HTMLUListElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);

    const { container } = renderTray({ picks: manyPicks(50) });

    expect(screen.getAllByRole("listitem")).toHaveLength(50);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.className).toContain("overscroll-contain");

    // Two rows plus one gap between them — see selection-tray.tsx's
    // `FALLBACK_ROW_GAP_PX` comment for why 12px is the right fallback under
    // jsdom specifically (no compiled Tailwind stylesheet loaded here to
    // read the real `gap-3` value from).
    // The universal split (epic #250 S7) replaced the flat measured cap with
    // a fixed pre-measure ceiling; the point that survives is that it does
    // not grow with the pick count.
    const expectedMaxHeightPx = 260;
    expect(scrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);

    // The bug this task fixes was height growing WITH the pick count. Prove
    // the cap does not scale: 3 picks must land on the exact same number.
    cleanup();
    const { container: fewContainer } = renderTray({ picks: manyPicks(3) });
    const fewScrollContainer = fewContainer.querySelector(".overflow-y-auto") as HTMLElement;
    expect(fewScrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);
  });

  // Task #206, criterion 8, the governing constraint: with 50 picks and NONE
  // of them marked original, the cap this task fixed must land on the exact
  // SAME number it did before this slice existed — an extra type line on
  // every item would grow the measured row height and, with it, the cap.
  it("does not change the measured cap for 50 picks when nobody marked an original (criterion 8)", () => {
    // Task #208: same per-element-type treatment as the test above — a
    // uniform mock cannot distinguish "measured the right `<li>`" from
    // "measured the wrong element", which is exactly the class of regression
    // this criterion needs to still catch once #206's type line is in play.
    const rowHeightPx = 120;
    const wrongElementHeightPx = 4_000;
    vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: rowHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: rowHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
    const wrongElementRect = {
      height: wrongElementHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: wrongElementHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);
    vi.spyOn(HTMLUListElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);

    const { container } = renderTray({ picks: manyPicks(50) });

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer.style.maxHeight).toBe("260px");
  });
});

describe("SelectionTray — the type line (task #206)", () => {
  it("renders no type line at all when nobody in the gallery marked an original (criterion 8)", () => {
    renderTray({
      picks: [
        pick({ assetId: "a1", selectionKind: "edited" }),
        pick({ assetId: "a2", selectionKind: "edited" }),
      ],
    });

    // Not "no text says Original" alone — that would also pass if the whole
    // tray failed to render. Positive control first, then the negative.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("Editada")).toBeNull();
    expect(screen.queryByText("Original")).toBeNull();
  });

  it("shows every item's own type once ANY pick in the gallery is original", () => {
    renderTray({
      picks: [
        pick({ assetId: "a1", selectionKind: "edited" }),
        pick({ assetId: "a2", selectionKind: "original" }),
      ],
    });

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Both items carry their OWN type, not just the original one — the
    // design decision recorded in selection-tray.tsx's own comment (uniform
    // item height once the line is on at all).
    expect(within(items[0]!).getByText("Editada")).toBeDefined();
    expect(within(items[1]!).getByText("Original")).toBeDefined();
  });

  it("marks the type line's own accessible name too, only once the gallery has any original", () => {
    renderTray({
      picks: [
        pick({
          assetId: "a1",
          pickedBy: { id: "client-b", label: "Beto" },
          selectionKind: "original",
        }),
      ],
    });

    expect(
      screen.getByRole("button", { name: "Ver IMG_0001.JPG, elegida por Beto, original" }),
    ).toBeDefined();
  });

  it("does not change the accessible name at all when nobody marked an original", () => {
    renderTray({
      picks: [
        pick({
          assetId: "a1",
          pickedBy: { id: "client-b", label: "Beto" },
          selectionKind: "edited",
        }),
      ],
    });

    expect(
      screen.getByRole("button", { name: "Ver IMG_0001.JPG, elegida por Beto" }),
    ).toBeDefined();
  });

  // Criterion 7 — the type line must not silently reintroduce #203's bug for
  // a gallery that DOES have originals: 50 picks, some original, still caps
  // at two rows.
  //
  // ⚠️ NOT the blind uniform `HTMLElement.prototype` mock the flat cap's own
  // ORIGINAL test used to use, before task #208 fixed it: that mock could not
  // tell "measured the right `<li>`" from "measured the wrong element" — a
  // reviewer proved this by pointing flat's own measurement at the SCROLL
  // CONTAINER instead of the first item and watching that blind test stay
  // green. This test's own change (the type line) does not touch WHICH
  // element gets measured, but the task's own instruction is explicit: any
  // test this slice needs the flat cap to hold through follows the CORRECTED
  // per-element-type pattern (#204's own fix for by-person mode), same
  // pattern #208 later applied to flat's own test too. `HTMLLIElement` gets
  // the real row height; every OTHER element type (the `<ul>`, the scroll
  // `<div>`) gets an implausibly large one, so a regression that measured the
  // wrong element produces an unmistakably wrong cap instead of a
  // coincidentally-close one.
  it("still caps the scrollable list to two rows worth of height with 50 picks, some of them original", () => {
    const itemHeightPx = 132; // stand-in for one real item + label + type line
    const wrongElementHeightPx = 4_000;
    vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: itemHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: itemHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
    const wrongElementRect = {
      height: wrongElementHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: wrongElementHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    };
    // Both the scroll `<div>` AND the `<ul>` itself — either one is "the
    // wrong element" if a regression measured it instead of the first `<li>`.
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);
    vi.spyOn(HTMLUListElement.prototype, "getBoundingClientRect").mockReturnValue(wrongElementRect);
    const picks = Array.from({ length: 50 }, (_, index) =>
      pick({
        assetId: `asset-${index}`,
        pickedBy: { id: "client-b", label: "Beto Ruiz" },
        selectionKind: index % 5 === 0 ? "original" : "edited",
      }),
    );

    const { container } = renderTray({ picks });

    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer.style.maxHeight).toBe("260px");
  });

  it("shows the type line in by-person mode too, per item within each group", () => {
    renderTray({
      mode: "by-person",
      viewerId: "client-a",
      picks: [
        pick({
          assetId: "a1",
          pickedBy: { id: "client-a", label: "Ana" },
          selectionKind: "original",
        }),
      ],
    });

    expect(screen.getByText("Original")).toBeDefined();
  });
});

describe("SelectionTray — allowsOriginalSelection is OFF (task #214)", () => {
  // Criterion 3's own tray counterpart: a REAL `original` pick in the list —
  // not a data anomaly this component invented — must still show no type
  // line at all while the gallery's own switch is off. "Absent, not zeroed"
  // applies to the FLAG, not only to `hasAnyOriginal`.
  it("renders no type line at all, even with a genuinely original pick, while the switch is off", () => {
    renderTray({
      allowsOriginalSelection: false,
      picks: [
        pick({ assetId: "a1", selectionKind: "edited" }),
        pick({ assetId: "a2", selectionKind: "original" }),
      ],
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("Editada")).toBeNull();
    expect(screen.queryByText("Original")).toBeNull();
  });

  it("does not change the accessible name, even with a genuinely original pick, while the switch is off", () => {
    renderTray({
      allowsOriginalSelection: false,
      picks: [
        pick({
          assetId: "a1",
          pickedBy: { id: "client-b", label: "Beto" },
          selectionKind: "original",
        }),
      ],
    });

    expect(
      screen.getByRole("button", { name: "Ver IMG_0001.JPG, elegida por Beto" }),
    ).toBeDefined();
  });
});

describe("groupPicksByPicker (task #204) — the pure grouping function", () => {
  it("groups by picker id, not by label — two different people sharing a name stay separate", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: { id: "client-x", label: "Ana" } }),
      pick({ assetId: "a2", pickedBy: { id: "client-y", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), null);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(["client-x", "client-y"]);
  });

  it("identifies the viewer's group by id, never by label — a different person sharing the viewer's name stays separate", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: { id: "client-a", label: "Zoe Restrepo" } }),
      pick({ assetId: "a2", pickedBy: { id: "client-b", label: "Zoe Restrepo" } }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), "client-a");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "client-a", label: "Tú" });
    expect(groups[1]).toMatchObject({ key: "client-b", label: "Zoe Restrepo" });
  });

  // THE TASK'S OWN NAMED TRAP: if the viewer's name happened to sort FIRST
  // alphabetically, this would pass under plain alphabetical order too and
  // prove nothing about the "viewer first" rule specifically. "Zoe" sorts
  // after both "Ana" and "Beto".
  it("orders the viewer first, the rest alphabetically, unattributed last — with a viewer name that sorts LAST alphabetically", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: { id: "client-z", label: "Zoe Restrepo" } }),
      pick({ assetId: "a2", pickedBy: { id: "client-b", label: "Beto Ruiz" } }),
      pick({ assetId: "a3", pickedBy: { id: "client-a", label: "Ana Gómez" } }),
      pick({ assetId: "a4", pickedBy: null }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), "client-z");

    expect(groups.map((g) => g.label)).toEqual(["Tú", "Ana Gómez", "Beto Ruiz", "Sin registro"]);
  });

  it("keeps within-group order exactly as given — oldest pick first, never reordered", () => {
    const picks = [
      pick({ assetId: "old", pickedBy: { id: "client-a", label: "Ana" } }),
      pick({ assetId: "new", pickedBy: { id: "client-a", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), null);

    expect(groups[0]?.picks.map((p) => p.assetId)).toEqual(["old", "new"]);
  });

  it("keeps every unattributed pick in ONE group at the end, never split or merged into a named one", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: null }),
      pick({ assetId: "a2", pickedBy: null }),
      pick({ assetId: "a3", pickedBy: { id: "client-a", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), null);

    expect(groups[groups.length - 1]).toMatchObject({ label: "Sin registro" });
    expect(groups[groups.length - 1]?.picks).toHaveLength(2);
  });

  it("does not sort by how many each person picked — a small viewer group still leads a much bigger one", () => {
    // The trap the task body names explicitly: sorting by count would make
    // rows jump position as a live pick arrives. One pick for the viewer,
    // five for someone else — count-based order would put the OTHER person
    // first; this must not.
    const picks = [
      ...Array.from({ length: 5 }, (_unused, index) =>
        pick({ assetId: `big-${index}`, pickedBy: { id: "client-b", label: "Beto Ruiz" } }),
      ),
      pick({ assetId: "a1", pickedBy: { id: "client-a", label: "Ana Gómez" } }),
    ];

    const groups = groupPicksByPicker(entriesFrom(picks), "client-a");

    expect(groups[0]).toMatchObject({
      key: "client-a",
      picks: [expect.objectContaining({ assetId: "a1" })],
    });
  });
});

describe("SelectionTray — by-person mode (task #204)", () => {
  function namedPick(assetId: string, pickerId: string, label: string): SelectionPick {
    return pick({ assetId, pickedBy: { id: pickerId, label } });
  }

  /** Every `<p>` in the tray whose text names a group ("Name (N)"), in
   * document order — the group headers, and only the group headers: the
   * stale-connection warning and the empty-state message never contain a
   * parenthesized count. */
  function groupHeaderTexts(container: HTMLElement): (string | null)[] {
    return [...container.querySelectorAll("p")]
      .filter((p) => /\(\d+\)/.test(p.textContent ?? ""))
      .map((p) => p.textContent);
  }

  // The by-person branch must be gated on `mode`, not silently active
  // whenever there is more than one picker. Flat now groups by STATE (the
  // universal split), never by person.
  it("flat mode groups by state, not by person, even with 3 different pickers", () => {
    const { container } = renderTray({
      mode: "flat",
      // Distinct from every pick's own `pickedBy.id` below, so none of them
      // reads as "Tú" and the labels asserted are the raw names — this test
      // is about layout, not attribution.
      viewerId: "viewer-not-in-this-list",
      urls: {
        a1: "https://r2.example.com/a1",
        a2: "https://r2.example.com/a2",
        a3: "https://r2.example.com/a3",
      },
      picks: [
        namedPick("a1", "client-b", "Beto Ruiz"),
        namedPick("a2", "client-a", "Ana Gómez"),
        namedPick("a3", "client-c", "Caro"),
      ],
    });

    // By-person renders one <ul> PER PICKER; flat renders the state split.
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
    expect(groupHeaderTexts(container)).toEqual(["Pedidas (3)"]);
    // Insertion order preserved — never re-sorted alphabetically the way
    // by-person's OWN groups would be.
    const labels = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent);
    expect(labels).toEqual(["Beto Ruiz", "Ana Gómez", "Caro"]);
  });

  // Criterion 3 and criterion 6 (the counts sum to the total) together.
  it("groups picks into one row per picker, each with a name and a count that sums to the total", () => {
    const { container } = renderTray({
      mode: "by-person",
      viewerId: "client-a",
      picks: [
        namedPick("a1", "client-a", "Ana Gómez"),
        namedPick("a2", "client-a", "Ana Gómez"),
        namedPick("a3", "client-b", "Beto Ruiz"),
        namedPick("a4", "client-c", "Caro Ruiz"),
        namedPick("a5", "client-c", "Caro Ruiz"),
        namedPick("a6", "client-c", "Caro Ruiz"),
      ],
    });

    expect(groupHeaderTexts(container)).toEqual([
      "Tú (2)envió",
      "Beto Ruiz (1)envió",
      "Caro Ruiz (3)envió",
    ]);
    // Criterion 3: thumbnails still render through the SAME <TrayItem> — one
    // <ul> per group (3 people), one <li> per pick (6 total), and the
    // per-group counts (2 + 1 + 3) sum to that same 6.
    expect(container.querySelectorAll("ul")).toHaveLength(3);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
  });

  // Task #262 review, warning 3. Since Q1 another person's UNSENT cart IS an
  // entry (`claim: null`), and `groupPicksByPicker` groups CLAIMED entries
  // only. Gating the empty state on `entries.length` meant a by-person tray
  // holding nothing but other people's carts rendered an empty scroll box
  // with no copy — the state task #203 criterion 7 forbids. The gate is now
  // `claimed.length === 0 && unsent.length === 0` for by-person (finding 1
  // added the unsent half: the VIEWER's own cart is `claim: null` too).
  it("shows the empty state when by-person's only entries are other people's carts", () => {
    const otherCart = {
      assetId: "a1",
      claim: null,
      picks: [
        {
          userId: "client-b",
          label: "Beto Ruiz",
          kind: "edited" as const,
          pickedAt: "2026-07-30T12:00:00.000Z",
          submittedAt: null,
          state: "cart" as const,
        },
      ],
    };

    const { container } = renderTray({ mode: "by-person", entries: [otherCart] });

    expect(screen.getByText(/Todavía no eligieron ninguna foto/)).toBeDefined();
    // And no empty scroll box around it.
    expect(container.querySelectorAll("ul")).toHaveLength(0);
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(0);
    cleanup();

    // Flat mode reaches the same copy through its own state split; the fix
    // above must not have moved that behaviour either.
    renderTray({ mode: "flat", entries: [otherCart] });
    expect(screen.getByText(/Todavía no eligieron ninguna foto/)).toBeDefined();
  });

  // Task #262 review, finding 1 — the state EVERY by-person gallery starts
  // in: the viewer has picked a photo and nobody has sent anything yet. The
  // viewer's own cart is an entry with `claim: null` (Q1), so gating the
  // empty copy on `claimed.length` alone told the client "nobody has picked a
  // photo yet" right after they picked one.
  it("shows the viewer's own unsent cart as 'Por enviar', never the empty state", () => {
    const ownCart = fixtureEntry("a1", null, [fixturePick("client-a", "Ana", "cart")]);
    const { container } = renderTray({
      mode: "by-person",
      viewerId: "client-a",
      entries: [ownCart],
    });

    expect(screen.queryByText(/Todavía no eligieron ninguna foto/)).toBeNull();
    expect(groupHeaderTexts(container)).toEqual(["Por enviar (1)"]);
    // The pick is really rendered — once — and not duplicated into "Tú"'s
    // claimed group.
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(groupHeaderTexts(container)).not.toContain("Tú (1)");
  });

  // Task #262 review, finding 2 — by-person does NOT dedupe across sections,
  // and that is the owner-approved behaviour (2026-10-17), not an oversight.
  // Rows are UNITS (approved Q5): an asset billed to Beto stays in Beto's
  // row, including its "envió" marker, while the viewer's DEGRADED pick on it
  // (decision 8: their own unsent ask on a photo somebody else already sent)
  // belongs in their "Por enviar" group. The same asset in two people's rows
  // is exactly what by-person mode is for. This test exists because the
  // previous "one entry, once" filter made a1 vanish from Beto's row and the
  // whole suite stayed green: delete it today and this goes RED.
  it("keeps a degraded pick in BOTH the viewer's 'Por enviar' and the row of the person its unit is billed to", () => {
    const degradedOnBeto = fixtureEntry("a1", { billedTo: { id: "client-b", label: "Beto" } }, [
      fixturePick("client-b", "Beto", "billed"),
      fixturePick("client-a", "Ana", "degraded"),
    ]);
    const { container } = renderTray({
      mode: "by-person",
      viewerId: "client-a",
      entries: [degradedOnBeto],
    });

    // Beto really did send, so his row (and the "envió" marker) survives.
    expect(groupHeaderTexts(container)).toEqual(["Por enviar (1)", "Beto (1)envió"]);

    // Exactly ONE <li> per section — never two inside one section — and both
    // sections hold the SAME asset: the billed unit under Beto, the viewer's
    // degraded ask under "Por enviar".
    const sections = [...container.querySelectorAll("p")]
      .filter((p) => /\(\d+\)/.test(p.textContent ?? ""))
      .map((p) => p.parentElement!.querySelectorAll("li"));
    expect(sections).toHaveLength(2);
    expect(sections.map((items) => items.length)).toEqual([1, 1]);
    const renderedAssetSrcs = [...container.querySelectorAll("li img")].map((img) =>
      img.getAttribute("src"),
    );
    expect(renderedAssetSrcs).toEqual(["https://r2.example.com/a1", "https://r2.example.com/a1"]);
  });

  // Criterion 4 — the task's own named trap: the viewer's name ("Zoe
  // Restrepo") sorts LAST alphabetically against "Ana" and "Beto", so this
  // fails under plain alphabetical order and only passes if "viewer first"
  // is actually implemented as its own rule.
  it("puts the viewer's row first even though their name sorts last alphabetically", () => {
    const { container } = renderTray({
      mode: "by-person",
      viewerId: "client-z",
      picks: [
        namedPick("a1", "client-z", "Zoe Restrepo"),
        namedPick("a2", "client-b", "Beto Ruiz"),
        namedPick("a3", "client-a", "Ana Gómez"),
      ],
    });

    expect(groupHeaderTexts(container)).toEqual([
      "Tú (1)envió",
      "Ana Gómez (1)envió",
      "Beto Ruiz (1)envió",
    ]);
  });

  // Criterion 5 — unattributed picks (a deleted user, `onDelete: "set null"`)
  // get their own group, always last, never dropped and never merged into a
  // named picker's group.
  it("puts unattributed picks in their own 'Sin registro' group, at the end", () => {
    const { container } = renderTray({
      mode: "by-person",
      viewerId: "client-a",
      picks: [
        namedPick("a1", "client-a", "Ana Gómez"),
        pick({ assetId: "a2", pickedBy: null }),
        namedPick("a3", "client-b", "Beto Ruiz"),
      ],
    });

    expect(groupHeaderTexts(container)).toEqual([
      "Tú (1)envió",
      "Beto Ruiz (1)envió",
      "Sin registro (1)",
    ]);
    // Not lost: still 3 thumbnails rendered in total.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  // Criterion 8 — collapse/expand still works in by-person mode, same
  // native-`hidden` mechanism #203 established for flat.
  it("starts expanded and collapses correctly in by-person mode too", async () => {
    const user = userEvent.setup();
    const { container } = renderTray({
      mode: "by-person",
      picks: [namedPick("a1", "client-b", "Beto Ruiz")],
    });

    expect(screen.getByRole("listitem")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    // Not queryable by role at all — same "excluded from the accessibility
    // tree" proof #203's own flat-mode test uses. The `<li>` is still in the
    // DOM (jsdom's `querySelector` does not care about `hidden`), so this
    // checks it has a `[hidden]` ancestor rather than that it disappeared.
    expect(screen.queryByRole("listitem")).toBeNull();
    const listRegion = container.querySelector("li")?.closest("[hidden]");
    expect(listRegion).not.toBeNull();

    // The header counter survives collapse in EITHER mode — same criterion
    // #203 established, re-checked here because by-person renders a
    // completely different subtree below it.
    expect(screen.getByText("1").closest("[hidden]")).toBeNull();
  });

  // Criterion 7 — the height cap MUST NOT depend on how lopsided the groups
  // are: 40 picks in one group and 5 each in two others would blow the cap
  // wide open if the implementation measured a whole GROUP's stacked height
  // instead of a single item's.
  //
  // MOCKED PER ELEMENT TYPE, not uniformly — review finding (BLOCKING 2): an
  // earlier version of this test mocked `HTMLElement.prototype` itself, so
  // EVERY element (a single `<li>` thumbnail and a whole group's own stacked
  // `<div>` wrapper alike) reported the identical fake height. That made the
  // exact regression this test claims to guard against — the effect's
  // `container?.querySelector("li")` regressing to `querySelector("div")`,
  // silently measuring the first GROUP'S wrapper instead of one thumbnail —
  // completely invisible: reviewer applied that one-word mutation and all
  // 33 tests in this file still passed. Mocking `<li>` and `<div>` to
  // report DIFFERENT heights is what makes "which element got measured"
  // an observable fact instead of a comment's unverified claim.
  it("caps by-person's list from a THUMBNAIL's own height, not a whole group's — measured, not assumed, and independent of how lopsided the groups are", () => {
    const itemHeightPx = 120; // a single <TrayItem>'s own real height
    // What a group's own STACKED wrapper `<div>` would report if THAT were
    // measured instead — implausibly large on purpose, so a wrong-element
    // regression produces an unmistakably wrong cap rather than a
    // coincidentally-close one.
    const groupWrapperHeightPx = 4_000;

    vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: itemHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: itemHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: groupWrapperHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: groupWrapperHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });

    const picks = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        namedPick(`big-${index}`, "client-a", "Ana Gómez"),
      ),
      ...Array.from({ length: 5 }, (_unused, index) =>
        namedPick(`mid-${index}`, "client-b", "Beto Ruiz"),
      ),
      ...Array.from({ length: 5 }, (_unused, index) =>
        namedPick(`small-${index}`, "client-c", "Caro Ruiz"),
      ),
    ];

    const { container } = renderTray({ mode: "by-person", picks });

    expect(screen.getAllByRole("listitem")).toHaveLength(50);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.className).toContain("overscroll-contain");

    // The SAME formula #203 established for flat mode (two item-heights plus
    // one row-gap) — 252px. A regression that measured the group wrapper
    // `<div>` instead would land on 4_000 * 2 + 12 = 8_012px, an order of
    // magnitude off and impossible to mistake for a rounding difference.
    const expectedMaxHeightPx = itemHeightPx * 2 + 12;
    expect(scrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);

    // Distribution flipped (a small group renders first this time) — same
    // cap regardless, proving it tracks a single ITEM, not "whichever group
    // happens to be first".
    cleanup();
    const flippedPicks = [
      ...Array.from({ length: 2 }, (_unused, index) =>
        namedPick(`first-${index}`, "client-a", "Ana Gómez"),
      ),
      ...Array.from({ length: 48 }, (_unused, index) =>
        namedPick(`rest-${index}`, "client-b", "Beto Ruiz"),
      ),
    ];
    const { container: flippedContainer } = renderTray({ mode: "by-person", picks: flippedPicks });
    const flippedScrollContainer = flippedContainer.querySelector(
      ".overflow-y-auto",
    ) as HTMLElement;
    expect(flippedScrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);
  });

  // Task #206, criterion 7 — the SAME 50-pick, lopsided-groups stress case
  // above, but with originals mixed in (task #206's own reason to re-check
  // this file's cap at all: an extra line per item is exactly the kind of
  // change that could silently move it). Same corrected per-element-type
  // mocking as the test above — a wrong-element regression must still be
  // unmistakable, not just "the flat mode's own test happens to stay green
  // regardless of which element got measured", which is what task #208 later
  // fixed for flat mode's own tests.
  it("keeps by-person's own height cap correct with 50 picks across 3 groups, some marked original", () => {
    const itemHeightPx = 132; // one real item + label + type line
    const groupWrapperHeightPx = 4_000;

    vi.spyOn(HTMLLIElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: itemHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: itemHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });
    vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: groupWrapperHeightPx,
      width: 96,
      top: 0,
      left: 0,
      right: 96,
      bottom: groupWrapperHeightPx,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    });

    const picks = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        pick({
          assetId: `big-${index}`,
          pickedBy: { id: "client-a", label: "Ana Gómez" },
          selectionKind: index % 4 === 0 ? "original" : "edited",
        }),
      ),
      ...Array.from({ length: 5 }, (_unused, index) =>
        pick({ assetId: `mid-${index}`, pickedBy: { id: "client-b", label: "Beto Ruiz" } }),
      ),
      ...Array.from({ length: 5 }, (_unused, index) =>
        pick({ assetId: `small-${index}`, pickedBy: { id: "client-c", label: "Caro Ruiz" } }),
      ),
    ];

    const { container } = renderTray({ mode: "by-person", picks });

    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer.style.maxHeight).toBe(`${itemHeightPx * 2 + 12}px`);
    // And the type line really is there, in this mode too.
    expect(within(scrollContainer).getAllByText("Original").length).toBeGreaterThan(0);
  });
});

// Task #236 — slim collapsed row on mobile. jsdom applies no Tailwind, so
// these pin the structural contract: the subtitle lives INSIDE the collapsible
// region (native `hidden` when collapsed), never in the header row.
describe("SelectionTray — compact chrome (task #236)", () => {
  it("keeps the subtitle inside the collapsible region, not in the header row", () => {
    renderTray({ picks: [pick()] });

    const subtitle = screen.getByText("Puedes seguir eligiendo y enviar más fotos cuando quieras.");
    const toggle = screen.getByRole("button", { name: "Ocultar" });
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(region?.contains(subtitle)).toBe(true);
    const headerRow = screen.getByRole("heading", { name: "Fotos elegidas" }).parentElement
      ?.parentElement;
    expect(headerRow?.contains(subtitle)).toBe(false);
  });

  it("collapsed: the subtitle is inside a native-hidden region, the heading and count stay visible", async () => {
    const user = userEvent.setup();
    renderTray({ picks: [pick()] });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));

    const subtitle = screen.getByText("Puedes seguir eligiendo y enviar más fotos cuando quieras.");
    expect(subtitle.closest("[hidden]")).not.toBeNull();
    const heading = screen.getByRole("heading", { name: "Fotos elegidas" });
    expect(heading.closest("[hidden]")).toBeNull();
    expect(screen.getByText("1").closest("[hidden]")).toBeNull();
  });

  it("locked: the 'ya fue enviada' note is inside the region too", async () => {
    const user = userEvent.setup();
    renderTray({ picks: [pick()], isLocked: true });

    await user.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(screen.getByText("La selección ya fue enviada.").closest("[hidden]")).not.toBeNull();
  });

  it("zero picks: the toggle and the empty-state paragraph are hidden below lg (nothing to fold)", () => {
    renderTray({ picks: [] });

    expect(screen.getByRole("button", { name: "Ocultar" }).className).toContain("max-lg:hidden");
    expect(screen.getByText(/Todavía no eligieron ninguna foto/).className).toContain(
      "max-lg:hidden",
    );
  });

  it("with picks the toggle is offered at every width", () => {
    renderTray({ picks: [pick()] });

    expect(screen.getByRole("button", { name: "Ocultar" }).className).not.toContain(
      "max-lg:hidden",
    );
  });

  // Epic #239 (task #241).
  describe("per-person lock", () => {
    // Two people who SHARE a display name: only the id may decide who "envió".
    const twin1 = { id: "client-b", label: "Beto Ruiz" };
    const twin2 = { id: "client-c", label: "Beto Ruiz" };

    it("marks only the group whose id is locked, even when another person has the same name", () => {
      renderTray({
        mode: "by-person",
        picks: [pick({ assetId: "a1", pickedBy: twin1 }), pick({ assetId: "a2", pickedBy: twin2 })],
        adminLockedPickerIds: ["client-c"],
      });

      expect(screen.getAllByText("envió")).toHaveLength(1);
      // Both group headers read "Beto Ruiz (1)"; exactly one carries the marker.
      const headers = screen
        .getAllByText(/Beto Ruiz/, { selector: "p" })
        .filter((node) => node.textContent?.includes("(1)"));
      expect(headers).toHaveLength(2);
      expect(headers.filter((header) => header.textContent?.includes("envió"))).toHaveLength(1);
    });

    it("marks a submitter 'envió' and a photographer-locked person 'cerrada', never the reverse", () => {
      renderTray({
        mode: "by-person",
        picks: [pick({ assetId: "a1", pickedBy: twin1 }), pick({ assetId: "a2", pickedBy: twin2 })],
        adminLockedPickerIds: ["client-c"],
      });

      expect(screen.getAllByText("envió")).toHaveLength(1);
      expect(screen.getAllByText("cerrada")).toHaveLength(1);
      expect(screen.getByText("envió").parentElement?.textContent).toBe("Beto Ruiz (1)envió");
      expect(screen.getByText("cerrada").parentElement?.textContent).toBe("Beto Ruiz (1)cerrada");
    });

    it("shows no marker for an UNSENT pick with no admin lock", () => {
      renderTray({
        mode: "by-person",
        picks: [pick({ selectedAt: null })],
        adminLockedPickerIds: [],
      });

      expect(screen.queryByText("envió")).toBeNull();
      expect(screen.queryByText("cerrada")).toBeNull();
    });

    // Task #261 review, warning 1. The badge used to ask only whether SOME
    // pick on the entry was sent, never WHOSE — so a legacy "Sin registro"
    // unit (`claim.billedTo === null`, a real state: the 0017 backfill's
    // classic claims) read "Sin registro (1) envió" the moment another
    // member joined that photo and sent their own pick. The header names
    // nobody, so it cannot credit a send to anyone.
    it("shows no 'envió' for an unattributed legacy unit, even when a member's joined pick was sent", () => {
      const { container } = renderTray({
        mode: "by-person",
        entries: [
          {
            assetId: "a1",
            claim: {
              claimedAt: "2026-07-01T09:00:00.000Z",
              resolvedKind: "edited",
              billedTo: null,
              charge: "included",
            },
            // Exactly what the domain emits for this shape: the unit has no
            // billed holder, so a submitted pick on it resolves to "joined"
            // (pick-resolution.ts) rather than "billed".
            picks: [
              {
                userId: "client-b",
                label: "Beto Ruiz",
                kind: "edited",
                pickedAt: "2026-07-30T12:00:00.000Z",
                submittedAt: "2026-07-30T12:00:00.000Z",
                state: "joined",
              },
            ],
          },
        ],
      });

      // The group still renders, under its own header — this is about the
      // badge, not about dropping the photo.
      const header = [...container.querySelectorAll("p")].find((p) =>
        /\(\d+\)/.test(p.textContent ?? ""),
      );
      expect(header?.textContent).toBe("Sin registro (1)");
      expect(screen.getAllByRole("listitem")).toHaveLength(1);
      // No badge ANYWHERE: not on that header, not on any other.
      expect(screen.queryByText("envió")).toBeNull();
      expect(screen.queryByText("cerrada")).toBeNull();
    });

    it("tells a photographer-locked viewer their selection was closed, never that it was sent", () => {
      renderTray({ picks: [pick()], isLocked: true, isGalleryLocked: false, lockedByAdmin: true });

      expect(
        screen.getByText("Tu fotógrafo cerró tu selección. Los demás todavía están eligiendo."),
      ).toBeDefined();
      expect(screen.queryByText(/ya fue enviada/)).toBeNull();
    });

    it("says only the viewer's selection was sent when they are locked but the gallery is not", () => {
      renderTray({ picks: [pick()], isLocked: true, isGalleryLocked: false });

      expect(
        screen.getByText("Tu selección ya fue enviada. Los demás todavía están eligiendo."),
      ).toBeDefined();
      expect(screen.queryByText("La selección ya fue enviada.")).toBeNull();
    });

    it("keeps the gallery-wide wording when the gallery itself is locked", () => {
      renderTray({ picks: [pick()], isLocked: true, isGalleryLocked: true });

      expect(screen.getByText("La selección ya fue enviada.")).toBeDefined();
    });
  });
});

// Epic #250 S7 — the rolling split is now the ONLY proofing layout (by-person
// stays its own alternate), so a gallery with the flag OFF must still show
// "Por enviar" / "Pedidas", and the included/extra boundary inside Pedidas is
// a visible cut with the existing "Extra" tag.
describe("SelectionTray — universal order split (S7)", () => {
  const baseProps = {
    urls: {
      a1: "https://r2.example.com/a1",
      a2: "https://r2.example.com/a2",
    },
    filenamesByAssetId: { a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" },
    viewerId: "client-a",
    mode: "flat" as const,
    isLocked: false,
    isStale: false,
    allowsOriginalSelection: true,
    rollingDelivery: false,
    onOpenAsset: () => {},
    onImageError: () => {},
  };

  it("shows Por enviar and Pedidas without rolling delivery", () => {
    render(
      <SelectionTray
        {...baseProps}
        entries={[
          fixtureEntry("a1", null, [fixturePick("client-a", "Ana", "cart")]),
          fixtureEntry("a2", { billedTo: { id: "client-b", label: "Beto" } }, [
            fixturePick("client-b", "Beto", "billed"),
          ]),
        ]}
      />,
    );

    const headings = Array.from(
      screen.getByRole("region", { name: "Fotos elegidas" }).querySelectorAll("p"),
    ).map((p) => p.textContent?.trim());
    expect(headings).toContain("Por enviar (1)");
    expect(headings).toContain("Pedidas (1)");
  });

  it("cuts Pedidas before the first extra-charge unit and tags it 'Extra'", () => {
    render(
      <SelectionTray
        {...baseProps}
        entries={[
          fixtureEntry("a1", { billedTo: { id: "client-b", label: "Beto" }, charge: "included" }, [
            fixturePick("client-b", "Beto", "billed"),
          ]),
          fixtureEntry("a2", { billedTo: { id: "client-b", label: "Beto" }, charge: "extra" }, [
            fixturePick("client-b", "Beto", "billed"),
          ]),
        ]}
      />,
    );

    const tag = screen.getByText("Extra");
    const cut = tag.closest("li");
    expect(cut).not.toBeNull();
    // The cut lands exactly before the extra unit, in arrival order.
    const nextItem = cut?.nextElementSibling as HTMLElement;
    expect(within(nextItem).getByRole("button", { name: /IMG_0002\.JPG/ })).toBeDefined();
    expect(screen.queryAllByText("Extra")).toHaveLength(1);
  });
});
