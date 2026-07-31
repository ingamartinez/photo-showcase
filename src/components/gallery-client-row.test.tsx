// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryClientRow } from "./gallery-client-row";
import type {
  RemoveGalleryClientState,
  ResendGalleryAccessEmailState,
} from "@/app/dashboard/galleries/actions";

const removeGalleryClientMock =
  vi.fn<
    (state: RemoveGalleryClientState, formData: FormData) => Promise<RemoveGalleryClientState>
  >();
const resendGalleryAccessEmailMock =
  vi.fn<
    (
      state: ResendGalleryAccessEmailState,
      formData: FormData,
    ) => Promise<ResendGalleryAccessEmailState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  removeGalleryClient: (...args: [RemoveGalleryClientState, FormData]) =>
    removeGalleryClientMock(...args),
  resendGalleryAccessEmail: (...args: [ResendGalleryAccessEmailState, FormData]) =>
    resendGalleryAccessEmailMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = { id: "u1", name: "Ana Pérez", email: "ana@example.com" };

// Task #133: "Quitar" and "Reenviar acceso" no longer sit on the row as two
// small, adjacent buttons — they live inside the row's single 44px
// "Acciones" trigger (a <DropdownMenu>). Every test that needs one of them
// opens the menu first, the same way a real pointer/keyboard user would.
async function openActionsMenu(user: ReturnType<typeof userEvent.setup>, name = CLIENT.name) {
  await user.click(screen.getByRole("button", { name: `Acciones para ${name}` }));
}

afterEach(() => {
  cleanup();
  removeGalleryClientMock.mockReset();
  removeGalleryClientMock.mockResolvedValue({ status: "idle" });
  resendGalleryAccessEmailMock.mockReset();
  resendGalleryAccessEmailMock.mockResolvedValue({ status: "idle" });
});

describe("GalleryClientRow", () => {
  it("renders the client's name and email", () => {
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable={false}
      />,
    );

    expect(screen.getByText(/Ana Pérez/)).toBeDefined();
    expect(screen.getByText(/ana@example\.com/)).toBeDefined();
  });

  it("hides the Acciones trigger entirely when neither removable nor resendable", () => {
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
        resendable={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
  });

  it("does not submit until the confirm step, and cancel returns to the initial state", async () => {
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();
    expect(removeGalleryClientMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    // Back to the initial state: the Acciones trigger is reachable again.
    expect(screen.getByRole("button", { name: /Acciones para/ })).toBeDefined();
  });

  // The task's own explicit requirement: the confirmation must say WHAT is
  // about to happen — sharpest on a DELIVERED gallery, where removal takes
  // away photos the client may have already paid for.
  it("shows the delivered-specific warning before confirming, on a delivered gallery", async () => {
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="delivered"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));

    expect(
      screen.getByText(/perder el acceso para ver y descargar las fotos entregadas/),
    ).toBeDefined();
  });

  it("submits galleryId and clientId through removeGalleryClient once confirmed", async () => {
    removeGalleryClientMock.mockResolvedValue({ status: "removed" });
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
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
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByText(/quitado/);
    expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
  });

  it("shows the error message returned by the action, without hiding the row", async () => {
    removeGalleryClientMock.mockResolvedValue({
      status: "error",
      message:
        "No podés quitar al último cliente activo de una galería que ya no está en borrador.",
    });
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByRole("alert");
    expect(screen.getByText(/No podés quitar al último cliente activo/)).toBeDefined();
    // Still there — the removal was refused, not applied.
    expect(screen.getByText(/Ana Pérez/)).toBeDefined();
  });
});

describe("GalleryClientRow — resend affordance (task #101)", () => {
  it("hides 'Reenviar acceso' entirely when resendable is false and removable is false", () => {
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="draft"
        removable={false}
        resendable={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
  });

  it("offers only Quitar, not Reenviar acceso, when resendable is false", async () => {
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="draft"
        removable
        resendable={false}
      />,
    );

    await openActionsMenu(user);
    expect(screen.queryByRole("menuitem", { name: /Reenviar acceso/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Quitar" })).toBeDefined();
  });

  it("submits galleryId and clientId through resendGalleryAccessEmail when selected", async () => {
    resendGalleryAccessEmailMock.mockResolvedValue({
      status: "resent",
      message: `Le reenviamos el enlace de acceso a ${CLIENT.email}.`,
    });
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
        resendable
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Reenviar acceso/ }));

    expect(resendGalleryAccessEmailMock).toHaveBeenCalledTimes(1);
    const [, formData] = resendGalleryAccessEmailMock.mock.calls[0] as [
      ResendGalleryAccessEmailState,
      FormData,
    ];
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("clientId")).toBe(CLIENT.id);
    await screen.findByRole("status");
    expect(screen.getByText(/Le reenviamos el enlace de acceso/)).toBeDefined();
  });

  it("shows the throttled message as an alert, distinct from a success", async () => {
    resendGalleryAccessEmailMock.mockResolvedValue({
      status: "throttled",
      message: "Ya le reenviaste el correo varias veces en poco tiempo.",
    });
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
        resendable
      />,
    );

    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Reenviar acceso/ }));

    await screen.findByRole("alert");
    expect(screen.getByText(/varias veces en poco tiempo/)).toBeDefined();
  });

  // TRAP B (kanban #101's own re-implementation brief): the button actually
  // at risk of being wrongly disabled by a shared `pending` flag is
  // "Confirmar" (`disabled={removePending}` in the removal form) — NOT
  // "Quitar"/the menu trigger, neither of which is `disabled` at all, so
  // neither can be proven to "stay enabled" by asserting on it (a naive
  // version of this exact test, asserting on "Quitar" instead, passed
  // against this task's own first, lost implementation even after its
  // author deliberately reintroduced the bug it claimed to catch).
  //
  // MUTATION-PROVEN: temporarily editing gallery-client-row.tsx's
  // "Confirmar" button to `disabled={resendPending || removePending}` turns
  // this test RED — see this task's final report for the captured failure
  // output.
  it("does not disable 'Confirmar' while an unrelated resend is pending", async () => {
    // Never resolves on its own — keeps the resend form's `pending` state
    // true for the life of this test, the same way a real in-flight
    // `fetch`/server-action round trip would.
    let resolveResend: (value: ResendGalleryAccessEmailState) => void = () => {};
    resendGalleryAccessEmailMock.mockImplementation(
      () =>
        new Promise<ResendGalleryAccessEmailState>((resolve) => {
          resolveResend = resolve;
        }),
    );
    const user = userEvent.setup();
    render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable
        resendable
      />,
    );

    // Reach the confirming state so "Confirmar" is on the page at all.
    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar" }));
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDefined();

    // Put an UNRELATED resend in flight.
    await openActionsMenu(user);
    await user.click(screen.getByRole("menuitem", { name: /Reenviar acceso/ }));

    // No jest-dom is wired into this Vitest setup (no setupFiles, no prior
    // usage in this repo) — `toBeDisabled()` would throw as an undefined
    // matcher rather than genuinely asserting anything, which would itself
    // be a "test that doesn't test what it says" defect. Reading the DOM
    // property directly is the honest equivalent.
    const confirmButton = screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);

    resolveResend({ status: "resent", message: "ok" });
  });
});
