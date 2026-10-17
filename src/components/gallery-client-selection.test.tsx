// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryClientRow } from "./gallery-client-row";
import type { GalleryClientSelectionActionState } from "@/app/dashboard/galleries/actions";
import type { ClientSelectionView } from "@/lib/client-selection-state";

type ActionFn = (
  state: GalleryClientSelectionActionState,
  formData: FormData,
) => Promise<GalleryClientSelectionActionState>;
const lockMock = vi.fn<ActionFn>();
const unlockMock = vi.fn<ActionFn>();
const removeMock = vi.fn<ActionFn>();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  lockGalleryClientSelection: (...args: Parameters<ActionFn>) => lockMock(...args),
  unlockGalleryClientSelection: (...args: Parameters<ActionFn>) => unlockMock(...args),
  removeGalleryClientPicks: (...args: Parameters<ActionFn>) => removeMock(...args),
  removeGalleryClient: vi.fn(),
  resendGalleryAccessEmail: vi.fn(),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = { id: "u1", name: "Ana Pérez", email: "ana@example.com" };

afterEach(() => {
  cleanup();
  lockMock.mockReset();
  lockMock.mockResolvedValue({ status: "done", message: "Bloqueamos la selección." });
  unlockMock.mockReset();
  unlockMock.mockResolvedValue({ status: "done", message: "Desbloqueamos la selección." });
  removeMock.mockReset();
  removeMock.mockResolvedValue({ status: "done", message: "Quitamos las fotos." });
});

function renderRow(
  selection: ClientSelectionView | undefined,
  status: Parameters<typeof GalleryClientRow>[0]["status"] = "proofing",
  extra: { removable?: boolean; resendable?: boolean } = {},
) {
  return render(
    <GalleryClientRow
      galleryId={GALLERY_ID}
      client={CLIENT}
      status={status}
      removable={extra.removable ?? false}
      resendable={extra.resendable ?? false}
      selection={selection}
    />,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: `Acciones para ${CLIENT.name}` }));
}

const OPEN: ClientSelectionView = { state: "open", pickCount: 3, submittedOn: null };
const SUBMITTED: ClientSelectionView = {
  state: "submitted",
  pickCount: 1,
  submittedOn: "12/10/2026",
};
const LOCKED: ClientSelectionView = { state: "locked", pickCount: 0, submittedOn: null };

describe("per-client selection — state line (inline)", () => {
  it("shows count and the three states", () => {
    const { unmount } = renderRow(OPEN);
    expect(screen.getByText("3 fotos elegidas · Eligiendo")).toBeDefined();
    unmount();
    const second = renderRow(SUBMITTED);
    expect(screen.getByText("1 foto elegida · Envió el 12/10/2026")).toBeDefined();
    second.unmount();
    renderRow(LOCKED);
    expect(screen.getByText("0 fotos elegidas · Bloqueado por vos")).toBeDefined();
  });

  // Task #244 — rolling delivery's row: "pedidas X · editadas Y · por enviar Z".
  // The owner's rule: the word "carrito" never reaches the UI.
  it("rolling delivery shows pedidas / editadas / por enviar and never says carrito", () => {
    renderRow({
      state: "open",
      pickCount: 6,
      submittedOn: null,
      order: { requested: 4, edited: 1, unsent: 2 },
    });

    expect(screen.getByText("pedidas 4 · editadas 1 · por enviar 2 · Eligiendo")).toBeDefined();
    expect(document.body.textContent ?? "").not.toMatch(/carrito/i);
  });

  it("without rolling delivery the row keeps the plain pick count", () => {
    renderRow(OPEN);

    expect(screen.queryByText(/pedidas/)).toBeNull();
  });

  it("is not rendered without a selection", () => {
    renderRow(undefined);
    expect(screen.queryByText(/Eligiendo/)).toBeNull();
  });
});

