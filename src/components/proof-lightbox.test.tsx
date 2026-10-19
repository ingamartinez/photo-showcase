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
    isExtra: false,
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
  extraPhotoPriceTiersSnapshot: null,
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
  vi.unstubAllGlobals();
});

function lightboxProps(
  overrides: Partial<ComponentProps<typeof ProofLightbox>> = {},
): ComponentProps<typeof ProofLightbox> {
  const assets = overrides.assets ?? assetsFor(3);
  const viewerId = overrides.viewerId ?? "viewer";
  // Most tests predate epic #250 and spell "the viewer picked this" as
  // `asset.isSelected: true`. That flag is the CLAIM now, so the helper
  // mirrors it as the viewer's own UNSENT pick — which is what those tests
  // mean. Tests that need a foreign or sent pick override `entryById`.
  const entryById =
    overrides.entryById ??
    Object.fromEntries(
      assets
        .filter((asset) => asset.isSelected)
        .map((asset) => [
          asset.id,
          {
            assetId: asset.id,
            claim: {
              claimedAt: "2026-10-17T12:00:00.000Z",
              resolvedKind: "edited" as const,
              billedTo: { id: viewerId, label: "Ana" },
              charge: "included" as const,
              canEscalate: false,
            },
            picks: [
              {
                userId: viewerId,
                label: "Ana",
                kind: "edited" as const,
                pickedAt: "2026-10-17T12:00:00.000Z",
                submittedAt: null,
                state: "cart" as const,
              },
            ],
          },
        ]),
    );
  return {
    assets,
    urls: {},
    index: 1,
    viewerId,
    entryById,
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
        extraPhotoPriceTiersSnapshot: null,
        originalPhotoPriceCopSnapshot: 2000,
      }),
    });

    expect(screen.getByText("9 pedidas · 13 incluidas")).toBeDefined();
  });

  it("announces the running count politely, since it changes while the client looks at the photo", () => {
    renderLightbox({
      quota: computeQuota(9, 0, {
        includedPhotosSnapshot: 13,
        extraPhotoPriceCopSnapshot: 5000,
        extraPhotoPriceTiersSnapshot: null,
        originalPhotoPriceCopSnapshot: 2000,
      }),
    });

    expect(screen.getByText("9 pedidas · 13 incluidas").getAttribute("aria-live")).toBe("polite");
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

        expect(screen.getByRole("button", { name: "Elegida" }).querySelector("svg")).not.toBeNull();

        rerender(
          <ProofLightbox
            {...lightboxProps({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 })}
          />,
        );

        expect(
          screen.getByRole("button", { name: "Elegir esta foto" }).querySelector("svg"),
        ).toBeNull();
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

      expect(screen.getByText("Desliza para pasar")).toBeDefined();

      rerender(<ProofLightbox {...lightboxProps({ assets: assetsFor(1), index: 0 })} />);

      expect(screen.queryByText("Desliza para pasar")).toBeNull();
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

// ---------------------------------------------------------------------------
// PINCH-TO-ZOOM IS NOT A SWIPE (owner bug report, 2026-08-21)
// ---------------------------------------------------------------------------
// "cuando se ve la foto en grande [...] la foto se pasa a la siguiente cuando
// intentan hacer pinch to zoom desde el celular".
//
// These fixtures carry the two fields the old handlers ignored, and they are
// the whole point of this block: `touches` is the fingers STILL DOWN, and it
// is what tells a pinch apart from a swipe. Every test here fails against the
// pre-fix handlers — verified by reverting them, not assumed.
function touchAt(...clientXs: number[]) {
  return clientXs.map((clientX) => ({ clientX }));
}

describe("ProofLightbox — a pinch must never navigate", () => {
  // The exact reported gesture: a finger lands, a second joins, and the two
  // spread apart. The first finger to lift has travelled 140px horizontally —
  // three and a half times the 40px swipe threshold — which is why the old
  // code did not misfire occasionally, it misfired on every single pinch.
  it("does not navigate when a second finger joins and the two spread apart", () => {
    renderLightbox({ index: 1 });

    fireEvent.touchStart(dialog(), { touches: touchAt(200) });
    fireEvent.touchStart(dialog(), { touches: touchAt(200, 210) });
    // Finger one lifts, far to the left; finger two is still on the glass.
    fireEvent.touchEnd(dialog(), { touches: touchAt(340), changedTouches: touchAt(60) });
    // Finger two lifts, far to the right.
    fireEvent.touchEnd(dialog(), { touches: [], changedTouches: touchAt(340) });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  // `touchend` fires once PER FINGER, not once per gesture. A handler that
  // decides on the first one is deciding while the hand is still moving.
  it("decides nothing while another finger is still on the glass", () => {
    renderLightbox({ index: 1 });

    fireEvent.touchStart(dialog(), { touches: touchAt(200) });
    fireEvent.touchEnd(dialog(), { touches: touchAt(150), changedTouches: touchAt(100) });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  // The other half of the fix, and the one a careless version breaks: refusing
  // pinches must not cost the client their swipe. A "once pinched, always
  // pinched" flag would pass every test above and quietly kill navigation for
  // the rest of the session.
  it("still swipes normally on the very next one-finger gesture after a pinch", () => {
    renderLightbox({ index: 1 });

    fireEvent.touchStart(dialog(), { touches: touchAt(200) });
    fireEvent.touchStart(dialog(), { touches: touchAt(200, 210) });
    fireEvent.touchEnd(dialog(), { touches: touchAt(340), changedTouches: touchAt(60) });
    fireEvent.touchEnd(dialog(), { touches: [], changedTouches: touchAt(340) });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.touchStart(dialog(), { touches: touchAt(200) });
    fireEvent.touchEnd(dialog(), { touches: [], changedTouches: touchAt(100) });

    expect(onNavigate).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// DESKTOP CLICK-TO-1:1 ZOOM (owner request, 2026-08-21)
// ---------------------------------------------------------------------------
// "en desktop no se le puede hacer zoom a la foto, incluye admin y cliente".
//
// THE GEOMETRY IS REAL, NOT ROUND NUMBERS PICKED TO MAKE THE MATHS EASY:
// a 1067x1600 portrait proof (`PROOF_MAX_LONG_EDGE` is 1600, src/lib/images.ts)
// in the stage a 1440x900 laptop actually leaves once the lightbox's own top
// and bottom chrome are taken out. `object-contain` fits it by HEIGHT, so the
// screen is painting a 1600px photo at 750px — under half its resolution — and
// 1:1 is therefore 1600/750 = ~2.13x. Every expectation below is written as
// that division rather than as `2.133`, so a wrong constant cannot pass.
const STAGE = { width: 1440, height: 750 };
const PORTRAIT = { width: 1067, height: 1600 };
const STAGE_CENTRE = { x: STAGE.width / 2, y: STAGE.height / 2 };

function stubPointerCapability(isFine: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(pointer: fine)" && isFine,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

// JSDOM lays nothing out — every box is 0x0 and every image is 0x0 natural —
// so the two measurements the hook reads have to be supplied by hand. Firing
// `load` afterwards is what the real browser does once the proof arrives.
function primeStage(altText: string, stage = STAGE, natural = PORTRAIT) {
  const img = screen.getByAltText(altText) as HTMLImageElement;
  const stageEl = img.parentElement as HTMLElement;
  Object.defineProperty(img, "naturalWidth", { value: natural.width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: natural.height, configurable: true });
  Object.defineProperty(stageEl, "clientWidth", { value: stage.width, configurable: true });
  Object.defineProperty(stageEl, "clientHeight", { value: stage.height, configurable: true });
  stageEl.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: stage.width,
      bottom: stage.height,
      width: stage.width,
      height: stage.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  fireEvent.load(img);
  return { img, stageEl };
}

function clickAt(stageEl: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(stageEl, { pointerId: 1, button: 0, clientX: x, clientY: y });
  fireEvent.pointerUp(stageEl, { pointerId: 1, button: 0, clientX: x, clientY: y });
}

function dragBy(stageEl: HTMLElement, from: { x: number; y: number }, dx: number, dy: number) {
  fireEvent.pointerDown(stageEl, { pointerId: 1, button: 0, clientX: from.x, clientY: from.y });
  fireEvent.pointerMove(stageEl, { pointerId: 1, clientX: from.x + dx, clientY: from.y + dy });
  fireEvent.pointerUp(stageEl, {
    pointerId: 1,
    button: 0,
    clientX: from.x + dx,
    clientY: from.y + dy,
  });
}

/** The transform actually painted, decomposed. `null` when the photo is
 * sitting fitted, which is what "no zoom" looks like in the DOM. */
function painted(img: HTMLImageElement) {
  const match = /^translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)$/.exec(
    img.style.transform,
  );
  return match ? { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) } : null;
}

describe("ProofLightbox — desktop zoom to 1:1", () => {
  it("takes the photo to exactly one image pixel per CSS pixel, not some round multiple", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage("IMG_0001.JPG");

    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);

    const result = painted(img);
    expect(result).not.toBeNull();
    // The photo is height-bound in this stage, so undoing `object-contain`
    // exactly means natural height over stage height and nothing else.
    expect(result!.scale).toBeCloseTo(PORTRAIT.height / STAGE.height, 6);
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  // Without this the browser's own image-drag takes over the moment a pan
  // starts and the photo tears away from the cursor.
  it("turns off the browser's native image drag, which would otherwise hijack the pan", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img } = primeStage("IMG_0001.JPG");

    expect(img.draggable).toBe(false);
  });

  // The assertion that actually pins the clamp down: at 1:1 this portrait is
  // 1067px wide inside a 1440px stage, so it has NO horizontal slack at all
  // and 300px of sideways drag must move it exactly nowhere — while the same
  // gesture's vertical component runs to its limit of (1600-750)/2 = 425.
  it("pans only where the photo actually overflows, and stops at its edge", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage("IMG_0001.JPG");
    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);

    dragBy(stageEl, STAGE_CENTRE, 300, 900);

    const result = painted(img);
    expect(result!.x).toBe(0);
    expect(result!.y).toBe((PORTRAIT.height - STAGE.height) / 2);
    // And the drag did not double as a click that toggles the zoom back off.
    expect(result!.scale).toBeCloseTo(PORTRAIT.height / STAGE.height, 6);
  });

  it("zooms towards the point clicked, so clicking a face gets that face", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage("IMG_0001.JPG");

    // 200px above centre: that point must stay put while everything scales
    // around it, which takes a compensating translate of 200 * (scale - 1).
    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y - 200);

    const scale = PORTRAIT.height / STAGE.height;
    expect(painted(img)!.y).toBeCloseTo(200 * (scale - 1), 4);
  });

  it("clicking again puts the photo back to fitted", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage("IMG_0001.JPG");

    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);
    expect(painted(img)).not.toBeNull();
    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);

    expect(painted(img)).toBeNull();
  });

  // A tall or large monitor already paints a 1600px proof BIGGER than its own
  // resolution. "1:1" there would mean shrinking the photo, so there is
  // nothing on offer and the cursor must not promise otherwise.
  it("offers no zoom when the screen is already showing the photo at full resolution", () => {
    stubPointerCapability(true);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage(
      "IMG_0001.JPG",
      { width: 2000, height: 1800 },
      { width: 1600, height: 1067 },
    );

    expect(stageEl.className).not.toContain("cursor-zoom-in");
    clickAt(stageEl, 1000, 900);

    expect(painted(img)).toBeNull();
  });

  // The gate is the pointer QUERY, not merely the presence of `matchMedia` —
  // a phone has the function and must still get no click-to-zoom, because a
  // one-finger pan there would fight the swipe handler on the same surface.
  it("stays out of the way on a coarse pointer, where swipe owns the gesture", () => {
    stubPointerCapability(false);
    renderLightbox({ index: 0 });
    const { img, stageEl } = primeStage("IMG_0001.JPG");

    expect(stageEl.className).not.toContain("cursor-zoom-in");
    clickAt(stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);

    expect(painted(img)).toBeNull();
  });

  it("lands the next photo fitted instead of inheriting the last one's zoom", () => {
    stubPointerCapability(true);
    const { rerender } = render(<ProofLightbox {...lightboxProps({ index: 0 })} />);
    const first = primeStage("IMG_0001.JPG");
    clickAt(first.stageEl, STAGE_CENTRE.x, STAGE_CENTRE.y);
    expect(painted(first.img)).not.toBeNull();

    rerender(<ProofLightbox {...lightboxProps({ index: 1 })} />);
    // The NEW photo has to be measured too. Without this the assertion below
    // passes for the wrong reason — an unmeasured image cannot paint a
    // transform whether the zoom was reset or not, so the test would stay
    // green with the reset deleted. Caught by mutating it away; it was.
    const second = primeStage("IMG_0002.JPG");

    expect(painted(second.img)).toBeNull();
  });
});

