// Epic #250, task #260 (S5) — PLAN, THEN APPLY.
//
// Every admin money move in this slice follows one shape: a PURE function
// reads the asset rows and the picks, and answers exactly what would change;
// the write path reads the same rows under the gallery lock, runs the SAME
// function, and applies the diff with CAS predicates. The before/after the
// admin sees and the write that actually lands therefore come from one
// definition and cannot drift — the parity tests in `pick-plans.test.ts` are
// what pins that.
//
// Pure: no I/O, no DB, no env. `pick-claims.ts` is the server half that
// executes these plans. This module imports `pick-resolution` (the per-asset
// state machine) and `quota-attribution` (the money split) and nothing else
// that touches the world.
import {
  arrivalAfter,
  claimFromAsset,
  compareCartOrder,
  latestBilledAt,
  reresolveClaim,
  submitPick,
} from "@/lib/pick-resolution";
import type { AssetClaim, SubmittedPick } from "@/lib/pick-resolution";
import type { SelectionKind, SubmitProjection } from "@/lib/selection-snapshot";
import { attributeQuota, shareFor } from "@/lib/quota-attribution";
import type { AttributionShare, ClaimedUnit } from "@/lib/quota-attribution";

/** One row of `assets`, as every reader of this module sees it. */
export type AssetRow = {
  id: string;
  isSelected: boolean;
  selectionKind: SelectionKind;
  billedTo: string | null;
  billedAt: Date | null;
  finalKey: string | null;
  selectedAt: Date | null;
  requestedAt: Date | null;
};

/** One row of `asset_picks`. */
export type PickRow = {
  assetId: string;
  userId: string;
  kind: SelectionKind;
  pickedAt: Date;
  submittedAt: Date | null;
};

/** What a plan does to one asset. The write path picks its CAS from the
 * BEFORE state and writes the AFTER state, so the name is descriptive; the
 * authoritative diff is `before` -> `after`. */
export type AssetChangeOp =
  "claim" | "escalate" | "unclaim" | "transfer" | "rekind" | "transfer_rekind";

export type AssetChange = {
  assetId: string;
  before: AssetClaim;
  after: AssetClaim;
  op: AssetChangeOp;
};

export type PickPlan = {
  assetChanges: AssetChange[];
  /** One arrival for the whole plan, or `null` when nothing claims/raises.
   * Same expression as `claimCart`'s step 3 (`arrivalAfter` over the gallery's
   * latest claimed `billed_at`). */
  arrival: Date | null;
};

/** Counts per `submitPick` outcome, unchanged from `CartClaimResult`. */
export type CartClaimCounts = {
  claimed: number;
  escalated: number;
  joined: number;
  escalationBlocked: number;
};

function claimsEqual(a: AssetClaim, b: AssetClaim): boolean {
  if (!a.claimed || !b.claimed) return a.claimed === b.claimed;
  return (
    a.kind === b.kind &&
    a.billedTo === b.billedTo &&
    a.billedAt?.getTime() === b.billedAt?.getTime()
  );
}

/** `null` when nothing about the claim changes. */
function opFor(before: AssetClaim, after: AssetClaim): AssetChangeOp | null {
  if (!before.claimed && !after.claimed) return null;
  if (!before.claimed) {
    return after.claimed ? "claim" : null;
  }
  if (!after.claimed) return "unclaim";
  const kindChanged = before.kind !== after.kind;
  const holderChanged = before.billedTo !== after.billedTo;
  if (!kindChanged && !holderChanged) return null;
  if (kindChanged && holderChanged) {
    // The commercial escalation (decision 3/15): an `edited` request raises an
    // `original` unit and re-arrives. Named apart from a plain re-kind because
    // that is the case the epic gives a name to.
    return before.kind === "original" && after.kind === "edited" ? "escalate" : "transfer_rekind";
  }
  return kindChanged ? "rekind" : "transfer";
}

function changeOf(assetId: string, before: AssetClaim, after: AssetClaim): AssetChange | null {
  const op = opFor(before, after);
  if (op === null || claimsEqual(before, after)) return null;
  return { assetId, before, after, op };
}

function planArrival(rows: readonly AssetRow[], now: Date): Date {
  return arrivalAfter(
    now,
    latestBilledAt(rows.filter((row) => row.isSelected).map((row) => row.billedAt)),
  );
}

