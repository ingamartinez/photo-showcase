// @vitest-environment jsdom
//
// Task #131, review round 1. The slice shipped `onCreated` — the callback that
// closes this dialog when <GalleryForm> succeeds — with NO test anywhere
// exercising it. That mattered because closing the dialog unmounts the portal,
// and the form's own `role="status"` "Galería creada." lives inside it: a
// screen-reader user submitted the form and got nothing back.
//
// This file is the guard for the fix. Its subject is not "does the dialog
// close" (that is a means) but "is the success PERCEIVABLE after it closes"
// (that is the acceptance criterion), which is why every assertion below is
// about the live region rather than about the callback firing.
//
// #7 reuses this component's shape, which is why the fix and its test live at
// the pattern rather than at the call site.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardGalleryCreateDialog } from "./dashboard-gallery-create-dialog";
import type { CreateGalleryState } from "@/app/dashboard/galleries/actions";

const createGalleryMock =
  vi.fn<(state: CreateGalleryState, formData: FormData) => Promise<CreateGalleryState>>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  createGallery: (...args: [CreateGalleryState, FormData]) => createGalleryMock(...args),
}));

const CLIENTS = [{ id: "u1", name: "Ana Pérez", email: "ana@example.com" }];
const PACKAGES = [{ id: 1, name: "Estándar", includedPhotos: 13 }];

beforeEach(() => {
  createGalleryMock.mockReset();
});

afterEach(() => {
  cleanup();
});

/** Opens the dialog, fills the required fields and submits. */
async function createOne(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Nueva galería" }));
  const dialog = await screen.findByRole("dialog");
  await user.selectOptions(within(dialog).getByLabelText("Paquete"), "1");
  await user.type(within(dialog).getByLabelText("Título"), "Boda Ana y Beto");
  await user.type(within(dialog).getByLabelText("Fecha de la sesión"), "2026-08-01");
  await user.click(within(dialog).getByRole("button", { name: "Crear galería" }));
}

describe("DashboardGalleryCreateDialog", () => {
  // A live region has to be in the accessibility tree BEFORE its text changes.
  // Rendering the region and its content in one commit is the classic way to
  // ship a live region that never announces anything, so "it is already there,
  // and it is empty" is a real property and not ceremony.
  it("mounts an empty live region before anything has happened", () => {
    render(<DashboardGalleryCreateDialog clients={CLIENTS} packages={PACKAGES} />);

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("announces the creation from outside the dialog, so closing cannot take it away", async () => {
    createGalleryMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardGalleryCreateDialog clients={CLIENTS} packages={PACKAGES} />);

    // Captured BEFORE the interaction: the assertion at the end compares node
    // IDENTITY, which is what proves the region survived rather than being
    // torn down and replaced (a replacement is a region a screen reader never
    // announces).
    const region = screen.getByRole("status");

    await createOne(user);

    // The dialog goes away...
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // ...and the confirmation is still here, on the very same node, in the
    // page tree rather than in the unmounted portal.
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Galería creada. Ya aparece en la lista.");
    expect(region.isConnected).toBe(true);
    expect(document.body.contains(region)).toBe(true);
  });

  it("returns focus to the trigger and keeps the announcement", async () => {
    createGalleryMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardGalleryCreateDialog clients={CLIENTS} packages={PACKAGES} />);

    const trigger = screen.getByRole("button", { name: "Nueva galería" });
    await createOne(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("status").textContent).toContain("Galería creada.");
  });

  // A live region only announces when its text CHANGES. Two identical
  // successes in a row would otherwise be one announcement and one silent
  // no-op, which is the same defect as having no region at all — for the
  // second gallery. Reopening the dialog is what resets it.
  it("re-announces a second creation instead of going silent", async () => {
    createGalleryMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardGalleryCreateDialog clients={CLIENTS} packages={PACKAGES} />);

    const region = screen.getByRole("status");

    await createOne(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Galería creada. Ya aparece en la lista.");

    // Reopening clears it — the "" the next success transitions away from.
    await user.click(screen.getByRole("button", { name: "Nueva galería" }));
    await screen.findByRole("dialog");
    expect(region.textContent).toBe("");

    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText("Paquete"), "1");
    await user.type(within(dialog).getByLabelText("Título"), "Quince Isabela");
    await user.type(within(dialog).getByLabelText("Fecha de la sesión"), "2026-09-01");
    await user.click(within(dialog).getByRole("button", { name: "Crear galería" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Galería creada. Ya aparece en la lista.");
  });

  // The mirror case, and the reason <GalleryForm>'s effect keys off a boolean
  // rather than off the state object: a rejected submit must leave the dialog
  // open with the photographer's typing intact, and must not announce a
  // success that did not happen.
  it("stays open and announces nothing when the action reports an error", async () => {
    createGalleryMock.mockResolvedValue({
      status: "error",
      message: "Ese paquete ya no está disponible.",
    });
    const user = userEvent.setup();
    render(<DashboardGalleryCreateDialog clients={CLIENTS} packages={PACKAGES} />);

    await createOne(user);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toBeDefined();
    expect(within(dialog).getByText("Ese paquete ya no está disponible.")).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
