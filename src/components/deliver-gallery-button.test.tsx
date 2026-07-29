// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeliverGalleryButton } from "./deliver-gallery-button";
import type { DeliverGalleryState } from "@/app/dashboard/galleries/actions";

const deliverGalleryMock =
  vi.fn<(state: DeliverGalleryState, formData: FormData) => Promise<DeliverGalleryState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  deliverGallery: (...args: [DeliverGalleryState, FormData]) => deliverGalleryMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_EMAIL = "ana@example.com";

afterEach(() => {
  cleanup();
  deliverGalleryMock.mockReset();
});

describe("DeliverGalleryButton", () => {
  it("submits the gallery id", async () => {
    deliverGalleryMock.mockResolvedValue({ status: "delivered" });
    const user = userEvent.setup();
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={[CLIENT_EMAIL]}
        pendingFinalsCount={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Entregar galería" }));

    const [, formData] = deliverGalleryMock.mock.calls[0] as [DeliverGalleryState, FormData];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
  });

  it("shows a plain confirmation and hides the form once delivered", async () => {
    deliverGalleryMock.mockResolvedValue({ status: "delivered" });
    const user = userEvent.setup();
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={[CLIENT_EMAIL]}
        pendingFinalsCount={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Entregar galería" }));

    await screen.findByRole("status");
    expect(screen.getByText(`Entregada — le enviamos un correo a ${CLIENT_EMAIL}.`)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Entregar galería" })).toBeNull();
  });

  // Task #94: a gallery can have several clients now — the confirmation
  // must name all of them, not just the first.
  it("shows a confirmation naming every client's email when the gallery has several", async () => {
    deliverGalleryMock.mockResolvedValue({ status: "delivered" });
    const user = userEvent.setup();
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={["ana@example.com", "beto@example.com"]}
        pendingFinalsCount={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Entregar galería" }));

    await screen.findByRole("status");
    expect(screen.getByText(/ana@example\.com, beto@example\.com/)).toBeDefined();
  });

  // The delivery itself already committed by the time this state is reached
  // (see actions.ts's own header comment on `deliverGallery`) — this is a
  // DISTINCT, louder result from a plain success, same stance as
  // <UnlockSelectionPanel>'s own `unlocked_email_failed` case.
  it("surfaces a failed client notification as a loud alert, distinct from plain success", async () => {
    deliverGalleryMock.mockResolvedValue({
      status: "delivered_email_failed",
      message: "Entregamos la galería, pero no pudimos avisarle al cliente por correo.",
    });
    const user = userEvent.setup();
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={[CLIENT_EMAIL]}
        pendingFinalsCount={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Entregar galería" }));

    await screen.findByRole("alert");
    expect(
      screen.getByText("Entregamos la galería, pero no pudimos avisarle al cliente por correo."),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Entregar galería" })).toBeNull();
  });

  it("shows the error message returned by the action and keeps the form available to retry", async () => {
    deliverGalleryMock.mockResolvedValue({
      status: "error",
      message: "Falta 1 final por subir antes de poder entregar esta galería.",
    });
    const user = userEvent.setup();
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={[CLIENT_EMAIL]}
        pendingFinalsCount={0}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Entregar galería" }));

    await screen.findByRole("alert");
    expect(
      screen.getByText("Falta 1 final por subir antes de poder entregar esta galería."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Entregar galería" })).toBeDefined();
  });

  // The disabled button is UX only — deliverGallery() itself re-checks every
  // selected asset's own finalKey regardless of what this prop says (see the
  // action's own comment). Covered here just to lock in the convenience.
  it("disables the button and explains why while finals are still pending", () => {
    render(
      <DeliverGalleryButton
        galleryId={GALLERY_ID}
        clientEmails={[CLIENT_EMAIL]}
        pendingFinalsCount={2}
      />,
    );

    expect(screen.getByRole("button", { name: "Entregar galería" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByText("Subí los finales que faltan antes de poder entregar la galería."),
    ).toBeDefined();
  });
});
