// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditGalleryMetaDialog } from "./edit-gallery-meta-dialog";
import type { UpdateGalleryMetaState } from "@/app/dashboard/galleries/actions";

const updateGalleryMetaMock =
  vi.fn<(state: UpdateGalleryMetaState, formData: FormData) => Promise<UpdateGalleryMetaState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  updateGalleryMeta: (...args: [UpdateGalleryMetaState, FormData]) =>
    updateGalleryMetaMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  updateGalleryMetaMock.mockReset();
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Editar galería" }));
  return screen.findByRole("dialog");
}

function renderDialog(props: Partial<Parameters<typeof EditGalleryMetaDialog>[0]> = {}) {
  return render(
    <EditGalleryMetaDialog
      galleryId={GALLERY_ID}
      title="Boda Ana y Beto"
      sessionDate="2026-01-01"
      {...props}
    />,
  );
}

describe("EditGalleryMetaDialog — fields", () => {
  // The boundary date is the trap: `new Date("2026-01-01")` renders as
  // 2025-12-31 in America/Bogota. The input must show the prop VERBATIM.
  it("pre-fills the title and the session date exactly as passed, date untransformed", async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);

    // No jest-dom is wired into this Vitest setup, so `.value` off the DOM
    // node is the honest equivalent of `toHaveValue` (same reasoning as
    // edit-gallery-terms-dialog.test.tsx's own comment).
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe("Boda Ana y Beto");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Fecha de la sesión").value).toBe(
      "2026-01-01",
    );
  });

  it("marks both fields required — an edit has no meaningful empty value", async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);

    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").required).toBe(true);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Fecha de la sesión").required).toBe(
      true,
    );
  });

  it("submits the gallery id and the typed values, the date as a plain YYYY-MM-DD string", async () => {
    updateGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    const titleField = within(dialog).getByLabelText("Título");
    await user.clear(titleField);
    await user.type(titleField, "Boda Ana y Beto — corregida");
    // jsdom's date input ignores `user.clear`/`user.type` for the value part;
    // `fireEvent.change` is the accepted way to drive it (same note in the
    // plan, and the create-dialog tests only ever type into an EMPTY date).
    fireEvent.change(within(dialog).getByLabelText("Fecha de la sesión"), {
      target: { value: "2026-12-31" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    const [, formData] = updateGalleryMetaMock.mock.calls[0] as [UpdateGalleryMetaState, FormData];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("title")).toBe("Boda Ana y Beto — corregida");
    expect(formData.get("sessionDate")).toBe("2026-12-31");
  });

  // The regression the controlled inputs exist for: React 19 resets an
  // uncontrolled `<form action>` after the action resolves, error states
  // included. If the typed values vanish here, the admin is told to fix a
  // field the dialog just erased.
  it("shows the server's error message, keeps the form open, and keeps what was typed", async () => {
    updateGalleryMetaMock.mockResolvedValue({
      status: "error",
      message: "Ingresa un título.",
    });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    const titleField = within(dialog).getByLabelText("Título");
    await user.clear(titleField);
    await user.type(titleField, "  ");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await within(dialog).findByRole("alert");
    expect(within(dialog).getByText("Ingresa un título.")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe("  ");
  });

  it("shows a plain success message and keeps the form open (no auto-close)", async () => {
    updateGalleryMetaMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    renderDialog();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await within(dialog).findByRole("status");
    expect(within(dialog).getByText("Galería actualizada.")).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("discards an abandoned edit when the dialog is closed and re-opened", async () => {
    const user = userEvent.setup();
    renderDialog();

    let dialog = await openDialog(user);
    const titleField = within(dialog).getByLabelText("Título");
    await user.clear(titleField);
    await user.type(titleField, "Sin guardar");
    await user.keyboard("{Escape}");

    dialog = await openDialog(user);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Título").value).toBe("Boda Ana y Beto");
    expect(within(dialog).getByLabelText<HTMLInputElement>("Fecha de la sesión").value).toBe(
      "2026-01-01",
    );
  });
});
