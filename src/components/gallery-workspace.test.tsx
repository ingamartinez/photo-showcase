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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryWorkspace, type WorkspaceAsset } from "./gallery-workspace";
import type { DeliverGalleryState } from "@/app/dashboard/galleries/actions";

// <GalleryWorkspace> now renders <DeliverGalleryButton> itself (task #86) —
// its module imports `deliverGallery` from here, which transitively pulls in
// `@/lib/db`/`@/auth`/etc. Mocked wholesale for the same reason
// deliver-gallery-button.test.tsx already mocks this module: this suite
// never exercises the real server action.
const deliverGalleryMock =
  vi.fn<(state: DeliverGalleryState, formData: FormData) => Promise<DeliverGalleryState>>();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  deliverGallery: (...args: [DeliverGalleryState, FormData]) => deliverGalleryMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_EMAIL = "ana@example.com";

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
    hasFinal: false,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  deliverGalleryMock.mockReset();
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

    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[]}
        clientEmails={[CLIENT_EMAIL]}
        canDeliver={false}
      />,
    );

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

    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[assetFor()]}
        clientEmails={[CLIENT_EMAIL]}
        canDeliver={false}
      />,
    );
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
        clientEmails={[CLIENT_EMAIL]}
        canDeliver={false}
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

  // Task #26's own scope note: "the screen should make the remaining work
  // obvious — which selected assets still lack a final."
  it("shows no pending-finals summary when nothing is selected yet", () => {
    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[assetFor({ isSelected: false })]}
        clientEmails={[CLIENT_EMAIL]}
        canDeliver={false}
      />,
    );

    expect(screen.queryByText(/finales/)).toBeNull();
  });

  it("summarizes pending finals for selected assets, and updates it live after an upload", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { asset: { id: "a1" } })));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[
          assetFor({ id: "a1", isSelected: true, hasFinal: false }),
          assetFor({ id: "a2", originalFilename: "second.jpg", isSelected: true, hasFinal: false }),
        ]}
        clientEmails={[CLIENT_EMAIL]}
        canDeliver={false}
      />,
    );

    expect(screen.getByText("Faltan 2 de 2 finales por subir.")).toBeDefined();

    // Two selected tiles both render their own "Subir final" input; only
    // the first one's upload response resolves (mocked above) — the fetch
    // mock does not distinguish which asset it was called for, but that's
    // fine here: this test is about the SUMMARY updating from ONE upload,
    // not about which specific tile it was.
    const file = new File(["edited"], "a1-edit.jpg", { type: "image/jpeg" });
    const [firstInput] = screen.getAllByLabelText("Subir final") as HTMLInputElement[];
    fireEvent.change(firstInput!, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Faltan 1 de 2 finales por subir.")).toBeDefined());
  });

  // Task #86's own regression: the deliver control used to live outside this
  // component, fed a `pendingFinalsCount` prop computed ONCE, server-side, at
  // page render — nothing updated it after an upload, so a photographer who
  // uploaded the last missing final without reloading saw the counter above
  // say "ya están subidos" while the button stayed disabled. Proven by
  // MUTATION, not just by asserting the happy path: temporarily reintroducing
  // that bug (freezing `pendingFinalsCount` at its value from
  // `initialAssets` instead of recomputing it from `sorted`/`assets`) makes
  // this exact test fail — the button stays disabled after the upload
  // resolves, because `waitFor` never observes it flip. Restoring the fix
  // (deriving the prop from the SAME live `assets` state on every render, as
  // implemented above) makes it pass again. This test would ALSO fail if
  // <DeliverGalleryButton> stopped disabling on `pendingFinalsCount > 0`
  // entirely, so it is not vacuous in the other direction either.
  it("enables the deliver button, without a page reload, the instant the last missing final finishes uploading", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, { asset: { id: "a1" } })));
    vi.stubGlobal("fetch", fetchMock);
    deliverGalleryMock.mockResolvedValue({ status: "idle" });

    render(
      <GalleryWorkspace
        galleryId={GALLERY_ID}
        initialAssets={[assetFor({ id: "a1", isSelected: true, hasFinal: false })]}
        clientEmails={[CLIENT_EMAIL]}
        canDeliver
      />,
    );

    const deliverButton = () => screen.getByRole("button", { name: "Entregar galería" });
    expect(deliverButton()).toHaveProperty("disabled", true);

    const file = new File(["edited"], "a1-edit.jpg", { type: "image/jpeg" });
    const finalInput = screen.getByLabelText("Subir final") as HTMLInputElement;
    fireEvent.change(finalInput, { target: { files: [file] } });

    await waitFor(() => expect(deliverButton()).toHaveProperty("disabled", false));
  });
});
