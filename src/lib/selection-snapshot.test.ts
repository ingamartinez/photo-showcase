import { describe, expect, it } from "vitest";
import {
  pickerLabelFor,
  UNATTRIBUTED_PICKER_LABEL,
  type SelectionPicker,
} from "@/lib/selection-snapshot";

function picker(overrides: Partial<SelectionPicker> = {}): SelectionPicker {
  return { id: "client-a", label: "Ana Pérez", ...overrides };
}

describe("pickerLabelFor", () => {
  it("names another client by the label the server resolved", () => {
    expect(pickerLabelFor(picker({ id: "client-b", label: "Beto Ruiz" }), "client-a")).toBe(
      "Beto Ruiz",
    );
  });

  it("renders the viewer's OWN pick as 'Vos', not their own name", () => {
    // The distinction the tray exists to draw is "me vs. one of the others" —
    // seeing your own name attributed back at you is noise.
    expect(pickerLabelFor(picker({ id: "client-a", label: "Ana Pérez" }), "client-a")).toBe("Vos");
  });

  it("falls back to the server's label when there is no viewer id at all", () => {
    expect(pickerLabelFor(picker(), null)).toBe("Ana Pérez");
  });

  it("says so plainly, rather than guessing a name, when a pick has no attribution", () => {
    // Reachable two ways, both honest: a pick made before task #94 added
    // `assets.selected_by`, and a picker whose `users` row was later deleted
    // (`onDelete: "set null"`).
    expect(pickerLabelFor(null, "client-a")).toBe(UNATTRIBUTED_PICKER_LABEL);
    expect(pickerLabelFor(null, null)).toBe(UNATTRIBUTED_PICKER_LABEL);
  });

  it("never credits the viewer for a pick that merely shares their label", () => {
    // Identity is the id, never the display string — two people can share a
    // name, and "Vos" next to somebody else's pick is the one wrong answer
    // this function must not give.
    expect(pickerLabelFor(picker({ id: "client-b", label: "Ana Pérez" }), "client-a")).toBe(
      "Ana Pérez",
    );
  });
});
