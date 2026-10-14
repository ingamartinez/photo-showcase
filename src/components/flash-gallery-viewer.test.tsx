// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlashGalleryViewer } from "./flash-gallery-viewer";

const ASSETS = [
  { id: "a1", originalFilename: "IMG_0001.JPG" },
  { id: "a2", originalFilename: "IMG_0002.JPG" },
  { id: "a3", originalFilename: "IMG_0003.JPG" },
];

function setup() {
  return render(<FlashGalleryViewer publicSlug="abc123" assets={ASSETS} />);
}

function href(element: HTMLElement) {
  return element.getAttribute("href");
}

function viewerSrc(dialog: HTMLElement) {
  return within(dialog).getByRole("img").getAttribute("src");
}

afterEach(cleanup);

describe("<FlashGalleryViewer> grid", () => {
  it("renders the delivered grid: 2 columns on mobile, same gap and tiles in the given order", () => {
    const { container } = setup();
    const list = container.querySelector("ul");
    expect(list?.className).toContain("grid-cols-2");
    expect(list?.className).toContain("gap-[2px]");
    expect(list?.className).toContain("sm:grid-cols-3");
    expect(list?.className).toContain("lg:grid-cols-4");
    const tiles = screen.getAllByRole("button", { name: /^Ver / });
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Ver IMG_0001.JPG",
      "Ver IMG_0002.JPG",
      "Ver IMG_0003.JPG",
    ]);
    const srcs = Array.from(container.querySelectorAll("li img")).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      "/flash/abc123/display/a1",
      "/flash/abc123/display/a2",
      "/flash/abc123/display/a3",
    ]);
  });

  it("points 'Descargar todo' at the flash zip route, not a normal-gallery route", () => {
    setup();
    expect(href(screen.getByRole("link", { name: "Descargar todo" }))).toBe("/flash/abc123/zip");
  });

  it("renders no selection controls at all", () => {
    setup();
    expect(
      screen.queryByRole("button", { name: /Seleccionar|Quitar de seleccionadas/ }),
    ).toBeNull();
    expect(screen.queryByText(/elegidas|incluidas/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Editada|Original/ })).toBeNull();
  });
});

describe("<FlashGalleryViewer> viewer", () => {
  it("opens at the tapped photo, not at the first", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Ver IMG_0002.JPG" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("2 / 3")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "IMG_0002.JPG" })).toBeTruthy();
    expect(viewerSrc(dialog)).toBe("/flash/abc123/display/a2");
  });

  it("walks next and previous through every photo and stops at both edges", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    const dialog = screen.getByRole("dialog");
    const prev = within(dialog).getByRole("button", { name: "Foto anterior" });
    const next = within(dialog).getByRole("button", { name: "Foto siguiente" });
    expect((prev as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(next);
    expect(within(dialog).getByText("2 / 3")).toBeTruthy();
    expect(viewerSrc(dialog)).toBe("/flash/abc123/display/a2");
    await userEvent.click(next);
    expect(within(dialog).getByText("3 / 3")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "IMG_0003.JPG" })).toBeTruthy();
    expect((next as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(prev);
    expect(within(dialog).getByText("2 / 3")).toBeTruthy();
    expect(viewerSrc(dialog)).toBe("/flash/abc123/display/a2");
  });

  it("navigates with the arrow keys and ignores them at the edges", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Ver IMG_0003.JPG" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(within(dialog).getByText("3 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(dialog).getByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(dialog).getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(within(dialog).getByText("1 / 3")).toBeTruthy();
  });

  it("points the download at the CURRENT photo's flash final route, per photo", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    const dialog = screen.getByRole("dialog");
    expect(href(within(dialog).getByRole("link", { name: "Descargar: IMG_0001.JPG" }))).toBe(
      "/flash/abc123/final/a1",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Foto siguiente" }));
    expect(href(within(dialog).getByRole("link", { name: "Descargar: IMG_0002.JPG" }))).toBe(
      "/flash/abc123/final/a2",
    );
    expect(within(dialog).queryByRole("link", { name: "Descargar: IMG_0001.JPG" })).toBeNull();
  });

  it("closes back to the grid", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Ver IMG_0002.JPG" }));
    await userEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Ver / })).toHaveLength(3);
  });

  it("renders no pick control or quota line inside the viewer", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "Ver IMG_0001.JPG" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/Elegir esta foto|Elegida|elegidas/)).toBeNull();
    expect(within(dialog).queryByRole("group")).toBeNull();
  });
});

describe("<FlashGalleryViewer> empty", () => {
  it("renders nothing for an empty gallery", () => {
    const { container } = render(<FlashGalleryViewer publicSlug="abc123" assets={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
