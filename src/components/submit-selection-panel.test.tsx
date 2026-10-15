// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubmitSelectionPanel } from "./submit-selection-panel";
import { computeQuota } from "@/lib/quota";

// No `@/lib/format` mock needed — same reasoning as selection-counter.test.tsx:
// it has no `server-only`/`@/lib/db` import, so jsdom resolves it directly.

// Every fixture in THIS describe block passes 0 originals on purpose — see
// the "two-tariff confirmation" describe block below for the `originals > 0`
// cases (task #206).
//
// TASK #214'S OWN TRAP, RECORDED SO IT ISN'T RE-MADE: every render below
// passes `allowsOriginalSelection={true}`, even though this whole block is
// about zero originals. These tests (line 265's own "never mentions
// originals... when there are none" especially) guard the COUNT half of
// #206's rule; the switch being ON is what makes the count the operative
// condition. Setting it to `false` here would let the FLAG satisfy the
// precondition instead, making the count branch unreachable — exactly the
// review-round-1 defect this comment exists to prevent a repeat of. The
// flag's OWN "off -> no mention regardless of count" behavior gets its
// dedicated test in the "two-tariff confirmation" describe block below,
// which deliberately uses a NON-ZERO originals count so the two guards can
// never substitute for one another.
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
        quota={computeQuota(5, 0, SNAPSHOT)}
        isLocked
        submittedAt="2026-07-28T12:00:00.000Z"
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
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
        quota={computeQuota(5, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Enviar selección" })).toBeDefined();
  });

  it("disables the submit button when nothing is selected yet", () => {
    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(0, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
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
        quota={computeQuota(15, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/fuera de la app/);
    // Cancelled -> never issues the request.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Epic #239 replaced task #147's "closes the board for everyone" framing:
  // the lock is per person now, so the dialog must say it closes only YOUR
  // selection (with YOUR count) while the quota lines stay gallery-wide.
  it("states it closes only YOUR selection with YOUR count, that the quota is group-wide, and that the client cannot reopen alone", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(15, 0, SNAPSHOT)}
        ownPickCount={9}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    const message = confirmSpy.mock.calls[0]?.[0] as string;
    // 9 own picks out of a group-wide 15: the headline counts the viewer's.
    expect(message).toMatch(/¿Cerrar tu selección \(9 fotos tuyas\)\?/);
    expect(message).toMatch(/Solo se cierra tu selección/);
    expect(message).not.toMatch(/para todos/);
    expect(message).toMatch(/toda la galería, no solo las tuyas/);
    expect(message).toMatch(/no se puede modificar sola/);
  });

  it("POSTs to the submit route and reports the outcome once confirmed", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const submittedQuota = computeQuota(15, 0, SNAPSHOT);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          status: "submitted",
          quota: submittedQuota,
          submittedAt: "2026-07-28T12:00:00.000Z",
          // A group gallery: this submission did NOT close the gallery.
          gallerySelected: false,
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
        allowsOriginalSelection={true}
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
        gallerySelected: false,
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
        quota={computeQuota(1, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() =>
      expect(screen.getByText("Elige al menos una foto antes de enviar.")).toBeDefined(),
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
        quota={computeQuota(5, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={onSubmitted}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() =>
      expect(
        screen.getByText("No se pudo enviar la selección. Prueba de nuevo en un momento."),
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
        quota={computeQuota(5, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    await vi.waitFor(() => expect(screen.getByText("No se pudo conectar.")).toBeDefined());
  });

  // The governing constraint (task #206, restricting #205's own surface):
  // with zero originals, this confirmation must not mention them at all.
  it("never mentions originals in the confirmation dialog when there are none", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={computeQuota(15, 0, SNAPSHOT)}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    const confirmSpy = vi.mocked(window.confirm);
    const message = confirmSpy.mock.calls[0]?.[0] as string;
    expect(message).not.toMatch(/original/i);
  });
});

describe("SubmitSelectionPanel — the two-tariff confirmation (task #206)", () => {
  // Task #214 — defaults ON: every test in this describe block exercises a
  // confirmation with real originals present, which needs the switch on to
  // render at all.
  async function openConfirmation(
    quota: ReturnType<typeof computeQuota>,
    allowsOriginalSelection = true,
  ): Promise<string> {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();

    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={quota}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={allowsOriginalSelection}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    // `Intl.NumberFormat`'s `es-CO` currency output separates the symbol from
    // the digits with a NON-BREAKING space (U+00A0), not an ordinary one —
    // same collapsing `counterText()` already does in
    // selection-counter.test.tsx (`\s+` matches both), so a plain-space
    // literal in an assertion below means what it looks like it means.
    const raw = confirmSpy.mock.calls[0]?.[0] as string;
    return raw.replace(/\s+/g, " ");
  }

  // Criterion 3/4 — both summands non-zero, neither a multiple of the other.
  it("states both tariffs and the total once there are edited extras AND originals", async () => {
    const snapshot = {
      includedPhotosSnapshot: 7,
      extraPhotoPriceCopSnapshot: 5_000,
      extraPhotoPriceTiersSnapshot: null,
      originalPhotoPriceCopSnapshot: 2_000,
    };
    // 9 edited -> 2 over 7 -> 10_000. 3 originals -> 6_000. Total 16_000.
    const message = await openConfirmation(computeQuota(9, 3, snapshot));

    expect(message).toMatch(/Extras: 2 × \$ 5\.000 = \$ 10\.000\./);
    expect(message).toMatch(/Originales: 3 × \$ 2\.000 = \$ 6\.000\./);
    expect(message).toMatch(/Total: \$ 16\.000\./);
  });

  // The trap the task body names explicitly.
  it("states an original never counts toward the included quota", async () => {
    const message = await openConfirmation(computeQuota(5, 2, SNAPSHOT));

    expect(message).toMatch(/nunca cuenta para la cuota incluida/);
  });

  // Originals present, but the client stayed within the included edited
  // count — the extras line must not appear (it would falsely claim extras
  // exist), but the originals line must, and no "No tienes extras..." either.
  it("shows only the originals line when there are originals but no edited extras", async () => {
    const message = await openConfirmation(computeQuota(5, 2, SNAPSHOT));

    expect(message).not.toMatch(/Extras:/);
    expect(message).not.toMatch(/No tienes extras/);
    expect(message).toMatch(/Originales: 2 × \$ 2\.000 = \$ 4\.000\./);
    // Exactly one tariff line -> no separate "Total:" line (it would repeat
    // the same number).
    expect(message).not.toMatch(/Total:/);
  });

  it("still states the extras/surcharge situation is settled outside the app, with originals present", async () => {
    const message = await openConfirmation(computeQuota(5, 2, SNAPSHOT));

    expect(message).toMatch(/se coordina por fuera de la app/);
  });

  // Task #214 — same "absent, not zeroed" governing constraint as the
  // counter and the tray: a genuinely non-zero originals count must not
  // surface here while the gallery's own switch is off.
  it("never mentions originals when the switch is off, even with a real originals count", async () => {
    const message = await openConfirmation(computeQuota(5, 2, SNAPSHOT), false);

    expect(message).not.toMatch(/original/i);
  });
});

describe("SubmitSelectionPanel — volume tiers (task #231)", () => {
  const TIERS = [
    { minExtras: 1, priceCop: 15_000 },
    { minExtras: 3, priceCop: 13_000 },
    { minExtras: 5, priceCop: 11_000 },
    { minExtras: 10, priceCop: 10_000 },
  ];
  const TIERED = {
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 15_000,
    extraPhotoPriceTiersSnapshot: TIERS,
    originalPhotoPriceCopSnapshot: 2_000,
  };

  async function confirmationFor(quota: ReturnType<typeof computeQuota>): Promise<string> {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    render(
      <SubmitSelectionPanel
        galleryId="g1"
        quota={quota}
        isLocked={false}
        submittedAt={null}
        onSubmitted={vi.fn()}
        allowsOriginalSelection={true}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Enviar selección" }));
    return (confirmSpy.mock.calls[0]?.[0] as string).replace(/\s+/g, " ");
  }

  it("the confirmation states the reached tier's unit price and the volume total", async () => {
    const message = await confirmationFor(computeQuota(13 + 10, 0, TIERED));

    expect(message).toMatch(/Extras: 10 × \$ 10\.000 = \$ 100\.000\./);
  });

  it("a flat-price gallery's confirmation line is unchanged", async () => {
    const message = await confirmationFor(computeQuota(15, 0, SNAPSHOT));

    expect(message).toMatch(/Extras: 2 × \$ 5\.000 = \$ 10\.000\./);
  });
});

// Epic #239 (task #241): the locked line depends on WHOSE lock it is.
describe("SubmitSelectionPanel locked states (epic #239)", () => {
  const base = {
    galleryId: "g1",
    quota: computeQuota(15, 0, SNAPSHOT),
    submittedAt: "2026-10-15T13:00:00.000Z",
    onSubmitted: vi.fn(),
    allowsOriginalSelection: true,
  };

  it("viewer locked, gallery still open: their own selection was sent, the others still choose", () => {
    render(<SubmitSelectionPanel {...base} isLocked={true} isGalleryLocked={false} />);

    expect(screen.getByText(/Enviaste tu selección/)).toBeDefined();
    expect(screen.getByText(/Los demás todavía están eligiendo/)).toBeDefined();
    expect(screen.queryByText(/tiene acceso a esta selección/)).toBeNull();
  });

  it("locked by the photographer: says so and claims no submission", () => {
    render(
      <SubmitSelectionPanel
        {...base}
        submittedAt={null}
        isLocked={true}
        isGalleryLocked={false}
        lockedByAdmin={true}
      />,
    );

    expect(screen.getByText(/Tu fotógrafo cerró tu selección/)).toBeDefined();
    expect(screen.queryByText(/Enviaste/)).toBeNull();
  });

  it("gallery locked: the unchanged gallery-wide line", () => {
    render(<SubmitSelectionPanel {...base} isLocked={true} isGalleryLocked={true} />);

    expect(screen.getByText(/tiene acceso a esta selección/)).toBeDefined();
  });

  it("shows the server's admin refusal as a sentence, not the generic error", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(409, { error: "admin_cannot_submit" }))),
    );
    const user = userEvent.setup();

    render(<SubmitSelectionPanel {...base} submittedAt={null} isLocked={false} />);
    await user.click(screen.getByRole("button", { name: "Enviar selección" }));

    expect(
      await screen.findByText("El envío de la selección es solo para clientes."),
    ).toBeDefined();
  });
});
