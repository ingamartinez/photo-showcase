// @vitest-environment jsdom
//
// The VISUAL half of the proof grid, tested on its own — which is the whole
// point of task #144's split and the reason task #145 could be reviewed as a
// redesign rather than as a change to the live-synchronisation logic.
// <ProofTile> holds no state, issues no request and decides nothing, so
// everything below is a pure input -> markup assertion; the toggling,
// polling, quota and submit-lock behaviour these props FEED is proven in
// proof-grid.test.tsx against the real <ProofGrid> and the real
// `useSharedSelection`, and nothing here duplicates it.
//
// WHAT THESE TESTS CAN AND CANNOT SEE: jsdom applies no stylesheet, so a
// Tailwind class is a string here and nothing more. Where the assertion is
// really "this class is present", the test says so in its own name rather
// than claiming a rendered size nobody measured — the measured, at-390px
// verification of this slice is a Playwright capture, not this file.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofTile } from "./proof-tile";
import type { ProofAsset } from "./proof-grid";

const ASSET: ProofAsset = {
  id: "a1",
  originalFilename: "IMG_0001.JPG",
  proofWidth: 1600,
  proofHeight: 1067,
  isSelected: false,
  proofUrl: "https://r2.example.com/proof-1",
  hasFinal: false,
  displayUrl: null,
  isExtra: false,
};

function renderTile(overrides: Partial<Parameters<typeof ProofTile>[0]> = {}) {
  const props = {
    asset: ASSET,
    position: 1,
    src: "https://r2.example.com/proof-1",
    isSelected: false,
    isPending: false,
    isLocked: false,
    showDownload: false,
    onError: vi.fn(),
    onOpen: vi.fn(),
    onToggleSelection: vi.fn(),
    // Task #206 — the domain's own default; the tests exercising the type
    // control override these explicitly.
    selectionKind: "edited" as const,
    onSetSelectionKind: vi.fn(),
    // Task #214 — default ON: most tests in this file predate the switch and
    // exercise the type control directly. The tests exercising the switch
    // itself override this explicitly.
    allowsOriginalSelection: true,
    ...overrides,
  };
  return { props, ...render(<ProofTile {...props} />) };
}

function pickButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^(Seleccionar|Quitar de seleccionadas)/ });
}

afterEach(cleanup);

