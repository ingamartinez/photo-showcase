// Epic #250, task #258 (S3) — the PURE resolution half of "choosing is asking,
// not owning". No I/O, no DB, no env: this module holds the state machine and
// nothing else, so its tests run without a database and the property test can
// model client actions with exactly these functions.
//
// The structural guarantee of decision 7 lives here, not in a gate: a client
// edit (`gatePickEdit`) carries no `AssetClaim` and therefore has no pure path
// that rewrites `assets`; the only branch of `submitPick` that rewrites a
// claimed asset's `kind` is `escalated`, and its type pins `kind: "edited"`.
// A client submit can never move edited -> original.
//
// The test suite guards that the import list below stays exactly one line.
import type { SelectionKind } from "@/lib/selection-snapshot";

/** The resolved claim of one asset, mapped onto `assets`: `claimed` =
 * `is_selected`, `kind` = `selection_kind`, `billedTo` = `selected_by`,
 * `billedAt` = `billed_at`. A `claimed: false` asset may still have several
 * cart picks; it has no billed unit. */
export type AssetClaim =
  | { claimed: false }
  | { claimed: true; kind: SelectionKind; billedTo: string | null; billedAt: Date | null };

export type Claimed = Extract<AssetClaim, { claimed: true }>;

/** `cart`: a pick with no submit on an unclaimed asset.
 * `degraded`: a pick with no submit on an asset already claimed by someone.
 * `billed`: submitted, and this person holds the asset's unit.
 * `joined`: submitted, but the unit belongs to someone else. */
export type PickStatus = "cart" | "degraded" | "billed" | "joined";

export type PickEdit = { type: "remove" } | { type: "retype"; kind: SelectionKind };

export type PickEditGate =
  { ok: true } | { ok: false; error: "already_requested" | "pick_degraded" };

export type SubmitOutcome =
  | { type: "claimed"; claim: Claimed }
  | { type: "escalated"; from: string | null; claim: Claimed & { kind: "edited" } }
  | { type: "joined"; claim: Claimed }
  | { type: "escalation_blocked"; reason: "final_exists"; claim: Claimed };

export function claimFromAsset(row: {
  isSelected: boolean;
  selectionKind: SelectionKind;
  billedTo: string | null;
  billedAt: Date | null;
}): AssetClaim {
  if (!row.isSelected) return { claimed: false };
  return {
    claimed: true,
    kind: row.selectionKind,
    billedTo: row.billedTo,
    billedAt: row.billedAt,
  };
}

/**
 * The read-time pick state. Decision 8: a pick on a photo someone else already
 * claimed is DEGRADED — still visible with attribution, but it does not
 * count, it is not edited, and its owner may remove it until they submit.
 *
 * A submitted pick on an unclaimed asset is a definitional contradiction
 * (`is_selected` means "at least one submitted pick"), so it THROWS rather
 * than picking a silent status. S5 must preserve that.
 */
export function derivePickStatus(
  pick: { userId: string; submittedAt: Date | null },
  claim: AssetClaim,
): PickStatus {
  if (pick.submittedAt === null) {
    return claim.claimed ? "degraded" : "cart";
  }
  if (!claim.claimed) {
    throw new Error("pick-resolution: submitted pick on an unclaimed asset");
  }
  return claim.billedTo === pick.userId ? "billed" : "joined";
}

/**
 * Whether one of this person's own picks may be edited. Inserting a pick is
 * NOT gated here: the PK plus `onConflictDoNothing` make it idempotent, and a
 * pick on a claimed photo is legal (it degrades). Gallery-level gates (status,
 * membership, lock, `allowsOriginalSelection`) stay in the route.
 *
 * `cart` allows everything. `degraded` (decision 8/16): remove is allowed
 * until submit; a retype to the same kind is an idempotent no-op; `original`
 * -> `edited` is allowed (decision 16); `edited` -> `original` is
 * `pick_degraded`. `billed`/`joined` are frozen: the epic's new meaning of
 * `already_requested` is "your OWN pick is already requested".
 */
