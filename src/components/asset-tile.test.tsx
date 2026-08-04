// @vitest-environment jsdom
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { AssetTile } from "./asset-tile";
import type { WorkspaceAsset } from "./gallery-workspace";

// Task #199: <AssetTile> calls `useSortable()` itself now (see its own
// header comment) — dnd-kit's hooks read from React context, so every test
// below renders through this same minimal <DndContext>/<SortableContext>
// pair rather than the bare `<ul>` the pre-#199 suite used. `items={[id]}`
// is a single-item list on purpose: these are all UNIT tests of one tile in
// isolation (open/mark/delete/final-upload), not of reordering itself —
// gallery-workspace.test.tsx is where a REAL multi-tile drag/keyboard
// reorder is exercised end to end.
function renderTile(ui: ReactElement, id = "a1") {
  return render(
    <DndContext>
      <SortableContext items={[id]}>
        <ul>{ui}</ul>
      </SortableContext>
    </DndContext>,
  );
}

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
let onFinalUploaded: ReturnType<typeof vi.fn<(assetId: string) => void>>;
// Task #195: every test below that doesn't specifically exercise these two
// controls just needs a stub — `isMarked` defaults to `false` so the
// existing tests' assumptions (no "Elegida" text collision, etc.) still
// hold with the marking control now always rendered.
let onOpen: ReturnType<typeof vi.fn<() => void>>;
let onToggleMarked: ReturnType<typeof vi.fn<(assetId: string) => void>>;

