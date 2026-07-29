// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnlockSelectionPanel } from "./unlock-selection-panel";
import type { UnlockSelectionState } from "@/app/dashboard/galleries/actions";

const unlockSelectionMock =
  vi.fn<(state: UnlockSelectionState, formData: FormData) => Promise<UnlockSelectionState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  unlockSelection: (...args: [UnlockSelectionState, FormData]) => unlockSelectionMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  unlockSelectionMock.mockReset();
});

describe("UnlockSelectionPanel", () => {
  it("submits the gallery id and the optional reason the admin typed", async () => {
    unlockSelectionMock.mockResolvedValue({ status: "unlocked" });
    const user = userEvent.setup();
    render(<UnlockSelectionPanel galleryId={GALLERY_ID} />);

    await user.type(screen.getByLabelText("Nota (opcional)"), "Hablamos por WhatsApp.");
    await user.click(screen.getByRole("button", { name: "Desbloquear selección" }));

    const [, formData] = unlockSelectionMock.mock.calls[0] as [UnlockSelectionState, FormData];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("reason")).toBe("Hablamos por WhatsApp.");
  });

  it("submits with no reason at all when the admin leaves it blank", async () => {
    unlockSelectionMock.mockResolvedValue({ status: "unlocked" });
    const user = userEvent.setup();
    render(<UnlockSelectionPanel galleryId={GALLERY_ID} />);

    await user.click(screen.getByRole("button", { name: "Desbloquear selección" }));

    const [, formData] = unlockSelectionMock.mock.calls[0] as [UnlockSelectionState, FormData];
    expect(formData.get("reason")).toBe("");
  });

  it("shows a plain confirmation and hides the form once unlocked", async () => {
    unlockSelectionMock.mockResolvedValue({ status: "unlocked" });
    const user = userEvent.setup();
    render(<UnlockSelectionPanel galleryId={GALLERY_ID} />);

    await user.click(screen.getByRole("button", { name: "Desbloquear selección" }));

    await screen.findByRole("status");
    expect(screen.getByText(/el cliente puede volver a elegir/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Desbloquear selección" })).toBeNull();
  });

  // The unlock itself already committed by the time this state is reached
  // (see actions.ts's own header comment) — this is a DISTINCT, louder
  // result from a plain success, because the client has no other way to
  // learn their selection reopened.
  it("surfaces a failed client notification as a loud alert, distinct from plain success", async () => {
    unlockSelectionMock.mockResolvedValue({
      status: "unlocked_email_failed",
      message: "Desbloqueamos la selección, pero no pudimos avisarle al cliente por correo.",
    });
    const user = userEvent.setup();
    render(<UnlockSelectionPanel galleryId={GALLERY_ID} />);

    await user.click(screen.getByRole("button", { name: "Desbloquear selección" }));

    await screen.findByRole("alert");
    expect(
      screen.getByText(
        "Desbloqueamos la selección, pero no pudimos avisarle al cliente por correo.",
      ),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Desbloquear selección" })).toBeNull();
  });

  it("shows the error message returned by the action and keeps the form available to retry", async () => {
    unlockSelectionMock.mockResolvedValue({
      status: "error",
      message: "Esta galería no tiene una selección enviada para desbloquear.",
    });
    const user = userEvent.setup();
    render(<UnlockSelectionPanel galleryId={GALLERY_ID} />);

    await user.click(screen.getByRole("button", { name: "Desbloquear selección" }));

    await screen.findByRole("alert");
    expect(
      screen.getByText("Esta galería no tiene una selección enviada para desbloquear."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Desbloquear selección" })).toBeDefined();
  });
});