export function gatePickEdit(
  status: PickStatus,
  currentKind: SelectionKind,
  edit: PickEdit,
): PickEditGate {
  if (status === "cart") return { ok: true };
  if (status === "degraded") {
    if (edit.type === "remove") return { ok: true };
    if (edit.kind === currentKind) return { ok: true };
    return edit.kind === "edited" ? { ok: true } : { ok: false, error: "pick_degraded" };
  }
  return { ok: false, error: "already_requested" };
}

/**
 * Resolve one submit of one cart pick. Decisions 3, 4, 15:
 * - unclaimed -> `claimed`; the submitter's pick becomes the billed unit;
 * - claimed by the submitter -> THROW (unreachable: the billed person holds
 *   the asset's submitted pick and the PK forbids a second one);
 * - claimed original, submitting edited, no final -> `escalated`, exactly one
 *   unit moves from the previous holder (or "Sin registro") to the submitter;
 * - the same with a final -> `escalation_blocked`, claim UNCHANGED (Q2 in the
 *   plan: S4 decides whether the route joins or 409s; this function stamps
 *   nothing);
 * - every other claimed case -> `joined`, claim unchanged.
 */
export function submitPick(
  claim: AssetClaim,
  pick: { userId: string; kind: SelectionKind },
  ctx: { arrival: Date; hasFinal: boolean },
): SubmitOutcome {
  if (!claim.claimed) {
    return {
      type: "claimed",
      claim: { claimed: true, kind: pick.kind, billedTo: pick.userId, billedAt: ctx.arrival },
    };
  }
  if (claim.billedTo === pick.userId) {
    throw new Error("pick-resolution: submitter is already billed for this asset");
  }
  if (claim.kind === "original" && pick.kind === "edited") {
    if (ctx.hasFinal) {
      return { type: "escalation_blocked", reason: "final_exists", claim };
    }
    return {
      type: "escalated",
      from: claim.billedTo,
      claim: { claimed: true, kind: "edited", billedTo: pick.userId, billedAt: ctx.arrival },
    };
  }
  return { type: "joined", claim };
}

/** One submitted pick still standing on an asset AFTER an admin's change.
 * `reresolveClaim` only needs these three fields: who, what they asked for,
 * and when they asked (the arrival tie-break). */
export type SubmittedPick = {
  userId: string;
  kind: SelectionKind;
  submittedAt: Date;
};

/** `(submittedAt, userId)` ascending, code-unit on the id — the pick-level
 * analogue of `compareArrival` (quota-attribution.ts). Deterministic, and the
 * id tie-break never depends on the locale. */
function compareSubmittedAt(a: SubmittedPick, b: SubmittedPick): number {
  const diff = a.submittedAt.getTime() - b.submittedAt.getTime();
  if (diff !== 0) return diff < 0 ? -1 : 1;
  if (a.userId === b.userId) return 0;
  return a.userId < b.userId ? -1 : 1;
}

function earliest(
  picks: readonly SubmittedPick[],
  predicate: (pick: SubmittedPick) => boolean,
): SubmittedPick {
  return [...picks].filter(predicate).sort(compareSubmittedAt)[0]!;
}

/**
 * Epic #250, task #260 (S5) — THE pure per-asset rule for an ADMIN change to
 * somebody's submitted picks: what the asset's claim becomes once those picks
 * are gone (or retyped). This is the only definition of that transition;
 * `pick-plans.ts` applies it, and the dashboard preview and the executed write
 * both go through it, so they cannot drift.
 *
 * Decisions this encodes, in the order the rules run:
 *
 * 1. An UNCLAIMED asset with a submitted pick is the contradiction
 *    `derivePickStatus` throws on. New claims only ever come from
 *    `claimCart`, so an admin re-resolution that would produce this state is a
 *    caller bug and THROWS rather than inventing a silent status.
 * 2. A legacy unit (`billedTo === null`, the "Sin registro" census bucket) is
 *    returned untouched. Its basis is not in `asset_picks`, so re-resolution
 *    has no business adding or removing one.
 * 3. No submitted pick left -> the asset is unclaimed. The caller clears the
 *    dependent columns; this function only says "nobody holds it".
 * 4. The kind is `edited` iff SOME remaining submitted pick is edited
 *    (decision 3), except while the asset has a final: decision 15 freezes it
 *    in BOTH directions then, because the file was produced against that kind.
 * 5. The holder:
 *    - a RAISE (`original -> edited`) is an escalation: it goes to the
 *      earliest edited pick and RE-ARRIVES (`billedAt = ctx.arrival`), the
 *      same semantics as a client escalation (`pick-claims.ts`), so no third
 *      party loses an included slot;
 *    - otherwise the current holder keeps the unit while their own pick is
 *      still there and still compatible (same kind, or frozen by a final);
 *    - otherwise it TRANSFERS to the earliest picker of the resolved kind,
 *      KEEPING `billedAt`: a transfer does not create a new unit, so it stays
 *      in its arrival slot and only the two people change.
 */
