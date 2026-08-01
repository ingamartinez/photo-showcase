// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofLightbox } from "./proof-lightbox";
import type { ProofAsset } from "./proof-grid";
import { computeQuota } from "@/lib/quota";

function assetsFor(count: number, overrides: Partial<ProofAsset>[] = []): ProofAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/proof-${index + 1}`,
    hasFinal: false,
    // Task #89: see the identical default in proof-grid.test.tsx.
    displayUrl: null,
    ...overrides[index],
  }));
}

// The SAME pure function <SelectionCounter> is fed from, not a hand-built
// object literal: the lightbox displays two of its fields and must keep
// agreeing with the one place the quota maths lives (src/lib/quota.ts).
// Task #205 — 0 originals throughout this file: nothing writes
// `assets.selectionKind` to anything but `edited` yet (task #206).
const QUOTA = computeQuota(0, 0, {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5000,
  originalPhotoPriceCopSnapshot: 2000,
});

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
let onImageError: ReturnType<typeof vi.fn<(assetId: string) => void>>;
let onToggleSelection: ReturnType<typeof vi.fn<(assetId: string, nextSelected: boolean) => void>>;
let onSetSelectionKind: ReturnType<typeof vi.fn<(assetId: string, kind: string) => void>>;

beforeEach(() => {
  onClose = vi.fn();
  onNavigate = vi.fn();
  onImageError = vi.fn();
  onToggleSelection = vi.fn();
  onSetSelectionKind = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

function lightboxProps(
  overrides: Partial<ComponentProps<typeof ProofLightbox>> = {},
): ComponentProps<typeof ProofLightbox> {
  return {
    assets: assetsFor(3),
    urls: {},
    index: 1,
    quota: QUOTA,
    onClose,
    onNavigate,
    onImageError,
    onToggleSelection,
    pendingAssetIds: new Set<string>(),
    isLocked: false,
    isDelivered: false,
    // Task #206 — no asset is selected by default in `assetsFor`, so this
    // empty map is never actually read; tests exercising the type control
    // override it explicitly.
    selectionKindById: {},
    onSetSelectionKind,
    // Task #214 — default ON, same reasoning as proof-grid.test.tsx's own
    // `renderGrid` default: most tests here predate the switch and exercise
    // the type control directly. The tests exercising the switch itself
    // override this explicitly.
    allowsOriginalSelection: true,
    ...overrides,
  };
}

// Every test below wants the same handlers and an empty `pendingAssetIds` by
// default — this only ever overrides `assets`/`urls`/`index`, so the toggle
// wiring doesn't need repeating in every single test.
function renderLightbox(overrides: Partial<ComponentProps<typeof ProofLightbox>> = {}) {
  return render(<ProofLightbox {...lightboxProps(overrides)} />);
}

// The dialog IS the swipe surface (see the component's own comment on
// `handleTouchStart`), so touch events go straight to the element carrying
// `role="dialog"` — the same element the handlers are bound to.
function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function touchList(clientX: number) {
  return [{ clientX }];
}

describe("ProofLightbox", () => {
  it("renders the current asset's image, filename, and position", () => {
    renderLightbox({ assets: assetsFor(3), index: 1 });

    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    expect(screen.getByText("IMG_0002.JPG")).toBeDefined();
    const img = screen.getByAltText("IMG_0002.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/proof-2");
  });

  // Task #146: "cuál es, cuántas van, si esta está elegida" — the running
  // count is the one of the three the old lightbox did not show at all, and
  // the grid's own <SelectionCounter> is unreachable behind an `aria-hidden`
  // modal. Both numbers come from the shared `QuotaResult`; this component
  // does no arithmetic of its own.
  it("shows the running selected count and the package's included count", () => {
    renderLightbox({
      quota: computeQuota(9, 0, {
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5000,
        originalPhotoPriceCopSnapshot: 2000,
      }),
    });

    expect(screen.getByText("9 elegidas · 13 incluidas")).toBeDefined();
  });

  it("announces the running count politely, since it changes while the client looks at the photo", () => {
    renderLightbox({
      quota: computeQuota(9, 0, {
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5000,
        originalPhotoPriceCopSnapshot: 2000,
      }),
    });

    expect(screen.getByText("9 elegidas · 13 incluidas").getAttribute("aria-live")).toBe("polite");
  });

  it("prefers the shared refreshed URL over the asset's own stale proofUrl", () => {
    renderLightbox({
      assets: assetsFor(1),
      urls: { a1: "https://r2.example.com/refreshed" },
      index: 0,
    });

    const img = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/refreshed");
  });

  // The 5-minute presigned-URL expiry path (task #23/#146): looking at ONE
  // photograph for longer than `PRESIGNED_URL_TTL_SECONDS` is this screen's
  // ordinary case, not an edge case, so the recovery hook has to survive
  // every redesign of the markup around it.
  it("calls onImageError with the asset id when the <img> fails to load", () => {
    renderLightbox({ assets: assetsFor(1), index: 0 });

    fireEvent.error(screen.getByAltText("IMG_0001.JPG"));

    expect(onImageError).toHaveBeenCalledWith("a1");
  });

  it("shows the whole photograph rather than cropping it, which is what task #145's uniform tile box traded on", () => {
    renderLightbox({ assets: assetsFor(1), index: 0 });

    expect(screen.getByAltText("IMG_0001.JPG").className).toContain("object-contain");
  });

  // The mock draws `.lb__wm` (client.html:504-509) because its stage is a CSS
  // gradient with nothing to protect. Here the real mark is composited into
  // the proof bytes by `processProof`; a CSS copy would be a FAKE mark a
  // client deletes from the DOM in seconds. Guarded rather than merely
  // documented, because "add the watermark from the mock" is exactly the note
  // a future reviewer would leave on this file.
  it("draws no CSS watermark — the real one is in the proof bytes", () => {
    renderLightbox({ assets: assetsFor(1), index: 0 });

    expect(screen.queryByText(/Alejo Frames/i)).toBeNull();
    expect(dialog().querySelector('[class*="rotate-"]')).toBeNull();
  });

  describe("modal dialog mechanics", () => {
    it("closes on Escape", () => {
      renderLightbox();

      fireEvent.keyDown(dialog(), { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("moves focus into the dialog on open, onto the way out", () => {
      renderLightbox({ assets: assetsFor(1), index: 0 });

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));
    });

    // The trap. Tab from the LAST control inside the dialog must come back to
    // the first, never reach the gallery page underneath. At index 1 of 3
    // every control is enabled, so the ring is: Cerrar, anterior, elegir,
    // siguiente.
    it("traps Tab inside the dialog instead of letting it reach the page behind", async () => {
      const user = userEvent.setup();
      renderLightbox();

      const close = screen.getByRole("button", { name: "Cerrar" });
      const previous = screen.getByRole("button", { name: "Foto anterior" });
      const pick = screen.getByRole("button", { name: "Elegir esta foto" });
      const next = screen.getByRole("button", { name: "Foto siguiente" });

      expect(document.activeElement).toBe(close);
      await user.tab();
      expect(document.activeElement).toBe(previous);
      await user.tab();
      expect(document.activeElement).toBe(pick);
      await user.tab();
      expect(document.activeElement).toBe(next);
      // The wrap: without a trap this lands on <body> (or on the gallery page
      // behind), which is the exact defect this test exists for.
      await user.tab();
      expect(document.activeElement).toBe(close);
    });

    it("wraps Shift+Tab backwards from the first control to the last", async () => {
      const user = userEvent.setup();
      renderLightbox();

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));

      await user.tab({ shift: true });

      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Foto siguiente" }));
    });

    // The other half of "must not strand focus": after closing, the client is
    // back in the grid with focus on the tile they came from, so the next Tab
    // continues from where they were rather than at the top of the document.
    it("returns focus to whatever opened it when it closes", async () => {
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>
              Ver IMG_0001.JPG
            </button>
            {open && (
              <ProofLightbox
                {...lightboxProps({ assets: assetsFor(1), index: 0 })}
                onClose={() => setOpen(false)}
              />
            )}
          </>
        );
      }

      const user = userEvent.setup();
      render(<Harness />);
      // Captured BEFORE opening: the modal marks everything outside itself
      // `aria-hidden`, so a role query would no longer find this button.
      const trigger = screen.getByRole("button", { name: "Ver IMG_0001.JPG" });

      await user.click(trigger);
      expect(screen.getByRole("dialog")).toBeDefined();

      await user.click(screen.getByRole("button", { name: "Cerrar" }));

      // Radix restores focus on a macrotask after unmount, hence waitFor.
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it("hides the gallery page behind it from assistive tech while it is open", () => {
      const { container } = render(
        <>
          <button type="button">Un control de la grilla</button>
          <ProofLightbox {...lightboxProps()} />
        </>,
      );

      // The dialog is in a portal on <body>; the grid's own container is a
      // sibling, and the modal marks it hidden.
      expect(container.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("button", { name: "Un control de la grilla" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cerrar" })).toBeDefined();
    });

    // Asserted against the component's OWN inline lock, not the primitive's
    // — see the effect's comment in proof-lightbox.tsx for why it keeps one.
    it("locks background scroll while open and releases it on close", () => {
      const { unmount } = renderLightbox({ assets: assetsFor(1), index: 0 });

      expect(document.body.style.overflow).toBe("hidden");

      unmount();

      expect(document.body.style.overflow).toBe("");
    });

    it("names the dialog after the photo on screen", () => {
      renderLightbox({ assets: assetsFor(3), index: 1 });

      expect(screen.getByRole("dialog", { name: "IMG_0002.JPG" })).toBeDefined();
    });
  });

  describe("navigation", () => {
    it("navigates with ArrowRight/ArrowLeft from the middle of the set", () => {
      renderLightbox();

      fireEvent.keyDown(dialog(), { key: "ArrowRight" });
      expect(onNavigate).toHaveBeenCalledWith(2);

      fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    it("does nothing on ArrowLeft at the first photo, or ArrowRight at the last", () => {
      const { rerender } = render(<ProofLightbox {...lightboxProps({ index: 0 })} />);

      fireEvent.keyDown(dialog(), { key: "ArrowLeft" });
      expect(onNavigate).not.toHaveBeenCalled();

      rerender(<ProofLightbox {...lightboxProps({ index: 2 })} />);

      fireEvent.keyDown(dialog(), { key: "ArrowRight" });
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("navigates via the on-screen prev/next buttons", () => {
      renderLightbox();

      fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
      expect(onNavigate).toHaveBeenCalledWith(2);

      fireEvent.click(screen.getByRole("button", { name: "Foto anterior" }));
      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    // Task #146 changed this from HIDING the unusable control to disabling
    // it. A hidden button re-flows the footer row, which moves the pick
    // button under a thumb already travelling towards it — and the pick
    // button is pressed 15 times in a run of 84.
    it("keeps prev/next mounted at the ends of the set and disables them instead of hiding them", () => {
      const { rerender } = render(<ProofLightbox {...lightboxProps({ index: 0 })} />);

      expect(
        (screen.getByRole("button", { name: "Foto anterior" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Foto siguiente" }) as HTMLButtonElement).disabled,
      ).toBe(false);

      rerender(<ProofLightbox {...lightboxProps({ index: 2 })} />);

      expect(
        (screen.getByRole("button", { name: "Foto anterior" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(
        (screen.getByRole("button", { name: "Foto siguiente" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    });
  });

  // Task #24/#146: the whole point of the redesign — 84 photos means 168 taps
  // if choosing requires closing the viewer first.
  describe("selection toggle", () => {
    it("offers to pick an unselected photo without leaving the full-screen view", () => {
      renderLightbox({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 });

      fireEvent.click(screen.getByRole("button", { name: "Elegir esta foto" }));

      expect(onToggleSelection).toHaveBeenCalledWith("a1", true);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the picked state and calls onToggleSelection(id, false) to unpick", () => {
      renderLightbox({ assets: assetsFor(1, [{ isSelected: true }]), index: 0 });

      const button = screen.getByRole("button", { name: "Elegida" });
      expect(button.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(button);

      expect(onToggleSelection).toHaveBeenCalledWith("a1", false);
    });

    // "Picked vs unpicked is legible and not by colour alone" is an epic-wide
    // rule (#140), and the three channels are asserted SEPARATELY on purpose:
    // one of them silently disappearing while the other two carry the state
    // is precisely how a colour-only regression sneaks back in.
    describe("picked is never colour alone", () => {
      it("channel 1 — a ✓ glyph appears, and is absent when unpicked", () => {
        const { rerender } = render(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: true }]), index: 0 })}
          />,
        );

        expect(screen.getByRole("button", { name: "Elegida" }).textContent).toContain("✓");

        rerender(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 })}
          />,
        );

        expect(screen.getByRole("button", { name: "Elegir esta foto" }).textContent).not.toContain(
          "✓",
        );
      });

      it("channel 2 — the words change, so the state survives a greyscale screenshot", () => {
        const { rerender } = render(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: true }]), index: 0 })}
          />,
        );

        expect(screen.getByRole("button", { name: "Elegida" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "Elegir esta foto" })).toBeNull();

        rerender(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 })}
          />,
        );

        expect(screen.getByRole("button", { name: "Elegir esta foto" })).toBeDefined();
        expect(screen.queryByRole("button", { name: "Elegida" })).toBeNull();
      });

      // CLASS-LEVEL, and named that way deliberately: jsdom paints nothing, so
      // this proves the filled/outline SWITCH is wired, not that it renders.
      // The painted result is evidence a capture provides, not this file.
      it("channel 3 — the button declares a filled block when picked and a hairline outline when not", () => {
        const { rerender } = render(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: true }]), index: 0 })}
          />,
        );

        expect(screen.getByRole("button", { name: "Elegida" }).className).toContain("bg-accent");

        rerender(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 })}
          />,
        );

        const unpicked = screen.getByRole("button", { name: "Elegir esta foto" });
        expect(unpicked.className).not.toContain("bg-accent");
        expect(unpicked.className).toContain("border-line-2");
      });
    });

    it("disables the toggle button while this asset's toggle is pending", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: false }]),
        index: 0,
        pendingAssetIds: new Set(["a1"]),
      });

      const button = screen.getByRole("button", {
        name: "Elegir esta foto",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    // Task #25: the same UX-only mirror of the server-side submission lock
    // as <ProofTile>'s own `isLocked` prop.
    it("disables the toggle button once the gallery is locked", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: false }]),
        index: 0,
        isLocked: true,
      });

      const button = screen.getByRole("button", {
        name: "Elegir esta foto",
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
  });

  // Task #28: the same delivered-gallery download affordance as the grid
  // tile behind this lightbox — see proof-grid.test.tsx's own "delivered
  // gallery downloads" suite for the fuller coverage (fetch wiring, error
  // state). These only prove the CONDITIONAL rendering here, since the
  // lightbox re-derives it per-asset on every navigation rather than taking
  // a single boolean prop.
  describe("delivered gallery downloads", () => {
    it("does not render a download button when the gallery isn't delivered, even if the asset has a final", () => {
      renderLightbox({
        assets: assetsFor(1, [{ hasFinal: true }]),
        index: 0,
        isDelivered: false,
      });

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("does not render a download button for a delivered gallery's asset with no final", () => {
      renderLightbox({
        assets: assetsFor(1, [{ hasFinal: false }]),
        index: 0,
        isDelivered: true,
      });

      expect(screen.queryByRole("button", { name: /Descargar/ })).toBeNull();
    });

    it("renders a download button for the current asset when the gallery is delivered and it has a final", () => {
      renderLightbox({
        assets: assetsFor(1, [{ hasFinal: true }]),
        index: 0,
        isDelivered: true,
      });

      expect(screen.getByRole("button", { name: "Descargar: IMG_0001.JPG" })).toBeDefined();
    });
  });

  describe("touch swipe", () => {
    it("swipes left to advance to the next photo", () => {
      renderLightbox();

      fireEvent.touchStart(dialog(), { touches: touchList(200) });
      fireEvent.touchEnd(dialog(), { changedTouches: touchList(100) });

      expect(onNavigate).toHaveBeenCalledWith(2);
    });

    it("swipes right to go to the previous photo", () => {
      renderLightbox();

      fireEvent.touchStart(dialog(), { touches: touchList(100) });
      fireEvent.touchEnd(dialog(), { changedTouches: touchList(200) });

      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    // The one most likely to be wrong: a tap (or a jittery finger with
    // barely any movement) must not be misread as a swipe. Below the 40px
    // threshold in either direction, nothing should navigate.
    it("does not navigate when the movement is below the 40px swipe threshold", () => {
      renderLightbox();

      fireEvent.touchStart(dialog(), { touches: touchList(200) });
      fireEvent.touchEnd(dialog(), { changedTouches: touchList(180) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe left past the last photo", () => {
      renderLightbox({ index: 2 });

      fireEvent.touchStart(dialog(), { touches: touchList(200) });
      fireEvent.touchEnd(dialog(), { changedTouches: touchList(100) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe right before the first photo", () => {
      renderLightbox({ index: 0 });

      fireEvent.touchStart(dialog(), { touches: touchList(100) });
      fireEvent.touchEnd(dialog(), { changedTouches: touchList(200) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("tells the client the gesture exists, and says nothing when there is nowhere to swipe to", () => {
      const { rerender } = render(<ProofLightbox {...lightboxProps()} />);

      expect(screen.getByText("Deslizá para pasar")).toBeDefined();

      rerender(<ProofLightbox {...lightboxProps({ assets: assetsFor(1), index: 0 })} />);

      expect(screen.queryByText("Deslizá para pasar")).toBeNull();
    });
  });

  // Task #206 — the SAME type control <ProofTile> carries, next to the pick
  // button here instead of the grid tile.
  describe("the type control (task #206)", () => {
    it("does not render for an unselected photo", () => {
      renderLightbox({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    });

    it("does not render once the selection is locked, even for a selected photo", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: true }]),
        index: 0,
        isLocked: true,
      });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    });

    it("renders both type buttons for a selected, unlocked photo, with the current kind pressed", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: true }]),
        index: 0,
        selectionKindById: { a1: "original" },
      });

      const edited = screen.getByRole("button", { name: "Marcar como editada: IMG_0001.JPG" });
      const original = screen.getByRole("button", { name: "Marcar como original: IMG_0001.JPG" });
      expect(edited.getAttribute("aria-pressed")).toBe("false");
      expect(original.getAttribute("aria-pressed")).toBe("true");
    });

    it("calls onSetSelectionKind with the asset id and the tapped kind, without touching onToggleSelection", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: true }]),
        index: 0,
        selectionKindById: { a1: "edited" },
      });

      fireEvent.click(screen.getByRole("button", { name: "Marcar como original: IMG_0001.JPG" }));

      expect(onSetSelectionKind).toHaveBeenCalledWith("a1", "original");
      expect(onToggleSelection).not.toHaveBeenCalled();
    });

    it("disables both type buttons while this asset is pending, mirroring the pick button's own gate", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: true }]),
        index: 0,
        pendingAssetIds: new Set(["a1"]),
      });

      expect(
        screen
          .getByRole("button", { name: "Marcar como editada: IMG_0001.JPG" })
          .hasAttribute("disabled"),
      ).toBe(true);
    });

    // Task #214 — the SAME gate <ProofTile>'s own tests measure, mirrored
    // here: a selected, unlocked photo still shows no type control at all
    // once the gallery's switch is off.
    it("does not render when allowsOriginalSelection is off, even for a selected, unlocked photo", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: true }]),
        index: 0,
        selectionKindById: { a1: "original" },
        allowsOriginalSelection: false,
      });

      expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    });
  });
});
