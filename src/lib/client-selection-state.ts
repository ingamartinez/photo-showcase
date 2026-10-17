// Per-client selection state for the admin dashboard (epic #239, slice #242).
//
// Pure and import-safe from Client Components (no `server-only`): the row
// component and the server actions both ask the SAME functions which state a
// client is in and which admin actions are valid for it. The server action
// re-checks regardless — hiding a button is UX, never the authority.
import type { Gallery } from "@/lib/db/schema";

/** `open` — still choosing. `submitted` — pressed "Enviar selección" (both
 * columns set). `locked` — locked by the admin (lock set, submitted NULL). */
export type ClientSelectionState = "open" | "submitted" | "locked";

export function clientSelectionState(lock: {
  lockedAt: Date | null;
  submittedAt: Date | null;
}): ClientSelectionState {
  if (lock.lockedAt === null) return "open";
  return lock.submittedAt !== null ? "submitted" : "locked";
}

const SUBMITTED_ON = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "America/Bogota",
});

/** "dd/mm/yyyy" in the studio's timezone — formatted on the SERVER and handed
 * to the row as a string, so server and client renders cannot disagree. */
export function formatSubmittedOn(date: Date): string {
  return SUBMITTED_ON.format(date);
}

/** The dashboard's wording for each state (Spanish, user-facing). */
export function clientSelectionStateLabel(
  state: ClientSelectionState,
  submittedOn: string | null,
): string {
  if (state === "open") return "Eligiendo";
  if (state === "submitted") return submittedOn ? `Envió el ${submittedOn}` : "Envió su selección";
  return "Bloqueado por vos";
}

/** Task #244 — rolling delivery's per-person tally. Only present on galleries
 * with the flag on. Internally "cart", user-facing "por enviar". */
export type ClientOrderTally = { requested: number; edited: number; unsent: number };

export type ClientSelectionView = {
  state: ClientSelectionState;
  pickCount: number;
  order?: ClientOrderTally;
  /** "dd/mm/yyyy"; only set for `submitted`. */
  submittedOn: string | null;
};

/** What one dashboard row renders, from the raw per-client lock columns. */
export function toClientSelectionView(input: {
  lockedAt: Date | null;
  submittedAt: Date | null;
  pickCount: number;
  order?: ClientOrderTally;
}): ClientSelectionView {
  const state = clientSelectionState(input);
  return {
    state,
    pickCount: input.pickCount,
    ...(input.order ? { order: input.order } : {}),
    submittedOn:
      state === "submitted" && input.submittedAt ? formatSubmittedOn(input.submittedAt) : null,
  };
}

/** "pedidas X · editadas Y · por enviar Z" — the rolling-delivery row. The
 * word "carrito" must never reach the UI (owner decision, task #244). */
export function clientOrderTallyLabel(order: ClientOrderTally): string {
  return `pedidas ${order.requested} · editadas ${order.edited} · por enviar ${order.unsent}`;
}

export function clientPickCountLabel(count: number): string {
  return count === 1 ? "1 foto elegida" : `${count} fotos elegidas`;
}

/** The admin per-client actions only make sense while picking is live:
 * `proofing` (open) or `selected` (everyone locked). */
export function isClientLockActionableStatus(status: Gallery["status"]): boolean {
  return status === "proofing" || status === "selected";
}

export type ClientLockActions = {
  canLock: boolean;
  canUnlock: boolean;
  canRemovePicks: boolean;
};

/** Which per-client buttons the dashboard offers. `removePicks` is offered when
 * there is something to remove: picks, or a lock that removing resets. */
export function clientLockActions(input: {
  galleryStatus: Gallery["status"];
  state: ClientSelectionState;
  pickCount: number;
}): ClientLockActions {
  if (!isClientLockActionableStatus(input.galleryStatus)) {
    return { canLock: false, canUnlock: false, canRemovePicks: false };
  }
  return {
    canLock: input.state === "open",
    canUnlock: input.state !== "open",
    canRemovePicks: input.pickCount > 0 || input.state !== "open",
  };
}
