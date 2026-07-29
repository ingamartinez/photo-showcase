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