// Epic #250 S7 — the full lightbox line set (D11 §1b). The line describes the
// VIEWER'S own pick and names the person the unit is BILLED to; the other
// askers live on the tile's chips. The button is the viewer's pick, never
// `assets.isSelected`.
describe("ProofLightbox — the owner's copy set (S7)", () => {
  const A = { id: "client-a", label: "Ana" };
  const B = { id: "client-b", label: "Beto" };
  const sent = "2026-10-17T12:00:00.000Z";
  const base = {
    userId: A.id,
    label: A.label,
    kind: "edited" as const,
    pickedAt: sent,
  };
  const claim = (
    billedTo: { id: string; label: string } | null,
    canEscalate = false,
    resolvedKind: "edited" | "original" = "edited",
  ) => ({
    claimedAt: sent,
    resolvedKind,
    billedTo,
    charge: "included" as const,
    canEscalate,
  });

  function renderWithEntry(
    entry: ComponentProps<typeof ProofLightbox>["entryById"] extends infer _T
      ? NonNullable<ComponentProps<typeof ProofLightbox>["entryById"]>[string]
      : never,
    overrides: Partial<ComponentProps<typeof ProofLightbox>> = {},
  ) {
    return renderLightbox({
      assets: assetsFor(1),
      index: 0,
      viewerId: A.id,
      entryById: { a1: entry },
      ...overrides,
    });
  }

  it("C3: the viewer's own unsent pick on a free photo", () => {
    renderWithEntry({
      assetId: "a1",
      claim: null,
      picks: [{ ...base, submittedAt: null, state: "cart" }],
    });

    expect(screen.getByRole("button", { name: "Elegida" })).toBeDefined();
    expect(screen.getByText("Todavía no la enviaste · puedes sacarla")).toBeDefined();
  });

  it("C4: a degraded pick names the billed holder and only removes the viewer's own", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(B),
      picks: [
        { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
        { ...base, submittedAt: null, state: "degraded" },
      ],
    });

    const line = screen.getByText(/Ya la pidió/);
    expect(line.querySelector("b")?.textContent).toBe("Beto");
    expect(line.textContent).toContain("así que la reciben todos");
    expect(line.textContent).toContain("puedes sacar la tuya");
  });

  it("C5: claimed by somebody else and the viewer has no pick", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(B),
      picks: [{ ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" }],
    });

    expect(screen.getByRole("button", { name: "Elegir esta foto" })).toBeDefined();
    expect(screen.getByText(/Ya la pidió/).textContent).toContain("Beto");
  });

  it("C6: billed to the viewer -> 'La pediste tú', disabled", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(A),
      picks: [{ ...base, submittedAt: sent, state: "billed" }],
    });

    const button = screen.getByRole("button", { name: "Pedida" });
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText(/La pediste/).textContent).toContain("tú");
    expect(screen.getByText(/escríbele a tu fotógrafo/)).toBeDefined();
  });

  it("C7: joined -> names the billed holder, disabled", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(B),
      picks: [
        { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
        { ...base, submittedAt: sent, state: "joined" },
      ],
    });

    const line = screen.getByText(/La pidió/);
    expect(line.querySelector("b")?.textContent).toBe("Beto");
    expect(line.textContent).toContain("tú también la pediste");
    expect(screen.getByRole("button", { name: "Pedida" })).toHaveProperty("disabled", true);
  });

  it("C8: a legacy unit with no attribution", () => {
    renderWithEntry({ assetId: "a1", claim: claim(null), picks: [] });

    expect(screen.getByRole("button", { name: "Elegir esta foto" })).toBeDefined();
    expect(screen.getByText("Ya está pedida")).toBeDefined();
  });

  // Task #268 — the escalation line: somebody else's ORIGINAL, no final yet,
  // the viewer's own pick unsent and (effectively) edited.
  it("promises the escalation when the original has no final and the pick is edited", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(B, true, "original"),
      picks: [
        { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
        { ...base, submittedAt: null, state: "degraded" },
      ],
    });

    const line = screen.getByText(/la pidió original/);
    expect(line.querySelector("b")?.textContent).toBe("Beto");
    expect(line.textContent).toContain("si la envías editada, pasa a tu nombre");
  });

  it("does not promise it when canEscalate is false (a final exists)", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(B, false, "original"),
      picks: [
        { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
        { ...base, submittedAt: null, state: "degraded" },
      ],
    });

    expect(screen.queryByText(/la pidió original/)).toBeNull();
    expect(screen.getByText(/así que la reciben todos/)).toBeDefined();
  });

  it("does not promise it when the viewer's local kind is original", () => {
    renderWithEntry(
      {
        assetId: "a1",
        claim: claim(B, true, "original"),
        picks: [
          { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
          { ...base, submittedAt: null, state: "degraded", kind: "original" },
        ],
      },
      { selectionKindById: { a1: "original" } },
    );

    expect(screen.queryByText(/la pidió original/)).toBeNull();
  });

  it("shows it with originals OFF, mirroring planCartClaim's coercion", () => {
    renderWithEntry(
      {
        assetId: "a1",
        claim: claim(B, true, "original"),
        picks: [
          { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" },
          { ...base, submittedAt: null, state: "degraded", kind: "original" },
        ],
      },
      { allowsOriginalSelection: false, selectionKindById: { a1: "original" } },
    );

    expect(screen.getByText(/la pidió original/)).toBeDefined();
  });

  it("follows selectionKindById live", () => {
    const entry = {
      assetId: "a1",
      claim: claim(B, true, "original"),
      picks: [
        { ...base, userId: B.id, label: B.label, submittedAt: sent, state: "billed" as const },
        { ...base, submittedAt: null, state: "degraded" as const },
      ],
    };
    const { rerender } = renderWithEntry(entry, { selectionKindById: { a1: "original" } });
    expect(screen.queryByText(/la pidió original/)).toBeNull();

    rerender(
      <ProofLightbox
        assets={assetsFor(1)}
        urls={{}}
        index={0}
        quota={QUOTA}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onImageError={vi.fn()}
        onToggleSelection={vi.fn()}
        pendingAssetIds={new Set()}
        isLocked={false}
        isDelivered={false}
        selectionKindById={{ a1: "edited" }}
        onSetSelectionKind={vi.fn()}
        allowsOriginalSelection
        viewerId={A.id}
        entryById={{ a1: entry }}
      />,
    );

    expect(screen.getByText(/la pidió original/)).toBeDefined();
  });

  it("keeps 'Ya está pedida' for a legacy original with no holder", () => {
    renderWithEntry({
      assetId: "a1",
      claim: claim(null, true, "original"),
      picks: [{ ...base, submittedAt: null, state: "degraded" }],
    });

    expect(screen.getByText("Ya está pedida")).toBeDefined();
    expect(screen.queryByText(/la pidió original/)).toBeNull();
  });

  it("shows no line at all on a free photo with no pick", () => {
    renderWithEntry(null);

    expect(screen.getByRole("button", { name: "Elegir esta foto" })).toBeDefined();
    expect(
      screen.queryByText(/Todavía no|Ya la pidió|Ya está pedida|La pediste|La pidió/),
    ).toBeNull();
  });
});

