// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AssetTile } from "./asset-tile";
import type { WorkspaceAsset } from "./gallery-workspace";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function assetFor(overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id: "a1",
    originalFilename: "IMG_0001.JPG",
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: false,
    sortOrder: 0,
    proofUrl: "https://r2.example.com/original-presigned",
    hasFinal: false,
    ...overrides,
  };
}

let onDeleted: ReturnType<typeof vi.fn<(assetId: string) => void>>;
let onMoved: ReturnType<typeof vi.fn<(updates: { id: string; sortOrder: number }[]) => void>>;
let onFinalUploaded: ReturnType<typeof vi.fn<(assetId: string) => void>>;

beforeEach(() => {
  onDeleted = vi.fn();
  onMoved = vi.fn();
  onFinalUploaded = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AssetTile", () => {
  it("renders the thumbnail (by its actual URL) and the filename", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const img = screen.getByRole("img") as HTMLImageElement;
    expect(img.src).toBe("https://r2.example.com/original-presigned");
    expect(screen.getByText("IMG_0001.JPG")).toBeDefined();
  });

  // Task #194: the owner's own report was "al abrir la galería me carga
  // todas las imágenes" — a bare <img> defaults to `loading="eager"`. This
  // renders a REAL tile (asserting the <img> exists first, via its actual
  // alt text) and only then checks the attribute, so a component that
  // stopped rendering an <img> at all would fail loudly here instead of
  // this test passing vacuously — the exact trap this repo's kanban body
  // calls out by name.
  it("marks the thumbnail lazy and async-decoded, so a long grid doesn't fetch every proof eagerly", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const img = screen.getByAltText("IMG_0001.JPG") as HTMLImageElement;
    expect(img).toBeDefined();
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  // Task #194's own trap: with `loading="lazy"`, a tile that never scrolled
  // into view never fires `load`/`error`, so the "recover from an expired
  // presigned URL" path (already proven above for the eager case) now has
  // to survive being the FIRST thing that happens to a tile, not the
  // second — and, per that same acceptance criterion, must still not loop
  // if the browser fires more than one `error` event for the same broken
  // image (real browsers can do this on a slow/flaky connection).
  it("recovers once from an error on a tile that just entered the viewport, and does not loop on a second error", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const img = screen.getByRole("img") as HTMLImageElement;
    // First error: the lazily-loaded image's first real load attempt fails
    // against an already-expired presigned URL.
    fireEvent.error(img);
    await waitFor(() => expect(img.src).toBe("https://r2.example.com/refreshed"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second error on the SAME <img> (e.g. the refreshed URL itself 404s,
    // or the browser retries after a flaky connection): must not refetch
    // again — `refreshedOnce` stops it, exactly as it already does for the
    // eager case.
    fireEvent.error(img);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disables 'move up' for the first tile and 'move down' for the last tile", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={true}
          isLast={true}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    expect(screen.getByRole("button", { name: "Mover antes" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Mover después" })).toHaveProperty("disabled", true);
  });

  it("refetches a fresh presigned URL and swaps the <img> src when the original one fails to load", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const img = screen.getByRole("img") as HTMLImageElement;
    fireEvent.error(img);

    await waitFor(() => expect(img.src).toBe("https://r2.example.com/refreshed"));
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/proof");
  });

  it("deletes the asset after confirmation and reports it via onDeleted", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("a1"));
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1", { method: "DELETE" });
  });

  it("does not delete when the confirmation dialog is dismissed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("shows an inline error and does not call onDeleted when the delete request fails", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(500, { error: "boom" })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.getByText("No se pudo eliminar.")).toBeDefined());
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("moves the asset up and reports the server's updated sort orders via onMoved", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          updated: [
            { id: "a1", sortOrder: 0 },
            { id: "a0", sortOrder: 1 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ul>
        <AssetTile
          asset={assetFor()}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    await user.click(screen.getByRole("button", { name: "Mover antes" }));

    await waitFor(() =>
      expect(onMoved).toHaveBeenCalledWith([
        { id: "a1", sortOrder: 0 },
        { id: "a0", sortOrder: 1 },
      ]),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/assets/a1/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "up" }),
    });
  });

  // Task #26: the final-upload control is only ever rendered for a
  // SELECTED asset — see the component's own comment for why.
  it("does not render the final-upload control for an unselected asset", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor({ isSelected: false })}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    expect(screen.queryByText("Subir final")).toBeNull();
    expect(screen.queryByText("Falta el final")).toBeNull();
  });

  it("shows 'Falta el final' with a 'Subir final' control for a selected asset with no final yet", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: false })}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    expect(screen.getByText("Falta el final")).toBeDefined();
    expect(screen.getByText("Subir final")).toBeDefined();
  });

  it("shows 'Final subido' with a 'Reemplazar' control for a selected asset that already has one", () => {
    render(
      <ul>
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: true })}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    expect(screen.getByText("Final subido")).toBeDefined();
    expect(screen.getByText("Reemplazar")).toBeDefined();
  });

  // Task #134's headline criterion: the three asset states are distinguishable
  // "at a glance across the whole grid, not one tile at a time" — i.e. ON the
  // thumbnail itself, not only in the below-image controls a photographer
  // would have to open one tile at a time to read (already covered above).
  // These three tests guard the overlay badges specifically, and each one is
  // a real WORD/GLYPH check, not a class/colour assertion — the failure mode
  // this criterion exists to prevent is a colour-only distinction that a
  // colour-blind photographer, or anyone reading a screenshot in greyscale,
  // cannot see at all.
  describe("state legibility on the thumbnail itself (task #134)", () => {
    it("shows no 'Elegida' badge on the thumbnail for an unselected asset", () => {
      render(
        <ul>
          <AssetTile
            asset={assetFor({ isSelected: false })}
            isFirst={false}
            isLast={false}
            onDeleted={onDeleted}
            onMoved={onMoved}
            onFinalUploaded={onFinalUploaded}
          />
        </ul>,
      );

      expect(screen.queryByText("Elegida")).toBeNull();
    });

    it("shows an 'Elegida' badge on the thumbnail for a selected asset", () => {
      render(
        <ul>
          <AssetTile
            asset={assetFor({ isSelected: true, hasFinal: false })}
            isFirst={false}
            isLast={false}
            onDeleted={onDeleted}
            onMoved={onMoved}
            onFinalUploaded={onFinalUploaded}
          />
        </ul>,
      );

      expect(screen.getByText("Elegida")).toBeDefined();
    });

    it("shows the '✓' final badge on the thumbnail only once selected AND a final exists, never for a selected asset still missing one", () => {
      const { rerender } = render(
        <ul>
          <AssetTile
            asset={assetFor({ isSelected: true, hasFinal: false })}
            isFirst={false}
            isLast={false}
            onDeleted={onDeleted}
            onMoved={onMoved}
            onFinalUploaded={onFinalUploaded}
          />
        </ul>,
      );
      expect(screen.queryByTitle("Final subido")).toBeNull();

      rerender(
        <ul>
          <AssetTile
            asset={assetFor({ isSelected: true, hasFinal: true })}
            isFirst={false}
            isLast={false}
            onDeleted={onDeleted}
            onMoved={onMoved}
            onFinalUploaded={onFinalUploaded}
          />
        </ul>,
      );
      const finalBadge = screen.getByTitle("Final subido");
      expect(finalBadge.textContent).toBe("✓");
    });
  });

  it("uploads a final and reports it via onFinalUploaded on success", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return Promise.resolve(jsonResponse(200, { asset: { id: "a1" } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ul>
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: false })}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const input = screen.getByLabelText("Subir final") as HTMLInputElement;
    const file = new File(["edited-bytes"], "IMG_0001-edit.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onFinalUploaded).toHaveBeenCalledWith("a1"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/a1/final",
      expect.objectContaining({ method: "POST" }),
    );
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestInit.body).toBeInstanceOf(FormData);
    expect((requestInit.body as FormData).get("file")).toBe(file);
  });

  it("shows an inline error and does not call onFinalUploaded when the upload fails", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(409, { error: "asset_not_selected" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ul>
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: false })}
          isFirst={false}
          isLast={false}
          onDeleted={onDeleted}
          onMoved={onMoved}
          onFinalUploaded={onFinalUploaded}
        />
      </ul>,
    );

    const input = screen.getByLabelText("Subir final") as HTMLInputElement;
    const file = new File(["edited-bytes"], "IMG_0001-edit.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("asset_not_selected")).toBeDefined());
    expect(onFinalUploaded).not.toHaveBeenCalled();
  });
});
