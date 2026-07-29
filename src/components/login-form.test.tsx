// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginForm } from "./login-form";
import type { LoginActionState } from "@/app/(marketing)/login/actions";

const requestMagicLinkMock =
  vi.fn<(state: LoginActionState, formData: FormData) => Promise<LoginActionState>>();

vi.mock("@/app/(marketing)/login/actions", () => ({
  requestMagicLink: (...args: [LoginActionState, FormData]) => requestMagicLinkMock(...args),
}));

afterEach(() => {
  cleanup();
  requestMagicLinkMock.mockReset();
});

describe("LoginForm", () => {
  it("renders the request form by default", () => {
    render(<LoginForm />);

    expect(screen.getByLabelText("Correo electrónico")).toBeDefined();
    expect(screen.getByRole("button", { name: "Enviar enlace de acceso" })).toBeDefined();
  });

  it("shows the confirmation screen after a successful submit", async () => {
    requestMagicLinkMock.mockResolvedValue({ status: "sent" });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Correo electrónico"), "client@example.com");
    await user.click(screen.getByRole("button", { name: "Enviar enlace de acceso" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeDefined();
    });
    expect(screen.getByText(/Revisá tu correo/)).toBeDefined();
  });

  it("swaps the surrounding header along with the form after a successful submit", async () => {
    // Regression guard for #9's review comment: the header used to keep
    // reading "Escribí el correo..." even once the notice below already said
    // the link was sent.
    requestMagicLinkMock.mockResolvedValue({ status: "sent" });
    const user = userEvent.setup();
    render(<LoginForm />);

    expect(screen.getByRole("heading", { name: "Ingresá a tu galería." })).toBeDefined();

    await user.type(screen.getByLabelText("Correo electrónico"), "client@example.com");
    await user.click(screen.getByRole("button", { name: "Enviar enlace de acceso" }));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Enlace en camino." })).toBeDefined();
    });
    expect(screen.queryByRole("heading", { name: "Ingresá a tu galería." })).toBeNull();
  });

  it("shows the SAME confirmation screen regardless of which address was submitted", async () => {
    // The component has no way of knowing (and must not care) whether the
    // action's "sent" result came from a known or unknown address — that is
    // the whole point of the anti-enumeration guard.
    requestMagicLinkMock.mockResolvedValue({ status: "sent" });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Correo electrónico"), "ghost@example.com");
    await user.click(screen.getByRole("button", { name: "Enviar enlace de acceso" }));

    await waitFor(() => {
      expect(screen.getByText(/Revisá tu correo/)).toBeDefined();
    });
  });

  it("shows the inline validation error returned by the action", async () => {
    // The typed value only has to pass the <input type="email"> browser
    // constraint so the submit actually reaches the (mocked) action — the
    // error message rendered below comes entirely from the action's result,
    // which is what this test verifies.
    requestMagicLinkMock.mockResolvedValue({
      status: "error",
      message: "Ingresá un correo electrónico válido.",
    });
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("Correo electrónico"), "test@example.com");
    await user.click(screen.getByRole("button", { name: "Enviar enlace de acceso" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
    expect(screen.getByText("Ingresá un correo electrónico válido.")).toBeDefined();
  });
});
