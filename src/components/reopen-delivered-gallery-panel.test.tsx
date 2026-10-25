// @vitest-environment jsdom
//
// Task #287 (round 2, UI) — the delivered-reopen panel. Its module imports
// `reopenDeliveredGallery` from the server actions module, which transitively
// pulls `@/lib/auth-guards` (`import "server-only"`, unresolvable under jsdom)
// and the real database, so the actions module is mocked wholesale, exactly
// like every other component test that mounts a `useActionState` form.
//
// WHAT THIS SUITE PROVES, and why each one is a real risk:
//
// - The trigger and the Cancel button call the action ZERO times. Opening a
//   confirmation is not consent; a form that submits from its trigger would
//   delete a delivered gallery's finals on a stray click.
// - Confirming sends the gallery id and the optional reason ONCE, and nothing
//   else (no keys, no counter, no client ids).
// - A pending action cannot be resubmitted.
// - `reopened`, `reopened_email_failed`, `reopened_cleanup_failed` and `error`
//   are four visibly different outcomes. The cleanup failure in particular is
//   an ALERT with the durable count, never the quiet success status — the
//   reopen committed, but bytes are still owed.
// - WHEN BOTH CLEANUP AND EMAIL FAIL, BOTH ALERTS ARE VISIBLE (task #287 UI
//   review, finding 1). The cleanup failure owns `message`; the notification
//   outcome travels independently (`emailFailed` + the addresses), and losing
//   it here would lose it for good because a cleanup retry never sends an
//   email.
// - The confirmation body is the owner's approved copy verbatim, and the
//   fourth paragraph is the only one that changes between ordinary and
//   rolling delivery.
// - The dialog ships no inherited English `Close` button, and a committed
//   outcome takes keyboard focus instead of dropping it on BODY.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReopenDeliveredGalleryPanel } from "./reopen-delivered-gallery-panel";
import type { ReopenDeliveredGalleryState } from "@/app/dashboard/galleries/actions";

const reopenMock =
  vi.fn<
    (state: ReopenDeliveredGalleryState, formData: FormData) => Promise<ReopenDeliveredGalleryState>
  >();

vi.mock("@/app/dashboard/galleries/actions", () => ({
  reopenDeliveredGallery: (...args: [ReopenDeliveredGalleryState, FormData]) => reopenMock(...args),
}));

const GALLERY_ID = "11111111-1111-4111-8111-111111111111";

// The owner's approved copy, transcribed once, in the TUTEO the owner's standing
// decision requires (Q8, #262/#263). These constants are the assertion targets,
// so a paraphrase anywhere in the component fails here instead of shipping. The
// EMAIL-failure sentences are derived from the panel's own shipped function
// below, for the reason stated there.
const TRIGGER = "Reabrir entrega";
const PENDING = "Reabriendo…";
const TITLE = "¿Reabrir esta galería entregada?";
const CONFIRM = "Reabrir y borrar finales";
const CANCEL = "Cancelar";

const FACT_CANCELLED =
  "Se cancela la selección que ya estaba enviada: cada persona vuelve a tener sus fotos como " +
  "carrito y tiene que elegir y enviar de nuevo.";
const FACT_FINALS =
  "También se borran los finales que ya subiste de esta galería y sus versiones de vista " +
  "previa, incluidos los regalos: tienes que volver a subirlos todos para entregar otra vez.";
const FACT_MONEY =
  "Los extras y el recargo se recalculan con este nuevo envío, así que lo que se facturó antes " +
  "queda en cero (lo ya cobrado lo arreglas por fuera, como siempre). No hay forma de deshacer " +
  "esto desde la app.";
const AVAILABILITY_NORMAL =
  "Mientras tanto nadie puede descargar los finales de esta galería. Los archivos que el cliente " +
  "ya se descargó no se pueden recuperar.";
const AVAILABILITY_ROLLING =
  "Mientras no haya finales nuevos no hay nada para descargar; a medida que los vuelvas a subir, " +
  "el cliente los va a poder bajar sin esperar a la nueva entrega.";

const SUCCESS =
  "Galería reabierta — cada cliente puede volver a elegir, y les avisamos por correo.";
