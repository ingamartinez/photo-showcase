// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList, type SelectedPhotoListItem } from "./selected-photos-list";

afterEach(cleanup);

// Task #245 — two pickers, both kinds, interleaved so that a row reading the
// wrong picker/kind (an index-vs-index mix-up) cannot pass by coincidence.
//
// Task #263: the row is driven by `billedTo` (the unit's holder) plus the
// LIST of people who asked. IMG_3 is Ana's unit that Beto joined, so it must
// read "Ana +1" — reading `pickers[0]` or the joiner's name instead is the
// bug this pins.
const PEOPLE = [
  { id: "ana", label: "Ana" },
  { id: "beto", label: "beto@x.co" },
];
const ITEMS: SelectedPhotoListItem[] = [
  {
    id: "1",
    originalFilename: "IMG_1.JPG",
    selectionKind: "edited",
    billedTo: "ana",
    pickers: ["ana"],
  },
  {
    id: "2",
    originalFilename: "IMG_2.JPG",
    selectionKind: "original",
    billedTo: "beto",
    pickers: ["beto"],
  },
  {
    id: "3",
    originalFilename: "IMG_3.JPG",
    selectionKind: "edited",
    billedTo: "ana",
    pickers: ["ana", "beto"],
  },
  {
    id: "4",
    originalFilename: "IMG_4.JPG",
    selectionKind: "original",
    billedTo: "ana",
    pickers: ["ana"],
  },
  { id: "5", originalFilename: "IMG_5.JPG", selectionKind: "edited", billedTo: null, pickers: [] },
  {
    id: "6",
    originalFilename: "IMG_6.JPG",
    selectionKind: "edited",
    billedTo: "ghost",
    pickers: ["ghost"],
  },
];

describe("SelectedPhotosList — attribution (#245)", () => {
  it("shows each filename next to its own picker and kind, without rolling delivery", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await user.click(screen.getByText(/^Fotos seleccionadas/));

    const rows = Object.fromEntries(
      screen
        .getAllByRole("listitem")
        .map((li) => [
          li.querySelector("[data-testid=photo-filename]")?.textContent,
          li.querySelector("[data-testid=photo-attribution]")?.textContent,
        ]),
    );
    expect(rows).toEqual({
      "IMG_1.JPG": "Ana · Editada",
      "IMG_2.JPG": "beto@x.co · Original",
      // Two people asked: the holder is named, the joiner is counted.
      "IMG_3.JPG": "Ana +1 · Editada",
      "IMG_4.JPG": "Ana · Original",
      "IMG_5.JPG": "Editada",
      // An unknown id never renders as a bare uuid.
      "IMG_6.JPG": "Editada",
    });
  });

  it("copies filenames only, never the attribution", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await user.click(screen.getByText(/^Fotos seleccionadas/));

    const [editedButton, originalButton] = screen.getAllByRole("button", { name: "Copiar" });
    await user.click(editedButton);
    expect(writeText).toHaveBeenLastCalledWith("IMG_1.JPG\nIMG_3.JPG\nIMG_5.JPG\nIMG_6.JPG");
    await user.click(originalButton);
    expect(writeText).toHaveBeenLastCalledWith("IMG_2.JPG\nIMG_4.JPG");
  });
});
