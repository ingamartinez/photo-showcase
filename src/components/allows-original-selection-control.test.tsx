// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllowsOriginalSelectionControl } from "./allows-original-selection-control";
import type { UpdateAllowsOriginalSelectionState } from "@/app/dashboard/galleries/actions";
import { previewOriginalsOff, type AssetRow } from "@/lib/pick-plans";

const updateAllowsOriginalSelectionMock =
  vi.fn<
    (
      state: UpdateAllowsOriginalSelectionState,
      formData: FormData,
    ) => Promise<UpdateAllowsOriginalSelectionState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  updateAllowsOriginalSelection: (...args: [UpdateAllowsOriginalSelectionState, FormData]) =>
    updateAllowsOriginalSelectionMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-18T00:00:00Z");

// The gallery terms this control's numbers are priced with — the frozen
// snapshots the page hands the planner.
const TERMS = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

/** One `assets` row as `planOriginalsOff` sees it. `billedTo` defaults to a
 * real holder because a claimed unit normally has one; the LEGACY row
 * (`billedTo: null`) is opted into explicitly below. */
function asset(id: string, selectionKind: "edited" | "original", extra: Partial<AssetRow> = {}) {
  return {
    id,
    isSelected: true,
    selectionKind,
    billedTo: "u1",
    billedAt: null,
    finalKey: null,
    selectedAt: null,
    requestedAt: null,
    ...extra,
  } satisfies AssetRow;
}

const edited = (count: number) =>
  Array.from({ length: count }, (_unused, index) => asset(`e${index}`, "edited"));

const originals = (count: number, extra: (index: number) => Partial<AssetRow> = () => ({})) =>
  Array.from({ length: count }, (_unused, index) => asset(`o${index}`, "original", extra(index)));

/** The prop the page passes: the SAME planner `updateAllowsOriginalSelection`
 * runs, so what this suite proves is what the dialog will really promise. */
const preview = (rows: AssetRow[]) => previewOriginalsOff(rows, NOW, TERMS);

afterEach(() => {
  cleanup();
  updateAllowsOriginalSelectionMock.mockReset();
});

describe("AllowsOriginalSelectionControl — switch is OFF", () => {
  it("shows an enable button and no dialog", () => {
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={false}
        originalsOff={preview([])}
      />,
    );

    expect(screen.getByRole("button", { name: "Habilitar selección de originales" })).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits the gallery id and true directly, with no confirmation step", async () => {
    updateAllowsOriginalSelectionMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={false}
        originalsOff={preview([])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Habilitar selección de originales" }));

    const [, formData] = updateAllowsOriginalSelectionMock.mock.calls[0] as [
      UpdateAllowsOriginalSelectionState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("allowsOriginalSelection")).toBe("true");
  });
});

describe("AllowsOriginalSelectionControl — switch is ON, nothing to reset", () => {
  it("shows a disable button and no dialog when there are zero originals", () => {
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview(edited(5))}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Deshabilitar selección de originales" }),
    ).toBeDefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("submits false directly, with no confirmation step, when there is nothing to reset", async () => {
    updateAllowsOriginalSelectionMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview(edited(5))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));

    const [, formData] = updateAllowsOriginalSelectionMock.mock.calls[0] as [
      UpdateAllowsOriginalSelectionState,
      FormData,
    ];
    expect(formData.get("allowsOriginalSelection")).toBe("false");
  });
});

