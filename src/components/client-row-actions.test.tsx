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
import type { DeleteClientResult, UpdateClientState } from "@/app/dashboard/clients/actions";

const updateClientMock =
  vi.fn<(state: UpdateClientState, formData: FormData) => Promise<UpdateClientState>>();
const deleteClientMock = vi.fn<(userId: unknown) => Promise<DeleteClientResult>>();

vi.mock("@/app/dashboard/clients/actions", () => ({
  updateClient: (...args: [UpdateClientState, FormData]) => updateClientMock(...args),
  // Task #280 — declared here because the row component imports it: Vitest
  // throws on access to an export a mocked module does not declare.
  deleteClient: (...args: [unknown]) => deleteClientMock(...args),
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
  deleteClientMock.mockReset();
  vi.restoreAllMocks();
});

/** Opens the row's menu without choosing anything. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, name = CLIENT.name) {
  await user.click(screen.getByRole("button", { name: `Acciones para ${name}` }));
  return screen.findByRole("menu");
}

/** A promise the test resolves by hand, so "while pending" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

  // The one-root rule (plan D13) said: the row goes from four grid children to
  // five, never six — a second element here silently becomes another grid child
  // on the phone layouts.
  //
  // TASK #280 AMENDED IT, with the orchestrator's approval: the delete-blocked
  // message has to be a direct child of the row's <li> (that <li> is a CSS grid;
  // nested inside this component's ~44px menu cell it would be squeezed into a
  // column), so the component returns a FRAGMENT. The invariant that still
  // matters is kept and pinned below: exactly ONE child when there is nothing to
  // report, and at most two — never a stray third.
  it("renders exactly one child when it has nothing to report", () => {
    const { container } = render(<ClientRowActions client={CLIENT} />);
    expect(container.children).toHaveLength(1);
  });

  it("renders its two children — the cell and the message — only when blocked", async () => {
    window.confirm = vi.fn(() => true);
    deleteClientMock.mockResolvedValue({ ok: false, message: "No se puede eliminar: bloqueado." });
    const user = userEvent.setup();
    const { container } = render(<ClientRowActions client={CLIENT} />);

    expect(container.children).toHaveLength(1);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect(container.children).toHaveLength(2);
    // The message is the LAST child and spans the row's full width, which is
    // the whole reason it is not inside the cell above.
    expect(container.children[1].getAttribute("role")).toBe("alert");
    expect(container.children[1].className).toContain("col-span-full");
  });
});

// Task #280 — deleting a client from the row's menu. The confirmation, the
// pending flag and the blocked message all live in this component; the decision
// itself (and what counts as "blocked") is `deleteClient`'s suite.
describe("ClientRowActions — delete", () => {
  it("offers Eliminar next to Editar", async () => {
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Editar" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Eliminar" })).toBeDefined();
  });

  // Acceptance criterion: nothing happens without the confirmation. The
  // negative is what matters — a declined confirm must not reach the action.
  it("deletes nothing when the confirmation is declined", async () => {
    const confirmSpy = vi.fn((_message?: string) => false);
    window.confirm = confirmSpy;
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(deleteClientMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes this row's client once the confirmation is accepted", async () => {
    const confirmSpy = vi.fn((_message?: string) => true);
    window.confirm = confirmSpy;
    deleteClientMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    await waitFor(() => expect(deleteClientMock).toHaveBeenCalledWith(CLIENT.id));
    // The confirmation names the client: a name AND the email, because two
    // clients can share a name while the email is the unique identity.
    expect(confirmSpy.mock.calls[0]![0]).toContain("Ana Pérez");
    expect(confirmSpy.mock.calls[0]![0]).toContain("ana@example.com");
    expect(confirmSpy.mock.calls[0]![0]).toContain("No se puede deshacer");
  });

  // A client row created by the magic-link flow can genuinely have no name
  // (`users.name` is nullable), so the email alone has to be enough — and only
  // once, not "(null) ana@example.com".
  it("names only the email when the client has no name", async () => {
    const confirmSpy = vi.fn((_message?: string) => true);
    window.confirm = confirmSpy;
    deleteClientMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ClientRowActions client={{ ...CLIENT, name: null }} />);

    await openMenu(user, "ana@example.com");
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    await waitFor(() => expect(deleteClientMock).toHaveBeenCalled());
    expect(confirmSpy.mock.calls[0]![0]).toBe("¿Eliminar a ana@example.com? No se puede deshacer.");
  });

  // Acceptance criterion: "Un mensaje visible en la lista cuando se bloquea —
  // no un `alert` para ese caso: tiene que quedar en pantalla para leerlo y
  // actuar." Three assertions, one per clause: it renders as an alert ROLE
  // (visible, announced), `window.alert` is never used, and the node is still
  // there after the menu has closed and after a later tick — i.e. it is state,
  // not a message tied to the popover's lifetime.
  it("keeps the blocked message on screen, and never as an alert()", async () => {
    const message =
      "No se puede eliminar: tiene 2 galerías activas. Primero quítale el acceso desde cada una.";
    window.confirm = vi.fn(() => true);
    const alertSpy = vi.spyOn(window, "alert");
    deleteClientMock.mockResolvedValue({ ok: false, message });
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alertSpy).not.toHaveBeenCalled();
    // The menu closed on select, so this is already "after the popover is gone".
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Same NODE, not merely the same text: a re-render that replaced it would
    // drop the announcement for a screen-reader user.
    expect(screen.getByRole("alert")).toBe(alert);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("alert")).toBe(alert);
  });

  // A stale block next to a NEW attempt reads as the new attempt's answer.
  it("clears the previous message when a new attempt starts", async () => {
    window.confirm = vi.fn(() => true);
    deleteClientMock.mockResolvedValueOnce({
      ok: false,
      message: "No se puede eliminar: bloqueado.",
    });
    const second = deferred<DeleteClientResult>();
    deleteClientMock.mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No se puede eliminar: bloqueado.");

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    // While the second attempt is still in flight, the first answer must be gone.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    second.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  // Independent pending flags (gallery-client-row.tsx:43-50): the delete's
  // spinner must not disable "Editar". The menu closes on select, so the state
  // is observed by REOPENING it — which is also the case that matters, since a
  // second click while the first delete is in flight is the double-delete this
  // flag exists to prevent.
  it("disables only its own item while deleting, and keeps Editar usable", async () => {
    window.confirm = vi.fn(() => true);
    const pending = deferred<DeleteClientResult>();
    deleteClientMock.mockReturnValue(pending.promise);
    const user = userEvent.setup();
    render(<ClientRowActions client={CLIENT} />);

    await openMenu(user);
    await user.click(await screen.findByRole("menuitem", { name: "Eliminar" }));

    await openMenu(user);
    const deleting = await screen.findByRole("menuitem", { name: "Eliminando…" });
    expect(deleting.getAttribute("aria-disabled")).toBe("true");
    const edit = screen.getByRole("menuitem", { name: "Editar" });
    expect(edit.getAttribute("aria-disabled")).not.toBe("true");

    pending.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Eliminando…" })).toBeNull());
  });
});
