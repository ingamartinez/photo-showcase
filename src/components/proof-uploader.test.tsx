// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProofUploader } from "./proof-uploader";
import type { WorkspaceAsset } from "./gallery-workspace";

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** A promise the test controls the resolution of, so it can assert nothing
 * else happened WHILE a request is still in flight — the only way to prove
 * "sequential, not just eventually-in-order" (task #20's acceptance
 * criterion) against a mocked `fetch`, since resolved-in-call-order alone
 * would look identical whether the component awaits each request or fires
 * them all at once. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFile(name: string): File {
  return new File(["fake-bytes"], name, { type: "image/jpeg" });
}

let onUploaded: ReturnType<typeof vi.fn<(asset: WorkspaceAsset) => void>>;

beforeEach(() => {
  onUploaded = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProofUploader", () => {
  it("uploads files ONE AT A TIME: the second request is never sent while the first is still in flight", async () => {
    const firstProofsCall = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/proofs")) {
        return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/proofs")).length === 1
          ? firstProofsCall.promise
          : Promise.resolve(
              jsonResponse(201, {
                asset: {
                  id: "a2",
                  proofKey: "galleries/g1/proofs/a2.webp",
                  width: 1600,
                  height: 1067,
                  sortOrder: 1,
                  originalFilename: "b.jpg",
                },
              }),
            );
      }
      // GET /api/assets/{id}/proof
      return Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/presigned" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ProofUploader galleryId={GALLERY_ID} onUploaded={onUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("a.jpg"),
      makeFile("b.jpg"),
    ]);

    // Only the first file's request has been sent — the second file is
    // still "En cola" (pending), proving the loop awaits each request
    // before starting the next one, not firing all of them up front.
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/proofs"))).toHaveLength(1);
    });
    expect(screen.getByText("b.jpg").nextSibling?.textContent).toBe("En cola");

    // Resolve the first request — only now should the second one start.
    firstProofsCall.resolve(
      jsonResponse(201, {
        asset: {
          id: "a1",
          proofKey: "galleries/g1/proofs/a1.webp",
          width: 1600,
          height: 1067,
          sortOrder: 0,
          originalFilename: "a.jpg",
        },
      }),
    );

    await waitFor(() => {
      expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/proofs"))).toHaveLength(2);
    });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2));
  });

  it("reports one failed file as failed while the rest of the batch still succeeds", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/proofs")) {
        const isFirstUpload =
          fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/proofs")).length === 1;
        if (isFirstUpload) {
          return Promise.resolve(jsonResponse(422, { error: "processing_failed" }));
        }
        return Promise.resolve(
          jsonResponse(201, {
            asset: {
              id: "a2",
              proofKey: "galleries/g1/proofs/a2.webp",
              width: 1600,
              height: 1067,
              sortOrder: 0,
              originalFilename: "good.jpg",
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse(200, { url: "https://r2.example.com/presigned" }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ProofUploader galleryId={GALLERY_ID} onUploaded={onUploaded} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("bad.jpg"),
      makeFile("good.jpg"),
    ]);

    await waitFor(() => expect(screen.getByText("processing_failed")).toBeDefined());
    await waitFor(() => expect(screen.getByText("Lista")).toBeDefined());

    // The one-bad-file failure never stopped the batch: the second (good)
    // file was still uploaded and reported via onUploaded exactly once.
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(onUploaded).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a2", originalFilename: "good.jpg" }),
    );
  });
});
