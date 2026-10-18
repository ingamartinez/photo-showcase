// Shared fixtures for epic #250's client UI tests (task #262). Three people,
// one gallery, and the wire shapes the server actually sends — so a test says
// "Ana has a degraded pick on IMG_0002" once and the component under test
// reads a real `SelectionEntry`/`SelectionCounter`, not a hand-shaped stand-in
// that could drift from `gallery-selection.ts`.
import type {
  SelectionCounter,
  SelectionEntry,
  SelectionEntryPick,
  SelectionKind,
  SelectionPickState,
} from "@/lib/selection-snapshot";
import { emptyShare, type AttributionShare } from "@/lib/quota-attribution";

export const ANA = { id: "client-a", label: "Ana" } as const;
export const BETO = { id: "client-b", label: "Beto" } as const;
export const SARA = { id: "client-c", label: "Sara" } as const;

const SENT_AT = "2026-10-17T12:00:00.000Z";

/** One person's request for one asset. `state` must agree with the claim the
 * entry carries; `entry()` below is the place that keeps those two in step. */
export function pick(
  userId: string,
  label: string,
  state: SelectionPickState,
  kind: SelectionKind = "edited",
): SelectionEntryPick {
  const sent = state === "billed" || state === "joined";
  return {
    userId,
    label,
    kind,
    pickedAt: SENT_AT,
    submittedAt: sent ? SENT_AT : null,
    state,
  };
}

/** One asset's entry. `claim` is either `null` (nobody has sent a pick, so it
 * is a pure cart/degraded row) or the billed unit a sent pick produced. */
export function entry(
  assetId: string,
  claim: {
    billedTo: { id: string; label: string } | null;
    resolvedKind?: SelectionKind;
    charge?: "included" | "extra" | "original";
  } | null,
  picks: SelectionEntryPick[],
): SelectionEntry {
  return {
    assetId,
    claim: claim
      ? {
          claimedAt: SENT_AT,
          resolvedKind: claim.resolvedKind ?? "edited",
          billedTo: claim.billedTo,
          charge: claim.charge ?? "included",
        }
      : null,
    picks,
  };
}

/** The server's four-number counter. Defaults describe a viewer with nothing
 * picked, which is the ordinary first paint. */
export function counter(overrides: Partial<SelectionCounter> = {}): SelectionCounter {
  return {
    group: 0,
    viewer: { yours: 0, shared: 0, toSend: 0 },
    people: [],
    unattributed: 0,
    unattributedShare: emptyShare(),
    ...overrides,
  };
}

/** One `counter.people` row: the counts AND the money the server attributed to
 * that person (task #264). Tests that only care about units can pass no share
 * and get the all-zero one. */
export function person(
  who: { id: string; label: string },
  units: number,
  share: AttributionShare = emptyShare(),
): SelectionCounter["people"][number] {
  return { userId: who.id, label: who.label, units, share };
}
