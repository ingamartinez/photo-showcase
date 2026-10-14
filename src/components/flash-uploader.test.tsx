// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlashUploader } from "./flash-uploader";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const FLASH_ID = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = `/api/flash/${FLASH_ID}/assets`;

function makeFile(name: string): File {
  return new File([`bytes-of-${name}`], name, { type: "image/jpeg" });
}

function okResponse(): Response {
  return { ok: true, status: 201, json: async () => ({}) } as Response;
}

/** The dropzone is the box that holds the "Subir fotos" heading. */
function dropzone(): HTMLElement {
  return screen.getByText("Subir fotos").parentElement!;
}

function dropPayload(files: File[]) {
  return { dataTransfer: { files } };
}

/** File names of every POST, in the order they were sent. */
function postedNames(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([, init]) => ((init as RequestInit).body as FormData).get("file") as File)
    .map((file) => file.name);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refreshMock.mockClear();
  fetchMock = vi.fn(() => Promise.resolve(okResponse()));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlashUploader dropzone", () => {
  it("dropping files uploads each one, in order, with its own file in its own POST", async () => {
    render(<FlashUploader flashGalleryId={FLASH_ID} />);

    fireEvent.drop(
      dropzone(),
      dropPayload([makeFile("alpha.jpg"), makeFile("beta.jpg"), makeFile("gamma.jpg")]),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.every(([url]) => url === ENDPOINT)).toBe(true);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === "POST")).toBe(
      true,
    );
    expect(postedNames(fetchMock)).toEqual(["alpha.jpg", "beta.jpg", "gamma.jpg"]);
    await waitFor(() => expect(screen.getByText("3 de 3 subidas")).toBeTruthy());
  });

  it("the file picker button still uploads the chosen files the same way", async () => {
    const user = userEvent.setup();
    render(<FlashUploader flashGalleryId={FLASH_ID} />);

    await user.upload(document.querySelector("input[type=file]")!, [
      makeFile("one.jpg"),
      makeFile("two.jpg"),
    ]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(postedNames(fetchMock)).toEqual(["one.jpg", "two.jpg"]);
  });

  it("dragover cancels the browser default and highlights the box; dragleave and drop clear it", async () => {
    render(<FlashUploader flashGalleryId={FLASH_ID} />);
    const box = dropzone();
    expect(box.className).not.toContain("border-accent");

    // fireEvent returns false when the handler called preventDefault().
    expect(fireEvent.dragOver(box)).toBe(false);
    expect(box.className).toContain("border-accent");

    fireEvent.dragLeave(box);
    expect(box.className).not.toContain("border-accent");

    fireEvent.dragOver(box);
    expect(box.className).toContain("border-accent");
    expect(fireEvent.drop(box, dropPayload([makeFile("a.jpg")]))).toBe(false);
    expect(box.className).not.toContain("border-accent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("a drop while an upload is in flight sends no new POST and does not replace the list", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    render(<FlashUploader flashGalleryId={FLASH_ID} />);

    fireEvent.drop(dropzone(), dropPayload([makeFile("first.jpg")]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.dragOver(dropzone());
    expect(dropzone().className).not.toContain("border-accent");
    fireEvent.drop(dropzone(), dropPayload([makeFile("second.jpg"), makeFile("third.jpg")]));

    release(okResponse());
    await waitFor(() => expect(screen.getByText("1 de 1 subidas")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedNames(fetchMock)).toEqual(["first.jpg"]);
    expect(screen.queryByText("second.jpg")).toBeNull();
  });
});
