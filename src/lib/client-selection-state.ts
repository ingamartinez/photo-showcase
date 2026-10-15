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
