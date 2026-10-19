// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList, type SelectedPhotoListItem } from "./selected-photos-list";

afterEach(cleanup);

// Epic #250 / task #263 — the photographer's work queue.
//
// Replaces selected-photos-list.rolling.test.tsx (deleted). Two things changed
// and both are load-bearing here:
//   - the pending filter is UNCONDITIONAL (decision 11 made the order
//     semantics mandatory, so there is no rolling_delivery flag to gate it),
//     and its predicate is `!hasFinal` — the deliver gate's own rule, on a
//     list every item of which is claimed;
//   - the person filter reads `pickers`, a LIST, not `selectedBy`: Beto JOINED
//     Ana's photo, so filtering by Beto must find it even though Ana holds it.
const PEOPLE = [
  { id: "ana", label: "Ana" },
  { id: "beto", label: "Beto" },
];

function item(
  id: string,
  billedTo: string,
  pickers: string[],
  hasFinal: boolean,
): SelectedPhotoListItem {
  return {
    id,
    originalFilename: `${id.toUpperCase()}.JPG`,
    selectionKind: "edited",
    billedTo,
    pickers,
    hasFinal,
  };
}

// Ana: one photo with a final she holds alone, one still pending, one that
// BETO joined (no final). Beto: one pending photo of his own.
const ITEMS = [
  item("x1", "ana", ["ana"], true),
  item("x2", "ana", ["ana"], false),
  item("x3", "ana", ["ana", "beto"], false),
  item("y1", "beto", ["beto"], false),
];

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Fotos seleccionadas/));
}
const listed = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[data-testid=photo-filename]")?.textContent);

describe("SelectedPhotosList — the work queue (#263)", () => {
  it('"Pendientes de subir editada" lists exactly the claimed photos with no final, with no flag', async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    // No `rollingDelivery` prop exists any more: this filter is not a feature
    // the admin turns on, it is what the list is for.
    await user.click(screen.getByLabelText("Pendientes de subir editada"));

    expect(listed()).toEqual(["X2.JPG", "X3.JPG", "Y1.JPG"]);
  });

  it("filters by person over `pickers`, so a JOINED photo is found under the joiner's name", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    await user.selectOptions(screen.getByLabelText("Persona"), "beto");

    // X3 is Ana's unit — Beto only joined it — and it must be listed anyway.
    expect(listed()).toEqual(["X3.JPG", "Y1.JPG"]);
  });

  it("combines the person filter with the pending filter", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    await user.selectOptions(screen.getByLabelText("Persona"), "ana");
    expect(listed()).toEqual(["X1.JPG", "X2.JPG", "X3.JPG"]);

    await user.click(screen.getByLabelText("Pendientes de subir editada"));
    expect(listed()).toEqual(["X2.JPG", "X3.JPG"]);
  });

  it("shows no person filter when there is only one person to filter by", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={[PEOPLE[0]!]} />);
    await open(user);

    expect(screen.queryByLabelText("Persona")).toBeNull();
    // ...but the pending filter is still there — it is not conditional on people.
    expect(screen.getByLabelText("Pendientes de subir editada")).toBeDefined();
    expect(listed()).toHaveLength(4);
  });
});
