// @vitest-environment jsdom
//
// Task #287 (round 2, UI) — the cleanup-recovery notice. Its module imports
// `retryReopenedFinalCleanup` from the server actions module (which drags in
// `server-only` and the real database), so that module is mocked wholesale
// here, same as every other component test that mounts a `useActionState`
// form.
//
// WHAT THIS SUITE PROVES, and the risk behind each one:
//
// - The pending paragraph names the DURABLE count it was given. A hardcoded
//   or locally-incremented number would describe a different obligation than
//   the one the server holds.
// - The retry submits the gallery id and the render-time epoch ONLY. Passing
//   object keys — or anything else the client could shape — would let the
//   admin action delete arbitrary storage paths.
// - Pending blocks a second retry (a double click must not start two drains).
// - Cleaned / failed / stale are three visibly different outcomes, and a stale
//   epoch's message replaces the notice instead of contradicting it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingFinalCleanupNotice } from "./pending-final-cleanup-notice";
import type { RetryReopenedFinalCleanupState } from "@/app/dashboard/galleries/actions";

const retryMock =
  vi.fn<
    (
      state: RetryReopenedFinalCleanupState,
      formData: FormData,
    ) => Promise<RetryReopenedFinalCleanupState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  retryReopenedFinalCleanup: (...args: [RetryReopenedFinalCleanupState, FormData]) =>
    retryMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";
const EPOCH = "2026-10-25T14:31:07.123Z";

const RETRY = "Reintentar limpieza";
const RETRY_PENDING = "Reintentando…";
const CLEANED = "Limpieza de finales completada.";
const STALE =
  "La limpieza pendiente ya no corresponde a esta galería — puede que se haya reintentado o " +
  "que la galería se haya vuelto a reabrir.";

function pendingCopy(count: number) {
  return (
    "La galería quedó reabierta, pero no pudimos borrar todos los finales viejos " +
    `(${count} archivo(s) pendiente(s)). Reintentá la limpieza; mientras tanto no reabras ni ` +
    "elimines esta galería."
  );
}

afterEach(() => {
  cleanup();
  retryMock.mockReset();
});

function renderNotice(remainingKeys = 4) {
  return render(
    <PendingFinalCleanupNotice
      galleryId={GALLERY_ID}
      reopenEpoch={EPOCH}
      remainingKeys={remainingKeys}
    />,
  );
}

describe("PendingFinalCleanupNotice — the pending obligation", () => {
  it("names the durable count the server read", () => {
    renderNotice(7);

    expect(screen.getByText(pendingCopy(7))).toBeDefined();
    expect(screen.getByRole("button", { name: RETRY })).toBeDefined();
  });

  it("retries with the gallery id and the rendered epoch, and nothing else", async () => {
    retryMock.mockResolvedValue({ status: "cleaned" });
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: RETRY }));

    await waitFor(() => expect(retryMock).toHaveBeenCalledTimes(1));
    const [, formData] = retryMock.mock.calls[0]!;
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("expectedEpoch")).toBe(EPOCH);
    // Keys are the manifest's business, never the client's: no third field
    // may exist that the action could read as a storage path.
    expect(new Set(formData.keys())).toEqual(new Set(["galleryId", "expectedEpoch"]));
  });

  it("blocks a second retry while the first one is pending", async () => {
    // Settled only after the assertion — a hanging promise would leave React's
    // action transition pending for the rest of the file.
    let settle: (state: RetryReopenedFinalCleanupState) => void = () => {};
    retryMock.mockReturnValue(
      new Promise<RetryReopenedFinalCleanupState>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: RETRY }));

    const pendingButton = await screen.findByRole("button", { name: RETRY_PENDING });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect(retryMock).toHaveBeenCalledTimes(1);

    settle({ status: "cleaned" });
    expect((await screen.findByRole("status")).textContent).toBe(CLEANED);
  });
});

describe("PendingFinalCleanupNotice — the three retry outcomes are distinct", () => {
  it("replaces the notice with a status when the cleanup completed", async () => {
    retryMock.mockResolvedValue({ status: "cleaned" });
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: RETRY }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(CLEANED);
    // Nothing is owed any more: neither the notice nor a retry button remains.
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(screen.queryByText(pendingCopy(4))).toBeNull();
  });

  it("keeps the obligation visible and reports the fresh count when the retry fails", async () => {
    retryMock.mockResolvedValue({ status: "cleanup_failed", remainingCleanupKeys: 2 });
    const user = userEvent.setup();
    renderNotice(4);

    await user.click(screen.getByRole("button", { name: RETRY }));

    const alerts = (await screen.findAllByRole("alert")).map((node) => node.textContent);
    // The gallery is still reopened with cleanup owed — the notice survives…
    expect(alerts).toContain(pendingCopy(4));
    // …and the failure names the remainder that is left now.
    expect(alerts).toContain(
      "No pudimos terminar la limpieza. Quedan 2 archivo(s) pendiente(s); reintentá en un rato.",
    );
    // The retry stays available: the obligation is still there.
    expect(screen.getByRole("button", { name: RETRY })).toBeDefined();
  });

  it("renders the action's own message when the drainer could not count the remainder", async () => {
    retryMock.mockResolvedValue({
      status: "cleanup_failed",
      message: "No pudimos terminar la limpieza. Reintentá en un rato.",
    });
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: RETRY }));

    const alerts = (await screen.findAllByRole("alert")).map((node) => node.textContent);
    expect(alerts).toContain("No pudimos terminar la limpieza. Reintentá en un rato.");
  });

  it("replaces the notice with the stale-epoch message instead of contradicting it", async () => {
    retryMock.mockResolvedValue({ status: "error", message: STALE });
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole("button", { name: RETRY }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(STALE);
    // The notice described an obligation that no longer belongs to this
    // gallery; showing both would be a contradiction.
    expect(screen.queryByText(pendingCopy(4))).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