// Task #214's own owner decision: turning off with originals ALREADY picked
// shows a before/after preview first, and only applies on confirm.
describe("AllowsOriginalSelectionControl — switch is ON, originals already picked", () => {
  it("opens a confirmation dialog instead of submitting directly", async () => {
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([...edited(12), ...originals(3)])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));

    expect(await screen.findByRole("dialog")).toBeDefined();
    // Opening the dialog must NOT itself have applied anything — the whole
    // point of the confirmation step.
    expect(updateAllowsOriginalSelectionMock).not.toHaveBeenCalled();
  });

  // computeQuota(12, 3, {13, 5000, 2000}) => extras 0 (12 < 13), originals 3,
  // originalsSurchargeCop 6_000, surchargeCop 6_000. After the reset: 15
  // edited, 0 originals => extras 2 (15 - 13), surchargeCop 10_000. This is
  // the owner's own example shape: "N fotos vuelven a editada · el recargo
  // baja de $ X a $ Y".
  it("shows the before/after preview with the real numbers, computed via computeQuota", async () => {
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([...edited(12), ...originals(3)])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");

    expect(
      within(dialog).getByText("Hoy: 12 editadas · 3 originales · recargo $ 6.000"),
    ).toBeDefined();
    expect(
      within(dialog).getByText("Al confirmar: 15 editadas · 0 originales · recargo $ 10.000"),
    ).toBeDefined();
  });

  it("names the exact count of photos that revert to edited, singular when exactly one", async () => {
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([...edited(12), ...originals(1)])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/1 foto original ya elegida vuelve a editada/)).toBeDefined();
  });

  // Task #263 / decision 15: an original that already has a final CANNOT be
  // re-labelled (`planOriginalsOff` skips it), so "Al confirmar" must not
  // promise a literal 0 originals. That literal was the pre-#263 bug — this
  // case goes red against it (the old code would render "15 editadas · 0
  // originales · recargo $ 10.000" here instead of "14 editadas · 1 original
  // · recargo $ 7.000").
  it("keeps the FINAL-FROZEN originals in the 'Al confirmar' row instead of hardcoding 0", async () => {
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([
          ...edited(12),
          ...originals(3, (index) =>
            index === 0 ? { finalKey: "galleries/g1/finals/o0.jpg" } : {},
          ),
        ])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");

    // 2 of the 3 revert to edited (12 + 2 = 14), 1 stays original.
    // computeQuota(14, 1, {13, 5000, 2000}): extras 1 -> 5.000 + 2.000 = 7.000.
    expect(
      within(dialog).getByText("Al confirmar: 14 editadas · 1 original · recargo $ 7.000"),
    ).toBeDefined();
    // ...and the sentence names only the two that really revert.
    expect(
      within(dialog).getByText(/2 fotos originales ya elegidas vuelven a editadas/),
    ).toBeDefined();
  });

  // Task #263 fix round (W1). `planOriginalsOff` skips TWO kinds of claimed
  // original: one with a final (decision 15) and a LEGACY one with no recorded
  // holder (`reresolveClaim` rule 2 — never invent or remove the basis of a
  // legacy unit). The first fix counted only the final-frozen ones, so the
  // dialog promised the legacy unit as reverted while the write left it
  // `original`. The numbers below are the planner's, by construction: only ONE
  // of the three originals reverts.
  it("does not promise the LEGACY original with no holder as reverted either", async () => {
    const user = userEvent.setup();
    const rows = [
      ...edited(12),
      ...originals(3, (index) =>
        index === 0
          ? { finalKey: "galleries/g1/finals/o0.jpg" }
          : index === 1
            ? { billedTo: null }
            : {},
      ),
    ];
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview(rows)}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");

    // 12 + 1 = 13 edited, 2 still original (frozen + legacy).
    // computeQuota(13, 2, {13, 5000, 2000}): extras 0, 2 originales -> 4.000.
    expect(
      within(dialog).getByText("Al confirmar: 13 editadas · 2 originales · recargo $ 4.000"),
    ).toBeDefined();
    expect(within(dialog).getByText(/1 foto original ya elegida vuelve a editada/)).toBeDefined();
  });

  it("only submits the action after the admin clicks confirm inside the dialog", async () => {
    updateAllowsOriginalSelectionMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([...edited(12), ...originals(3)])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");
    expect(updateAllowsOriginalSelectionMock).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirmar y apagar" }));

    const [, formData] = updateAllowsOriginalSelectionMock.mock.calls[0] as [
      UpdateAllowsOriginalSelectionState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("allowsOriginalSelection")).toBe("false");
  });

  it("shows the server's error message inside the dialog on failure", async () => {
    updateAllowsOriginalSelectionMock.mockResolvedValue({
      status: "error",
      message: "La galería no existe.",
    });
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        originalsOff={preview([...edited(12), ...originals(3)])}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar y apagar" }));

    await within(dialog).findByRole("alert");
    expect(within(dialog).getByText("La galería no existe.")).toBeDefined();
  });
});