/** The submitted picks of one asset, in the shape `reresolveClaim` takes. */
function submittedOn(picks: readonly PickRow[], assetId: string): SubmittedPick[] {
  return picks
    .filter((pick) => pick.assetId === assetId && pick.submittedAt !== null)
    .map((pick) => ({ userId: pick.userId, kind: pick.kind, submittedAt: pick.submittedAt! }));
}

/**
 * The cart-claim plan: `claimCart` steps 3-4, lifted out verbatim so the
 * before/after preview of an admin lock and the lock itself are one function.
 *
 * `allowsOriginal: false` coerces an `original` cart pick to `edited` — the
 * pick row is rewritten (its id lands in `pickKindFixes`, which the caller
 * applies) and resolved as edited. WHY: the PATCH gate that refuses new
 * originals reads `allowsOriginalSelection` WITHOUT the gallery lock, so a
 * retype to `original` can land after an OFF commits; `claimCart` holds the
 * locked gallery row, so coercing here closes that race at the money boundary
 * for every claimer (submit, admin lock, on-behalf PATCH).
 */
export function planCartClaim(
  rows: readonly AssetRow[],
  cartPicks: readonly PickRow[],
  userId: string,
  now: Date,
  opts: { allowsOriginal: boolean },
): {
  assetChanges: AssetChange[];
  arrival: Date;
  counts: CartClaimCounts;
  pickKindFixes: string[];
} {
  const arrival = planArrival(rows, now);
  const counts: CartClaimCounts = { claimed: 0, escalated: 0, joined: 0, escalationBlocked: 0 };
  const pickKindFixes: string[] = [];
  const assetChanges: AssetChange[] = [];

  const ordered = [...cartPicks].sort(compareCartOrder);
  for (const pick of ordered) {
    const row = rows.find((candidate) => candidate.id === pick.assetId);
    if (!row) throw new Error(`pick-plans: cart pick references unknown asset ${pick.assetId}`);
    const kind: SelectionKind =
      !opts.allowsOriginal && pick.kind === "original" ? "edited" : pick.kind;
    if (kind !== pick.kind) pickKindFixes.push(pick.assetId);

    const before = claimFromAsset(row);
    const outcome = submitPick(
      before,
      { userId, kind },
      { arrival, hasFinal: row.finalKey !== null },
    );

    if (outcome.type === "claimed") counts.claimed += 1;
    else if (outcome.type === "escalated") counts.escalated += 1;
    else if (outcome.type === "joined") counts.joined += 1;
    else counts.escalationBlocked += 1;

    const change = changeOf(row.id, before, outcome.claim);
    if (change) assetChanges.push(change);
  }

  return {
    assetChanges,
    arrival,
    counts,
    pickKindFixes,
  };
}

/**
 * Re-resolve the given assets against the gallery's picks AFTER the admin's
 * change. Assets that nobody submitted on are skipped by the caller (they
 * carried no claim); passing one is harmless and produces no change, because
 * `reresolveClaim` returns the same `claimed: false`.
 */
export function planReresolve(
  rows: readonly AssetRow[],
  picksAfter: readonly PickRow[],
  affectedAssetIds: readonly string[],
  now: Date,
): PickPlan {
  const arrival = planArrival(rows, now);
  const assetChanges: AssetChange[] = [];

  for (const assetId of [...new Set(affectedAssetIds)]) {
    const row = rows.find((candidate) => candidate.id === assetId);
    if (!row) throw new Error(`pick-plans: unknown asset ${assetId}`);
    const before = claimFromAsset(row);
    const after = reresolveClaim(before, submittedOn(picksAfter, assetId), {
      hasFinal: row.finalKey !== null,
      arrival,
    });
    const change = changeOf(assetId, before, after);
    if (change) assetChanges.push(change);
  }

  return { assetChanges, arrival: assetChanges.length === 0 ? null : arrival };
}

/**
 * Remove EVERY pick of one person (cart and submitted). Only the assets where
 * a SUBMITTED pick was deleted need re-resolution — a cart or degraded pick
 * never carried a claim.
 */
export function planRemovePicks(
  rows: readonly AssetRow[],
  picks: readonly PickRow[],
  userId: string,
  now: Date,
): PickPlan & { deletedPicks: PickRow[] } {
  const deletedPicks = picks.filter((pick) => pick.userId === userId);
  const affected = deletedPicks
    .filter((pick) => pick.submittedAt !== null)
    .map((pick) => pick.assetId);
  const picksAfter = picks.filter((pick) => pick.userId !== userId);
  const plan = planReresolve(rows, picksAfter, affected, now);
  return { ...plan, deletedPicks };
}

