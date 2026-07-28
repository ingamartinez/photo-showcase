// @vitest-environment jsdom
//
// This suite exercises the REAL <ProofUploader> and <AssetTile> (not stubs)
// against a mocked `fetch`, so it also proves the state-lifting contract
// between them and <GalleryWorkspace>: an upload's response gets appended,
// a delete's response removes the row, a reorder's response patches
// sort_order — all via props/state, with no `router.refresh()` anywhere
// (see gallery-workspace.tsx's header comment for why that matters for a
// ~100-file upload).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryWorkspace, type WorkspaceAsset } from "./gallery-workspace";

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

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
    proofUrl: "https://r2.example.com/a1",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GalleryWorkspace", () => {
  it("renders the empty state, then appends a newly uploaded asset to the grid without a page refresh", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/proofs")) {
        return Promise.resolve(
          jsonResponse(201, {
            asset: {
              id: "a1",
              proofKey: "galleries/g1/proofs/a1.webp",
              width: 1600,
              height: 1067,
              sortOrder: 0,
              originalFilename: "IMG_0001.JPG",
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/a1" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<GalleryWorkspace galleryId={GALLERY_ID} initialAssets={[]} />);

    expect(screen.getByText(/Todavía no subiste fotos/)).toBeDefined();

    const file = new File(["bytes"], "IMG_0001.JPG", { type: "image/jpeg" });
    await user.upload(document.querySelector("input[type=file]")!, [file]);

    // Appears twice once uploaded: once in the uploader's own per-file
    // status list, and once as the new tile's filename in the grid below.
    await waitFor(() => expect(screen.getAllByText("IMG_0001.JPG")).toHaveLength(2));
    expect(screen.queryByText(/Todavía no subiste fotos/)).toBeNull();
  });

  it("removes an asset from the grid when its tile reports it deleted", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<GalleryWorkspace galleryId={GALLERY_ID} initialAssets={[assetFor()]} />);
    expect(screen.getByText("IMG_0001.JPG")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(screen.queryByText("IMG_0001.JPG")).toBeNull());
    expect(screen.getByText(/Todavía no subiste fotos/)).toBeDefined();
  });

  it("re-sorts the grid after a reorder response, without needing a server refresh", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          updated: [
            { id: "a2", sortOrder: 0 },
            { id: "a1", sortOrder: 1 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[
          assetFor({ id: "a1", originalFilename: "first.jpg", sortOrder: 0 }),
          assetFor({ id: "a2", originalFilename: "second.jpg", sortOrder: 1 }),
        ]}
      />,
    );

    const filenames = () => screen.getAllByText(/\.jpg$/).map((el) => el.textContent);
    expect(filenames()).toEqual(["first.jpg", "second.jpg"]);

    // "second.jpg" is the second tile (not first, not last) — its "move up"
    // button is enabled.
    const moveUpButtons = screen.getAllByRole("button", { name: "Mover antes" });
    await user.click(moveUpButtons[1]!);

    await waitFor(() => expect(filenames()).toEqual(["second.jpg", "first.jpg"]));
  });
});