const CLEANUP_PENDING_3 =
  "La galería quedó reabierta, pero no pudimos borrar todos los finales viejos (3 archivo(s) " +
  "pendiente(s)). Reintenta la limpieza; mientras tanto no reabras ni elimines esta galería.";
const DRAIN_THREW =
  "La galería quedó reabierta, pero no pudimos terminar de borrar los finales viejos. Reintenta " +
  "la limpieza desde el detalle de la galería.";

// --- the EMAIL-failure sentence -------------------------------------------
//
// These two sentences are the panel's OWN shipped copy (`emailFailureText`),
// built from the addresses the action reports. The UI review's finding 3 was a
// suite that asserted an approved sentence while a DIFFERENT, unapproved one
// reached the admin: the panel used to render `actions.ts`'s message verbatim,
// so the test was asserting a string no production path emitted. The sentence
// now lives in exactly one place — the layer that displays it — so a change to
// the wording cannot pass here, and there is no second copy to drift from.
//
// (`actions.ts` reports `emailFailed` + the addresses and carries no sentence;
// the panel owns the wording it displays.)
const EMAIL_PARTIAL_LEAD = "Reabrimos la galería, pero no pudimos avisarle por correo a: ";
const EMAIL_ZERO_RECIPIENTS_LEAD =
  "Reabrimos la galería, pero no encontramos clientes para avisar por correo. ";
const EMAIL_TAIL = "Avísale por otro medio (WhatsApp / llamada).";

/** The partial-failure sentence, with the addresses the action reported. */
function partialEmailFailure(...emails: string[]): string {
  return `${EMAIL_PARTIAL_LEAD}${emails.join(", ")}. ${EMAIL_TAIL}`;
}

/** The zero-recipient sentence: `emailFailed` with nobody to mail. */
function zeroRecipientsEmailFailure(): string {
  return `${EMAIL_ZERO_RECIPIENTS_LEAD}${EMAIL_TAIL}`;
}

afterEach(() => {
  cleanup();
  reopenMock.mockReset();
});

function renderPanel(rollingDelivery = false) {
  return render(
    <ReopenDeliveredGalleryPanel galleryId={GALLERY_ID} rollingDelivery={rollingDelivery} />,
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: TRIGGER }));
  return screen.findByRole("dialog");
}

async function confirm(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await openDialog(user);
  await user.click(within(dialog).getByRole("button", { name: CONFIRM }));
}

describe("ReopenDeliveredGalleryPanel — opening and cancelling never execute", () => {
  it("opens the confirmation dialog without calling the action", async () => {
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(TITLE)).toBeDefined();
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("closing with Cancelar never calls the action", async () => {
    // A VALID committed result on the mock, so the cancel-as-submit mutation
    // fails on the no-call assertion below instead of on a runtime TypeError
    // while rendering `undefined.status` (review suggestion M2). The assertion
    // is meant to be "nothing was submitted", not "the component crashed".
    reopenMock.mockResolvedValue({ status: "reopened" });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CANCEL }));

    // Radix unmounts the content: the dialog is really closed, not merely
    // hidden, so nothing in it can be submitted afterwards.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("ships no inherited Close button, and Cancelar still closes without submitting", async () => {
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);

    // `ui/dialog.tsx` renders a default close button whose accessible name is
    // an English `Close`; this panel already has the approved way out, so the
    // inherited one is suppressed (`showCloseButton={false}`).
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /cerrar/i })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: CANCEL }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(reopenMock).not.toHaveBeenCalled();
  });
});