/**
 * `allowsOriginalSelection` turned OFF: every `original` pick of the gallery
 * becomes `edited` (cart, degraded and submitted — decision 16's allowed
 * direction), and every claimed asset still priced as `original` is rewritten
 * to `edited` and RE-ARRIVES, unless it already has a final (decision 15
 * forbids re-labelling a file that exists; census says 0 such assets).
 *
 * The holder is unchanged: flipping a gallery-wide flag is not an escalation
 * between people, so nobody's unit moves to another person — it only moves to
 * the end of the included queue (`billedAt = arrival`), which is exactly what
 * `pick-claims.ts` does when a client escalates.
 */
export function planOriginalsOff(
  rows: readonly AssetRow[],
  picks: readonly PickRow[],
  now: Date,
): PickPlan & { pickRewrites: PickRow[] } {
  const pickRewrites = picks.filter((pick) => pick.kind === "original");
  const arrival = planArrival(rows, now);
  const assetChanges: AssetChange[] = [];

  for (const row of rows) {
    if (!row.isSelected || row.selectionKind !== "original") continue;
    if (row.finalKey !== null) continue;
    const before = claimFromAsset(row);
    const after = {
      claimed: true as const,
      kind: "edited" as const,
      billedTo: row.billedTo,
      billedAt: arrival,
    };
    if (row.billedTo === null) {
      // A legacy unit: rule 2 of `reresolveClaim` applies here too — never
      // invent or remove the basis of a legacy unit.
      continue;
    }
    const change = changeOf(row.id, before, after);
    if (change) assetChanges.push(change);
  }

  return {
    assetChanges,
    arrival: assetChanges.length === 0 ? null : arrival,
    pickRewrites,
  };
}

/**
 * What the SUBJECT's own "Enviar" button will do, from the SAME planner the
 * submit executes (`pick-claims.ts` calls `planCartClaim`). The confirmation
 * sheet states this before the irreversible moment; if it computed its own
 * counts or its own money it could disagree with the write, which is exactly
 * the defect this function exists to prevent. `pick-plans.test.ts`'s parity
 * test runs the projection and the executed `claimCart` over the same random
 * states.
 *
 * Per person, not gallery-wide (OQ1): `after` is the subject's own share after
 * the plan, priced by the attribution's single `computeQuota` call. The extra
 * unit price comes from that same attribution's `quota` rather than from
 * `after.extras` (which can be 0) or the live package row (which is not what
 * a frozen gallery charges).
 *
 * `passToYou = claimed + escalated` is exactly `claimCart`'s `newUnits`;
 * `alreadyRequested = joined + escalationBlocked`. Their sum is the cart.
 */
export function projectCartSubmit(
  rows: readonly AssetRow[],
  picks: readonly PickRow[],
  userId: string,
  now: Date,
  snapshot: Parameters<typeof attributeQuota>[1],
  opts: { allowsOriginal: boolean },
): SubmitProjection {
  // A cart pick on an asset ALREADY billed to this same person is a read-time
  // contradiction: `submitPick` throws "submitter is already billed" if such a
  // pick is ever stamped, and the PATCH gate can produce it on a legacy claim
  // with no pick of its own. The projection must not turn that state into a
  // 500 on every page read, so it is left out of the plan (its submit cannot
  // move anything anyway). Every normal cart — the parity test's and
  // production's — has no such row.
  const cartPicks = picks.filter(
    (pick) =>
      pick.userId === userId &&
      pick.submittedAt === null &&
      !rows.some((row) => row.id === pick.assetId && row.isSelected && row.billedTo === userId),
  );
  const plan = planCartClaim(rows, cartPicks, userId, now, opts);
  const afterAttribution = attributeQuota(
    unitsOf(applyPlanToRows(rows, plan.assetChanges)),
    snapshot,
  );

  return {
    passToYou: plan.counts.claimed + plan.counts.escalated,
    alreadyRequested: plan.counts.joined + plan.counts.escalationBlocked,
    after: shareFor(afterAttribution, userId),
    extraUnitPriceCop: afterAttribution.quota.extraUnitPriceCop,
  };
}

/** The assets that move between two states, named by `opFor` (the same rule
 * the planners use), so a re-read "after" produces the same names a plan
 * would. */
