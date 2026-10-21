// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteGalleryDialog } from "./delete-gallery-dialog";

const deleteGalleryMock = vi.fn();
vi.mock("@/app/dashboard/galleries/actions", () => ({
  deleteGallery: (...args: unknown[]) => deleteGalleryMock(...args),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const TITLE = "Boda Ana y Beto";
const LABEL = `Escribe el título de la galería para confirmar: «${TITLE}»`;

afterEach(() => {
  cleanup();
  deleteGalleryMock.mockReset();
  pushMock.mockReset();
});

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Eliminar galería" }));
  return screen.findByRole("dialog");
}

function renderDialog() {
  return render(<DeleteGalleryDialog galleryId={GALLERY_ID} title={TITLE} />);
}

describe("DeleteGalleryDialog — the typed title is the guard", () => {
  it("does not delete with the wrong title, and the handler itself refuses a programmatic submit", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    const input = within(dialog).getByLabelText<HTMLInputElement>(LABEL);

    await user.type(input, "Otra galería");

    const submit = within(dialog).getByRole("button", { name: "Eliminar galería" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    // Submitted DIRECTLY, not via Enter: jsdom has no implicit form
    // submission worth trusting, and with a disabled submit button an Enter
    // keystroke would assert nothing (`userEvent` only clicks an enabled
    // submitter). `fireEvent.submit` is what actually exercises the
    // handler's own `!matches` early return — the guard a disabled attribute
    // cannot replace.
    fireEvent.submit(input.closest("form")!);

    expect(deleteGalleryMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("treats a case-only difference as the wrong title", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(LABEL), TITLE.toLowerCase());

    expect(
      (within(dialog).getByRole("button", { name: "Eliminar galería" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("deletes once with the exact title, then navigates to the gallery list", async () => {
    deleteGalleryMock.mockResolvedValue({ ok: true, r2Failures: 0 });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    // Surrounding spaces are forgiven (a paste artifact), nothing else is.
    await user.type(within(dialog).getByLabelText(LABEL), `  ${TITLE}  `);
    await user.click(within(dialog).getByRole("button", { name: "Eliminar galería" }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/galleries"));
    expect(deleteGalleryMock).toHaveBeenCalledTimes(1);
    expect(deleteGalleryMock).toHaveBeenCalledWith(GALLERY_ID);
  });

  it("shows the action's message and stays put when the delete is refused", async () => {
    deleteGalleryMock.mockResolvedValue({ ok: false, message: "La galería no existe." });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(LABEL), TITLE);
    await user.click(within(dialog).getByRole("button", { name: "Eliminar galería" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("La galería no existe.");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("DeleteGalleryDialog — state starts clean every time it opens", () => {
  it("clears the typed title and any message when reopened", async () => {
    deleteGalleryMock.mockResolvedValue({ ok: false, message: "La galería no existe." });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    await user.type(within(dialog).getByLabelText(LABEL), TITLE);
    await user.click(within(dialog).getByRole("button", { name: "Eliminar galería" }));
    await within(dialog).findByRole("alert");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const reopened = await openDialog(user);

    expect(within(reopened).getByLabelText<HTMLInputElement>(LABEL).value).toBe("");
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });
});
