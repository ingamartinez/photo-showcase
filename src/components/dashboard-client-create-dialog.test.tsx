// @vitest-environment jsdom
//
// Task #132, same shape as dashboard-gallery-create-dialog.test.tsx for task
// #131. Its subject is not "does the dialog close" (that is a means) but "is
// the success PERCEIVABLE after it closes" (the acceptance criterion), which
// is why every assertion below is about the live region rather than about the
// callback firing in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DashboardClientCreateDialog } from "./dashboard-client-create-dialog";
import type { CreateClientState } from "@/app/dashboard/clients/actions";

const createClientMock =
  vi.fn<(state: CreateClientState, formData: FormData) => Promise<CreateClientState>>();

vi.mock("@/app/dashboard/clients/actions", () => ({
  createClient: (...args: [CreateClientState, FormData]) => createClientMock(...args),
}));

beforeEach(() => {
  createClientMock.mockReset();
});

afterEach(() => {
  cleanup();
});

/** Opens the dialog, fills the required fields and submits. */
async function createOne(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Nuevo cliente" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText("Nombre"), "Ana Pérez");
  await user.type(within(dialog).getByLabelText("Correo electrónico"), "ana@example.com");
  await user.click(within(dialog).getByRole("button", { name: "Agregar cliente" }));
}

describe("DashboardClientCreateDialog", () => {
  it("mounts an empty live region before anything has happened", () => {
    render(<DashboardClientCreateDialog />);

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("announces the creation from outside the dialog, so closing cannot take it away", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardClientCreateDialog />);

    // Captured BEFORE the interaction: the assertion at the end compares node
    // IDENTITY, which is what proves the region survived rather than being
    // torn down and replaced (a replacement is a region a screen reader never
    // announces).
    const region = screen.getByRole("status");

    await createOne(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Cliente agregado. Ya aparece en la lista.");
    expect(region.isConnected).toBe(true);
    expect(document.body.contains(region)).toBe(true);
  });

  it("returns focus to the trigger and keeps the announcement", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardClientCreateDialog />);

    const trigger = screen.getByRole("button", { name: "Nuevo cliente" });
    await createOne(user);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("status").textContent).toContain("Cliente agregado.");
  });

  // A live region only announces when its text CHANGES. Two identical
  // successes in a row would otherwise be one announcement and one silent
  // no-op, which is the same defect as having no region at all — for the
  // second client. Reopening the dialog is what resets it.
  it("re-announces a second creation instead of going silent", async () => {
    createClientMock.mockResolvedValue({ status: "created" });
    const user = userEvent.setup();
    render(<DashboardClientCreateDialog />);

    const region = screen.getByRole("status");

    await createOne(user);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Cliente agregado. Ya aparece en la lista.");

    // Reopening clears it — the "" the next success transitions away from.
    await user.click(screen.getByRole("button", { name: "Nuevo cliente" }));
    await screen.findByRole("dialog");
    expect(region.textContent).toBe("");

    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("Nombre"), "Beto Ruiz");
    await user.type(within(dialog).getByLabelText("Correo electrónico"), "beto@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Agregar cliente" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Cliente agregado. Ya aparece en la lista.");
  });

  // The mirror case, and the reason <ClientForm>'s effect keys off a boolean
  // rather than off the state object: a rejected submit must leave the dialog
  // open with the photographer's typing intact, and must not announce a
  // success that did not happen.
  it("stays open and announces nothing when the action reports an error", async () => {
    createClientMock.mockResolvedValue({
      status: "error",
      message: "Ya existe un cliente con ese correo electrónico.",
    });
    const user = userEvent.setup();
    render(<DashboardClientCreateDialog />);

    await createOne(user);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toBeDefined();
    expect(
      within(dialog).getByText("Ya existe un cliente con ese correo electrónico."),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
