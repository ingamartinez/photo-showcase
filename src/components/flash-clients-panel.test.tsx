// @vitest-environment jsdom
//
// Task #247 — the flash panel was the ONE client-picker call site with no test
// file at all (its picker was shipped by #233 untested). This file exists so
// that "all three call sites share one control" is asserted rather than
// assumed: it pins the third call site's trigger, its empty branch verbatim,
// and that `attachFlashClients` still receives every selected id — the third
// action that reads `getAll("clientIds")`.
//
// Deliberately narrow: the assigned-clients list and the remove button are
// #233's own concern and are not re-tested here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlashClientsPanel } from "./flash-clients-panel";
import type { AttachFlashClientsState } from "@/app/dashboard/flash/actions";

const attachFlashClientsMock =
  vi.fn<(state: AttachFlashClientsState, formData: FormData) => Promise<AttachFlashClientsState>>();
const removeFlashClientMock = vi.fn<(flashGalleryId: string, userId: string) => Promise<void>>();
const refreshMock = vi.fn();

vi.mock("@/app/dashboard/flash/actions", () => ({
  attachFlashClients: (...args: [AttachFlashClientsState, FormData]) =>
    attachFlashClientsMock(...args),
  removeFlashClient: (...args: [string, string]) => removeFlashClientMock(...args),
}));

// Same mock shape as flash-uploader.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const FLASH_ID = "22222222-2222-4222-8222-222222222222";

const ELIGIBLE_CLIENTS = [
  { id: "u1", name: "Ana Pérez", email: "ana@example.com" },
  { id: "u2", name: null, email: "beto@example.com" },
];

beforeEach(() => {
  attachFlashClientsMock.mockReset();
  removeFlashClientMock.mockReset();
  refreshMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FlashClientsPanel — attaching clients (task #247)", () => {
  it("uses the shared client picker and submits every selected id with the flash gallery id", async () => {
    attachFlashClientsMock.mockResolvedValue({
      status: "attached",
      message: "Clientes agregados.",
    });
    const user = userEvent.setup();
    render(
      <FlashClientsPanel
        flashGalleryId={FLASH_ID}
        assignedClients={[]}
        eligibleClients={ELIGIBLE_CLIENTS}
      />,
    );

    // A button, not a `<select multiple>`: the shared `ClientPicker`.
    const trigger = screen.getByLabelText("Agregar clientes");
    expect(trigger.tagName).toBe("BUTTON");

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Ana Pérez" }));
    await user.click(screen.getByRole("option", { name: "beto@example.com" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Agregar" }));

    await screen.findByText("Clientes agregados.");
    const [, formData] = attachFlashClientsMock.mock.calls[0] as [
      AttachFlashClientsState,
      FormData,
    ];
    expect(formData.get("flashGalleryId")).toBe(FLASH_ID);
    expect(formData.getAll("clientIds")).toEqual(["u1", "u2"]);
  });

  it("renders the verbatim empty branch and no picker when nobody is left to add", () => {
    render(
      <FlashClientsPanel flashGalleryId={FLASH_ID} assignedClients={[]} eligibleClients={[]} />,
    );

    expect(screen.getByText("No quedan clientes por agregar.")).toBeDefined();
    expect(screen.queryByLabelText("Agregar clientes")).toBeNull();
  });
});
