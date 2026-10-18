import { describe, expect, expectTypeOf, it } from "vitest";
import {
  claimedEntries,
  pickerLabelFor,
  viewerPickOf,
  UNATTRIBUTED_PICKER_LABEL,
  type SelectionEntry,
  type SelectionPickState,
  type SelectionPicker,
} from "@/lib/selection-snapshot";
import type { PickStatus } from "@/lib/pick-resolution";

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

function entry(assetId: string, userId: string | null, submittedAt: string | null): SelectionEntry {
  return {
    assetId,
    claim:
      userId === null
        ? null
        : {
            claimedAt: "2026-10-01T12:00:00.000Z",
            resolvedKind: "edited",
            billedTo: { id: userId, label: userId },
            charge: "included",
          },
    picks:
      userId === null
        ? []
        : [
            {
              userId,
              label: userId,
              kind: "edited",
              pickedAt: "2026-10-01T12:00:00.000Z",
              submittedAt,
              state: submittedAt ? "billed" : "degraded",
            },
          ],
  };
}

describe("claimedEntries", () => {
  it("keeps only claimed entries, in the server's order", () => {
    const entries = [
      entry("a1", "ana", "2026-10-01T12:00:00.000Z"),
      entry("a2", null, null),
      entry("a3", "beto", "2026-10-01T12:00:00.000Z"),
    ];

    expect(claimedEntries(entries).map((e) => e.assetId)).toEqual(["a1", "a3"]);
  });

  it("never counts anything — it is a filter, not a tally", () => {
    expect(claimedEntries([])).toEqual([]);
  });
});

describe("viewerPickOf", () => {
  it("finds the viewer's own pick by id, never by label", () => {
    const e = entry("a1", "ana", "2026-10-01T12:00:00.000Z");
    e.picks.push({
      userId: "beto",
      label: "ana",
      kind: "edited",
      pickedAt: "2026-10-01T12:00:00.000Z",
      submittedAt: null,
      state: "degraded",
    });

    expect(viewerPickOf(e, "beto")?.userId).toBe("beto");
    expect(viewerPickOf(e, "ana")?.userId).toBe("ana");
  });

  it("returns null for no viewer, or a viewer with no pick", () => {
    expect(viewerPickOf(entry("a1", "ana", null), null)).toBeNull();
    expect(viewerPickOf(entry("a1", "ana", null), "caro")).toBeNull();
  });
});

describe("type parity", () => {
  it("SelectionPickState is exactly PickStatus", () => {
    expectTypeOf<SelectionPickState>().toEqualTypeOf<PickStatus>();
  });
});