describe("per-client selection — entries live in the ⋯ menu", () => {
  it("adds NO inline buttons next to the line; the only control is the ⋯ trigger", () => {
    renderRow(OPEN);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      `Acciones para ${CLIENT.name}`,
    ]);
  });

  it("an open client offers Bloquear and Quitar sus fotos elegidas, not Desbloquear", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);

    expect(screen.getByRole("menuitem", { name: "Bloquear selección" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Desbloquear selección" })).toBeNull();
  });

  it("a submitted or admin-locked client offers Desbloquear, not Bloquear", async () => {
    const user = userEvent.setup();
    renderRow(SUBMITTED);
    await openMenu(user);
    expect(screen.getByRole("menuitem", { name: "Desbloquear selección" })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: "Bloquear selección" })).toBeNull();
  });

  it("is distinct from the existing 'Quitar' (remove the client)", async () => {
    const user = userEvent.setup();
    renderRow(OPEN, "proofing", { removable: true });
    await openMenu(user);

    const names = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(names).toContain("Quitar");
    expect(names).toContain("Quitar sus fotos elegidas");
  });

  it("shows the ⋯ trigger when ONLY selection entries exist (counts in hasActions)", () => {
    renderRow(OPEN, "proofing", { removable: false, resendable: false });
    expect(screen.getByRole("button", { name: `Acciones para ${CLIENT.name}` })).toBeDefined();
  });

  it.each(["draft", "delivered", "archived"] as const)(
    "offers no selection entry (and no trigger) on a %s gallery",
    (status) => {
      renderRow(SUBMITTED, status);
      expect(screen.queryByRole("button", { name: /Acciones para/ })).toBeNull();
    },
  );
});

describe("per-client selection — actions", () => {
  it("Bloquear selección posts the ids and the lock op", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));

    const [, formData] = lockMock.mock.calls[0]!;
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("clientId")).toBe("u1");
    expect(unlockMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  it("Desbloquear selección calls the unlock action only", async () => {
    const user = userEvent.setup();
    renderRow(SUBMITTED);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    expect(unlockMock).toHaveBeenCalledTimes(1);
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("Quitar sus fotos elegidas asks for confirmation first, naming what happens", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" }));

    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Se van a quitar las fotos que eligió esta persona/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    const [, formData] = removeMock.mock.calls[0]!;
    expect(formData.get("clientId")).toBe("u1");
    expect(lockMock).not.toHaveBeenCalled();
  });

  it("Cancelar leaves the picks alone", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("turns the confirmation step off after a successful removal", async () => {
    const user = userEvent.setup();
    renderRow(OPEN);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Quitar sus fotos elegidas" }));
    await user.click(screen.getByRole("button", { name: "Confirmar" }));

    await screen.findByText("Quitamos las fotos.");
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByText(/Se van a quitar las fotos/)).toBeNull();
  });
});

describe("per-client selection — only the most recent result is shown", () => {
  it("after Bloquear then Desbloquear, only the unlock message remains", async () => {
    const user = userEvent.setup();
    // The row keeps its (static) props between the two clicks, so both entries
    // must be reachable: use a locked view for the second step by re-rendering.
    const { rerender } = renderRow(OPEN);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Bloquear selección" }));
    await screen.findByText("Bloqueamos la selección.");

    rerender(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={CLIENT}
        status="proofing"
        removable={false}
        resendable={false}
        selection={LOCKED}
      />,
    );
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    await screen.findByText("Desbloqueamos la selección.");
    expect(screen.queryByText("Bloqueamos la selección.")).toBeNull();
  });

  it("a failed unlock email is an alert, replacing the earlier success", async () => {
    unlockMock.mockResolvedValue({ status: "done_email_failed", message: "No pudimos avisarle." });
    const user = userEvent.setup();
    renderRow(SUBMITTED);
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Desbloquear selección" }));

    expect((await screen.findByRole("alert")).textContent).toBe("No pudimos avisarle.");
  });
});
