// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProofLightbox } from "./proof-lightbox";
import type { ProofAsset } from "./proof-grid";

function assetsFor(count: number): ProofAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/proof-${index + 1}`,
  }));
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
let onImageError: ReturnType<typeof vi.fn<(assetId: string) => void>>;

beforeEach(() => {
  onClose = vi.fn();
  onNavigate = vi.fn();
  onImageError = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("ProofLightbox", () => {
  it("renders the current asset's image, filename, and position", () => {
    render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={1}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    const img = screen.getByAltText("IMG_0002.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/proof-2");
  });

  it("prefers the shared refreshed URL over the asset's own stale proofUrl", () => {
    render(
      <ProofLightbox
        assets={assetsFor(1)}
        urls={{ a1: "https://r2.example.com/refreshed" }}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    const img = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/refreshed");
  });

  it("calls onImageError with the asset id when the <img> fails to load", () => {
    render(
      <ProofLightbox
        assets={assetsFor(1)}
        urls={{}}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    fireEvent.error(screen.getByAltText("IMG_0001.JPG"));

    expect(onImageError).toHaveBeenCalledWith("a1");
  });

  it("closes on Escape", () => {
    render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={1}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("navigates with ArrowRight/ArrowLeft from the middle of the set", () => {
    render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={1}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

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
      />,
    );

    expect(screen.getByRole("button", { name: "Foto anterior" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Foto siguiente" })).toBeNull();
  });

  it("navigates via the on-screen prev/next buttons", () => {
    render(
      <ProofLightbox
        assets={assetsFor(3)}
        urls={{}}
        index={1}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Foto siguiente" }));
    expect(onNavigate).toHaveBeenCalledWith(2);

    fireEvent.click(screen.getByRole("button", { name: "Foto anterior" }));
    expect(onNavigate).toHaveBeenCalledWith(0);
  });

  it("locks body scroll while mounted, and restores it on unmount", () => {
    const { unmount } = render(
      <ProofLightbox
        assets={assetsFor(1)}
        urls={{}}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    expect(document.body.style.overflow).toBe("hidden");

    unmount();

    expect(document.body.style.overflow).toBe("");
  });

  it("moves focus to the close button on open", () => {
    render(
      <ProofLightbox
        assets={assetsFor(1)}
        urls={{}}
        index={0}
        onClose={onClose}
        onNavigate={onNavigate}
        onImageError={onImageError}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cerrar" }));
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
      render(
        <ProofLightbox
          assets={assetsFor(3)}
          urls={{}}
          index={1}
          onClose={onClose}
          onNavigate={onNavigate}
          onImageError={onImageError}
        />,
      );

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(100) });

      expect(onNavigate).toHaveBeenCalledWith(2);
    });

    it("swipes right to go to the previous photo", () => {
      render(
        <ProofLightbox
          assets={assetsFor(3)}
          urls={{}}
          index={1}
          onClose={onClose}
          onNavigate={onNavigate}
          onImageError={onImageError}
        />,
      );

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(100) });
      fireEvent.touchEnd(container, { changedTouches: touchList(200) });

      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    // The one most likely to be wrong: a tap (or a jittery finger with
    // barely any movement) must not be misread as a swipe. Below the 40px
    // threshold in either direction, nothing should navigate.
    it("does not navigate when the movement is below the 40px swipe threshold", () => {
      render(
        <ProofLightbox
          assets={assetsFor(3)}
          urls={{}}
          index={1}
          onClose={onClose}
          onNavigate={onNavigate}
          onImageError={onImageError}
        />,
      );

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(180) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe left past the last photo", () => {
      render(
        <ProofLightbox
          assets={assetsFor(3)}
          urls={{}}
          index={2}
          onClose={onClose}
          onNavigate={onNavigate}
          onImageError={onImageError}
        />,
      );

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(200) });
      fireEvent.touchEnd(container, { changedTouches: touchList(100) });

      expect(onNavigate).not.toHaveBeenCalled();
    });

    it("does not navigate on a swipe right before the first photo", () => {
      render(
        <ProofLightbox
          assets={assetsFor(3)}
          urls={{}}
          index={0}
          onClose={onClose}
          onNavigate={onNavigate}
          onImageError={onImageError}
        />,
      );

      const container = swipeContainer();
      fireEvent.touchStart(container, { touches: touchList(100) });
      fireEvent.touchEnd(container, { changedTouches: touchList(200) });

      expect(onNavigate).not.toHaveBeenCalled();
    });
  });
});