describe("ReopenDeliveredGalleryPanel — confirming submits exactly once", () => {
  it("sends the gallery id and the optional reason, and nothing else", async () => {
    reopenMock.mockResolvedValue({ status: "reopened" });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText("Nota (opcional)"), "ojos cerrados");
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    await waitFor(() => expect(reopenMock).toHaveBeenCalledTimes(1));
    const [, formData] = reopenMock.mock.calls[0]!;
    expect(formData.get("galleryId")).toBe(GALLERY_ID);
    expect(formData.get("reason")).toBe("ojos cerrados");
    // No fourth field: the action takes the id and the note, never keys or
    // ids the client could use to widen the destructive write.
    expect(new Set(formData.keys())).toEqual(new Set(["galleryId", "reason"]));
  });

  it("blocks a second confirmation while the first one is pending", async () => {
    // A promise the test settles only after asserting: the panel has to stay
    // pending during the whole window a double click would exploit. The test
    // MUST resolve it before finishing — React 19's `useActionState` keeps
    // the transition pending across the file if it is left hanging, which
    // silently stops every later test in this suite from ever seeing a
    // resolved state.
    let settle: (state: ReopenDeliveredGalleryState) => void = () => {};
    reopenMock.mockReturnValue(
      new Promise<ReopenDeliveredGalleryState>((resolve) => {
        settle = resolve;
      }),
    );
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    const pendingTrigger = await screen.findByRole("button", { name: PENDING });
    expect((pendingTrigger as HTMLButtonElement).disabled).toBe(true);
    expect(reopenMock).toHaveBeenCalledTimes(1);

    settle({ status: "reopened" });
    expect((await screen.findByRole("status")).textContent).toBe(SUCCESS);
  });
});