describe("ProofTile", () => {
  // Task #145's headline requirement, and the one this whole slice exists
  // for: "el toggle tiene que ser cómodo con el pulgar. Objetivo táctil de
  // 44px mínimo". The mock's own figure is 48px (`--tap`,
  // design/system/client.html:49, applied at :200-202).
  //
  // This asserts the CLASSES, not a measured box — jsdom has no layout and
  // no stylesheet, so it cannot measure one. `h-12 w-12` is Tailwind's 48px,
  // and that is exactly as much as this file is entitled to claim.
  it("gives the pick control Tailwind's 48px square classes (h-12/w-12), not the old text pill's padding", () => {
    renderTile();

    const className = pickButton().className;
    expect(className).toContain("h-12");
    expect(className).toContain("w-12");
    // The pill it replaced: `px-2 py-1 text-xs`, ~24px tall.
    expect(className).not.toContain("px-2");
    expect(className).not.toContain("text-xs");
  });

  // The mid-tone affordance fix, and like the test above this asserts a CLASS
  // is present, not a measured contrast ratio — jsdom composites nothing. What
  // it guards is that the deviation from the mock does not get "tidied back"
  // to the mock's own `.pick` (client.html:200-208), which carries no shadow:
  // over an RGB-128 photo the mock's disc (2.13:1) and ring (1.94:1) both miss
  // WCAG 1.4.11's 3:1, and the shadow is what backs the control there. It does
  // not make the control conforming — see proof-tile.tsx's own note on what a
  // blurred edge can and cannot buy — so this test's name says only that the
  // class survives. Both states, since the shadow is on the shared class list.
  it.each([true, false])(
    "keeps the pick control's shadow class, the mid-tone backing the mock does not have (isSelected=%s)",
    (isSelected) => {
      renderTile({ isSelected });

      expect(pickButton().className).toContain("shadow-[0_1px_6px_rgba(7,7,9,0.6)]");
    },
  );

  // "Elegida/no elegida se distingue de un vistazo y NO DEPENDE SOLO DEL
  // COLOR" — task #145's acceptance criterion, verbatim. The two channels
  // that survive greyscale are asserted here: a glyph (shape) inside the pick
  // control, and an inset frame element (structure) over the photo. The
  // third, the photo's own brightening, IS colour/luminance and is not what
  // this test rests on.
  describe("picked state is legible without colour", () => {
    it("renders a check glyph in the pick control and an inset frame over a picked photo", () => {
      const { container } = renderTile({ isSelected: true });

      expect(pickButton().textContent).toContain("✓");
      expect(container.querySelectorAll("span[aria-hidden='true'].border-accent")).toHaveLength(1);
    });

    it("renders neither the glyph nor the frame on an unpicked photo", () => {
      const { container } = renderTile({ isSelected: false });

      expect(pickButton().textContent).not.toContain("✓");
      expect(container.querySelectorAll("span[aria-hidden='true'].border-accent")).toHaveLength(0);
    });

    // The machine-readable channel, unchanged by the redesign: the visual
    // treatment above is what a sighted client reads, `aria-pressed` is what
    // everyone else reads, and losing it while keeping the ✓ would be an
    // invisible regression.
    it.each([true, false])(
      "carries the same fact in aria-pressed (isSelected=%s)",
      (isSelected) => {
        renderTile({ isSelected });

        expect(pickButton().getAttribute("aria-pressed")).toBe(String(isSelected));
      },
    );
  });

  // The accessible names deliberately did NOT move with the pixels: they name
  // the actual photo, unlike the mock's own "Elegir foto 1", and
  // proof-grid.test.tsx plus [publicSlug]/page.chrome.test.tsx query by them
  // in ~20 places.
  it.each([
    [false, "Seleccionar: IMG_0001.JPG"],
    [true, "Quitar de seleccionadas: IMG_0001.JPG"],
  ])("keeps the pick control's accessible name (isSelected=%s)", (isSelected, name) => {
    renderTile({ isSelected });

    expect(screen.getByRole("button", { name })).toBeDefined();
  });

  // Task #145: "tapping to LOOK and tapping to CHOOSE are never the same
  // gesture" (client.html:197-199). Two separate buttons, and picking must
  // not also open the lightbox — which is what a nested button, or a missing
  // `stopPropagation`, would silently produce.
  it("keeps looking and choosing on two separate controls", () => {
    const { props } = renderTile();

    fireEvent.click(pickButton());
    expect(props.onToggleSelection).toHaveBeenCalledTimes(1);
    expect(props.onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    expect(props.onToggleSelection).toHaveBeenCalledTimes(1);
  });

  // Task #25, mirrored here (the real gate is server-side — see
  // use-shared-selection.ts's `isLockedRef`). A `delivered` gallery is
  // `isLocked` too, which is why the download case below can assume both.
  it.each([
    ["locked", { isLocked: true }],
    ["pending", { isPending: true }],
  ])("disables the pick control while %s", (_label, overrides) => {
    renderTile(overrides);

    expect(pickButton().disabled).toBe(true);
  });

  // The CLS contract from task #23, restated after task #145 changed WHICH
  // box gets reserved. It is now the mock's uniform 2:3 (client.html:181), not
  // the asset's own `proofWidth / proofHeight` — see proof-tile.tsx's own
  // comment for the measured reason. What must NOT change is that the box
  // exists before the <img> does, and that it is the SAME box whatever shape
  // the proof happens to be: a tile that fell back to intrinsic sizing for
  // some assets would reintroduce both the layout shift and the detached pick
  // control the redesign removed.
  it.each([
    ["landscape", 1600, 1067],
    ["portrait", 900, 1600],
  ])("reserves the same uniform 2:3 box for a %s proof, before the image loads", (_l, w, h) => {
    const { container } = renderTile({ asset: { ...ASSET, proofWidth: w, proofHeight: h } });

    const wrapper = container.querySelector("img")?.parentElement;
    expect(wrapper?.className).toContain("aspect-[2/3]");
    // And nothing re-introduces a per-asset ratio through the back door.
    expect(wrapper?.getAttribute("style")).toBeNull();
  });

  // Task #145's "no se toca" list, first item: a presigned proof URL is good
  // for PRESIGNED_URL_TTL_SECONDS (5 minutes) and picking 15 of 84 is not a
  // five-minute job, so the <img>'s own onError is the recovery path and a
  // restyle may not drop it. The re-signing itself lives in use-proof-urls.ts
  // and is proven against the real hook in proof-grid.test.tsx; what is
  // proven here is only that this markup still HAS the hook wired to it.
  it("still reports an image error upward, so an expired URL can be re-signed", () => {
    const { container, props } = renderTile();

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img as HTMLImageElement);

    expect(props.onError).toHaveBeenCalledTimes(1);
  });

  // The mock's `.tile__n` (client.html:192-195), zero-padded so 84 proofs
  // stay in one visual column of digits.
  it("renders its 1-based position, zero-padded", () => {
    renderTile({ position: 4 });

    expect(screen.getByText("04")).toBeDefined();
  });

  // The collision task #145 created and had to resolve: the pick control took
  // over the bottom-right corner the download button already occupied, and a
  // `delivered` gallery renders BOTH (the toggle stays mounted-and-disabled
  // per #25 rather than being hidden). If these ever share a corner again the
  // client gets one control stacked invisibly on top of the other.
  it("keeps the delivered-gallery download button out of the pick control's corner", () => {
    const { container } = renderTile({ isSelected: true, isLocked: true, showDownload: true });

    const download = screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" });
    const downloadCorner = download.closest("div.absolute");
    expect(downloadCorner).not.toBeNull();
    expect(downloadCorner?.className).toContain("left-2");
    expect(downloadCorner?.className).not.toContain("right-");
    expect(pickButton().className).toContain("right-[7px]");
    // Both really are on the tile at once — the premise of this test, not an
    // aside: if `delivered` ever stopped rendering the disabled toggle the
    // assertion above would still pass while guarding nothing.
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });

  // Task #206's own criterion 8 / the design decision this file's comment
  // spells out: the type control does not exist for an asset nobody picked.
  describe("the type control (task #206)", () => {
    it("does not render for an unselected photo", () => {
      const { container } = renderTile({ isSelected: false });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
      // Two buttons only: open the viewer, and the pick control.
      expect(container.querySelectorAll("button")).toHaveLength(2);
    });

    it("does not render once the selection is locked, even for a selected photo", () => {
      renderTile({ isSelected: true, isLocked: true });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    });

    it("renders both type buttons for a selected, unlocked photo, with the current kind pressed", () => {
      renderTile({ isSelected: true, selectionKind: "original" });

      const edited = screen.getByRole("button", { name: "Marcar como editada: IMG_0001.JPG" });
      const original = screen.getByRole("button", { name: "Marcar como original: IMG_0001.JPG" });
      expect(edited.getAttribute("aria-pressed")).toBe("false");
      expect(original.getAttribute("aria-pressed")).toBe("true");
    });

    it("calls onSetSelectionKind with the tapped kind, without touching onToggleSelection", () => {
      const { props } = renderTile({ isSelected: true, selectionKind: "edited" });

      fireEvent.click(screen.getByRole("button", { name: "Marcar como original: IMG_0001.JPG" }));

      expect(props.onSetSelectionKind).toHaveBeenCalledWith("original");
      expect(props.onToggleSelection).not.toHaveBeenCalled();
    });

    it("disables both type buttons while pending, mirroring the pick control's own gate", () => {
      renderTile({ isSelected: true, isPending: true });

      expect(
        screen
          .getByRole("button", { name: "Marcar como editada: IMG_0001.JPG" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen
          .getByRole("button", { name: "Marcar como original: IMG_0001.JPG" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    // Task #214 — measured in the DOM, not by asserting the flag's own value:
    // a selected, unlocked photo still shows no type control at all once the
    // gallery's own switch is off.
    it("does not render when allowsOriginalSelection is off, even for a selected, unlocked photo", () => {
      const { container } = renderTile({
        isSelected: true,
        selectionKind: "original",
        allowsOriginalSelection: false,
      });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
      // Two buttons only: open the viewer, and the pick control — same as
      // the "unselected photo" case above, just for a different reason.
      expect(container.querySelectorAll("button")).toHaveLength(2);
    });

    // The crowding trap the task body names explicitly: the new control must
    // not starve the pick control of its own space, or turn one tap into the
    // other. The type control sits bottom-LEFT, the pick control bottom-
    // RIGHT — different corners, never overlapping classes.
    it("shares the tile with the pick control without occupying its corner", () => {
      const { container } = renderTile({ isSelected: true });

      const typeGroup = screen.getByRole("group", { name: "Tipo de foto: IMG_0001.JPG" });
      expect(typeGroup.className).toContain("left-2");
      expect(typeGroup.className).not.toContain("right-");
      expect(pickButton().className).toContain("right-[7px]");
      // Open, pick, editada, original — four controls, none nested.
      expect(container.querySelectorAll("button")).toHaveLength(4);
    });
  });
});
