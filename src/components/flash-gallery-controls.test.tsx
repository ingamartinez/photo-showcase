// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlashGalleryControls } from "./flash-gallery-controls";

const setPublicMock = vi.fn();
const deleteGalleryMock = vi.fn();
vi.mock("@/app/dashboard/flash/actions", () => ({
  setFlashGalleryPublic: (...args: unknown[]) => setPublicMock(...args),
  deleteFlashGallery: (...args: unknown[]) => deleteGalleryMock(...args),
}));

const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

const FLASH_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  setPublicMock.mockReset();
  deleteGalleryMock.mockReset();
  pushMock.mockReset();
  refreshMock.mockReset();
  vi.restoreAllMocks();
});

function renderControls(initialIsPublic: boolean) {
  return render(
    <FlashGalleryControls
      flashGalleryId={FLASH_ID}
      publicPath="/flash/abc123"
      initialIsPublic={initialIsPublic}
    />,
  );
}

describe("FlashGalleryControls", () => {
  it("turns a private gallery public by asking the action for true", async () => {
    setPublicMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderControls(false);

    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);

    await waitFor(() => expect(setPublicMock).toHaveBeenCalledWith(FLASH_ID, true));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("turns a public gallery private by asking for false", async () => {
    setPublicMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderControls(true);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(setPublicMock).toHaveBeenCalledWith(FLASH_ID, false));
  });

  it("keeps the old state and shows the error when the action refuses", async () => {
    setPublicMock.mockResolvedValue({ ok: false, message: "La galería no existe." });
    const user = userEvent.setup();
    renderControls(false);
    await user.click(screen.getByRole("switch"));
    await screen.findByText("La galería no existe.");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("copies the absolute /flash/<slug> link", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderControls(true);
    await user.click(screen.getByRole("button", { name: "Copiar enlace" }));
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/flash/abc123`);
  });

  it("deletes only after confirmation and then returns to the list", async () => {
    deleteGalleryMock.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm");
    renderControls(false);

    confirm.mockReturnValueOnce(false);
    await user.click(screen.getByRole("button", { name: "Borrar galería" }));
    expect(deleteGalleryMock).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "Borrar galería" }));
    await waitFor(() => expect(deleteGalleryMock).toHaveBeenCalledWith(FLASH_ID));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard/flash"));
  });
});
