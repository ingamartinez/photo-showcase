// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList } from "./selected-photos-list";

afterEach(cleanup);

const ITEMS = [
  { id: "1", originalFilename: "IMG_A1.jpg", selectedBy: "a", selectionKind: "edited" as const },
  { id: "2", originalFilename: "IMG_B1.jpg", selectedBy: "b", selectionKind: "edited" as const },
  { id: "3", originalFilename: "IMG_C1.jpg", selectedBy: "c", selectionKind: "edited" as const },
  {
    id: "4",
    originalFilename: "IMG_ORPHAN.jpg",
    selectedBy: null,
    selectionKind: "edited" as const,
  },
];
const LABEL = "Solo de quienes ya enviaron o quedaron bloqueados";

describe("SelectedPhotosList per-person filter", () => {
  it("lists everything by default and only the locked clients' picks once filtered", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} frozenPickerIds={["a", "c"]} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(4);

    await user.click(screen.getByLabelText(LABEL));

    const names = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(names).toEqual(["IMG_A1.jpg", "IMG_C1.jpg"]);
    expect(screen.getByText("Fotos seleccionadas (2)")).toBeDefined();
  });

  it("shows no filter when nobody is locked", () => {
    render(<SelectedPhotosList items={ITEMS} frozenPickerIds={[]} />);
    expect(screen.queryByLabelText(LABEL)).toBeNull();
  });
});
