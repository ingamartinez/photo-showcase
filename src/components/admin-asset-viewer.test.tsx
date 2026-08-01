// @vitest-environment jsdom
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminAssetViewer } from "./admin-asset-viewer";
import type { WorkspaceAsset } from "./gallery-workspace";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function assetsFor(count: number, overrides: Partial<WorkspaceAsset>[] = []): WorkspaceAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    sortOrder: index,
    proofUrl: `https://r2.example.com/proof-${index + 1}`,
    hasFinal: false,
    ...overrides[index],
  }));
}

let onClose: ReturnType<typeof vi.fn<() => void>>;
let onNavigate: ReturnType<typeof vi.fn<(index: number) => void>>;
let onToggleMarked: ReturnType<typeof vi.fn<(assetId: string) => void>>;

beforeEach(() => {
  onClose = vi.fn();
  onNavigate = vi.fn();
  onToggleMarked = vi.fn();
});

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function viewerProps(
  overrides: Partial<ComponentProps<typeof AdminAssetViewer>> = {},
): ComponentProps<typeof AdminAssetViewer> {
  return {
    assets: assetsFor(3),
    index: 1,
    markedIds: new Set<string>(),
    onToggleMarked,
    onClose,
    onNavigate,
    ...overrides,
  };
}

function renderViewer(overrides: Partial<ComponentProps<typeof AdminAssetViewer>> = {}) {
  return render(<AdminAssetViewer {...viewerProps(overrides)} />);
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("AdminAssetViewer", () => {
  it("renders the current asset's image WHOLE (object-contain, not the tile's own object-cover crop) with its filename and position", () => {
    renderViewer({ assets: assetsFor(3), index: 1 });

    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    expect(screen.getByText("IMG_0002.JPG")).toBeDefined();
    const img = screen.getByAltText("IMG_0002.JPG") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/proof-2");
    expect(img.className).toContain("object-contain");
  });

  // The 5-minute presigned-URL expiry path — this screen's ordinary case,
  // not an edge case (see the component's own comment).
  it("refetches a fresh presigned URL and swaps the <img> src when it fails to load, and does not loop on a repeated error", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderViewer({ assets: assetsFor(1), index: 0 });

    const img = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    fireEvent.error(img);

    await waitFor(() => expect(img.src).toBe("https://r2.example.com/refreshed"));
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");

    fireEvent.error(img);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("navigation", () => {
    it("navigates next/prev via the on-screen buttons", async () => {
      const user = userEvent.setup();
      renderViewer({ assets: assetsFor(3), index: 1 });

      await user.click(screen.getByRole("button", { name: "Foto siguiente" }));
      expect(onNavigate).toHaveBeenCalledWith(2);

      await user.click(screen.getByRole("button", { name: "Foto anterior" }));
      expect(onNavigate).toHaveBeenCalledWith(0);
    });

    it("disables 'Foto anterior' at the first asset and 'Foto siguiente' at the last", () => {
      renderViewer({ assets: assetsFor(3), index: 0 });
      expect(screen.getByRole("button", { name: "Foto anterior" })).toHaveProperty(
        "disabled",
        true,
      );

      cleanup();
      renderViewer({ assets: assetsFor(3), index: 2 });
      expect(screen.getByRole("button", { name: "Foto siguiente" })).toHaveProperty(
        "disabled",
        true,
      );
    });

    it("navigates with the ArrowRight/ArrowLeft keys", () => {
      renderViewer({ assets: assetsFor(3), index: 1 });

      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onNavigate).toHaveBeenCalledWith(2);

      fireEvent.keyDown(window, { key: "ArrowLeft" });
      expect(onNavigate).toHaveBeenCalledWith(0);
    });
  });

  describe("the marking control", () => {
    it("shows the unmarked state and toggles it via onToggleMarked", async () => {
      const user = userEvent.setup();
      renderViewer({ assets: assetsFor(1), index: 0, markedIds: new Set() });

      const markButton = screen.getByRole("button", { name: "Marcar para borrar" });
      expect(markButton.getAttribute("aria-pressed")).toBe("false");

      await user.click(markButton);

      expect(onToggleMarked).toHaveBeenCalledWith("a1");
    });

    it("shows the marked state for an asset already in markedIds", () => {
      renderViewer({ assets: assetsFor(1), index: 0, markedIds: new Set(["a1"]) });

      const markButton = screen.getByRole("button", { name: "Marcada para borrar" });
      expect(markButton.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("modal dialog mechanics", () => {
    it("closes on Escape", () => {
      renderViewer();

      fireEvent.keyDown(dialog(), { key: "Escape" });

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes via the explicit close button", async () => {
      const user = userEvent.setup();
      renderViewer();

      await user.click(screen.getByRole("button", { name: "Cerrar" }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("hides the gallery grid behind it from assistive tech while it is open", () => {
      const { container } = render(
        <>
          <button type="button">Una miniatura de la grilla</button>
          <AdminAssetViewer {...viewerProps()} />
        </>,
      );

      expect(container.getAttribute("aria-hidden")).toBe("true");
      expect(screen.queryByRole("button", { name: "Una miniatura de la grilla" })).toBeNull();
      expect(screen.getByRole("button", { name: "Cerrar" })).toBeDefined();
    });

    // The trap itself, proven the way the kanban body demands: NOT "tab
    // wraps back to the first control" (a loop test proves a ring exists,
    // it does not prove the ring is CLOSED to the page behind — see task
    // #184's own open debt on exactly this substitution). This asserts the
    // one fact a loop-only test cannot: after tabbing past the dialog's own
    // last control, the element BEHIND the dialog never receives focus.
    // Mutation-proven against a REAL trap failure, not merely a
    // never-autofocuses one: replacing `<DialogPrimitive.Content>` with a
    // bare `<div role="dialog">` first failed this test's own PREAMBLE
    // (`document.activeElement` was never `close` to begin with, since a
    // plain div never autofocuses) rather than the trap assertion below it
    // — red for the wrong reason proves nothing, the same as green. Adding
    // `autoFocus` to the "Cerrar" button on top of the bare-div mutation is
    // what actually reached the assertion this test exists for and failed
    // there, on "the element behind received focus".
    //
    // SCOPE, STATED EXPLICITLY: this covers the TAB vector only. Setting
    // `modal={false}` on `<DialogPrimitive.Root>` does NOT break this test
    // — Radix's `FocusScope` keeps `loop` behaviour even with
    // `trapped={false}` in this version, so a regression that only
    // disables `modal` (which also drops the background `aria-hidden`,
    // covered by a separate test above) would slip past a Tab-only check
    // like this one. A future change to pointer-based or programmatic
    // focus escape (`element.focus()` called directly on a background
    // node, say) is NOT exercised here either.
    it("never lets focus escape to a control behind the dialog while tabbing through it", async () => {
      const user = userEvent.setup();
      render(
        <>
          <button type="button">Una miniatura de la grilla</button>
          <AdminAssetViewer {...viewerProps({ assets: assetsFor(1), index: 0 })} />
        </>,
      );

      // Single asset -> prev/next are both disabled and excluded from the
      // tab ring, so the dialog's own ring is: Cerrar, Marcar. Tab past the
      // last one enough times that a broken trap would have reached the
      // background button by now.
      const close = screen.getByRole("button", { name: "Cerrar" });
      expect(document.activeElement).toBe(close);

      for (let i = 0; i < 6; i++) {
        await user.tab();
        // The one assertion that actually proves the trap: the element
        // OUTSIDE the dialog must never become the active element, at any
        // point in the ring, not merely "eventually wraps back to Cerrar".
        expect(document.activeElement?.textContent).not.toBe("Una miniatura de la grilla");
      }
    });

    it("returns focus to whatever opened it when it closes", async () => {
      function Harness() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>
              Ver IMG_0001.JPG en grande
            </button>
            {open && (
              <AdminAssetViewer
                {...viewerProps({ assets: assetsFor(1), index: 0 })}
                onClose={() => setOpen(false)}
              />
            )}
          </>
        );
      }

      const user = userEvent.setup();
      render(<Harness />);
      const trigger = screen.getByRole("button", { name: "Ver IMG_0001.JPG en grande" });

      await user.click(trigger);
      expect(screen.getByRole("dialog")).toBeDefined();

      await user.click(screen.getByRole("button", { name: "Cerrar" }));

      // Radix restores focus on a macrotask after unmount, hence waitFor.
      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    it("locks background scroll while open and restores it on close", () => {
      const { unmount } = renderViewer();

      expect(document.body.style.overflow).toBe("hidden");

      unmount();

      expect(document.body.style.overflow).toBe("");
    });
  });
});
