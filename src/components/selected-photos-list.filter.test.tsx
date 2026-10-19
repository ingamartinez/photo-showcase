// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectedPhotosList, type SelectedPhotoListItem } from "./selected-photos-list";

afterEach(cleanup);

// Epic #250 / task #263. This file REPLACES the `frozenPickerIds` cases that
// lived here before ("only the picks of people who already sent"): decision 10
// made a submit an order that never locks, so no member is frozen any more and
// that checkbox no longer exists. What replaces it is the per-person filter
// over `pickers`, the list of everybody who SUBMITTED a pick — which is the
// only thing that can find a photo under a name that joined somebody else's
// unit.
const PEOPLE = [
  { id: "ana", label: "Ana" },
  { id: "beto", label: "Beto" },
  { id: "caro", label: "Caro" },
];

const ITEMS: SelectedPhotoListItem[] = [
  {
    id: "1",
    originalFilename: "IMG_A1.jpg",
    billedTo: "ana",
    pickers: ["ana"],
    selectionKind: "edited",
  },
  {
    id: "2",
    originalFilename: "IMG_B1.jpg",
    billedTo: "beto",
    pickers: ["beto", "ana"],
    selectionKind: "edited",
  },
  {
    id: "3",
    originalFilename: "IMG_C1.jpg",
    billedTo: "caro",
    pickers: ["caro"],
    selectionKind: "edited",
  },
  // A legacy unit: claimed, no recorded holder, and nobody's pick row (0017's
  // backfill). It must stay listable under "Todas" and under nobody else.
  {
    id: "4",
    originalFilename: "IMG_ORPHAN.jpg",
    billedTo: null,
    pickers: [],
    selectionKind: "edited",
  },
];

const listed = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[data-testid=photo-filename]")?.textContent);

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText(/^Fotos seleccionadas/));
}

describe("SelectedPhotosList per-person filter (#263)", () => {
  it("lists everything by default, and only one person's photos once filtered", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    expect(listed()).toHaveLength(4);

    await user.selectOptions(screen.getByLabelText("Persona"), "caro");

    expect(listed()).toEqual(["IMG_C1.jpg"]);
    expect(screen.getByText("Fotos seleccionadas (1)")).toBeDefined();
  });

  it("includes a photo somebody JOINED, not only the ones they hold", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    await user.selectOptions(screen.getByLabelText("Persona"), "ana");

    // IMG_B1 is Beto's unit; Ana joined it.
    expect(listed()).toEqual(["IMG_A1.jpg", "IMG_B1.jpg"]);
  });

  it("shows no person filter when there is a single person", async () => {
    render(<SelectedPhotosList items={ITEMS} people={[PEOPLE[0]!]} />);
    expect(screen.queryByLabelText("Persona")).toBeNull();
  });

  it("keeps a legacy unit with no holder and no pick under 'Todas'", async () => {
    const user = userEvent.setup();
    render(<SelectedPhotosList items={ITEMS} people={PEOPLE} />);
    await open(user);

    expect(listed()).toContain("IMG_ORPHAN.jpg");
    await user.selectOptions(screen.getByLabelText("Persona"), "caro");
    expect(listed()).not.toContain("IMG_ORPHAN.jpg");
  });
});
