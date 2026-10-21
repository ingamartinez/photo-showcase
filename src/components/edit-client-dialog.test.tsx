// @vitest-environment jsdom
//
// Task #279. The subject is the dialog's own contract, not the action: prefill
// from the client's row, the #50 echo-on-error mechanism, the conditional
// email-change notice (epic #278 decision 3) and the success callback. The
// live region that makes a save perceivable lives in the row component
// (client-row-actions.test.tsx), because it must survive this dialog closing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditClientDialog, type EditableClient } from "./edit-client-dialog";
import type { UpdateClientState } from "@/app/dashboard/clients/actions";

const updateClientMock =
  vi.fn<(state: UpdateClientState, formData: FormData) => Promise<UpdateClientState>>();

vi.mock("@/app/dashboard/clients/actions", () => ({
  updateClient: (...args: [UpdateClientState, FormData]) => updateClientMock(...args),
}));

const CLIENT: EditableClient = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Ana Pérez",
  email: "ana@example.com",
  phone: "+57 300 111 1111",
};

function renderDialog(overrides: Partial<EditableClient> = {}, onUpdated = vi.fn()) {
  const onOpenChange = vi.fn();
  render(
    <EditClientDialog
      client={{ ...CLIENT, ...overrides }}
      open
      onOpenChange={onOpenChange}
      onUpdated={onUpdated}
    />,
  );
  return { onUpdated, onOpenChange };
}

async function submit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
}

afterEach(() => {
  cleanup();
  updateClientMock.mockReset();
});

describe("EditClientDialog", () => {
  it("prefills the fields with the client's current values", () => {
    renderDialog();

    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Ana Pérez");
    expect((screen.getByLabelText("Correo electrónico") as HTMLInputElement).value).toBe(
      "ana@example.com",
    );
    expect((screen.getByLabelText("WhatsApp (opcional)") as HTMLInputElement).value).toBe(
      "+57 300 111 1111",
    );
  });

  // `users.name` and `users.phone` are both nullable — a nameless client must
  // open on an empty field (and the name is still `required`, so the
  // photographer has to fill it: epic decision, the name cannot be blanked).
  it("renders empty name and phone fields for a client that has neither", () => {
    renderDialog({ name: null, phone: null });

    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("WhatsApp (opcional)") as HTMLInputElement).value).toBe("");
  });

  it("submits the row id and the three edited fields", async () => {
    updateClientMock.mockResolvedValue({ status: "idle" });
    const user = userEvent.setup();
    renderDialog();

    await user.clear(screen.getByLabelText("Nombre"));
    await user.type(screen.getByLabelText("Nombre"), "Ana María Pérez");
    await user.type(screen.getByLabelText("WhatsApp (opcional)"), " ext. 2");
    await submit(user);

    await screen.findByRole("button", { name: "Guardar cambios" });
    const [, formData] = updateClientMock.mock.calls[0] as [UpdateClientState, FormData];
    expect(formData.get("userId")).toBe(CLIENT.id);
    expect(formData.get("name")).toBe("Ana María Pérez");
    expect(formData.get("email")).toBe("ana@example.com");
    expect(formData.get("phone")).toBe("+57 300 111 1111 ext. 2");
  });

  it("shows the action's error and keeps what was typed", async () => {
    updateClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
      values: { name: "Ana María", email: "beto@example.com", phone: "+57 1" },
    });
    const user = userEvent.setup();
    renderDialog();

    await submit(user);

    // The ECHOED values, not the stored ones: the reset blanked the form in
    // the same commit, and `defaultValue` is what puts the submission back.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ya existe un cliente con ese correo electrónico.",
    );
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Ana María");
    expect((screen.getByLabelText("Correo electrónico") as HTMLInputElement).value).toBe(
      "beto@example.com",
    );
    expect((screen.getByLabelText("WhatsApp (opcional)") as HTMLInputElement).value).toBe("+57 1");
  });

  it("shows the email-change notice only once the typed email differs", async () => {
    updateClientMock.mockResolvedValue({ status: "idle" });
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByText(/identidad para entrar/)).toBeNull();

    const email = screen.getByLabelText("Correo electrónico");
    await user.clear(email);
    await user.type(email, "ana.nueva@example.com");
    expect(screen.getByText(/identidad para entrar/)).toBeDefined();
    // Reachable by assistive tech through the input it describes.
    expect(email.getAttribute("aria-describedby")).toContain("edit-client-email-notice");

    // The same address in different case is NOT a change: the server
    // normalizes, so warning about it would be a false alarm.
    await user.clear(email);
    await user.type(email, "  ANA@Example.COM  ");
    expect(screen.queryByText(/identidad para entrar/)).toBeNull();
    expect(email.getAttribute("aria-describedby")).toBeNull();
  });

  it("calls onUpdated when the action reports the update", async () => {
    updateClientMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    const { onUpdated } = renderDialog();

    await submit(user);

    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
  });

  // The narrowed boolean, not the state object: two identical rejected
  // submits must not be read as a success.
  it("does not call onUpdated for a rejected submit, even twice", async () => {
    updateClientMock.mockResolvedValue({
      status: "error",
      message: "El cliente no existe.",
      values: { name: "Ana Pérez", email: "ana@example.com", phone: "" },
    });
    const user = userEvent.setup();
    const { onUpdated } = renderDialog();

    await submit(user);
    await screen.findByRole("alert");
    await submit(user);

    await vi.waitFor(() => expect(updateClientMock).toHaveBeenCalledTimes(2));
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
