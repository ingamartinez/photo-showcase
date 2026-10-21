// @vitest-environment jsdom
//
// Task #279 — the clients list's per-row "⋯" menu, and the two things that
// make a save PERCEIVABLE after the dialog closes: the live region that
// survives the portal unmounting, and the focus hand-back to the trigger.
// Both are asserted here rather than inside edit-client-dialog.test.tsx
// because the dialog cannot provide either one on its own.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClientRowActions } from "./client-row-actions";
import type { EditableClient } from "./edit-client-dialog";
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

async function openEditDialog(user: ReturnType<typeof userEvent.setup>, name = CLIENT.name) {
  await user.click(screen.getByRole("button", { name: `Acciones para ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: "Editar" }));
  return screen.findByRole("dialog");
}

afterEach(() => {
  cleanup();
  updateClientMock.mockReset();
});

describe("ClientRowActions", () => {
  it("names the trigger after the client", () => {
    render(<ClientRowActions client={CLIENT} />);
    expect(screen.getByRole("button", { name: "Acciones para Ana Pérez" })).toBeDefined();
  });

  // The same fallback the list row itself uses (`client.name ?? client.email`).
  it("falls back to the email when the client has no name", () => {
    render(<ClientRowActions client={{ ...CLIENT, name: null }} />);
    expect(screen.getByRole("button", { name: "Acciones para ana@example.com" })).toBeDefined();
  });

  // The epic's row-menu pattern, as gallery-client-row.tsx already ships it:
  // Radix owns `aria-expanded`, so this is a parity check on the mechanism.
  it("reports the menu's open state through aria-expanded", async () => {
    updateClientMock.mockResolvedValue({ status: "idle" });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    const trigger = screen.getByRole("button", { name: "Acciones para Ana Pérez" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the edit dialog prefilled for this row's client", async () => {
    updateClientMock.mockResolvedValue({ status: "idle" });
    const user = userEvent.setup();
    render(<ClientRowActions client={{ ...CLIENT, name: "Beto Ruiz" }} />);

    const dialog = await openEditDialog(user, "Beto Ruiz");

    expect((within(dialog).getByLabelText("Correo electrónico") as HTMLInputElement).value).toBe(
      "ana@example.com",
    );
    expect((within(dialog).getByLabelText("Nombre") as HTMLInputElement).value).toBe("Beto Ruiz");
    // The row selector the action updates comes from THIS row's client, not
    // from a stale closure or the previously opened row.
    const userId = dialog.querySelector<HTMLInputElement>('input[name="userId"]');
    expect(userId?.value).toBe(CLIENT.id);
  });

  it("mounts an empty live region before anything has happened", () => {
    render(<ClientRowActions client={CLIENT} />);

    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    expect(region.getAttribute("aria-live")).toBe("polite");
  });

  it("announces the save from outside the dialog, so closing cannot take it away", async () => {
    updateClientMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    // Captured BEFORE the interaction: comparing node IDENTITY is what proves
    // the region survived rather than being torn down and replaced.
    const region = screen.getByRole("status");

    const dialog = await openEditDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Cliente actualizado.");
    expect(document.body.contains(region)).toBe(true);
  });

  // Review round 1 (task #279) — the defect the single-cycle test above could
  // not see. The menu item used to call `setEditOpen(true)` directly, skipping
  // `handleOpenChange`, the only place the previous notice is cleared. The
  // region stayed at "Cliente actualizado." across the second cycle, so the
  // second save wrote the SAME string and assistive technology had nothing new
  // to announce — and because the dialog closes on success, that region is the
  // only success feedback there is.
  //
  // Two cycles on ONE mount, modelling the real page: revalidation re-renders
  // the keyed row with new props but keeps its state. The observed sequence is
  // asserted directly (empty while the dialog is open, notice after each save)
  // and also through a MutationObserver, which is the probe shape that caught
  // the bug: [notice, "", notice].
  it("announces two successive saves, clearing the notice every time it reopens", async () => {
    updateClientMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    const { rerender } = render(<ClientRowActions client={CLIENT} />);

    const region = screen.getByRole("status");
    // Text changes only: what a live region actually experiences.
    const observed: string[] = [];
    const observer = new MutationObserver(() => observed.push(region.textContent ?? ""));
    observer.observe(region, { characterData: true, childList: true, subtree: true });

    // --- cycle 1 ---
    let dialog = await openEditDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Cliente actualizado.");

    // `revalidatePath("/dashboard/clients")` refreshes the keyed <li>: same
    // component instance, new props. A remount would hide the bug.
    rerender(<ClientRowActions client={{ ...CLIENT, name: "Ana Pérez Gómez" }} />);

    // --- cycle 2, same mounted row ---
    dialog = await openEditDialog(user, "Ana Pérez Gómez");
    // The assertion the bug failed: reopening resets the region.
    expect(region.textContent).toBe("");

    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(region.textContent).toBe("Cliente actualizado.");

    await waitFor(() => expect(observed.at(-1)).toBe("Cliente actualizado."));
    observer.disconnect();
    expect(observed).toEqual(["Cliente actualizado.", "", "Cliente actualizado."]);
  });

  it("closes on Escape and hands focus back to the row trigger", async () => {
    updateClientMock.mockResolvedValue({ status: "idle" });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    const trigger = screen.getByRole("button", { name: "Acciones para Ana Pérez" });
    await openEditDialog(user);
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the trigger after a successful save too", async () => {
    updateClientMock.mockResolvedValue({ status: "updated" });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    const trigger = screen.getByRole("button", { name: "Acciones para Ana Pérez" });
    const dialog = await openEditDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  // The one-root rule (plan D13): the row goes from four grid children to
  // five. A second root element here silently becomes a sixth grid child on
  // the phone layouts — the bug this pins.
  it("renders exactly one root element", () => {
    const { container } = render(<ClientRowActions client={CLIENT} />);
    expect(container.children).toHaveLength(1);
  });
});
