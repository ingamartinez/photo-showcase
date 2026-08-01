// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { groupPicksByPicker, SelectionTray } from "./selection-tray";
import type { SelectionPick } from "@/lib/selection-snapshot";

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

function renderTray(overrides: Partial<ComponentProps<typeof SelectionTray>> = {}) {
  return render(
    <SelectionTray
      picks={[]}
      urls={{ a1: "https://r2.example.com/a1", a2: "https://r2.example.com/a2" }}
      filenamesByAssetId={{ a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" }}
      viewerId="client-a"
      // Task #204 — default to `flat`, today's only behavior. The by-person
      // describe block below overrides this explicitly per test.
      mode="flat"
      isLocked={false}
      isStale={false}
      onOpenAsset={() => {}}
      onImageError={() => {}}
      {...overrides}
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

  it("attributes the viewer's own pick as 'Vos'", () => {
    renderTray({ picks: [pick({ pickedBy: { id: "client-a", label: "Ana Pérez" } })] });

    expect(screen.getByText("Vos")).toBeDefined();
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

    const labels = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(labels).toEqual(["Beto", "Vos"]);
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
    expect(screen.getByText(/recargá para verla/i)).toBeDefined();
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
        picks={[
          pick({ assetId: "a1" }),
          pick({ assetId: "a2", pickedBy: { id: "client-c", label: "Caro" } }),
        ]}
        urls={{ a1: "https://r2.example.com/a1", a2: "https://r2.example.com/a2" }}
        filenamesByAssetId={{ a1: "IMG_0001.JPG", a2: "IMG_0002.JPG" }}
        viewerId="client-a"
        mode="flat"
        isLocked={false}
        isStale={false}
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
    const rowHeightPx = 120; // stand-in for one real item + its label
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
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

    const { container } = renderTray({ picks: manyPicks(50) });

    expect(screen.getAllByRole("listitem")).toHaveLength(50);

    const scrollContainer = container.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.className).toContain("overscroll-contain");

    // Two rows plus one gap between them — see selection-tray.tsx's
    // `FALLBACK_ROW_GAP_PX` comment for why 12px is the right fallback under
    // jsdom specifically (no compiled Tailwind stylesheet loaded here to
    // read the real `gap-3` value from).
    const expectedMaxHeightPx = rowHeightPx * 2 + 12;
    expect(scrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);

    // The bug this task fixes was height growing WITH the pick count. Prove
    // the cap does not scale: 3 picks must land on the exact same number.
    cleanup();
    const { container: fewContainer } = renderTray({ picks: manyPicks(3) });
    const fewScrollContainer = fewContainer.querySelector(".overflow-y-auto") as HTMLElement;
    expect(fewScrollContainer.style.maxHeight).toBe(`${expectedMaxHeightPx}px`);
  });
});

describe("groupPicksByPicker (task #204) — the pure grouping function", () => {
  it("groups by picker id, not by label — two different people sharing a name stay separate", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: { id: "client-x", label: "Ana" } }),
      pick({ assetId: "a2", pickedBy: { id: "client-y", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(picks, null);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key).sort()).toEqual(["client-x", "client-y"]);
  });

  it("identifies the viewer's group by id, never by label — a different person sharing the viewer's name stays separate", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: { id: "client-a", label: "Zoe Restrepo" } }),
      pick({ assetId: "a2", pickedBy: { id: "client-b", label: "Zoe Restrepo" } }),
    ];

    const groups = groupPicksByPicker(picks, "client-a");

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ key: "client-a", label: "Vos" });
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

    const groups = groupPicksByPicker(picks, "client-z");

    expect(groups.map((g) => g.label)).toEqual(["Vos", "Ana Gómez", "Beto Ruiz", "Sin registro"]);
  });

  it("keeps within-group order exactly as given — oldest pick first, never reordered", () => {
    const picks = [
      pick({ assetId: "old", pickedBy: { id: "client-a", label: "Ana" } }),
      pick({ assetId: "new", pickedBy: { id: "client-a", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(picks, null);

    expect(groups[0]?.picks.map((p) => p.assetId)).toEqual(["old", "new"]);
  });

  it("keeps every unattributed pick in ONE group at the end, never split or merged into a named one", () => {
    const picks = [
      pick({ assetId: "a1", pickedBy: null }),
      pick({ assetId: "a2", pickedBy: null }),
      pick({ assetId: "a3", pickedBy: { id: "client-a", label: "Ana" } }),
    ];

    const groups = groupPicksByPicker(picks, null);

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

    const groups = groupPicksByPicker(picks, "client-a");

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

  // Criterion 1, re-checked against the mid-flight constraint: flat must
  // render EXACTLY as before even with SEVERAL distinct pickers — exactly
  // the shape that would trigger grouping under `by-person`. Proves the
  // by-person branch is gated on `mode`, not silently active whenever there
  // is more than one picker.
  it("flat mode ignores who picked what for layout purposes, even with 3 different pickers", () => {
    const { container } = renderTray({
      mode: "flat",
      // Distinct from every pick's own `pickedBy.id` below, so none of them
      // reads as "Vos" and the labels asserted are the raw names — this test
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

    // By-person renders one <ul> PER GROUP; flat renders exactly one.
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
    expect(groupHeaderTexts(container)).toEqual([]);
    // Insertion order preserved — never re-sorted alphabetically the way
    // by-person's OWN groups would be.
    const labels = screen.getAllByRole("listitem").map((item) => item.textContent);
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

    expect(groupHeaderTexts(container)).toEqual(["Vos (2)", "Beto Ruiz (1)", "Caro Ruiz (3)"]);
    // Criterion 3: thumbnails still render through the SAME <TrayItem> — one
    // <ul> per group (3 people), one <li> per pick (6 total), and the
    // per-group counts (2 + 1 + 3) sum to that same 6.
    expect(container.querySelectorAll("ul")).toHaveLength(3);
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
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

    expect(groupHeaderTexts(container)).toEqual(["Vos (1)", "Ana Gómez (1)", "Beto Ruiz (1)"]);
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

    expect(groupHeaderTexts(container)).toEqual(["Vos (1)", "Beto Ruiz (1)", "Sin registro (1)"]);
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
});
