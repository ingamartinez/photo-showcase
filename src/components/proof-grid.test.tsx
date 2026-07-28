// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofGrid } from "./proof-grid";
import type { ProofAsset } from "./proof-grid";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function assetsFor(overrides: Partial<ProofAsset>[] = [{}]): ProofAsset[] {
  return overrides.map((override, index) => ({
    id: `a${index + 1}`,
    originalFilename: `IMG_000${index + 1}.JPG`,
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    proofUrl: `https://r2.example.com/original-${index + 1}`,
    ...override,
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProofGrid", () => {
  it("renders the empty state when there are no assets", () => {
    render(<ProofGrid initialAssets={[]} />);

    expect(screen.getByText(/todavía no subió fotos/i)).toBeDefined();
  });

  it("reserves each tile's aspect ratio from proofWidth/proofHeight before the image ever loads", () => {
    const { container } = render(
      <ProofGrid initialAssets={assetsFor([{ proofWidth: 1600, proofHeight: 1067 }])} />,
    );

    const img = container.querySelector("img");
    const wrapper = img?.parentElement;
    expect(wrapper?.getAttribute("style")).toContain("aspect-ratio: 1600 / 1067");
  });

  it("renders each asset's thumbnail by its original presigned URL", () => {
    const { container } = render(<ProofGrid initialAssets={assetsFor([{}, {}])} />);

    // Not getByRole("img"): each tile's <img alt=""> is deliberately
    // decorative (the enclosing button already carries an aria-label with
    // the filename), which removes it from the accessibility tree's "img"
    // role — queried off the DOM directly instead.
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("https://r2.example.com/original-1");
    expect(images[1]?.getAttribute("src")).toBe("https://r2.example.com/original-2");
  });

  it("opens the lightbox at the clicked tile's index", async () => {
    const user = userEvent.setup();
    render(<ProofGrid initialAssets={assetsFor([{}, {}, {}])} />);

    await user.click(screen.getByRole("button", { name: "Ver IMG_0002.JPG" }));

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText(/2 \/ 3/)).toBeDefined();
    expect(screen.getByText("IMG_0002.JPG", { exact: false })).toBeDefined();
  });

  it("closes the lightbox", async () => {
    const user = userEvent.setup();
    render(<ProofGrid initialAssets={assetsFor([{}])} />);

    await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    expect(screen.getByRole("dialog")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // The task's URL-expiry acceptance criterion: a stale URL recovers
  // in-place (the tile swaps its own <img> src) without a hard reload, and
  // once refreshed, opening the lightbox for the SAME asset reuses that
  // already-refreshed URL instead of fetching it again — the shared-state
  // design this file's header comment documents.
  it("refreshes a stale tile's URL on <img> error, and the lightbox reuses the refreshed URL for the same asset without fetching again", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed-1" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    const { container } = render(<ProofGrid initialAssets={assetsFor([{}])} />);

    const tileImg = container.querySelector("img") as HTMLImageElement;
    expect(tileImg.src).toBe("https://r2.example.com/original-1");

    fireEvent.error(tileImg);
    await vi.waitFor(() => expect(tileImg.src).toBe("https://r2.example.com/refreshed-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");

    await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));

    const lightboxImg = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    expect(lightboxImg.src).toBe("https://r2.example.com/refreshed-1");
    // Still exactly once — the lightbox picked up the already-refreshed URL
    // from shared state instead of re-fetching it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never refetches more than once for the same asset even if the <img> keeps erroring", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ProofGrid initialAssets={assetsFor([{}])} />);
    const tileImg = container.querySelector("img") as HTMLImageElement;

    fireEvent.error(tileImg);
    fireEvent.error(tileImg);
    fireEvent.error(tileImg);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
