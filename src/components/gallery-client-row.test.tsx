// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryClientRow } from "./gallery-client-row";
import type { RemoveGalleryClientState } from "@/app/dashboard/galleries/actions";

const removeGalleryClientMock =
  vi.fn<
    (state: RemoveGalleryClientState, formData: FormData) => Promise<RemoveGalleryClientState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  removeGalleryClient: (...args: [RemoveGalleryClientState, FormData]) =>
    removeGalleryClientMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = { id: "u1", name: "Ana Pérez", email: "ana@example.com" };

afterEach(() => {
  cleanup();
  removeGalleryClientMock.mockReset();
  removeGalleryClientMock.mockResolvedValue({ status: "idle" });
});

describe("GalleryClientRow", () => {
  it("renders the client's name and email", () => {
    render(<GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="proofing" removable />);

    expect(screen.getByText(/Ana Pérez/)).toBeDefined();
    expect(screen.getByText(/ana@example\.com/)).toBeDefined();
  });

  it("hides the Quitar button entirely when removable is false", () => {
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });

  it("does not submit until the confirm step, and cancel returns to the initial state", async () => {
    const user = userEvent.setup();
    render(<GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="proofing" removable />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();
    expect(removeGalleryClientMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.getByRole("button", { name: "Quitar" })).toBeDefined();
  });

  // The task's own explicit requirement: the confirmation must say WHAT is
  // about to happen — sharpest on a DELIVERED gallery, where removal takes
  // away photos the client may have already paid for.
  it("shows the delivered-specific warning before confirming, on a delivered gallery", async () => {
    const user = userEvent.setup();
    render(
      <GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="delivered" removable />,
    );

    await user.click(screen.getByRole("button", { name: "Quitar" }));

    expect(
      screen.getByText(/perder el acceso para ver y descargar las fotos entregadas/),
    ).toBeDefined();
  });

  it("submits galleryId and clientId through removeGalleryClient once confirmed", async () => {
    removeGalleryClientMock.mockResolvedValue({ status: "removed" });
    const user = userEvent.setup();
    render(<GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="proofing" removable />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    expect(removeGalleryClientMock).toHaveBeenCalledTimes(1);
    const [, formData] = removeGalleryClientMock.mock.calls[0] as [
      RemoveGalleryClientState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("clientId")).toBe(CLIENT.id);
  });

  it("renders a 'quitado' state once the removal succeeds", async () => {
    removeGalleryClientMock.mockResolvedValue({ status: "removed" });
    const user = userEvent.setup();
    render(<GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="proofing" removable />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByText(/quitado/);
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });

  it("shows the error message returned by the action, without hiding the row", async () => {
    removeGalleryClientMock.mockResolvedValue({
      status: "error",
      message:
        "No podés quitar al último cliente activo de una galería que ya no está en borrador.",
    });
    const user = userEvent.setup();
    render(<GalleryClientRow galleryId={GALLERY_ID} client={CLIENT} status="proofing" removable />);

    await user.click(screen.getByRole("button", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByRole("alert");
    expect(screen.getByText(/No podés quitar al último cliente activo/)).toBeDefined();
    // Still there — the removal was refused, not applied.
    expect(screen.getByText(/Ana Pérez/)).toBeDefined();
  });
});
