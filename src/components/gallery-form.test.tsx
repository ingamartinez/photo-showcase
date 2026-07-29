// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryForm } from "./gallery-form";
import type { CreateGalleryState } from "@/app/dashboard/galleries/actions";

const createGalleryMock =
  vi.fn<(state: CreateGalleryState, formData: FormData) => Promise<CreateGalleryState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  createGallery: (...args: [CreateGalleryState, FormData]) => createGalleryMock(...args),
}));

const CLIENTS = [
  { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  { id: "u2", name: null, email: "beto@example.com" },
];

const PACKAGES = [
  {
    id: 1,
    name: "Estándar",
    priceCop: 100_000,
    includedPhotos: 13,
    extraPhotoPriceCop: 5_000,
    durationLabel: "1.5–2 h",
  },
];

afterEach(() => {
  cleanup();
  createGalleryMock.mockReset();
});

describe("GalleryForm", () => {
  it("renders clients (multi-select), package, title and session-date fields", () => {
    render(<GalleryForm clients={CLIENTS} packages={PACKAGES} />);

    // Task #94: a gallery can have several clients now — "Clientes"
    // (plural), a `<select multiple>`.
    const clientsSelect = screen.getByLabelText("Clientes");
    expect(clientsSelect).toBeDefined();
    expect(clientsSelect).toHaveProperty("multiple", true);
    expect(screen.getByLabelText("Paquete")).toBeDefined();
    expect(screen.getByLabelText("Título")).toBeDefined();
    expect(screen.getByLabelText("Fecha de la sesión")).toBeDefined();
    expect(screen.getByRole("button", { name: "Crear galería" })).toBeDefined();
  });

  it("falls back to the client's email when they have no name", () => {
    render(<GalleryForm clients={CLIENTS} packages={PACKAGES} />);

    expect(screen.getByRole("option", { name: "beto@example.com" })).toBeDefined();
  });

  it("submits every SELECTED client (several), plus package, title and session date, through the action", async () => {
    createGalleryMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<GalleryForm clients={CLIENTS} packages={PACKAGES} />);

    // Task #94: selecting BOTH options on the multi-select — the action
    // must receive both, not just the first.
    await user.selectOptions(screen.getByLabelText("Clientes"), ["u1", "u2"]);
    await user.selectOptions(screen.getByLabelText("Paquete"), "1");
    await user.type(screen.getByLabelText("Título"), "Boda Ana y Beto");
    await user.type(screen.getByLabelText("Fecha de la sesión"), "2026-08-01");
    await user.click(screen.getByRole("button", { name: "Crear galería" }));

    await screen.findByText("Galería creada.");
    const [, formData] = createGalleryMock.mock.calls[0] as [CreateGalleryState, FormData];
    expect(formData.getAll("clientIds")).toEqual(["u1", "u2"]);
    expect(formData.get("packageId")).toBe("1");
    expect(formData.get("title")).toBe("Boda Ana y Beto");
    expect(formData.get("sessionDate")).toBe("2026-08-01");
  });

  it("shows the error message returned by the action", async () => {
    createGalleryMock.mockResolvedValue({
      status: "error",
      message: "Ese paquete ya no está disponible.",
    });
    const user = userEvent.setup();
    render(<GalleryForm clients={CLIENTS} packages={PACKAGES} />);

    await user.selectOptions(screen.getByLabelText("Clientes"), "u1");
    await user.selectOptions(screen.getByLabelText("Paquete"), "1");
    await user.type(screen.getByLabelText("Título"), "Boda");
    await user.type(screen.getByLabelText("Fecha de la sesión"), "2026-08-01");
    await user.click(screen.getByRole("button", { name: "Crear galería" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Ese paquete ya no está disponible.")).toBeDefined();
  });

  it("disables the submit button when there are no active packages", () => {
    render(<GalleryForm clients={CLIENTS} packages={[]} />);

    expect(screen.getByRole("button", { name: "Crear galería" })).toHaveProperty("disabled", true);
  });
});