describe("ReopenDeliveredGalleryPanel — the four outcomes are visibly distinct", () => {
  it("renders a completed reopen as a quiet status", async () => {
    reopenMock.mockResolvedValue({ status: "reopened" });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(SUCCESS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the email failure with every address the action reported", async () => {
    const message = partialEmailFailure("ana@example.com", "beto@example.com");
    reopenMock.mockResolvedValue({
      status: "reopened_email_failed",
      emailFailed: true,
      failedEmails: ["ana@example.com", "beto@example.com"],
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alert = await screen.findByRole("alert");
    // The exact sentence `emailFailureText` ships, with the addresses joined as
    // the approved copy shows them.
    expect(alert.textContent).toBe(message);
    // Distinct from success: an email failure is never reported as a status.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the zero-recipient wording when nobody was left to mail", async () => {
    const message = zeroRecipientsEmailFailure();
    reopenMock.mockResolvedValue({
      status: "reopened_email_failed",
      emailFailed: true,
      failedEmails: [],
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("does not ship the pre-approval email strings", async () => {
    // The exact defect finding 3 reported: `Avisale` (the pre-conversion voseo
    // spelling) and `a quién avisar` reached the admin while the approved list
    // says `Avísale` and `para avisar`. Both variants are rendered and pinned
    // byte-for-byte, so either regression goes RED here.
    for (const [failedEmails, expected] of [
      [[], zeroRecipientsEmailFailure()],
      [["ana@example.com"], partialEmailFailure("ana@example.com")],
    ] as const) {
      reopenMock.mockResolvedValue({
        status: "reopened_email_failed",
        emailFailed: true,
        failedEmails: [...failedEmails],
      });
      const user = userEvent.setup();
      renderPanel();
      await confirm(user);

      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toBe(expected);
      expect(text).not.toContain("Avisale");
      expect(text).not.toContain("a quién avisar");
      cleanup();
      reopenMock.mockReset();
    }
  });

  it("renders a cleanup failure as an alert with the durable pending count", async () => {
    reopenMock.mockResolvedValue({
      status: "reopened_cleanup_failed",
      emailFailed: false,
      remainingCleanupKeys: 3,
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alerts = await screen.findAllByRole("alert");
    // One alert: the email succeeded, so there is nothing else to warn about.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe(CLEANUP_PENDING_3);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the action's own cleanup message when it cannot count the remainder", async () => {
    reopenMock.mockResolvedValue({
      status: "reopened_cleanup_failed",
      emailFailed: false,
      message: DRAIN_THREW,
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    expect((await screen.findByRole("alert")).textContent).toBe(DRAIN_THREW);
  });

  it("renders a refused reopen as an alert with the server's reason", async () => {
    reopenMock.mockResolvedValue({
      status: "error",
      message: "Esta galería no está entregada, así que no hay una entrega que reabrir.",
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Esta galería no está entregada, así que no hay una entrega que reabrir.",
    );
  });
});

// Task #287 UI review, finding 1 (blocking): a cleanup failure took the whole
// result, so when the email ALSO failed the admin was told about the bytes and
// never about the clients nobody reached. A cleanup retry sends no email, so
// the warning had no later chance to appear.
describe("ReopenDeliveredGalleryPanel — cleanup and email failures are both shown", () => {
  it("shows the pending-cleanup alert AND the partial email alert", async () => {
    const message = partialEmailFailure("ana@example.com", "beto@example.com");
    reopenMock.mockResolvedValue({
      status: "reopened_cleanup_failed",
      emailFailed: true,
      remainingCleanupKeys: 3,
      failedEmails: ["ana@example.com", "beto@example.com"],
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]!.textContent).toBe(CLEANUP_PENDING_3);
    expect(alerts[1]!.textContent).toBe(message);
    // The names the action reported are still on screen, not just a boolean.
    expect(alerts[1]!.textContent).toContain("ana@example.com");
    expect(alerts[1]!.textContent).toContain("beto@example.com");
  });

  it("shows the drainer's cleanup message AND the zero-recipient email alert", async () => {
    const message = zeroRecipientsEmailFailure();
    reopenMock.mockResolvedValue({
      status: "reopened_cleanup_failed",
      emailFailed: true,
      message: DRAIN_THREW,
      failedEmails: [],
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual([DRAIN_THREW, message]);
  });
});

// Task #287 UI review, accessibility observation: a committed outcome replaces
// the dialog AND its trigger, so Radix restores focus to an element that no
// longer exists and keyboard position falls to BODY.
describe("ReopenDeliveredGalleryPanel — a committed result takes focus", () => {
  it("focuses the success result instead of leaving focus on BODY", async () => {
    reopenMock.mockResolvedValue({ status: "reopened" });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const status = await screen.findByRole("status");
    // Radix's FocusScope schedules its restore in a 0ms timer on unmount; the
    // panel's focus target runs after it, so wait for the SETTLED focus rather
    // than the window before that timer fired.
    await waitFor(() => expect(document.activeElement).toBe(status.parentElement));
    // Flushing one more turn proves no later timer steals it back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(status.parentElement);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("focuses the combined-failure result, so the warnings are where the keyboard is", async () => {
    reopenMock.mockResolvedValue({
      status: "reopened_cleanup_failed",
      emailFailed: true,
      remainingCleanupKeys: 3,
      failedEmails: ["ana@example.com", "beto@example.com"],
    });
    const user = userEvent.setup();
    renderPanel();

    await confirm(user);

    const alerts = await screen.findAllByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alerts[0]!.parentElement));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(alerts[0]!.parentElement);
  });
});

// The approved confirmation body. Every paragraph is asserted verbatim; only
// the fourth changes with `rollingDelivery`, because with no finals uploaded
// both modes have nothing to download right now, but a rolling gallery opens
// downloads again as each final is re-uploaded, before the new delivery.
describe("ReopenDeliveredGalleryPanel — the approved body, ordinary vs rolling", () => {
  it("states the ordinary-delivery facts, including the lost downloads", async () => {
    const user = userEvent.setup();
    renderPanel(false);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(FACT_CANCELLED)).toBeDefined();
    expect(within(dialog).getByText(FACT_FINALS)).toBeDefined();
    expect(within(dialog).getByText(FACT_MONEY)).toBeDefined();
    expect(within(dialog).getByText(AVAILABILITY_NORMAL)).toBeDefined();
    expect(within(dialog).queryByText(AVAILABILITY_ROLLING)).toBeNull();
    // Still nothing submitted just by reading the confirmation.
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("replaces only the download fact for a rolling gallery", async () => {
    const user = userEvent.setup();
    renderPanel(true);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(FACT_CANCELLED)).toBeDefined();
    expect(within(dialog).getByText(FACT_FINALS)).toBeDefined();
    expect(within(dialog).getByText(FACT_MONEY)).toBeDefined();
    expect(within(dialog).getByText(AVAILABILITY_ROLLING)).toBeDefined();
    expect(within(dialog).queryByText(AVAILABILITY_NORMAL)).toBeNull();
  });
});