export function reresolveClaim(
  current: AssetClaim,
  submitted: readonly SubmittedPick[],
  ctx: { hasFinal: boolean; arrival: Date },
): AssetClaim {
  if (!current.claimed) {
    if (submitted.length === 0) return { claimed: false };
    throw new Error("pick-resolution: submitted pick on an unclaimed asset");
  }
  if (current.billedTo === null) return current;
  if (submitted.length === 0) return { claimed: false };

  const resolved: SelectionKind = submitted.some((pick) => pick.kind === "edited")
    ? "edited"
    : "original";
  const kind: SelectionKind = ctx.hasFinal ? current.kind : resolved;

  if (current.kind === "original" && kind === "edited") {
    const winner = earliest(submitted, (pick) => pick.kind === "edited");
    return { claimed: true, kind, billedTo: winner.userId, billedAt: ctx.arrival };
  }

  const holderPick = submitted.find((pick) => pick.userId === current.billedTo);
  if (holderPick && (ctx.hasFinal || holderPick.kind === kind)) {
    return { claimed: true, kind, billedTo: current.billedTo, billedAt: current.billedAt };
  }

  // A final freezes the KIND, not the holder: if the holder left, the unit has
  // to land on somebody who still has a pick.
  const candidates = ctx.hasFinal ? submitted : submitted.filter((pick) => pick.kind === kind);
  const winner = earliest(candidates, () => true);
  return { claimed: true, kind, billedTo: winner.userId, billedAt: current.billedAt };
}

/** The gallery's latest non-null `billed_at`, for `arrivalAfter`. */
export function latestBilledAt(billedAts: readonly (Date | null)[]): Date | null {
  let latest: Date | null = null;
  for (const at of billedAts) {
    if (at !== null && (latest === null || at.getTime() > latest.getTime())) {
      latest = at;
    }
  }
  return latest;
}

/**
 * A strictly-increasing arrival for a submit. `now` when it is newer than the
 * gallery's latest, otherwise the latest plus 1 millisecond (a tie, or a clock
 * that stepped backwards).
 *
 * WHY THIS EXISTS: arrival order decides the included slots, and ties are
 * broken by `asset_id` (quota-attribution's `compareArrival`). A later submit
 * by B whose `billedAt` EQUALS A's earlier one, and whose `asset_id` sorts
 * lower, would take A's included slot and raise A's surcharge — violating
 * decision 7. S4 must compute `arrival` once per submit, after the lock, from
 * the gallery's latest `billed_at`, and pass it to every `submitPick` in that
 * submit. JS Dates are milliseconds and Postgres stores microseconds; the
 * +1 ms beats any sub-millisecond remainder truncation hides.
 */
export function arrivalAfter(now: Date, latest: Date | null): Date {
  if (latest === null || now.getTime() > latest.getTime()) return now;
  return new Date(latest.getTime() + 1);
}

/**
 * The submit order of a cart: `(pickedAt, assetId)` ascending, code-unit. The
 * fake db has no `orderBy`, so S4 sorts in JS through this function.
 * Attribution does not depend on it (all claims in one submit share
 * `arrival`); it is only for determinism.
 */
export function compareCartOrder(
  a: { pickedAt: Date; assetId: string },
  b: { pickedAt: Date; assetId: string },
): number {
  const diff = a.pickedAt.getTime() - b.pickedAt.getTime();
  if (diff !== 0) return diff < 0 ? -1 : 1;
  if (a.assetId === b.assetId) return 0;
  return a.assetId < b.assetId ? -1 : 1;
}
