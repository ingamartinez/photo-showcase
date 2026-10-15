// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GalleryClientSelection } from "./gallery-client-selection";
import { GalleryClientRow } from "./gallery-client-row";
import type { GalleryClientSelectionActionState } from "@/app/dashboard/galleries/actions";

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

afterEach(() => {
  cleanup();
  for (const mock of [lockMock, unlockMock, removeMock]) {
    mock.mockReset();
    mock.mockResolvedValue({ status: "done", message: "ok" });
  }
});

function renderSelection(
  selection: Parameters<typeof GalleryClientSelection>[0]["selection"],
  galleryStatus: Parameters<typeof GalleryClientSelection>[0]["galleryStatus"] = "proofing",
) {
  return render(
    <GalleryClientSelection
      galleryId={GALLERY_ID}
      clientId="u1"
      galleryStatus={galleryStatus}
      selection={selection}
    />,
  );
}

describe("GalleryClientSelection — states and counts", () => {
  it("open: 'Eligiendo' with its pick count; offers Bloquear and Quitar fotos but not Desbloquear", () => {
    renderSelection({ state: "open", pickCount: 3, submittedOn: null });

    expect(screen.getByText("3 fotos elegidas · Eligiendo")).toBeDefined();
    expect(screen.getByRole("button", { name: "Bloquear" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Quitar fotos" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Desbloquear" })).toBeNull();
  });

  it("submitted: 'Envió el {fecha}'; offers Desbloquear, not Bloquear", () => {
    renderSelection({ state: "submitted", pickCount: 1, submittedOn: "12/10/2026" });

    expect(screen.getByText("1 foto elegida · Envió el 12/10/2026")).toBeDefined();
    expect(screen.getByRole("button", { name: "Desbloquear" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Bloquear" })).toBeNull();
  });

  it("locked by the admin: 'Bloqueado por vos'", () => {
    renderSelection({ state: "locked", pickCount: 0, submittedOn: null });

    expect(screen.getByText("0 fotos elegidas · Bloqueado por vos")).toBeDefined();
    expect(screen.getByRole("button", { name: "Desbloquear" })).toBeDefined();
  });

  it("open with zero picks offers no remove button", () => {
    renderSelection({ state: "open", pickCount: 0, submittedOn: null });
    expect(screen.queryByRole("button", { name: "Quitar fotos" })).toBeNull();
  });

  it.each(["draft", "delivered", "archived"] as const)("offers no action on a %s gallery", (s) => {
    renderSelection({ state: "submitted", pickCount: 4, submittedOn: "12/10/2026" }, s);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("4 fotos elegidas · Envió el 12/10/2026")).toBeDefined();
  });
});

describe("GalleryClientSelection — actions", () => {
  it("Bloquear posts the gallery and client ids", async () => {
    const user = userEvent.setup();
    renderSelection({ state: "open", pickCount: 2, submittedOn: null });

    await user.click(screen.getByRole("button", { name: "Bloquear" }));

    const [, formData] = lockMock.mock.calls[0]!;
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("clientId")).toBe("u1");
  });

  it("Quitar fotos asks for confirmation first and names what happens; nothing is sent until Confirmar", async () => {
    const user = userEvent.setup();
    renderSelection({ state: "open", pickCount: 2, submittedOn: null });

    await user.click(screen.getByRole("button", { name: "Quitar fotos" }));
    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Se van a quitar las fotos que eligió esta persona/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Confirmar" }));
    const [, formData] = removeMock.mock.calls[0]!;
    expect(formData.get("clientId")).toBe("u1");
  });

  it("Cancelar leaves the picks alone", async () => {
    const user = userEvent.setup();
    renderSelection({ state: "open", pickCount: 2, submittedOn: null });

    await user.click(screen.getByRole("button", { name: "Quitar fotos" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(removeMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("a failed unlock email is shown as an alert", async () => {
    unlockMock.mockResolvedValue({ status: "done_email_failed", message: "No pudimos avisarle." });
    const user = userEvent.setup();
    renderSelection({ state: "submitted", pickCount: 2, submittedOn: "12/10/2026" });

    await user.click(screen.getByRole("button", { name: "Desbloquear" }));

    expect((await screen.findByRole("alert")).textContent).toBe("No pudimos avisarle.");
  });
});

describe("GalleryClientRow wiring", () => {
  it("renders the panel only when a selection is given", () => {
    const client = { id: "u1", name: "Ana", email: "ana@example.com" };
    const { rerender } = render(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={client}
        status="proofing"
        removable={false}
        resendable={false}
      />,
    );
    expect(screen.queryByText(/Eligiendo/)).toBeNull();

    rerender(
      <GalleryClientRow
        galleryId={GALLERY_ID}
        client={client}
        status="proofing"
        removable={false}
        resendable={false}
        selection={{ state: "open", pickCount: 5, submittedOn: null }}
      />,
    );
    expect(screen.getByText("5 fotos elegidas · Eligiendo")).toBeDefined();
  });
});
