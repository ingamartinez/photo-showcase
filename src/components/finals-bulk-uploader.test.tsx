// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FinalsBulkUploader } from "./finals-bulk-uploader";
import type { WorkspaceAsset } from "./gallery-workspace";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A promise the test controls the resolution of — same technique as
 * proof-uploader.test.tsx's own `deferred`, needed for the exact same
 * reason: proving "sequential" requires observing that request #2 has NOT
 * been sent while request #1 is still pending, which resolved-in-order
 * alone cannot distinguish from a `Promise.all`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeAsset(overrides: Partial<WorkspaceAsset> = {}): WorkspaceAsset {
  return {
    id: "a1",
    originalFilename: "DSC_0001.JPG",
    proofWidth: 1600,
    proofHeight: 1067,
    isSelected: true,
    sortOrder: 0,
    proofUrl: "https://r2.example.com/a1",
    hasFinal: false,
    ...overrides,
  };
}

function makeFile(name: string): File {
  return new File(["fake-bytes"], name, { type: "image/jpeg" });
}

let onFinalUploaded: ReturnType<typeof vi.fn<(assetId: string) => void>>;

beforeEach(() => {
  onFinalUploaded = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FinalsBulkUploader", () => {
  it("renders nothing when there are no selected assets to map against", () => {
    const { container } = render(
      <FinalsBulkUploader selectedAssets={[]} onFinalUploaded={onFinalUploaded} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // TASK #220: the file picker's `accept` must match the server's own
  // format allowlist (`ACCEPTED_FINAL_FORMATS`, JPEG + PNG) exactly — a hint
  // for the OS file dialog, not the real gate (the server check is what
  // actually enforces it). #218 left this at `image/jpeg` only once already
  // and nothing caught it drifting from the server, which is exactly what
  // blocked the owner from selecting his own PNG finals even after the
  // server-side fix shipped; this assertion exists so that gap can't reopen
  // silently. MUTATION PROOF: reverting the input's `accept` back to
  // `"image/jpeg"` (or `"image/*"`) turns this test red.
  it("narrows the file picker's accept to the server's own format allowlist (JPEG + PNG)", () => {
    const asset = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader selectedAssets={[asset]} onFinalUploaded={onFinalUploaded} />);

    const input = document.querySelector("input[type=file]");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("accept")).toBe("image/jpeg,image/png");
  });

  it("shows the proposed mapping BEFORE uploading anything — no request goes out on file choice alone", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const asset = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[asset]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001-Edit.jpg")]);

    expect(await screen.findByText(/1 emparejada/)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows ambiguous pairings with their reason and does not count them toward matches", async () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001.jpg")]);

    expect(await screen.findByText(/0 emparejadas/)).toBeDefined();
    expect(await screen.findByText(/mismo nombre entre fotos elegidas/)).toBeDefined();
  });

  it("uploads matched files ONE AT A TIME: the second request is never sent while the first is still in flight", async () => {
    const firstCall = deferred<Response>();
    let finalCallCount = 0;
    const fetchMock = vi.fn(() => {
      finalCallCount++;
      return finalCallCount === 1 ? firstCall.promise : Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0002.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("DSC_0001.jpg"),
      makeFile("DSC_0002.jpg"),
    ]);
    await screen.findByText(/2 emparejadas/);

    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The second match must still be "En cola" — proves the loop awaits the
    // first request instead of firing both up front (a `Promise.all` would
    // have already issued call #2 by this point).
    expect(screen.getByText("En cola")).toBeDefined();

    firstCall.resolve(jsonResponse(200, {}));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onFinalUploaded).toHaveBeenCalledTimes(2));
  });

  it("a failed upload leaves its item in error and does not stop the rest of the batch", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(jsonResponse(409, { error: "asset_not_selected" }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0002.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("DSC_0001.jpg"),
      makeFile("DSC_0002.jpg"),
    ]);
    await screen.findByText(/2 emparejadas/);

    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));

    await waitFor(() => expect(screen.getByText("asset_not_selected")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Listo")).toBeDefined());

    // The failed first file never blocked the second: onFinalUploaded fired
    // exactly once, for the asset that actually succeeded.
    expect(onFinalUploaded).toHaveBeenCalledTimes(1);
    expect(onFinalUploaded).toHaveBeenCalledWith("a2");
  });

  it("calls onFinalUploaded once per successfully matched asset, with the right asset id", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001.jpg")]);
    await screen.findByText(/1 emparejada/);
    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));

    await waitFor(() => expect(onFinalUploaded).toHaveBeenCalledTimes(1));
    expect(onFinalUploaded).toHaveBeenCalledWith("a1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assets/a1/final",
      expect.objectContaining({ method: "POST" }),
    );
  });

  // Review-caught gap (#217 bloqueante 1): `handleConfirm` reads
  // `pendingFiles[match.fileIndex]`, NOT `pendingFiles[index]` — `index` is
  // the match's position within `plan.matches`, `fileIndex` is its position
  // within the ORIGINAL chosen-file list. The two only coincide when every
  // chosen file matched something, which every other test in this file
  // happens to set up. A stray unmatched file placed BEFORE the matching
  // ones is what makes them diverge — this is the ordinary shape of a real
  // batch (some exported extras, some leftovers), not a contrived edge case.
  it("uploads each match's own file, not the file sitting at that match's position — a stray unmatched file earlier in the list must not shift the pairing", async () => {
    const calls: { url: string; fileName: string | undefined }[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const formData = init!.body as FormData;
      const file = formData.get("file") as File | null;
      calls.push({ url: String(url), fileName: file?.name });
      return Promise.resolve(jsonResponse(200, {}));
    });
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0002.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0003.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("STRAY.jpg"),
      makeFile("DSC_0002.jpg"),
      makeFile("DSC_0003.jpg"),
    ]);
    await screen.findByText(/2 emparejadas/);

    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(calls).toEqual([
      { url: "/api/assets/a1/final", fileName: "DSC_0002.jpg" },
      { url: "/api/assets/a2/final", fileName: "DSC_0003.jpg" },
    ]);
  });

  // Review-caught gap (#217 secundario 5): when the SAME `originalFilename`
  // shows up more than once in an ambiguity's own asset list (the "two
  // memory cards" scenario, which trips BOTH `duplicate_asset_basename` and
  // `file_matches_multiple_assets` for the same file — see
  // final-filename-match.test.ts's own note on that), the message must not
  // repeat the identical name.
  it("de-duplicates a repeated asset name in the 'file matches multiple assets' message instead of showing it twice", async () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001.jpg")]);

    expect(
      await screen.findByText(
        "DSC_0001.jpg coincide con varias fotos elegidas que comparten el nombre DSC_0001.JPG.",
      ),
    ).toBeDefined();
    expect(screen.queryByText(/DSC_0001\.JPG, DSC_0001\.JPG/)).toBeNull();
    // The `duplicate_asset_basename` line renders directly ABOVE the one
    // asserted above, for this same file, and joins its names with " / "
    // rather than ", " — so the negative assertion on the comma-joined form
    // cannot see it. Re-review finding: without this line, dropping
    // `dedupeNames` from that arm alone leaves the whole suite green.
    expect(screen.queryByText(/DSC_0001\.JPG \/ DSC_0001\.JPG/)).toBeNull();
  });

  it("cancelling the proposed mapping clears it without uploading anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader selectedAssets={[a1]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001.jpg")]);
    await screen.findByText(/1 emparejada/);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByText(/emparejada/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
