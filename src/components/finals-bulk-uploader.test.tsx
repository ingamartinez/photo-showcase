// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** The dropzone is the box holding the "Subir finales en lote" heading. */
function dropzone(): HTMLElement {
  return screen.getByText("Subir finales en lote").parentElement!;
}

/** `fireEvent.drop` without this init leaves `event.dataTransfer` undefined
 * in jsdom (there is no `DataTransfer` global), and the handler would throw. */
function dropPayload(files: File[]) {
  return { dataTransfer: { files } };
}

/** jsdom has no `DragEvent`, so `fireEvent.dragLeave(el, { relatedTarget })`
 * silently drops `relatedTarget` (verified: the event falls back to `Event`,
 * whose constructor ignores it) and React reads `nativeEvent.relatedTarget`.
 * Define it on the instance instead. */
function dragLeaveTo(box: HTMLElement, relatedTarget: Node | null) {
  const event = createEvent.dragLeave(box);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  fireEvent(box, event);
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
      <FinalsBulkUploader assets={[]} onFinalUploaded={onFinalUploaded} />,
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
    render(<FinalsBulkUploader assets={[asset]} onFinalUploaded={onFinalUploaded} />);

    const input = document.querySelector("input[type=file]");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("accept")).toBe("image/jpeg,image/png");
  });

  it("shows the proposed mapping BEFORE uploading anything — no request goes out on file choice alone", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const asset = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader assets={[asset]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001-Edit.jpg")]);

    expect(await screen.findByText(/1 emparejada/)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows ambiguous pairings with their reason and does not count them toward matches", async () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0001.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

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
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [makeFile("DSC_0001.jpg")]);
    await screen.findByText(/1 emparejada/);

    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(screen.queryByText(/emparejada/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // TASK #285 — drag & drop as the SECOND door into `handleFilesChosen`,
  // nothing more. Every test below exercises the outer box, which is the
  // element the photographer actually drops onto.

  // T1 — a drop proposes a plan instead of uploading. This is the whole
  // difference with flash-uploader.tsx's drop, which uploads directly.
  it("dropping a file opens the review screen and sends zero requests", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    fireEvent.drop(dropzone(), dropPayload([makeFile("DSC_0001.jpg")]));

    expect(await screen.findByText(/1 emparejada/)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T2 — criterion 1's "EXACTAMENTE el mismo plan": the same file set goes
  // through both doors and must render the identical review screen. The
  // ant vacuity anchors below are mandatory: comparing two strings proves
  // nothing unless the fixture actually exercises matches, extras, unmatched
  // files, assets without a file AND an ambiguity.
  it("a drop and the file picker produce the identical review screen for the same files", async () => {
    const assets = [
      makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG", isSelected: true }),
      makeAsset({ id: "a2", originalFilename: "DSC_0002.JPG", isSelected: false }),
      makeAsset({ id: "a3", originalFilename: "DSC_0003.JPG", isSelected: true }),
      makeAsset({ id: "a4", originalFilename: "DSC_0004.JPG", isSelected: true }),
      makeAsset({ id: "a5", originalFilename: "DSC_0004.JPG", isSelected: true }),
    ];
    const fileNames = ["DSC_0001.jpg", "DSC_0002.jpg", "DSC_0004.jpg", "STRAY.jpg"];
    const user = userEvent.setup();

    render(<FinalsBulkUploader assets={assets} onFinalUploaded={onFinalUploaded} />);
    await user.upload(
      screen.getByLabelText("Elegir archivos"),
      fileNames.map((name) => makeFile(name)),
    );
    await screen.findByText(/1 emparejada/);
    const chosen = dropzone().textContent!;

    cleanup();

    render(<FinalsBulkUploader assets={assets} onFinalUploaded={onFinalUploaded} />);
    fireEvent.drop(dropzone(), dropPayload(fileNames.map((name) => makeFile(name))));
    await screen.findByText(/1 emparejada/);
    const dropped = dropzone().textContent!;

    for (const screenText of [chosen, dropped]) {
      expect(screenText).toMatch(/1 emparejada/);
      expect(screenText).toMatch(/1 extra/);
      expect(screenText).toMatch(/Sin destino: STRAY\.jpg/);
      expect(screenText).toMatch(/Sin archivo: DSC_0003\.JPG/);
      expect(screenText).toMatch(/ambigüedad/);
    }
    expect(dropped).toBe(chosen);
  });

  // T3 — the dropped `File` objects reach `pendingFiles` intact and each
  // POST carries the file matched to that asset, not a filename or a
  // reordered position.
  it("uploading a dropped batch sends each asset its own matched file", async () => {
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
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    fireEvent.drop(
      dropzone(),
      dropPayload([makeFile("STRAY.jpg"), makeFile("DSC_0002.jpg"), makeFile("DSC_0003.jpg")]),
    );
    await screen.findByText(/2 emparejadas/);

    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(calls).toEqual([
      { url: "/api/assets/a1/final", fileName: "DSC_0002.jpg" },
      { url: "/api/assets/a2/final", fileName: "DSC_0003.jpg" },
    ]);
  });

  // T4 — dragging text or a URL yields zero files; it must not open an
  // empty review. `preventDefault` is asserted through the return value of
  // `fireEvent.drop` (`false` == cancelled), otherwise this test would pass
  // on a component with no handlers at all.
  it("a drop with no files opens nothing and is still cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    expect(fireEvent.drop(dropzone(), dropPayload([]))).toBe(false);

    expect(screen.queryByText(/emparejada/)).toBeNull();
    expect(screen.getByLabelText("Elegir archivos")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T5 — criterion 2 end to end: dragover cancels the browser's navigation
  // (else it opens the file and kills the page) and highlights; dragleave
  // and drop both clear it. Class assertions use exact tokens, not
  // substrings, so a `hover:border-accent` could not satisfy them.
  it("dragover cancels and highlights the box, and dragleave and drop clear the highlight", () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    const box = dropzone();
    expect(box.classList.contains("border-accent")).toBe(false);
    expect(box.classList.contains("bg-accent/5")).toBe(false);

    expect(fireEvent.dragOver(box)).toBe(false);
    expect(box.classList.contains("border-accent")).toBe(true);
    expect(box.classList.contains("bg-accent/5")).toBe(true);

    dragLeaveTo(box, document.body);
    expect(box.classList.contains("border-accent")).toBe(false);
    expect(box.classList.contains("bg-accent/5")).toBe(false);

    expect(fireEvent.dragOver(box)).toBe(false);
    expect(box.classList.contains("border-accent")).toBe(true);

    expect(fireEvent.drop(box, dropPayload([]))).toBe(false);
    expect(box.classList.contains("border-accent")).toBe(false);
    expect(box.classList.contains("bg-accent/5")).toBe(false);
  });

  // T6 — the box has several text children; moving the pointer onto one of
  // them fires `dragleave` on the box too. The guard must only clear when
  // the drag really left the box. Both directions asserted, so a guard that
  // never clears fails just as loudly as one that never holds.
  it("leaving the box onto one of its own children keeps the highlight on", () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    const box = dropzone();
    fireEvent.dragOver(box);
    expect(box.classList.contains("border-accent")).toBe(true);

    dragLeaveTo(box, screen.getByText("Subir finales en lote"));
    expect(box.classList.contains("border-accent")).toBe(true);

    dragLeaveTo(box, document.body);
    expect(box.classList.contains("border-accent")).toBe(false);
  });

  // T7 — criterion 3: a drop while the sequential loop is in flight changes
  // nothing, with `preventDefault` still called (a live drop handler that
  // navigates would kill the upload), and the finished batch's per-file list
  // survives a later drop.
  it("a drop during an in-flight upload changes nothing and does not navigate", async () => {
    const firstCall = deferred<Response>();
    const fetchMock = vi.fn(() => firstCall.promise);
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0002.JPG" });
    const user = userEvent.setup();
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    fireEvent.drop(dropzone(), dropPayload([makeFile("DSC_0001.jpg")]));
    await screen.findByText(/1 emparejada/);

    await user.click(screen.getByRole("button", { name: /Confirmar y subir/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const box = dropzone();
    expect(fireEvent.dragOver(box)).toBe(false);
    expect(box.classList.contains("border-accent")).toBe(false);

    expect(
      fireEvent.drop(box, dropPayload([makeFile("DSC_0001.jpg"), makeFile("DSC_0002.jpg")])),
    ).toBe(false);
    expect(screen.queryByText(/2 emparejadas/)).toBeNull();
    expect(screen.getByRole("button", { name: /Confirmar y subir 1/ })).toBeDefined();

    firstCall.resolve(jsonResponse(200, {}));
    await screen.findByText("Listo");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(fireEvent.drop(box, dropPayload([makeFile("DSC_0002.jpg")]))).toBe(false);
    expect(screen.getByText("Listo")).toBeDefined();
    expect(screen.getByText(/1 emparejada/)).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // T8 — decision 3.2: while the review screen is up the drop zone is
  // inert and unhighlighted, exactly like the file button, which does not
  // even exist in that state. A stray drop must never silently change what
  // is about to be confirmed.
  it("a drop while the review screen is visible is ignored and unhighlighted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    const a2 = makeAsset({ id: "a2", originalFilename: "DSC_0002.JPG" });
    render(<FinalsBulkUploader assets={[a1, a2]} onFinalUploaded={onFinalUploaded} />);

    fireEvent.drop(dropzone(), dropPayload([makeFile("DSC_0001.jpg")]));
    await screen.findByText(/1 emparejada/);

    const box = dropzone();
    expect(fireEvent.dragOver(box)).toBe(false);
    expect(box.classList.contains("border-accent")).toBe(false);

    expect(
      fireEvent.drop(box, dropPayload([makeFile("DSC_0001.jpg"), makeFile("DSC_0002.jpg")])),
    ).toBe(false);

    expect(screen.getByText(/1 emparejada/)).toBeDefined();
    expect(screen.queryByText(/2 emparejadas/)).toBeNull();
    expect(screen.getByRole("button", { name: /Confirmar y subir 1/ })).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T9 — criterion 5, markup only (jsdom never evaluates `pointer-coarse`,
  // so both spans are "visible" here; the media query itself is Tailwind's
  // native variant, already shipped by proof-uploader.tsx).
  it("offers the drag copy only on fine pointers and keeps touch copy free of it", () => {
    const a1 = makeAsset({ id: "a1", originalFilename: "DSC_0001.JPG" });
    render(<FinalsBulkUploader assets={[a1]} onFinalUploaded={onFinalUploaded} />);

    const desktopCopy = screen.getByText(/Arrastra/);
    expect(desktopCopy.classList.contains("pointer-coarse:hidden")).toBe(true);

    const touchCopy = screen.getByText(/Elige varios archivos exportados/);
    expect(touchCopy.classList.contains("hidden")).toBe(true);
    expect(touchCopy.classList.contains("pointer-coarse:block")).toBe(true);
    expect(touchCopy.textContent).not.toMatch(/arrastr/i);
  });
});
