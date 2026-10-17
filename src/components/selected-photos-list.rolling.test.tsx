// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList, type SelectedPhotoListItem } from "./selected-photos-list";

afterEach(cleanup);

// Task #244 — the photographer's work queue under rolling delivery. The people
// own DIFFERENT photos and finals exist for only some of them, so a filter that
// ignores the person, or treats "por enviar" as work, goes red.
const PEOPLE = [
  { id: "ana", label: "Ana" },
  { id: "beto", label: "Beto" },
];

function item(
  id: string,
  by: string,
  isRequested: boolean,
  hasFinal: boolean,
): SelectedPhotoListItem {
  return {
    id,
    originalFilename: `${id.toUpperCase()}.JPG`,
    selectionKind: "edited",
    selectedBy: by,
    isRequested,
    hasFinal,
  };
}

// Ana: ordered+edited, ordered+pending, still por enviar.
// Beto: ordered+pending, still por enviar.
const ITEMS = [
  item("a1", "ana", true, true),
  item("a2", "ana", true, false),
  item("a3", "ana", false, false),
  item("b1", "beto", true, false),
  item("b2", "beto", false, false),
];

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Fotos seleccionadas/));
}
const listed = () => screen.getAllByRole("listitem").map((li) => li.textContent);

describe("SelectedPhotosList — rolling delivery work queue (#244)", () => {
  it('"Solo pedidas sin editar" lists ordered photos with no final, never por-enviar ones', async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} rollingDelivery people={PEOPLE} />);
    await open(user);

    await user.click(screen.getByLabelText("Solo pedidas sin editar"));

    expect(listed()).toEqual(["A2.JPG", "B1.JPG"]);
  });

  it("filters by person and combines with the pending filter", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} rollingDelivery people={PEOPLE} />);
    await open(user);

    await user.selectOptions(screen.getByLabelText("Persona"), "beto");
    expect(listed()).toEqual(["B1.JPG", "B2.JPG"]);

    await user.click(screen.getByLabelText("Solo pedidas sin editar"));
    expect(listed()).toEqual(["B1.JPG"]);
  });

  it("flag off: no queue filters and every pick is listed", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    expect(screen.queryByLabelText("Solo pedidas sin editar")).toBeNull();
    expect(listed()).toHaveLength(5);
  });
});
