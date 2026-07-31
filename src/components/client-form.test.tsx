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
  // only success. On success that is exactly what is wanted: the form comes
  // back empty, ready for the next client.
  it("blanks the typed values after a successful create", async () => {
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

  // Task #50, the papercut: the same reset used to blank the fields on an
  // ERROR too, so a photographer told "ya existe un cliente con ese correo"
  // had to retype name, email and phone to change one character. The action
  // now returns what was submitted and this form feeds it back through
  // `defaultValue`, which the reset restores to.
  it("keeps the submitted values on screen when the action rejects a duplicate", async () => {
    createClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
      values: { name: "Ana Pérez", email: "ana@example.com", phone: "+57 300 0000" },
    });
    const user = userEvent.setup();
    render(<ClientForm />);

    const nameInput = screen.getByLabelText("Nombre") as HTMLInputElement;
    const emailInput = screen.getByLabelText("Correo electrónico") as HTMLInputElement;
    const phoneInput = screen.getByLabelText("WhatsApp (opcional)") as HTMLInputElement;
    await user.type(nameInput, "Ana Pérez");
    await user.type(emailInput, "ana@example.com");
    await user.type(phoneInput, "+57 300 0000");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));

    await screen.findByRole("alert");
    expect(nameInput.value).toBe("Ana Pérez");
    expect(emailInput.value).toBe("ana@example.com");
    expect(phoneInput.value).toBe("+57 300 0000");
  });

  // The other half of the same rule, and the reason `values` is scoped to the
  // error branch: a later SUCCESS must not resurrect the values a previous
  // failed attempt left behind, or the photographer starts the next client on
  // top of the previous one's data.
  it("clears the fields again once a retry succeeds", async () => {
    createClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
      values: { name: "Ana Pérez", email: "ana@example.com", phone: "" },
    });
    const user = userEvent.setup();
    render(<ClientForm />);

    const emailInput = screen.getByLabelText("Correo electrónico") as HTMLInputElement;
    await user.type(screen.getByLabelText("Nombre"), "Ana Pérez");
    await user.type(emailInput, "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));
    await screen.findByRole("alert");
    expect(emailInput.value).toBe("ana@example.com");

    createClientMock.mockResolvedValue({ status: "created" });
    await user.clear(emailInput);
    await user.type(emailInput, "ana2@example.com");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));

    await screen.findByText("Cliente agregado.");
    expect(emailInput.value).toBe("");
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("");
  });

  // -------------------------------------------------------------------------
  // `onCreated` (task #132) — the one thing this form learns about being
  // inside a dialog (src/components/dashboard-client-create-dialog.tsx), same
  // shape as gallery-form.test.tsx's own pair for task #131. Every test above
  // renders WITHOUT it, which is what proves the prop is genuinely optional.
  // -------------------------------------------------------------------------

  async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Nombre"), "Ana Pérez");
    await user.type(screen.getByLabelText("Correo electrónico"), "ana@example.com");
    await user.click(screen.getByRole("button", { name: "Agregar cliente" }));
  }

  it("calls onCreated exactly once when the action reports success", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<ClientForm onCreated={onCreated} />);

    await fillAndSubmit(user);

    await screen.findByText("Cliente agregado.");
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  // The effect keys off a BOOLEAN (`state.status === "created"`), not off the
  // state object, precisely so a rejected submit — which produces a brand-new
  // object every time — never fires it. A dialog that closed on a validation
  // error would throw the photographer's typing away.
  it("does NOT call onCreated when the action reports an error", async () => {
    createClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
    });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<ClientForm onCreated={onCreated} />);

    await fillAndSubmit(user);

    await screen.findByRole("alert");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