// Epic #250 S11 — the owner's screenshot: on the C5 state the button split over
// two lines, the status line sat to its RIGHT and the next arrow dropped UNDER
// the previous one. Cause was structural, not cosmetic: `centerAction` was a
// fragment with two children, so `<PhotoViewer>`'s
// `grid-cols-[auto_1fr_auto]` row received FOUR grid items (fragment creates no
// node) and wrapped the third. The row's three-cell contract is the viewer's
// and is correct — it is shared with the flash gallery — so the fix is one cell
// on this side, and this test pins that, not pixels.
describe("ProofLightbox — the action row is three cells (S11)", () => {
  const A = { id: "client-a", label: "Ana" };
  const B = { id: "client-b", label: "Beto" };
  const sent = "2026-10-17T12:00:00.000Z";

  it("puts the pick button and its status line in ONE cell, so the arrows stay in the same row", () => {
    // The exact reported state: somebody else already asked for the photo and
    // the viewer has no pick of their own (C5) — the only state that renders a
    // button AND a line with this shape.
    renderLightbox({
      assets: assetsFor(1),
      index: 0,
      viewerId: A.id,
      entryById: {
        a1: {
          assetId: "a1",
          claim: {
            claimedAt: sent,
            resolvedKind: "edited" as const,
            billedTo: B,
            charge: "included" as const,
            canEscalate: false,
          },
          picks: [
            {
              userId: B.id,
              label: B.label,
              kind: "edited",
              pickedAt: sent,
              submittedAt: sent,
              state: "billed",
            },
          ],
        },
      },
    });

    const prev = screen.getByRole("button", { name: "Foto anterior" });
    const next = screen.getByRole("button", { name: "Foto siguiente" });
    const button = screen.getByRole("button", { name: "Elegir esta foto" });
    const line = screen.getByText(/Ya la pidió/);

    // The row IS the grid: prev and next share one parent, and that parent
    // must hold exactly three element children — two arrows and one cell.
    const row = prev.parentElement;
    expect(row).not.toBeNull();
    expect(next.parentElement).toBe(row);
    expect(row!.children).toHaveLength(3);

    // The pick control is not itself a cell of the row: it lives one level
    // down, which is what keeps the row at three cells.
    expect(button.parentElement).not.toBe(row);
    expect(Array.from(row!.children)).toContain(button.parentElement);

    // And the status line shares that one cell with the button instead of
    // taking the third column for itself.
    expect(line.parentElement).toBe(button.parentElement);

    // `min-w-0`: without it the `1fr` cell keeps its min-content width and the
    // button cannot shrink below the label's intrinsic width.
    expect(button.parentElement!.className).toContain("min-w-0");
  });
});
