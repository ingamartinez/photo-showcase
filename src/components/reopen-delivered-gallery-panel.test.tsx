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
// - The confirmation body is the owner's approved copy verbatim, and the
//   fourth paragraph is the only one that changes between ordinary and
//   rolling delivery.
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

// The owner's approved copy, transcribed once. These constants are the
// assertion targets, so a paraphrase anywhere in the component fails here
// instead of shipping.
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
  "previa, incluidos los regalos: tenés que volver a subirlos todos para entregar otra vez.";
const FACT_MONEY =
  "Los extras y el recargo se recalculan con este nuevo envío, así que lo que se facturó antes " +
  "queda en cero (lo ya cobrado lo arreglás por fuera, como siempre). No hay forma de deshacer " +
  "esto desde la app.";
const AVAILABILITY_NORMAL =
  "Mientras tanto nadie puede descargar los finales de esta galería. Los archivos que el cliente " +
  "ya se descargó no se pueden recuperar.";
const AVAILABILITY_ROLLING =
  "Mientras no haya finales nuevos no hay nada para descargar; a medida que los vuelvas a subir, " +
  "el cliente los va a poder bajar sin esperar a la nueva entrega.";

const SUCCESS =
  "Galería reabierta — cada cliente puede volver a elegir, y les avisamos por correo.";
const EMAIL_FAILURE =
  "Reabrimos la galería, pero no pudimos avisarle por correo a: ana@example.com. Avisale por " +
  "otro medio (WhatsApp / llamada).";
const DRAIN_THREW =
  "La galería quedó reabierta, pero no pudimos terminar de borrar los finales viejos. Reintentá " +
  "la limpieza desde el detalle de la galería.";

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

describe("ReopenDeliveredGalleryPanel — opening and cancelling never execute", () => {
  it("opens the confirmation dialog without calling the action", async () => {
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(TITLE)).toBeDefined();
    expect(reopenMock).not.toHaveBeenCalled();
  });

  it("closing with Cancelar never calls the action", async () => {
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CANCEL }));

    // Radix unmounts the content: the dialog is really closed, not merely
    // hidden, so nothing in it can be submitted afterwards.
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

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(SUCCESS);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders the email failure as an alert with the action's own message", async () => {
    reopenMock.mockResolvedValue({
      status: "reopened_email_failed",
      emailFailed: true,
      message: EMAIL_FAILURE,
    });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(EMAIL_FAILURE);
    // Distinct from success: an email failure is never reported as a status.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders a cleanup failure as an alert with the durable pending count", async () => {
    reopenMock.mockResolvedValue({ status: "reopened_cleanup_failed", remainingCleanupKeys: 3 });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "La galería quedó reabierta, pero no pudimos borrar todos los finales viejos (3 archivo(s) " +
        "pendiente(s)). Reintentá la limpieza; mientras tanto no reabras ni elimines esta galería.",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the action's own cleanup message when it cannot count the remainder", async () => {
    reopenMock.mockResolvedValue({ status: "reopened_cleanup_failed", message: DRAIN_THREW });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    expect((await screen.findByRole("alert")).textContent).toBe(DRAIN_THREW);
  });

  it("renders a refused reopen as an alert with the server's reason", async () => {
    reopenMock.mockResolvedValue({
      status: "error",
      message: "Esta galería no está entregada, así que no hay una entrega que reabrir.",
    });
    const user = userEvent.setup();
    renderPanel();

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: CONFIRM }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Esta galería no está entregada, así que no hay una entrega que reabrir.",
    );
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
