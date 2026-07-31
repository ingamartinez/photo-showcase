// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitSelectionPanel } from "./submit-selection-panel";
import { computeQuota } from "@/lib/quota";

// No `@/lib/format` mock needed — same reasoning as selection-counter.test.tsx:
// it has no `server-only`/`@/lib/db` import, so jsdom resolves it directly.

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SubmitSelectionPanel", () => {
  it("shows the already-submitted message and no button when the gallery is locked", () => {
    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(5, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked
        submittedAt="2026-07-28T12:00:00.000Z"
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.getByText(/Selección enviada/)).toBeDefined();
    // Pinned to the CORRECTED copy specifically — round-2 review's exact
    // finding: `/Selección enviada/` alone is a prefix shared by both this
    // honest string ("...tiene acceso a esta selección") and the earlier,
    // dishonest one this component used to render ("...ya fue notificado",
    // a guarantee the submit route cannot back up — see that component's
    // own header comment). Asserting only the shared prefix let a revert
    // back to the dishonest copy pass 27/27 green; this assertion is what
    // actually catches that regression.
    expect(screen.getByText(/tiene acceso/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Enviar selección" })).toBeNull();
  });

  it("renders the submit button when not locked", () => {
    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(5, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Enviar selección" })).toBeDefined();
  });

  it("disables the submit button when nothing is selected yet", () => {
    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(0, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Enviar selección" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  // Task #25's explicit acceptance criterion: the confirmation step states
  // what happens next, including that extras are settled outside the app.
  it("asks for confirmation stating the extras are settled outside the app before ever calling the submit route", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(15, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/fuera de la app/);
    // Cancelled -> never issues the request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Task #147: the shared-board framing (schema.ts:272-273's one-selection,
  // not one-per-client model) — this button closes the board for every
  // client attached to the gallery, not only the one tapping it.
  it("states the selection closes for everyone still picking, and cannot be reopened by the client alone", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(15, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/se cierra para todos/);
    expect(message).toMatch(/no se puede modificar sola/);
  });

  it("POSTs to the submit route and reports the outcome once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const submittedQuota = computeQuota(15, {
      includedPhotosSnapshot: 13,
      extraPhotoPriceCopSnapshot: 5_000,
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          status: "submitted",
          quota: submittedQuota,
          submittedAt: "2026-07-28T12:00:00.000Z",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={submittedQuota}
        isLocked={false}
        submittedAt={null}
        onSubmitted={onSubmitted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/submit-selection", {
      method: "POST",
    });
    await vi.waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith({
        quota: submittedQuota,
        submittedAt: "2026-07-28T12:00:00.000Z",
      });
    });
  });

  it("shows a specific message when the server refuses an empty selection", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(400, { error: "empty_selection" })));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(1, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() =>
      expect(screen.getByText("Elegí al menos una foto antes de enviar.")).toBeDefined(),
    );
  });

  it("shows a generic retry message on a server failure and never calls onSubmitted", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse(502, { error: "submission_failed" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(5, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={onSubmitted}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() =>
      expect(
        screen.getByText("No se pudo enviar la selección. Probá de nuevo en un momento."),
      ).toBeDefined(),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("shows a connection error message when fetch itself rejects", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("network unreachable")));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(5, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 })}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() => expect(screen.getByText("No se pudo conectar.")).toBeDefined());
  });
});
