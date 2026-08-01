// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelectionTrayModeControl } from "./selection-tray-mode-control";
import type { UpdateSelectionTrayModeState } from "@/app/dashboard/galleries/actions";

const updateSelectionTrayModeMock =
  vi.fn<
    (
      state: UpdateSelectionTrayModeState,
      formData: FormData,
    ) => Promise<UpdateSelectionTrayModeState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  updateSelectionTrayMode: (...args: [UpdateSelectionTrayModeState, FormData]) =>
    updateSelectionTrayModeMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  updateSelectionTrayModeMock.mockReset();
});

describe("SelectionTrayModeControl", () => {
  it("starts on the gallery's current mode", () => {
    render(<SelectionTrayModeControl galleryId={GALLERY_ID} selectionTrayMode="by-person" />);

    expect(screen.getByLabelText<HTMLSelectElement>("Bandeja de elegidas").value).toBe("by-person");
  });

  it("submits the gallery id and the newly picked mode", async () => {
    updateSelectionTrayModeMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(<SelectionTrayModeControl galleryId={GALLERY_ID} selectionTrayMode="flat" />);

    await user.selectOptions(screen.getByLabelText("Bandeja de elegidas"), "Agrupada por persona");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const [, formData] = updateSelectionTrayModeMock.mock.calls[0] as [
      UpdateSelectionTrayModeState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("selectionTrayMode")).toBe("by-person");
  });

  it("shows a success message once saved", async () => {
    updateSelectionTrayModeMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(<SelectionTrayModeControl galleryId={GALLERY_ID} selectionTrayMode="flat" />);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Modo actualizado.")).toBeDefined();
  });

  it("surfaces the server's error message instead of silently doing nothing", async () => {
    updateSelectionTrayModeMock.mockResolvedValue({
      status: "error",
      message: "La galería no existe.",
    });
    const user = userEvent.setup();
    render(<SelectionTrayModeControl galleryId={GALLERY_ID} selectionTrayMode="flat" />);

    await user.click(screen.getByRole("button", { name: "Guardar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("La galería no existe.");
  });
});