function assetsBetween(
  beforeRows: readonly AssetRow[],
  afterRows: readonly AssetRow[],
): { assetId: string; op: AssetChangeOp }[] {
  const out: { assetId: string; op: AssetChangeOp }[] = [];
  for (const afterRow of afterRows) {
    const beforeRow = beforeRows.find((row) => row.id === afterRow.id);
    if (!beforeRow) continue;
    const change = changeOf(afterRow.id, claimFromAsset(beforeRow), claimFromAsset(afterRow));
    if (change) out.push({ assetId: change.assetId, op: change.op });
  }
  return out;
}

/** The rows after the plan, in memory — the preview's own view, and the exact
 * mirror of what `applyAssetChanges` writes (a fresh claim stamps
 * `selected_at`/`requested_at`; a transfer or re-kind never touches them). */
export function applyPlanToRows(
  rows: readonly AssetRow[],
  changes: readonly AssetChange[],
): AssetRow[] {
  return rows.map((row) => {
    const change = changes.find((candidate) => candidate.assetId === row.id);
    if (!change) return row;
    if (!change.after.claimed) {
      return {
        ...row,
        isSelected: false,
        selectionKind: "edited",
        billedTo: null,
        billedAt: null,
        selectedAt: null,
        requestedAt: null,
      };
    }
    return {
      ...row,
      isSelected: true,
      selectionKind: change.after.kind,
      billedTo: change.after.billedTo,
      billedAt: change.after.billedAt,
      selectedAt: change.before.claimed ? row.selectedAt : change.after.billedAt,
      requestedAt: change.before.claimed ? row.requestedAt : change.after.billedAt,
    };
  });
}

export function unitsOf(rows: readonly AssetRow[]): ClaimedUnit[] {
  return rows
    .filter((row) => row.isSelected)
    .map((row) => ({
      assetId: row.id,
      billedTo: row.billedTo,
      kind: row.selectionKind,
      billedAt: row.billedAt,
    }));
}

export type PersonDelta = {
  userId: string;
  label: string;
  before: AttributionShare;
  after: AttributionShare;
};

export type AttributionDelta = {
  gallery: {
    before: ReturnType<typeof attributeQuota>["quota"];
    after: ReturnType<typeof attributeQuota>["quota"];
  };
  people: PersonDelta[];
  unattributed?: { before: AttributionShare; after: AttributionShare };
  assets: { assetId: string; op: AssetChangeOp }[];
};

const SHARE_FIELDS = [
  "included",
  "extras",
  "originals",
  "extrasSurchargeCop",
  "originalsSurchargeCop",
  "surchargeCop",
] as const;

function shareChanged(a: AttributionShare, b: AttributionShare): boolean {
  return SHARE_FIELDS.some((field) => a[field] !== b[field]);
}

/**
 * The before/after the admin sees: `attributeQuota` over the claimed rows
 * BEFORE the plan and over the same rows AFTER it, reduced to per-person
 * deltas. People whose share does not move are omitted; a person who lost
 * every unit is still listed (their `after` is all zeros), so a removal always
 * names the person it charged.
 *
 * Invariant (tested): Σ people `surchargeCop` + `unattributed` equals the
 * gallery total, before and after — the S3 invariant, carried over.
 */
export function attributionDelta(
  rows: readonly AssetRow[],
  plan: PickPlan,
  snapshot: Parameters<typeof attributeQuota>[1],
  labels: Readonly<Record<string, string | null | undefined>> = {},
): AttributionDelta {
  const delta = attributionDeltaBetween(
    rows,
    applyPlanToRows(rows, plan.assetChanges),
    snapshot,
    labels,
  );
  return {
    ...delta,
    assets: plan.assetChanges.map((change) => ({ assetId: change.assetId, op: change.op })),
  };
}

/** The same delta between two states of the same gallery, without needing the
 * plan that produced the second one. The on-behalf PATCH re-reads its own
 * "after" inside the transaction and uses this, so the numbers it answers with
 * come from the rows rather than from a second, hand-maintained diff. */
