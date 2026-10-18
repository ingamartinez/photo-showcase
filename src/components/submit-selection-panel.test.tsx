// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitSelectionPanel } from "./submit-selection-panel";
import { computeQuota } from "@/lib/quota";

// Epic #250 S7 replaced the old per-lock confirmation (which quoted the
// surcharge) with the owner-approved C10 send confirmation. The money lives
// in the fixed counter bar; this dialog owns only what the SEND does to the
// photos. These tests pin C9/C10, the disabled state, and the server refusals
// — the tariff arithmetic is already covered by quota.test.ts and
// selection-counter.test.tsx.
const SNAPSHOT = {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const base = {
  galleryId: "g1",
  quota: computeQuota(5, 0, SNAPSHOT),
  isLocked: false,
  submittedAt: null,
  onSubmitted: vi.fn(),
  allowsOriginalSelection: true,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SubmitSelectionPanel — send button (C9)", () => {
  it("labels the button with the viewer's own por-enviar count", () => {
    render(<SubmitSelectionPanel {...base} unsentCount={3} />);

    expect(screen.getByRole("button", { name: "Enviar las 3" })).toBeDefined();
  });

  it("uses the singular label for one photo", () => {
    render(<SubmitSelectionPanel {...base} unsentCount={1} />);

    expect(screen.getByRole("button", { name: "Enviar la foto" })).toBeDefined();
  });

  it("disables the button at zero por enviar", () => {
    render(<SubmitSelectionPanel {...base} unsentCount={0} />);

    expect(screen.getByRole("button", { name: "Enviar las 0" })).toHaveProperty("disabled", true);
  });

  it("is not rendered for a locked gallery, which keeps its sent message", () => {
    render(
      <SubmitSelectionPanel
        {...base}
        quota={computeQuota(5, 0, SNAPSHOT)}
        isLocked
        submittedAt="2026-07-28T12:00:00.000Z"
        unsentCount={0}
      />,
    );

    expect(screen.getByText(/tiene acceso/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Enviar/ })).toBeNull();
  });

  it("shows the admin preview note instead of a dead button", () => {
    render(<SubmitSelectionPanel {...base} isAdminPreview unsentCount={2} />);

    expect(screen.getByText(/solo para clientes/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Enviar/ })).toBeNull();
  });
});

describe("SubmitSelectionPanel — C10 confirmation", () => {
  it("states the send is irreversible, points to the photographer and explains the shared board", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} unsentCount={3} />);
    await user.click(screen.getByRole("button", { name: "Enviar las 3" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain("¿Envías estas 3?");
    expect(message).toContain("Lo que envíes ya no lo puedes sacar tú");
    expect(message).toContain("escríbele a tu fotógrafo");
    expect(message).toContain("Puedes seguir eligiendo y enviar más después");
    expect(message).toContain("Si alguien envía la misma antes que tú, queda a su nombre");
    expect(message).toContain("la selección se cierra sola");
    // Cancelled -> never issues the request.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the singular question for one photo", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} unsentCount={1} />);
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    expect(confirmSpy.mock.calls[0]?.[0] as string).toContain("¿Envías esta foto?");
  });
});

describe("SubmitSelectionPanel — server outcomes", () => {
  it("POSTs to the submit route and reports the outcome once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const submittedQuota = computeQuota(15, 0, SNAPSHOT);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          status: "submitted",
          quota: submittedQuota,
          submittedAt: "2026-07-28T12:00:00.000Z",
          gallerySelected: false,
          requestedCount: 2,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        {...base}
        quota={submittedQuota}
        onSubmitted={onSubmitted}
        unsentCount={2}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Enviar las 2" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/galleries/g1/submit-selection", {
      method: "POST",
    });
    await vi.waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith({
        quota: submittedQuota,
        submittedAt: "2026-07-28T12:00:00.000Z",
        gallerySelected: false,
        requestedCount: 2,
      });
    });
  });

  it("shows a specific message when the server refuses an empty selection", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(400, { error: "empty_selection" }))),
    );
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} unsentCount={1} />);
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    await vi.waitFor(() =>
      expect(screen.getByText("Elige al menos una foto antes de enviar.")).toBeDefined(),
    );
  });

  it("shows the server's admin refusal as a sentence, not the generic error", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(409, { error: "admin_cannot_submit" }))),
    );
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} unsentCount={1} />);
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    expect(
      await screen.findByText("El envío de la selección es solo para clientes."),
    ).toBeDefined();
  });

  it("shows a generic retry message on a server failure and never calls onSubmitted", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(502, { error: "submission_failed" }))),
    );
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} onSubmitted={onSubmitted} unsentCount={1} />);
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    await vi.waitFor(() =>
      expect(
        screen.getByText("No se pudo enviar la selección. Prueba de nuevo en un momento."),
      ).toBeDefined(),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("shows a connection error message when fetch itself rejects", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("network unreachable"))),
    );
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} unsentCount={1} />);
    await user.click(screen.getByRole("button", { name: "Enviar la foto" }));

    await vi.waitFor(() => expect(screen.getByText("No se pudo conectar.")).toBeDefined());
  });
});

describe("SubmitSelectionPanel — locked states (epic #239)", () => {
  const locked = {
    ...base,
    submittedAt: "2026-10-15T13:00:00.000Z",
    isLocked: true,
  };

  it("viewer locked, gallery still open: their own selection was sent, the others still choose", () => {
    render(<SubmitSelectionPanel {...locked} isGalleryLocked={false} />);

    expect(screen.getByText(/Enviaste tu selección/)).toBeDefined();
    expect(screen.getByText(/Los demás todavía están eligiendo/)).toBeDefined();
    expect(screen.queryByText(/tiene acceso a esta selección/)).toBeNull();
  });

  it("locked by the photographer: says so and claims no submission", () => {
    render(
      <SubmitSelectionPanel {...locked} submittedAt={null} isGalleryLocked={false} lockedByAdmin />,
    );

    expect(screen.getByText(/Tu fotógrafo cerró tu selección/)).toBeDefined();
    expect(screen.queryByText(/Enviaste/)).toBeNull();
  });

  it("gallery locked: the gallery-wide line", () => {
    render(<SubmitSelectionPanel {...locked} isGalleryLocked />);

    expect(screen.getByText(/tiene acceso a esta selección/)).toBeDefined();
  });
});
