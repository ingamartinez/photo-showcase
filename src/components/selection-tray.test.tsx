// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionTray } from "./selection-tray";
import type { SelectionPick } from "@/lib/selection-snapshot";

function pick(overrides: Partial<SelectionPick> = {}): SelectionPick {
  return {
    assetId: "a1",
    selectedAt: "2026-07-30T12:00:00.000Z",
    pickedBy: { id: "client-b", label: "Beto Ruiz" },
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