beforeEach(() => {
  onDeleted = vi.fn();
  onFinalUploaded = vi.fn();
  onOpen = vi.fn();
  onToggleMarked = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AssetTile", () => {
  it("renders the thumbnail (by its actual URL) and the filename", () => {
    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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
    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

  // Task #195: clicking the thumbnail image opens the full-screen viewer.
  // Real click, real DOM — not a prop-existence check.
  it("calls onOpen when the thumbnail image is clicked", async () => {
    const user = userEvent.setup();
    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG en grande" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // Task #195's naming/visual trap: the marking checkbox must be a SEPARATE
  // control from the "Elegida" badge, not a re-skin of it — this asserts
  // both are independently present/queryable at once for a selected AND
  // marked asset, which would be impossible if the marking control reused
  // the "Elegida" text or accidentally replaced it.
  it("renders the marking checkbox as a distinct control from the 'Elegida' badge, and reports a toggle via onToggleMarked", async () => {
    const user = userEvent.setup();
    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: true })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    // Both present at once: the client's "Elegida" fact and the
    // photographer's own mark control are two independent things on the
    // same tile, neither replacing the other.
    expect(screen.getByText("Elegida")).toBeDefined();
    const markButton = screen.getByRole("button", { name: "Marcar IMG_0001.JPG para borrar" });
    expect(markButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(markButton);

    expect(onToggleMarked).toHaveBeenCalledWith("a1");
    // The click must reach ONLY the marking control, never the "open
    // viewer" control layered underneath it at the same screen position.
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("labels the marking checkbox as 'Desmarcar' once isMarked is true", () => {
    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={true}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    const markButton = screen.getByRole("button", { name: "Desmarcar IMG_0001.JPG" });
    expect(markButton.getAttribute("aria-pressed")).toBe("true");
  });

  // Task #199: the up/down "move" buttons are gone, replaced by a single
  // drag handle — see the component's own header for why it is a dedicated
  // control rather than the whole tile. This only asserts the handle EXISTS
  // and is independently focusable/labelled — dnd-kit's own pointer/keyboard
  // sensors are exercised for real (a real reorder result, not a mocked
  // handler call) in gallery-workspace.test.tsx, where more than one
  // sortable item actually exists to move between.
  it("renders a dedicated, labelled drag handle, distinct from the open-viewer and marking controls", () => {
    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    const handle = screen.getByRole("button", { name: "Reordenar IMG_0001.JPG" });
    expect(handle.tagName).toBe("BUTTON");
    // Distinct controls, all three present at once: opening the viewer,
    // marking for deletion, and the drag handle are three separate buttons,
    // not one control wearing three labels.
    expect(screen.getByRole("button", { name: "Ver IMG_0001.JPG en grande" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Marcar IMG_0001.JPG para borrar" })).toBeDefined();
  });

  it("refetches a fresh presigned URL and swaps the <img> src when the original one fails to load", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/refreshed" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

    renderTile(
      <AssetTile
        asset={assetFor()}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.getByText("No se pudo eliminar.")).toBeDefined());
    expect(onDeleted).not.toHaveBeenCalled();
  });

  // Task #26: the final-upload control is only ever rendered for a
  // SELECTED asset — see the component's own comment for why.
  it("does not render the final-upload control for an unselected asset", () => {
    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: false })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    expect(screen.queryByText("Subir final")).toBeNull();
    expect(screen.queryByText("Falta el final")).toBeNull();
  });

  it("shows 'Falta el final' with a 'Subir final' control for a selected asset with no final yet", () => {
    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: true, hasFinal: false })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    expect(screen.getByText("Falta el final")).toBeDefined();
    expect(screen.getByText("Subir final")).toBeDefined();

    // TASK #218: the server-side gate tightened to `image/jpeg` only, and
    // the file picker's `accept` was narrowed to match — a hint for the OS
    // file dialog, not the real gate. MUTATION PROOF: reverting the input's
    // `accept` back to `"image/*"` turns this assertion red.
    const finalInput = screen.getByLabelText("Subir final") as HTMLInputElement;
    expect(finalInput.accept).toBe("image/jpeg");
  });

  it("shows 'Final subido' with a 'Reemplazar' control for a selected asset that already has one", () => {
    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: true, hasFinal: true })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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
      renderTile(
        <AssetTile
          asset={assetFor({ isSelected: false })}
          onDeleted={onDeleted}
          onFinalUploaded={onFinalUploaded}
          isMarked={false}
          onOpen={onOpen}
          onToggleMarked={onToggleMarked}
        />,
      );

      expect(screen.queryByText("Elegida")).toBeNull();
    });

    it("shows an 'Elegida' badge on the thumbnail for a selected asset", () => {
      renderTile(
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: false })}
          onDeleted={onDeleted}
          onFinalUploaded={onFinalUploaded}
          isMarked={false}
          onOpen={onOpen}
          onToggleMarked={onToggleMarked}
        />,
      );

      expect(screen.getByText("Elegida")).toBeDefined();
    });

    it("shows the '✓' final badge on the thumbnail only once selected AND a final exists, never for a selected asset still missing one", () => {
      const { rerender } = renderTile(
        <AssetTile
          asset={assetFor({ isSelected: true, hasFinal: false })}
          onDeleted={onDeleted}
          onFinalUploaded={onFinalUploaded}
          isMarked={false}
          onOpen={onOpen}
          onToggleMarked={onToggleMarked}
        />,
      );
      expect(screen.queryByTitle("Final subido")).toBeNull();

      // `rerender` replaces the WHOLE tree at the same root — it needs the
      // same <DndContext>/<SortableContext> wrapper `renderTile` used for
      // the initial render, not the bare tile, or the second pass would
      // lose the provider `useSortable()` reads from.
      rerender(
        <DndContext>
          <SortableContext items={["a1"]}>
            <ul>
              <AssetTile
                asset={assetFor({ isSelected: true, hasFinal: true })}
                onDeleted={onDeleted}
                onFinalUploaded={onFinalUploaded}
                isMarked={false}
                onOpen={onOpen}
                onToggleMarked={onToggleMarked}
              />
            </ul>
          </SortableContext>
        </DndContext>,
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

    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: true, hasFinal: false })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
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

    renderTile(
      <AssetTile
        asset={assetFor({ isSelected: true, hasFinal: false })}
        onDeleted={onDeleted}
        onFinalUploaded={onFinalUploaded}
        isMarked={false}
        onOpen={onOpen}
        onToggleMarked={onToggleMarked}
      />,
    );

    const input = screen.getByLabelText("Subir final") as HTMLInputElement;
    const file = new File(["edited-bytes"], "IMG_0001-edit.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("asset_not_selected")).toBeDefined());
    expect(onFinalUploaded).not.toHaveBeenCalled();
  });
});
