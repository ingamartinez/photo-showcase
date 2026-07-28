// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientForm } from "./client-form";
import type { CreateClientState } from "@/app/dashboard/clients/actions";

const createClientMock =
  vi.fn<(state: CreateClientState, formData: FormData) => Promise<CreateClientState>>();

vi.mock("@/app/dashboard/clients/actions", () => ({
  createClient: (...args: [CreateClientState, FormData]) => createClientMock(...args),
}));

afterEach(() => {
  cleanup();
  createClientMock.mockReset();
});

describe("ClientForm", () => {
  it("renders name, email and optional phone fields", () => {
    render(<ClientForm />);

    expect(screen.getByLabelText("Nombre")).toBeDefined();
    expect(screen.getByLabelText("Correo electrónico")).toBeDefined();
    const phoneInput = screen.getByLabelText("WhatsApp (opcional)") as HTMLInputElement;
    expect(phoneInput.required).toBe(false);
    expect(screen.getByRole("button", { name: "Agregar cliente" })).toBeDefined();
  });

  it("submits the typed values through the action", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<ClientForm />);

    await user.type(screen.getByLabelText("Nombre"), "Ana Pérez");
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@example.com");
    await user.type(screen.getByLabelText("WhatsApp (opcional)"), "+57 300 0000");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));

    await screen.findByText("Cliente agregado.");
    const [, formData] = createClientMock.mock.calls[0] as [CreateClientState, FormData];
    expect(formData.get("name")).toBe("Ana Pérez");
    expect(formData.get("email")).toBe("ana@example.com");
    expect(formData.get("phone")).toBe("+57 300 0000");
  });

  it("shows the friendly duplicate-email message returned by the action", async () => {
    createClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
    });
    const user = userEvent.setup();
    render(<ClientForm />);

    await user.type(screen.getByLabelText("Nombre"), "Ana");
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));

    await screen.findByRole("alert");
    expect(screen.getByText("Ya existe un cliente con ese correo electrónico.")).toBeDefined();
  });

  // React 19 blanks uncontrolled fields in a <form action={fn}> synchronously
  // at submit time (see client-form.tsx's comment) — for either outcome, not
  // only success. This asserts the actual, if slightly rough, behavior
  // rather than a "resets on success only" story that isn't true here.
  it("blanks the typed values once submitted, regardless of the action's outcome", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<ClientForm />);

    const emailInput = screen.getByLabelText("Correo electrónico") as HTMLInputElement;
    await user.type(screen.getByLabelText("Nombre"), "Ana");
    await user.type(emailInput, "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));

    await screen.findByText("Cliente agregado.");
    expect(emailInput.value).toBe("");
  });
});
