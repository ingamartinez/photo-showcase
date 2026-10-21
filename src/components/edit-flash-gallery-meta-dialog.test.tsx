// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditFlashGalleryMetaDialog } from "./edit-flash-gallery-meta-dialog";
import type { UpdateFlashGalleryMetaState } from "@/app/dashboard/flash/actions";

const updateFlashGalleryMetaMock =
  vi.fn<
    (state: UpdateFlashGalleryMetaState, formData: FormData) => Promise<UpdateFlashGalleryMetaState>
  >();

vi.mock("@/app/dashboard/flash/actions", () => ({
  updateFlashGalleryMeta: (...args: [UpdateFlashGalleryMetaState, FormData]) =>
    updateFlashGalleryMetaMock(...args),
}));

const FLASH_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  updateFlashGalleryMetaMock.mockReset();
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Editar" }));
  return screen.findByRole("dialog");
}

function renderDialog(overrides: Partial<Parameters<typeof EditFlashGalleryMetaDialog>[0]> = {}) {
  return render(
    <EditFlashGalleryMetaDialog
      flashGalleryId={FLASH_ID}
      title="Cumpleaños de Sofía"
      sessionDate="2026-10-18"
      {...overrides}
    />,
  );
}

describe("EditFlashGalleryMetaDialog — fields", () => {
  it("pre-fills the title and date with the gallery's current values", async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);

    // No jest-dom is wired into this Vitest setup, so `.value` off the DOM
    // node is the honest equivalent (same reasoning as the terms-dialog test).
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe(
      "Cumpleaños de Sofía",
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>("Fecha (opcional)").value).toBe(
      "2026-10-18",
    );
  });

  it("renders a null date as empty, leaves it optional, and keeps the title required with a 200 cap", async () => {
    const user = userEvent.setup();
    renderDialog({ sessionDate: null });

    const dialog = await openDialog(user);

    const title = within(dialog).getByLabelText<HTMLInputElement>("Título");
    const date = within(dialog).getByLabelText<HTMLInputElement>("Fecha (opcional)");
    expect(date.value).toBe("");
    expect(date.required).toBe(false);
    expect(title.required).toBe(true);
    expect(title.maxLength).toBe(200);
  });

  it("submits the gallery id, the typed title and the date under the action's field names", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog({ sessionDate: null });

    const dialog = await openDialog(user);
    const title = within(dialog).getByLabelText("Título");
    await user.clear(title);
    await user.type(title, "Otro título");
    await user.type(within(dialog).getByLabelText("Fecha (opcional)"), "2026-12-01");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    const [, formData] = updateFlashGalleryMetaMock.mock.calls[0] as [
      UpdateFlashGalleryMetaState,
      FormData,
    ];
    expect(formData.get("flashGalleryId")).toBe(FLASH_ID);
    expect(formData.get("title")).toBe("Otro título");
    expect(formData.get("sessionDate")).toBe("2026-12-01");
  });

  it("submits an empty string when the date is cleared, the value the action maps to NULL", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    await user.clear(within(dialog).getByLabelText("Fecha (opcional)"));
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    const [, formData] = updateFlashGalleryMetaMock.mock.calls[0] as [
      UpdateFlashGalleryMetaState,
      FormData,
    ];
    expect(formData.get("sessionDate")).toBe("");
  });

  it("clears the date through the 'Quitar fecha' button too", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Quitar fecha" }));

    expect(within(dialog).getByLabelText<HTMLInputElement>("Fecha (opcional)").value).toBe("");
    expect(within(dialog).queryByRole("button", { name: "Quitar fecha" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    const [, formData] = updateFlashGalleryMetaMock.mock.calls[0] as [
      UpdateFlashGalleryMetaState,
      FormData,
    ];
    expect(formData.get("sessionDate")).toBe("");
  });
});

describe("EditFlashGalleryMetaDialog — outcome", () => {
  it("shows the server's error inside the dialog and keeps what the admin typed", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({
      status: "error",
      message: "El título es muy largo.",
    });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    const title = within(dialog).getByLabelText("Título");
    await user.clear(title);
    await user.type(title, "Un título que el servidor va a rechazar");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("El título es muy largo.");
    // React 19 resets an uncontrolled form after an action; controlled inputs
    // must survive so the admin can fix the value instead of retyping it.
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe(
      "Un título que el servidor va a rechazar",
    );
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("shows a plain success message and keeps the dialog open (no auto-close)", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await within(dialog).findByRole("status");
    expect(within(dialog).getByText("Cambios guardados.")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("remounts on reopen: no leftover message, fields back to the current props", async () => {
    updateFlashGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    let dialog = await openDialog(user);
    const title = within(dialog).getByLabelText("Título");
    await user.clear(title);
    await user.type(title, "Título descartado");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    await within(dialog).findByRole("status");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openDialog(user);
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe(
      "Cumpleaños de Sofía",
    );
  });
});
