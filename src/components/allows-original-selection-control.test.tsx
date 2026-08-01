// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AllowsOriginalSelectionControl } from "./allows-original-selection-control";
import type { UpdateAllowsOriginalSelectionState } from "@/app/dashboard/galleries/actions";

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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={0}
        selectedOriginalCount={0}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={0}
        selectedOriginalCount={0}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={5}
        selectedOriginalCount={0}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={5}
        selectedOriginalCount={0}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={12}
        selectedOriginalCount={3}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={12}
        selectedOriginalCount={3}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={12}
        selectedOriginalCount={1}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText(/1 foto original ya elegida vuelve a editada/)).toBeDefined();
  });

  it("only submits the action after the admin clicks confirm inside the dialog", async () => {
    updateAllowsOriginalSelectionMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(
      <AllowsOriginalSelectionControl
        galleryId={GALLERY_ID}
        allowsOriginalSelection={true}
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={12}
        selectedOriginalCount={3}
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
        includedPhotosSnapshot={13}
        extraPhotoPriceCopSnapshot={5_000}
        originalPhotoPriceCopSnapshot={2_000}
        selectedEditedCount={12}
        selectedOriginalCount={3}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Deshabilitar selección de originales" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar y apagar" }));

    await within(dialog).findByRole("alert");
    expect(within(dialog).getByText("La galería no existe.")).toBeDefined();
  });
});
