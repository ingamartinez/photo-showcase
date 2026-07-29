// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofLightbox } from "./proof-lightbox";
import type { ProofAsset } from "./proof-grid";

function assetsFor(count: number, overrides: Partial<ProofAsset>[] = []): ProofAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/proof-${index + 1}`,
    hasFinal: false,
    ...overrides[index],
  }));
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
let onImageError: ReturnType<typeof vi.fn<(assetId: string) => void>>;
let onToggleSelection: ReturnType<typeof vi.fn<(assetId: string, nextSelected: boolean) => void>>;

beforeEach(() => {
  onClose = vi.fn();
  onNavigate = vi.fn();
  onImageError = vi.fn();
  onToggleSelection = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

// Every test below wants the same handlers and an empty `pendingAssetIds` by
// default — this only ever overrides `assets`/`urls`/`index`, so the toggle
// wiring doesn't need repeating in every single test.
function renderLightbox(overrides: Partial<ComponentProps<typeof ProofLightbox>> = {}) {
  return render(
    <ProofLightbox
      assets={assetsFor(3)}
      urls={{}}
      index={1}
      onClose={onClose}
      onNavigate={onNavigate}
      onImageError={onImageError}
      onToggleSelection={onToggleSelection}
      pendingAssetIds={new Set()}
      isLocked={false}
      isDelivered={false}
      {...overrides}
    />,
  );
}

describe("ProofLightbox", () => {
  it("renders the current asset's image, filename, and position", () => {
    renderLightbox({ assets: assetsFor(3), index: 1 });

    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    const img = screen.getByAltText("IMG_0002.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/proof-2");
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

  it("calls onImageError with the asset id when the <img> fails to load", () => {
    renderLightbox({ assets: assetsFor(1), index: 0 });

    fireEvent.error(screen.getByAltText("IMG_0001.JPG"));

    expect(onImageError).toHaveBeenCalledWith("a1");
  });

  it("closes on Escape", () => {
    renderLightbox();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates with ArrowRight/ArrowLeft from the middle of the set", () => {
    renderLightbox();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).toHaveBeenCalledWith(2);

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("does nothing on ArrowLeft at the first photo, or ArrowRight at the last", () => {
    const { rerender } = render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
        onToggleSelection={onToggleSelection}
        pendingAssetIds={new Set()}
        isLocked={false}
        isDelivered={false}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onNavigate).not.toHaveBeenCalled();

    rerender(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={2}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
        onToggleSelection={onToggleSelection}
        pendingAssetIds={new Set()}
        isLocked={false}
        isDelivered={false}
      />,
    );

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("hides the 'previous' control on the first photo and the 'next' control on the last", () => {
    const { rerender } = render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
        onToggleSelection={onToggleSelection}
        pendingAssetIds={new Set()}
        isLocked={false}
        isDelivered={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Foto anterior" })).toBeNull();
    expect(screen.getByRole("button", { name: "Foto siguiente" })).toBeDefined();

    rerender(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={2}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
        onToggleSelection={onToggleSelection}
        pendingAssetIds={new Set()}
        isLocked={false}
        isDelivered={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Foto anterior" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Foto siguiente" })).toBeNull();
  });

  it("navigates via the on-screen prev/next buttons", () => {
    renderLightbox();

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(onNavigate).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Foto anterior" }));
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("locks body scroll while mounted, and restores it on unmount", () => {
    const { unmount } = renderLightbox({ assets: assetsFor(1), index: 0 });

    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus to the close button on open", () => {
    renderLightbox({ assets: assetsFor(1), index: 0 });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));
  });

  // Task #24: the client can toggle selection from the full-screen view too,
  // not only the grid tile behind it.
  describe("selection toggle", () => {
    it("shows 'Seleccionar' for an unselected asset and calls onToggleSelection(id, true) on click", () => {
      renderLightbox({ assets: assetsFor(1, [{ isSelected: false }]), index: 0 });

      fireEvent.click(screen.getByRole("button", { name: "Seleccionar" }));

      expect(onToggleSelection).toHaveBeenCalledWith("a1", true);
    });

    it("shows the selected state and calls onToggleSelection(id, false) to deselect", () => {
      renderLightbox({ assets: assetsFor(1, [{ isSelected: true }]), index: 0 });

      const button = screen.getByRole("button", { name: /Seleccionada/ });
      expect(button.getAttribute("aria-pressed")).toBe("true");

      fireEvent.click(button);

      expect(onToggleSelection).toHaveBeenCalledWith("a1", false);
    });

    it("disables the toggle button while this asset's toggle is pending", () => {
      renderLightbox({
        assets: assetsFor(1, [{ isSelected: false }]),
        index: 0,
        pendingAssetIds: new Set(["a1"]),
      });

      const button = screen.getByRole("button", { name: "Seleccionar" }) as HTMLButtonElement;
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

      const button = screen.getByRole("button", { name: "Seleccionar" }) as HTMLButtonElement;
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
    // The swipe gesture lives on the container that wraps the image and the
    // prev/next controls — not on the <img> itself — so touch events are
    // dispatched against that container, the same element handleTouchStart/
    // handleTouchEnd are actually bound to.
    function swipeContainer(): HTMLElement {
      const dialog = screen.getByRole("dialog");
      const container = dialog.querySelector('[class*="relative"]');
      if (!container) throw new Error("swipe container not found");
      return container as HTMLElement;
    }

    function touchList(clientX: number) {
      return [{ clientX }];
    }

    it("swipes left to advance to the next photo", () => {
      renderLightbox();

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(100) });

      expect(onNavigate).toHaveBeenCalledWith(2);
    });

    it("swipes right to go to the previous photo", () => {
      renderLightbox();

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(100) });
      fireEvent.touchEnd(container, { changedTouches: touchList(200) });

      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    // The one most likely to be wrong: a tap (or a jittery finger with
    // barely any movement) must not be misread as a swipe. Below the 40px
    // threshold in either direction, nothing should navigate.
    it("does not navigate when the movement is below the 40px swipe threshold", () => {
      renderLightbox();

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(180) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe left past the last photo", () => {
      renderLightbox({ index: 2 });

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(100) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe right before the first photo", () => {
      renderLightbox({ index: 0 });

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(100) });
      fireEvent.touchEnd(container, { changedTouches: touchList(200) });

      expect(onNavigate).not.toHaveBeenCalled();
    });
  });
});
