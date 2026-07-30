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

describe("AttachGalleryClientsForm", () => {
  it("renders a multi-select of eligible clients plus the gallery id as a hidden field", () => {
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    const select = screen.getByLabelText("Agregar clientes");
    expect(select).toHaveProperty("multiple", true);
    expect(screen.getByRole("option", { name: "Ana Pérez" })).toBeDefined();
    // Falls back to email when a client has no name — same convention as
    // gallery-form.tsx's own picker.
    expect(screen.getByRole("option", { name: "beto@example.com" })).toBeDefined();
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

    await user.selectOptions(screen.getByLabelText("Agregar clientes"), ["u1", "u2"]);
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
      message: "Elegí clientes válidos.",
    });
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    await user.selectOptions(screen.getByLabelText("Agregar clientes"), "u1");
    await user.click(screen.getByRole("button", { name: "Agregar" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Elegí clientes válidos.")).toBeDefined();
  });

  it("surfaces a partial email-send failure distinctly, naming the failed address", async () => {
    attachGalleryClientsMock.mockResolvedValue({
      status: "attached_email_failed",
      message:
        "Agregamos al cliente, pero no pudimos enviarle el correo de acceso a: beto@example.com.",
    });
    const user = userEvent.setup();
    render(<AttachGalleryClientsForm galleryId={GALLERY_ID} eligibleClients={ELIGIBLE_CLIENTS} />);

    await user.selectOptions(screen.getByLabelText("Agregar clientes"), "u2");
    await user.click(screen.getByRole("button", { name: "Agregar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("beto@example.com");
  });
});
