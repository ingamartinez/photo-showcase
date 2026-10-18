// Per-client selection state for the admin dashboard (epic #239, slice #242;
// rewritten by epic #250, task #263).
//
// Pure and import-safe from Client Components (no `server-only`): the row
// component and the server actions both ask the SAME functions which state a
// client is in and which admin actions are valid for it. The server action
// re-checks regardless — hiding a button is UX, never the authority.
import type { Gallery } from "@/lib/db/schema";
import { formatCop } from "@/lib/format";
import type { AttributionShare } from "@/lib/quota-attribution";

/**
 * `open` — still choosing. `submitted` — pressed "Enviar selección" (or the
 * admin locked them after they had sent), and nothing is left in the cart.
 * `locked` — the admin froze them before they sent.
 *
 * EPIC #250 DECISION 10 CHANGED THE RULE: a submit no longer locks, it orders.
 * So the lock columns alone stopped describing "has this person finished?" —
 * a member who pressed Enviar reads `selection_submitted_at` set and
 * `selection_locked_at` NULL, which under the old mapping was "Eligiendo",
 * i.e. the dashboard claimed they were still picking when they were done.
 *
 * A submitted member whose cart is NON-EMPTY is `open` on purpose: they can
 * still add to the cart (a submit is per photo), and the gallery's own
 * auto-close (decision 13) says a gallery is not settled while anybody has a
 * pending cart. `hasCart` is that "por enviar > 0" fact, derived from the
 * picks, never a column.
 */
export type ClientSelectionState = "open" | "submitted" | "locked";

export function clientSelectionState(lock: {
  lockedAt: Date | null;
  submittedAt: Date | null;
  hasCart?: boolean;
}): ClientSelectionState {
  if (lock.lockedAt !== null) return lock.submittedAt !== null ? "submitted" : "locked";
  if (lock.submittedAt !== null && lock.hasCart !== true) return "submitted";
  return "open";
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

/** The dashboard's wording for each state (Spanish, user-facing). Tuteo:
 * "Bloqueado por ti", never "por vos" (task #262's rule, extended to the
 * dashboard by task #263). */
export function clientSelectionStateLabel(
  state: ClientSelectionState,
  submittedOn: string | null,
): string {
  if (state === "open") return "Eligiendo";
  if (state === "submitted") return submittedOn ? `Envió el ${submittedOn}` : "Envió su selección";
  return "Bloqueado por ti";
}

/**
 * One person's four numbers (epic #250 decision 14), as the dashboard row
 * shows them. `yours` = units billed to them ("pedidas"), `shared` = submitted
 * picks somebody else holds the unit for, `edited` = their billed units whose
 * final is already uploaded, `toSend` = picks still in their cart (cart or
 * degraded — a degraded pick is still "por enviar" until they submit it).
 */
export type ClientPersonTally = {
  yours: number;
  shared: number;
  edited: number;
  toSend: number;
};

export type ClientSelectionView = {
  state: ClientSelectionState;
  /** Total picks of this person: `yours + shared + toSend`. Kept because the
   * "Quitar sus fotos elegidas" entry is offered off it. */
  pickCount: number;
  person: ClientPersonTally;
  /** "dd/mm/yyyy"; only set for `submitted`. */
  submittedOn: string | null;
};

export const EMPTY_PERSON_TALLY: ClientPersonTally = {
  yours: 0,
  shared: 0,
  edited: 0,
  toSend: 0,
};

/** What one dashboard row renders, from the raw per-client lock columns and
 * that person's partition of the picks. */
export function toClientSelectionView(input: {
  lockedAt: Date | null;
  submittedAt: Date | null;
  person: ClientPersonTally;
}): ClientSelectionView {
  const state = clientSelectionState({
    lockedAt: input.lockedAt,
    submittedAt: input.submittedAt,
    hasCart: input.person.toSend > 0,
  });
  return {
    state,
    pickCount: input.person.yours + input.person.shared + input.person.toSend,
    person: input.person,
    submittedOn:
      state === "submitted" && input.submittedAt ? formatSubmittedOn(input.submittedAt) : null,
  };
}

/**
 * "pedidas Y · compartidas S · editadas E · por enviar T" — the per-person
 * tally, shown unconditionally since epic #250 (it used to be gated on
 * `rolling_delivery`; decision 11 made the order semantics mandatory, so the
 * gate had no meaning left).
 *
 * "pedidas" is the approved word, NOT "a su nombre": those units are billed to
 * this person ("a su nombre") but the dashboard says "pedidas" — the longer
 * phrase is the tooltip, not the label (owner answer, 2026-10-18).
 * The word "carrito" must never reach the UI (task #244).
 */
export function clientPersonTallyLabel(person: ClientPersonTally): string {
  return (
    `pedidas ${person.yours} · compartidas ${person.shared} · ` +
    `editadas ${person.edited} · por enviar ${person.toSend}`
  );
}

/**
 * One `AttributionShare` as a sentence: "N incluidas · M extras · K
 * originales · recargo $ X".
 *
 * This is the body of the admin's before/after rows. <AllowsOriginalSelection>
 * already used the "Hoy: … / Al confirmar: …" frame for a money-affecting
 * change (#214); epic #250 reuses that frame for every per-person delta, so
 * the two never look like different features.
 */
export function formatAttributionShare(share: AttributionShare): string {
  const nouns = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return (
    `${nouns(share.included, "incluida", "incluidas")} · ` +
    `${nouns(share.extras, "extra", "extras")} · ` +
    `${nouns(share.originals, "original", "originales")} · ` +
    `recargo ${formatCop(share.surchargeCop)}`
  );
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

/**
 * Which per-client buttons the dashboard offers.
 *
 * `canLock`/`canUnlock` are exactly the SERVER's own preconditions —
 * `lockGalleryClientSelection` refuses a member whose `lockedAt` is already
 * set (`actions.ts`), and `unlockGalleryClientSelection` refuses one whose
 * `lockedAt` is NULL. They are read off `lockedAt` alone, never off the
 * derived state: a submitted-but-unlocked member (the ordinary post-submit
 * state since decision 10) has nothing to unlock, and their submitted picks
 * are immutable anyway (S5's answer to Q5), so "Desbloquear" is not offered.
 *
 * `removePicks` is offered when there is something to remove: picks, or a
 * lock/submit that removing resets.
 */
export function clientLockActions(input: {
  galleryStatus: Gallery["status"];
  lockedAt: Date | null;
  submittedAt: Date | null;
  pickCount: number;
}): ClientLockActions {
  if (!isClientLockActionableStatus(input.galleryStatus)) {
    return { canLock: false, canUnlock: false, canRemovePicks: false };
  }
  return {
    canLock: input.lockedAt === null,
    canUnlock: input.lockedAt !== null,
    canRemovePicks: input.pickCount > 0 || input.lockedAt !== null || input.submittedAt !== null,
  };
}
