// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachGalleryClientsForm } from "./attach-gallery-clients-form";
import type { AttachGalleryClientsState } from "@/app/dashboard/galleries/actions";

const attachGalleryClientsMock =
  vi.fn<
    (state: AttachGalleryClientsState, formData: FormData) => Promise<AttachGalleryClientsState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  attachGalleryClients: (...args: [AttachGalleryClientsState, FormData]) =>
    attachGalleryClientsMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

const ELIGIBLE_CLIENTS = [
  { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  { id: "u2", name: null, email: "beto@example.com" },
];

afterEach(() => {
  cleanup();
  attachGalleryClientsMock.mockReset();
});

/**
 * Picks clients through the shared `ClientPicker` (task #247) and closes it.
 * The Escape is not ceremony: while the modal popover is open the rest of the
 * page is `aria-hidden` and the body is pointer-events-locked, so nothing
 * outside the list is queryable or clickable — exactly like the real flow.
 */
async function pickClients(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  names: string[],
) {
  await user.click(screen.getByLabelText(label));
  for (const name of names) {
    await user.click(screen.getByRole("option", { name }));
  }
  await user.keyboard("{Escape}");
}

describe("AttachGalleryClientsForm", () => {
  it("renders the shared client picker of eligible clients plus the gallery id as a hidden field", async () => {
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    // Task #247: the `<select multiple>` became the shared `ClientPicker`, whose
    // trigger is a button carrying this form's own label.
    const trigger = screen.getByLabelText("Agregar clientes");
    expect(trigger.tagName).toBe("BUTTON");
    expect(screen.getByLabelText<HTMLInputElement>("Agregar clientes").id).toBe(
      "attach-client-ids",
    );
    expect(screen.getByDisplayValue(GALLERY_ID)).toBeDefined();

    await user.click(trigger);
    expect(screen.getByRole("option", { name: "Ana Pérez" })).toBeDefined();
    // Falls back to email when a client has no name — same convention as
    // gallery-form.tsx's own picker.
    expect(screen.getByRole("option", { name: "beto@example.com" })).toBeDefined();
    await user.keyboard("{Escape}");
  });

  it("shows a message instead of the picker when there are no eligible clients", () => {
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={[]} />);

    expect(screen.queryByLabelText("Agregar clientes")).toBeNull();
    expect(
      screen.getByText(/Ya agregaste a todos los clientes disponibles a esta galería/),
    ).toBeDefined();
  });

  it("submits the galleryId and every SELECTED client id through the action", async () => {
    attachGalleryClientsMock.mockResolvedValue({
      status: "attached",
      message: "Cliente agregado.",
    });
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    await pickClients(user, "Agregar clientes", ["Ana Pérez", "beto@example.com"]);
    await user.click(screen.getByRole("button", { name: "Agregar" }));

    await screen.findByText("Cliente agregado.");
    const [, formData] = attachGalleryClientsMock.mock.calls[0] as [
      AttachGalleryClientsState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.getAll("clientIds")).toEqual(["u1", "u2"]);
  });

  it("shows the error message returned by the action", async () => {
    attachGalleryClientsMock.mockResolvedValue({
      status: "error",
      message: "Elige clientes válidos.",
    });
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    await pickClients(user, "Agregar clientes", ["Ana Pérez"]);
    await user.click(screen.getByRole("button", { name: "Agregar" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Elige clientes válidos.")).toBeDefined();
  });

  it("surfaces a partial email-send failure distinctly, naming the failed address", async () => {
    attachGalleryClientsMock.mockResolvedValue({
      status: "attached_email_failed",
      message:
        "Agregamos al cliente, pero no pudimos enviarle el correo de acceso a: beto@example.com.",
    });
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    await pickClients(user, "Agregar clientes", ["beto@example.com"]);
    await user.click(screen.getByRole("button", { name: "Agregar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("beto@example.com");
  });
});