export function attributionDeltaBetween(
  beforeRows: readonly AssetRow[],
  afterRows: readonly AssetRow[],
  snapshot: Parameters<typeof attributeQuota>[1],
  labels: Readonly<Record<string, string | null | undefined>> = {},
): AttributionDelta {
  const before = attributeQuota(unitsOf(beforeRows), snapshot);
  const after = attributeQuota(unitsOf(afterRows), snapshot);

  const userIds = new Set<string>();
  for (const person of before.people) userIds.add(person.userId);
  for (const person of after.people) userIds.add(person.userId);

  const people: PersonDelta[] = [];
  for (const userId of [...userIds].sort()) {
    const beforeShare = shareFor(before, userId);
    const afterShare = shareFor(after, userId);
    if (!shareChanged(beforeShare, afterShare)) continue;
    people.push({
      userId,
      label: labels[userId] ?? userId,
      before: beforeShare,
      after: afterShare,
    });
  }

  const delta: AttributionDelta = {
    gallery: { before: before.quota, after: after.quota },
    people,
    assets: assetsBetween(beforeRows, afterRows),
  };
  if (shareChanged(before.unattributed, after.unattributed)) {
    delta.unattributed = { before: before.unattributed, after: after.unattributed };
  }
  return delta;
}

/**
 * What <AllowsOriginalSelectionControl>'s confirmation shows: the gallery's
 * quota before the switch goes off, and after — the same `computeQuota` the
 * write lands.
 *
 * THE POINT IS THE PLANNER, NOT THE ARITHMETIC (task #263, fix round, W1).
 * `updateAllowsOriginalSelection` (actions.ts) runs `planOriginalsOff` and
 * applies its `assetChanges`; that plan skips TWO kinds of claimed original —
 * one that already has a final (decision 15, re-labelling a produced file is
 * forbidden) and a LEGACY unit with no recorded holder (`billedTo === null`,
 * `reresolveClaim`'s rule 2). A preview that counts the skips itself gets one
 * of the two wrong, which is exactly what happened: it promised the legacy
 * unit as reverted while the write left it `original`. So the numbers below
 * are `attributionDelta` over the plan — one definition of "what turns off"
 * for the dialog and the write.
 *
 * `picks` are NOT a parameter: re-kind-ing a pick row changes no `assets` row,
 * so the money is a function of the asset rows alone (`planOriginalsOff`
 * returns the pick rewrites for the caller to apply; they move nothing).
 */
export type OriginalsOffPreview = {
  before: AttributionDelta["gallery"]["before"];
  after: AttributionDelta["gallery"]["after"];
};

export function previewOriginalsOff(
  rows: readonly AssetRow[],
  now: Date,
  snapshot: Parameters<typeof attributeQuota>[1],
  labels: Readonly<Record<string, string | null | undefined>> = {},
): OriginalsOffPreview {
  const delta = attributionDelta(rows, planOriginalsOff(rows, [], now), snapshot, labels);
  return { before: delta.gallery.before, after: delta.gallery.after };
}

/**
 * The before/after the dashboard shows BEFORE the admin confirms either of the
 * two money-affecting per-person actions (epic #250, task #263):
 *
 *   - `lock`      — `lockGalleryClientSelection`, which claims that person's
 *                   cart (decision 18). Same planner the write runs:
 *                   `planCartClaim`, the one `claimCart` executes.
 *   - `removePicks` — `removeGalleryClientPicks`, which deletes every pick of
 *                   that person and re-resolves the assets that lose a
 *                   submitted one. Same planner the write runs:
 *                   `planRemovePicks`, the one `removeGalleryClientPicks`
 *                   executes.
 *
 * THE PARITY IS THE POINT. The preview and the write call the same function
 * on the same rows, and the executed delta comes from `attributionDeltaBetween`
 * over the rows the write actually produced — so "what it said would happen"
 * and "what happened" cannot be two pieces of maths. `pick-plans.test.ts` and
 * `actions.client-selection.test.ts` (the parity suite) pin that.
 *
 * `opts.allowsOriginal` mirrors `claimCart`'s own coercion: an `original` cart
 * pick in a gallery that no longer allows originals is previewed as the
 * `edited` pick the lock will actually resolve.
 */
export function previewClientActions(
  rows: readonly AssetRow[],
  picks: readonly PickRow[],
  userId: string,
  now: Date,
  snapshot: Parameters<typeof attributeQuota>[1],
  labels: Readonly<Record<string, string | null | undefined>> = {},
  opts: { allowsOriginal: boolean },
): { lock: AttributionDelta; removePicks: AttributionDelta } {
  const cartPicks = picks.filter((pick) => pick.userId === userId && pick.submittedAt === null);
  return {
    lock: attributionDelta(
      rows,
      planCartClaim(rows, cartPicks, userId, now, { allowsOriginal: opts.allowsOriginal }),
      snapshot,
      labels,
    ),
    removePicks: attributionDelta(
      rows,
      planRemovePicks(rows, picks, userId, now),
      snapshot,
      labels,
    ),
  };
}
