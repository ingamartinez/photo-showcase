"use server";

// Creating a gallery is the one place the epic's central rule lives: the
// chosen package's CURRENT terms are read exactly once, right here, and
// copied into `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`. From
// the moment this insert commits, the gallery owes the `packages` row
// nothing — see schema.ts's comment on those columns and PLAN.md §6.

import { z } from "zod";
import postgres from "postgres";
import { revalidatePath } from "next/cache";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { assets, galleries, galleryClients, packages, users } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import {
  activeClientRuleViolation,
  getGalleryClients,
  isGalleryVisibleToClient,
} from "@/lib/galleries";
import {
  galleryAccessResendKey,
  galleryAccessResendLimiter,
} from "@/lib/gallery-access-rate-limiters";
import { generateGallerySlug } from "@/lib/slug";
import { authEnv, resendEnv } from "@/lib/env";
import { computeQuota } from "@/lib/quota";
import { notifySelectionChanged } from "@/lib/selection-events";
import { sendUnlockNotificationEmail } from "@/lib/unlock-notification-email";

const createGallerySchema = z.object({
  // Fed by a `<select multiple>` picker backed by getClientsForPicker()
  // (src/lib/clients.ts) — a plain presence + shape check here is enough; a
  // value that doesn't actually reference an existing row is caught below,
  // at the insert itself. Task #94: a gallery can now belong to SEVERAL
  // clients, so this is an ARRAY, not a single id.
  //
  // Task #100 REMOVED the `.min(1, "Elegí al menos un cliente.")` this array
  // used to carry, on purpose and at the owner's request: the photographer
  // must be able to set a session up and upload proofs BEFORE the client
  // record exists. An EMPTY array is now a valid create, and the gallery it
  // produces sits in `draft` (the column default, schema.ts) — the one
  // status where zero active clients is legitimate. The lower bound did not
  // disappear, it moved to where it is actually true: `publishGallery` and
  // `deliverGallery` refuse to move a clientless gallery past `draft`, both
  // through `activeClientRuleViolation()` (src/lib/galleries.ts).
  clientIds: z.array(z.string().trim().min(1)),
  packageId: z
    .string()
    .trim()
    .min(1, "Elegí un paquete.")
    .refine((value) => Number.isInteger(Number(value)) && Number(value) > 0, {
      message: "Elegí un paquete válido.",
    })
    .transform(Number),
  title: z.string().trim().min(1, "Ingresá un título."),
  // `<input type="date">` posts "YYYY-MM-DD", the exact shape
  // `galleries.sessionDate` (a `date()` column in string mode) stores.
  sessionDate: z
    .string()
    .trim()
    .min(1, "Elegí la fecha de la sesión.")
    .pipe(z.iso.date("Ingresá una fecha de sesión válida.")),
});

export type CreateGalleryState = {
  status: "idle" | "error" | "created";
  message?: string;
};

const FOREIGN_KEY_VIOLATION = "23503";

// Same cause-chain walk as src/app/dashboard/clients/actions.ts's
// isUniqueViolation, generalized over the SQLSTATE code: drizzle-orm 0.45
// never lets the driver's own error surface directly (`DrizzleQueryError`
// wraps it in `.cause`), so a bare `error instanceof postgres.PostgresError`
// check is always false in production.
function hasPostgresErrorCode(error: unknown, code: string): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof postgres.PostgresError && e.code === code) return true;
  }
  return false;
}

export async function createGallery(
  _prevState: CreateGalleryState,
  formData: FormData,
): Promise<CreateGalleryState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page above it, per src/lib/auth-guards.ts's header comment and the
  // epic's "every route and action is admin-only" rule.
  await requireAdmin();

  const parsed = createGallerySchema.safeParse({
    // `<select multiple>` posts one FormData entry per selected option, all
    // under the same `name` — `getAll`, not `get`, is what surfaces every
    // one of them (task #94).
    clientIds: formData.getAll("clientIds"),
    packageId: formData.get("packageId"),
    title: formData.get("title"),
    sessionDate: formData.get("sessionDate"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisá los datos del formulario.",
    };
  }

  // Read the package's CURRENT terms exactly once, here — never again for
  // this gallery afterward. This is the read the snapshot columns exist to
  // replace everywhere else in the app.
  const [pkg] = await db
    .select()
    .from(packages)
    .where(eq(packages.id, parsed.data.packageId))
    .limit(1);

  if (!pkg) {
    return { status: "error", message: "Elegí un paquete válido." };
  }
  // Defense in depth: getActivePackages() only lists active packages, but
  // nothing stops a crafted request from posting a retired one's id directly.
  // Retired packages must stay valid for galleries that already reference
  // them, but must never be chosen for a NEW one.
  if (!pkg.active) {
    return { status: "error", message: "Ese paquete ya no está disponible." };
  }

  // Deduped defensively before the insert — a native `<select multiple>`
  // cannot post the same option twice, but a crafted request could. Without
  // this, a duplicate pair would hit `gallery_clients`'s composite primary
  // key (schema.ts) and raise a 23505 SQLSTATE this function has no catch
  // for at all (the `catch` block below only ever handles
  // `FOREIGN_KEY_VIOLATION`) — an unhandled 23505 would escape as an
  // uncaught 500, indistinguishable in the error alone from an actual
  // `public_slug` collision (`generateGallerySlug()`'s own 128 bits of
  // randomness makes that collision astronomically unlikely, but not
  // impossible — see that function's own comment). Deduping here removes
  // the only REACHABLE source of a `gallery_clients` 23505 entirely, rather
  // than trying to add a second, ambiguous catch for it.
  const clientIds = [...new Set(parsed.data.clientIds)];

  try {
    // The gallery row and its client memberships are inserted together, in
    // ONE transaction. Task #94 wrote this transaction to guarantee "a
    // gallery never commits with zero clients attached"; task #100 DELETED
    // that guarantee deliberately — a clientless `draft` gallery is now the
    // requested workflow, not a corruption to prevent.
    //
    // The transaction stays, guaranteeing the weaker (and still valuable)
    // thing that is actually true: a create is ALL-OR-NOTHING over the
    // clients the admin chose. Either the gallery and every membership
    // commit, or neither does. A partial failure that left the gallery
    // attached to only SOME of the chosen clients would be invisible — the
    // dashboard would render a plausible-looking client list that silently
    // omits someone who is supposed to have access.
    await db.transaction(async (tx) => {
      const [gallery] = await tx
        .insert(galleries)
        .values({
          packageId: pkg.id,
          title: parsed.data.title,
          sessionDate: parsed.data.sessionDate,
          // Unguessable, generated fresh for every gallery — never derived
          // from the title or a counter (schema.ts's comment on
          // `publicSlug`).
          publicSlug: generateGallerySlug(),
          includedPhotosSnapshot: pkg.includedPhotos,
          extraPhotoPriceCopSnapshot: pkg.extraPhotoPriceCop,
        })
        .returning({ id: galleries.id });

      // Task #100: skipped entirely for a clientless create. Not an
      // optimization — drizzle's `.values([])` builds `insert into
      // gallery_clients ("gallery_id", "user_id") values` with nothing after
      // it, which Postgres rejects as a syntax error.
      if (clientIds.length > 0) {
        await tx
          .insert(galleryClients)
          .values(clientIds.map((clientId) => ({ galleryId: gallery!.id, userId: clientId })));
      }
    });
  } catch (error) {
    if (hasPostgresErrorCode(error, FOREIGN_KEY_VIOLATION)) {
      return { status: "error", message: "Elegí clientes válidos." };
    }
    throw error;
  }

  revalidatePath("/dashboard/galleries");
  return { status: "created" };
}

// ---------------------------------------------------------------------------
// Publish gallery (task #21) — draft -> proofing, plus the client's email.
// ---------------------------------------------------------------------------

export type PublishGalleryState = {
  status: "idle" | "error" | "published";
  message?: string;
};

const publishGallerySchema = z.object({ galleryId: z.uuid() });

// Only a gallery still sitting in "draft" can be published — this single
// check is both halves of the epic's guard at once: an already-"proofing"
// gallery (published once already) and anything further along
// (selected/delivered/archived) are refused for the same reason, "there is
// nothing left to transition". Checked here, at the data-access path
// itself, not only by hiding the button in <PublishGalleryButton> once the
// gallery is no longer draft — a hidden button is UX, not authority (task
// #21's explicit acceptance criterion).
function isPublishable(status: Gallery["status"]): boolean {
  return status === "draft";
}

// The status a successful publish LANDS the gallery in. Named once so the
// active-client pre-flight below and the UPDATE that actually performs the
// transition can never drift apart — the pre-flight asks
// `activeClientRuleViolation()` about the DESTINATION status, and a literal
// repeated in two places is exactly how that question quietly starts being
// asked about the wrong one.
const PUBLISH_TARGET_STATUS = "proofing" as const satisfies Gallery["status"];

/**
 * draft -> proofing. Ordering, deliberate: the client's magic-link EMAIL is
 * sent BEFORE the gallery's status flips — the reverse of what might look
 * more natural.
 *
 * Sending is the side that can realistically fail (a network call to
 * Resend); the status UPDATE right after it is a single indexed write
 * against our own database, no less reliable than the SELECTs already done
 * above it. Doing the riskier side FIRST means a failed send leaves the
 * gallery exactly as it was — still "draft", nothing to undo, the operator
 * sees a clear error and can just press Publish again. The alternative
 * (flip first, send second, roll back on failure) would need a SECOND write
 * to undo the first if sending fails — trading one half-published state for
 * another, worse one (a compensating write that can itself fail). This
 * mirrors the ordering already chosen by the proofs upload route
 * (src/app/api/galleries/[galleryId]/proofs/route.ts: R2 write before the
 * `assets` insert) — do the side that can genuinely fail first, commit the
 * durable state change after it succeeds.
 *
 * The side that CAN still leak, symmetric to that same route's documented
 * R2-orphan case: if the email sends successfully but the status UPDATE
 * right after it fails (a real database outage, in practice — the DB was
 * just read from twice above without incident), the client receives a
 * working link into a gallery the admin dashboard still shows as
 * "Borrador". The operator's recovery is the same click: re-running this
 * action re-sends the email (the client gets a second, equally valid link —
 * mildly redundant, never incorrect or insecure, since each link is its own
 * single-use token) and retries the UPDATE. This is a smaller, safer leak
 * than a gallery stuck showing "proofing" with no client ever notified.
 *
 * Task #94 — SEVERAL clients, ALL-OR-NOTHING send: a gallery can now have
 * more than one client attached, so this sends the SAME magic-link email to
 * every one of them (`Promise.allSettled`, not a `for` loop with an early
 * `return` — one client's Resend failure must never stop the others from
 * getting theirs). The status flip below still only happens if EVERY send
 * succeeded — a partial send (2 of 3 clients notified) is treated the same
 * as a total failure for the PURPOSE of the status flip, not swallowed into
 * a vague "something went wrong": the returned error message names exactly
 * which address(es) failed, and retrying is safe for the clients who
 * already got theirs (mildly redundant, never incorrect, same reasoning as
 * the single-client case above — each magic link is its own single-use
 * token). This preserves the ORIGINAL invariant this function's ordering
 * comment already relies on ("never half-published without every client
 * notified"), generalized from one recipient to N instead of replaced.
 *
 * THE CONCURRENT DOUBLE-PUBLISH RACE, considered and DECLINED (task #120,
 * decided 2026-07-30, owner-approved) — read this before "fixing" it.
 *
 * Two concurrent callers can both clear `isPublishable()` against a still-
 * `draft` row and both reach the `signIn` sends below, so both emails are
 * gone before either reaches the guarded UPDATE. Task #61 made that write
 * conditional on `status = 'draft'`, which correctly de-duplicates the
 * STATUS TRANSITION but structurally cannot un-send the second email. The
 * only real fix is claiming the row atomically BEFORE sending — which the
 * ordering documented at the top of this comment deliberately forbids,
 * because a failed send has to leave the gallery retryable.
 *
 * It was declined for two reasons. First, the realistic trigger — one
 * photographer double-clicking — never reaches the server:
 * `src/components/publish-gallery-button.tsx` renders `disabled={pending}`
 * off `useActionState`. What remains needs two tabs or two devices, in a
 * single-operator app. Second, and more decisive: building it would REVERSE
 * a policy this very function already ships. The partial-failure branch
 * below deliberately re-sends to clients who already received their link,
 * and says so in the operator-facing copy ("quien ya lo recibió puede
 * recibir un segundo correo sin problema"). A duplicate email is already an
 * accepted outcome here, on purpose. You cannot claim-before-send without
 * also reversing that — and the terminal state converges either way, since
 * each magic link is independently single-use.
 *
 * The cost avoided: a new `gallery_status` value, a rollback path back to
 * `draft`, an explicit partial-multi-client-failure policy, and a crash-
 * recovery story for rows stuck mid-claim. Reopen if a second admin or a
 * client-facing publish ever makes the race real.
 */
export async function publishGallery(
  _prevState: PublishGalleryState,
  formData: FormData,
): Promise<PublishGalleryState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page above it, per src/lib/auth-guards.ts's header comment and the
  // epic's "every route and action is admin-only" rule.
  await requireAdmin();

  const parsed = publishGallerySchema.safeParse({ galleryId: formData.get("galleryId") });
  if (!parsed.success) {
    return { status: "error", message: "Galería inválida." };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }
  if (!isPublishable(gallery.status)) {
    return { status: "error", message: "Esta galería ya fue publicada." };
  }

  // Derived, never stored (PLAN.md §6) — counted fresh here rather than
  // trusting a client-side count, same reasoning as the proofs route's own
  // count() read.
  const [{ value: assetCount }] = await db
    .select({ value: count() })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  if (Number(assetCount) === 0) {
    return { status: "error", message: "Subí al menos una foto antes de publicar la galería." };
  }

  // Task #94: a gallery can have SEVERAL clients now — `gallery.clientId`
  // is gone entirely (schema.ts), replaced by this join-table read.
  //
  // DO NOT DELETE THE CHECK BELOW AS DEAD DEFENSIVE CODE. Reaching it with
  // an empty list is not just possible, it is the ordinary case for a
  // gallery the photographer set up before the client record existed (task
  // #100) or stripped back down to zero while still in `draft` (task #97).
  // `isPublishable` is `status === "draft"`, so EVERY gallery that reaches
  // this line is exactly the kind that may legitimately have no clients.
  // This refusal is the enforcement that stops it publishing to nobody.
  //
  // Task #100 collapsed the inline `clients.length === 0` that used to live
  // here into `activeClientRuleViolation()` (src/lib/galleries.ts) — the one
  // place the rule exists, shared with `deliverGallery` and
  // `removeGalleryClient`. Note it is asked about PUBLISH_TARGET_STATUS, not
  // `gallery.status`: the gallery sitting here is `draft`, which does NOT
  // require a client. Asking about the current status would permit exactly
  // what this refuses.
  const clients = await getGalleryClients(gallery.id);
  const activeClientViolation = activeClientRuleViolation({
    targetStatus: PUBLISH_TARGET_STATUS,
    activeClientCount: clients.length,
    action: "publish",
  });
  if (activeClientViolation) {
    return { status: "error", message: activeClientViolation };
  }

  const sendResults = await Promise.allSettled(
    clients.map((client) =>
      signIn("gallery-access", {
        email: client.email,
        redirect: false,
        // Task #22/#23 (backlog, epic #4) own building the page this points
        // at; the URL shape itself — `publicSlug`, the only identifier the
        // epic allows in a URL (PLAN.md §6) — is settled here, ahead of that
        // page. This app already ships forward-pointing links to
        // not-yet-built destinations on purpose (see
        // src/app/dashboard/page.tsx's own comment on /dashboard/clients
        // 404ing "ahead of its content"); until #22/#23 land, following this
        // link 404s after establishing a real, valid session — not broken,
        // just early.
        redirectTo: `/galleries/${gallery.publicSlug}`,
      }),
    ),
  );

  // A rejection that ISN'T an `AuthError` is a genuine bug/outage this
  // action has no story for (same "let it crash rather than silently
  // pretend" stance the single-client version already took) — surfaced by
  // rethrowing, not folded into the partial-failure message below.
  const unexpected = sendResults.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !(result.reason instanceof AuthError),
  );
  if (unexpected) throw unexpected.reason;

  const failedEmails = clients
    .filter((_, index) => sendResults[index]!.status === "rejected")
    .map((client) => client.email);
  if (failedEmails.length > 0) {
    return {
      status: "error",
      message: `No pudimos enviarle el correo a: ${failedEmails.join(", ")}. Probá de nuevo — quien ya lo recibió puede recibir un segundo correo sin problema.`,
    };
  }

  // Task #61 — this UPDATE is now CONDITIONAL (`WHERE status = 'draft'`), not
  // an unconditional flip. Why the SELECT's own `isPublishable()` check above
  // cannot substitute for this: it and this UPDATE are two SEPARATE round
  // trips to the database, with the entire `Promise.allSettled` email send
  // above sitting in the gap between them. A genuine double-submit (the
  // photographer double-clicking "Publicar" on a slow connection) runs a
  // SECOND `publishGallery` call whose own SELECT can land in that exact
  // gap, see `status = 'draft'` (this call hasn't written yet), and race
  // ahead — the textbook check-then-act race. Re-checking the status
  // earlier cannot close a gap that exists AFTER the check; only the WRITE
  // itself, made conditional, can be atomic. Postgres serializes concurrent
  // UPDATEs against the same row, so of two racing calls at most ONE
  // `WHERE status = 'draft'` clause matches; the other matches zero rows
  // and changes nothing.
  //
  // `.returning()` is how that outcome is OBSERVED here — branching on the
  // affected-row count, per this task's own scope, rather than assuming the
  // write always lands. An empty result means THIS call's WHERE matched
  // nothing: some other in-flight call already flipped this gallery to
  // PUBLISH_TARGET_STATUS. Deliberately NOT treated as an error below — see
  // the comment on that branch for why.
  let updated: { id: string }[];
  try {
    updated = await db
      .update(galleries)
      .set({ status: PUBLISH_TARGET_STATUS })
      .where(and(eq(galleries.id, gallery.id), eq(galleries.status, "draft")))
      .returning({ id: galleries.id });
  } catch {
    return {
      status: "error",
      message:
        "Le enviamos el correo al cliente, pero no pudimos actualizar el estado de la galería. " +
        "Volvé a intentar — el cliente puede recibir un segundo correo.",
    };
  }

  if (updated.length === 0) {
    // The LOSING side of the race: this call's own emails already went out
    // above (Promise.allSettled doesn't know or care who wins the write
    // below it — see this task's own ticket, "the send happens BEFORE the
    // update, deliberately", which this guard does NOT reorder), but some
    // other call's UPDATE landed first and the gallery is already
    // PUBLISH_TARGET_STATUS. This is NOT an error: the intended end state —
    // published, client notified — was reached, just not BY this call.
    // Reporting `status: "error"` here would tell the photographer
    // something needs fixing when nothing does; `<PublishGalleryButton>`
    // (src/components/publish-gallery-button.tsx) renders the exact same
    // "Publicada" success message for both the winner and the loser, which
    // is the correct read: from the photographer's chair, two clicks that
    // both end in "Publicada" is indistinguishable from — and no worse
    // than — one click that happened to land twice.
    //
    // What this guard does NOT fix, on purpose (see this task's own
    // ticket): the double EMAIL. Both calls' sends already happened before
    // either reached this line, so a true double-submit still issues two
    // working magic links. Accepted and pre-existing — each Auth.js
    // `verificationToken` is independently single-use (delete-then-return),
    // so only one link survives being clicked first regardless of how many
    // were sent.
    //
    // Falls through to the SAME revalidate + "published" return as the
    // winning branch below, on purpose — see the paragraph above for why
    // the two outcomes are meant to be indistinguishable from here on.
  }

  revalidatePath(`/dashboard/galleries/${gallery.id}`);
  revalidatePath("/dashboard/galleries");
  return { status: "published" };
}

// ---------------------------------------------------------------------------
// Unlock a submitted selection (task #73) — selected -> proofing.
//
// REPLACES A MANUAL-SQL ESCAPE HATCH. Before this action existed, the only
// way to undo a client's submission was an operator running
// `UPDATE galleries SET status = 'proofing' WHERE id = '<id>';` by hand
// against production — task #25's own review flagged this as the sole
// recovery path for a stuck `selected` gallery, with no operator surface and
// no audit trail. This action is that surface: it performs the identical
// state transition through the app's own authorization, idempotency, and
// audit-logging, so nobody needs shell access to a production database to
// reopen a gallery again.
// ---------------------------------------------------------------------------

export type UnlockSelectionState = {
  status: "idle" | "error" | "unlocked" | "unlocked_email_failed";
  message?: string;
};

const unlockSelectionSchema = z.object({
  galleryId: z.uuid(),
  // Optional (task #73's own scope note: "consider a reason field", decided
  // as optional) — a quick unlock during a live phone call must never be
  // blocked on typing a note first. `.trim()` first so a whitespace-only
  // textarea value collapses to `undefined` (via the `.optional()` below
  // never firing on an empty string) rather than being stored as a
  // non-empty-looking but meaningless reason.
  reason: z.string().trim().max(1000, "La nota es demasiado larga.").optional(),
});

// Same "the check IS the authority, hiding the button is only UX" stance as
// `isPublishable` above. Only a gallery sitting in `selected` — a submitted,
// not-yet-reopened selection — has anything to unlock: `draft`/`proofing`
// were never submitted (or already reopened), `delivered`/`archived` are
// further along than a reopen makes sense for.
function isUnlockable(status: Gallery["status"]): boolean {
  return status === "selected";
}

/**
 * selected -> proofing. Implements the REOPEN POLICY task #25 decided and
 * deliberately deferred building the admin side of (see
 * src/app/api/galleries/[galleryId]/submit-selection/route.ts's own header
 * comment): only an admin can undo a client's submission, and only here.
 *
 * `selectionSubmittedAt` is DELIBERATELY PRESERVED, never cleared, on
 * unlock. This was this task's own open question ("clear or preserve?"),
 * and task #75's review answered it: #75 made `selectionSubmittedAt` the
 * SORT KEY for `/dashboard/galleries` (`getGalleriesWithDetails`'s
 * `COALESCE(selectionSubmittedAt, createdAt)` ordering, src/lib/galleries.ts).
 * Clearing it here would drop a gallery the photographer is ACTIVELY
 * reopening — the single most recently-active gallery in the whole system
 * at that instant — straight back to its `createdAt` position, vanishing
 * from the top of the list it just proved itself to belong at. That is the
 * exact failure #75 was built to eliminate, reintroduced by this task for
 * the one case #75's own review flagged as the likeliest to trigger it. If
 * the selection is later resubmitted, the submit route (task #25) stamps a
 * FRESH `selectionSubmittedAt` on that transition regardless of what this
 * action ever did — nothing here needs to "reset" it for that to keep
 * working.
 *
 * The unlock is audited on the gallery's own row, not a separate history
 * table: WHO (`unlockedByEmail` — the acting admin's own session email,
 * PLAN.md §4's "identity is the email", snapshotted rather than a foreign
 * key; see schema.ts's comment on that column for why) and WHEN
 * (`unlockedAt`), plus an OPTIONAL `reason` a photographer can leave for
 * their own future reference and for the client's — "this is an audit
 * trail for a money conversation", per this task's own scope note. Only the
 * MOST RECENT unlock is kept (overwritten by a later one) — the acceptance
 * criterion is "who did it and when, AT MINIMUM", not a full append-only
 * log, and that scope cut is deliberate.
 *
 * Guarded the same way publishGallery/submit-selection already are: the
 * UPDATE's own `WHERE status = 'selected'` is the REAL, atomic guard
 * (`isUnlockable` above only fails fast, before ever writing, with a
 * clearer message than a generic "no rows updated") — a double-click, or
 * two admin tabs, can only ever unlock a given gallery once, and only the
 * winner's `unlockedAt`/`unlockedByEmail`/`unlockReason` survives.
 *
 * The client notification is BEST-EFFORT (a Resend outage must never leave
 * the gallery stuck half-transitioned) but its failure is NOT silently
 * swallowed the way submit-selection's own admin notification is. That
 * route can afford to swallow a failed send because `/dashboard/galleries`
 * already surfaces every `selected` gallery to the one person who needs to
 * notice it (the admin themselves, task #75). The client has no equivalent
 * surface here — no "your selection reopened" banner exists anywhere in
 * this app — so a client whose email never arrives has NO way to discover
 * the reopen on their own, and "the photographer waits forever" (this
 * task's own acceptance criterion) is exactly what happens. So a failed
 * send is reported back to the admin as a DISTINCT, actionable result
 * (`unlocked_email_failed`) instead of a generic success. The unlock
 * itself is never rolled back to "fix" an unrelated email failure —
 * reverting a durably-committed state transition would recreate the exact
 * half-done-state risk publishGallery's own ordering comment above reasons
 * about — but the admin learns immediately that they need to tell the
 * client some other way, the same "the fix is a phone call" stance task
 * #25 already settled on for the reopen policy itself.
 */
export async function unlockSelection(
  _prevState: UnlockSelectionState,
  formData: FormData,
): Promise<UnlockSelectionState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page hiding the button once a gallery is no longer `selected`. See
  // this file's own repeated stance on `isPublishable`/`isUnlockable` above
  // and the epic's "every route and action is admin-only" rule.
  const session = await requireAdmin();

  const parsed = unlockSelectionSchema.safeParse({
    galleryId: formData.get("galleryId"),
    // `formData.get` on a never-filled optional textarea returns `""`, not
    // `null` — normalized to `undefined` here so the schema's `.optional()`
    // actually fires instead of validating an empty string as "a reason".
    reason: formData.get("reason") || undefined,
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Galería inválida.",
    };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }
  if (!isUnlockable(gallery.status)) {
    return {
      status: "error",
      message: "Esta galería no tiene una selección enviada para desbloquear.",
    };
  }

  const reason = parsed.data.reason ?? null;
  // `session.user.email` is typed optional by NextAuth's `DefaultSession`,
  // but `users.email` is NOT NULL in schema.ts and the database session
  // strategy (src/auth.ts) populates `session.user` straight from that row
  // on every request — unreachable in practice, but the fallback keeps the
  // audit trail from silently losing the actor entirely if it ever did
  // happen.
  //
  // This used to cite "this file's own 'unreachable in practice'
  // client/admin lookups above" as precedent. Those lookups no longer claim
  // any such thing — #94, #97 and #100 each made one of them genuinely
  // reachable — so the cross-reference is gone and this stands on its own
  // NOT NULL column. Note the difference in KIND, which is why this one
  // survives: `users.email` is a database constraint, whereas the client
  // lookups rested on a form's validation.
  const unlockedByEmail = session.user.email ?? session.user.id;
  const now = new Date();

  const updated = await db
    .update(galleries)
    .set({
      status: "proofing",
      unlockedAt: now,
      unlockedByEmail,
      unlockReason: reason,
    })
    .where(and(eq(galleries.id, gallery.id), eq(galleries.status, "selected")))
    .returning();

  if (updated.length === 0) {
    // Lost the race — some other call already moved this gallery out of
    // `selected` between the read above and this UPDATE (a second unlock
    // click, or a concurrent admin tab). Same "the CAS is the only source
    // of truth" stance as the submit route's own losing branch: nothing
    // more to do, no partial write happened.
    return {
      status: "error",
      message: "Esta galería ya no tiene una selección enviada — puede que ya se haya actualizado.",
    };
  }
  const unlockedGallery = updated[0]!;

  // Task #114 — every open client tab reopens the instant this commits
  // (proof-grid.tsx's live `status`), rather than waiting up to a poll tick —
  // the same convergence-in-both-directions this action's own header comment
  // already promises, now pushed instead of polled. Fire-and-forget, same
  // reasoning as the two sibling call sites (the PATCH toggle route and the
  // submit route): the transition above already committed.
  void notifySelectionChanged(unlockedGallery.id).catch(() => {
    // Swallowed — see src/lib/selection-events.ts's own header comment; the
    // 30s fallback poll is the backstop.
  });

  // Task #94: a gallery can have SEVERAL clients now — `unlockedGallery.
  // clientId` is gone entirely (schema.ts), replaced by this join-table
  // read.
  //
  // AN EMPTY LIST HERE IS RARE BUT NOT IMPOSSIBLE. This comment used to say
  // "unreachable BY DESIGN (gallery-form.tsx requires at least one client at
  // creation, and there is no removal path yet)". Both halves of that are
  // now false: #97 added `removeGalleryClient`, and #100 removed the
  // creation-time requirement outright. Believing that sentence is exactly
  // what let `deliverGallery` ship with no zero-client guard at all for a
  // whole slice, so it is spelled out here rather than trimmed.
  //
  // What actually remains reachable: `isUnlockable` is
  // `status === "selected"`, and the rule requires an active client for
  // `selected`, so `removeGalleryClient` refuses to strip the last one off a
  // gallery that could reach this line. The only route to zero is the narrow
  // read-then-write race that action documents in its own header — two
  // concurrent removals both reading "2 active" and both committing.
  //
  // AND DO NOT ADD A PRE-FLIGHT REFUSAL HERE the way `deliverGallery` has
  // one. Deliver's guard exists because delivering to nobody CREATES a dead
  // end. Unlock moves `selected -> proofing`, and the rule already required
  // an active client for BOTH — a clientless gallery reaching this line is
  // already in a violating state that the unlock neither causes nor worsens.
  // Refusing here would only strand it further. The report below is the
  // right response.
  const clients = await getGalleryClients(unlockedGallery.id);

  // Quota AT THE MOMENT OF UNLOCK — since a `selected` gallery's assets
  // cannot be toggled (`SELECTION_LOCKED_STATUSES` on the sibling PATCH
  // route, src/app/api/assets/[assetId]/selection/route.ts), this is
  // exactly what the client had submitted, computed off the gallery's own
  // frozen snapshot terms — never the live `packages` row (this epic's
  // central rule, repeated in every sibling that touches quota).
  const siblings = await db
    .select({ isSelected: assets.isSelected })
    .from(assets)
    .where(eq(assets.galleryId, unlockedGallery.id));
  const selectedCount = siblings.filter((row) => row.isSelected).length;
  const quota = computeQuota(selectedCount, {
    includedPhotosSnapshot: unlockedGallery.includedPhotosSnapshot,
    extraPhotoPriceCopSnapshot: unlockedGallery.extraPhotoPriceCopSnapshot,
  });

  // Task #94 — SEVERAL clients, PARTIAL failure named explicitly: this used
  // to be a single best-effort send collapsed into one boolean
  // (`emailFailed`). With N clients, "one address bounced, the rest didn't"
  // is a new state this product hasn't had before — reported here as EXACTLY
  // which address(es) failed, not folded into a generic "couldn't notify
  // the client" the way a single boolean would. The unlock itself is NEVER
  // rolled back for an email failure (partial or total) — same "the state
  // transition already committed, notification is best-effort" stance the
  // header comment above already takes; this only changes what a failure
  // REPORTS, not what it does.
  let failedEmails: string[] = [];
  if (clients.length === 0) {
    // Reachable only through the removal race named at the lookup above —
    // treated the same as every client's send failing, since there is nobody
    // to notify either way. (This branch also said "unreachable BY DESIGN"
    // until task #100; it never was, once #97 shipped removal.)
    failedEmails = [];
  } else {
    try {
      const { RESEND_API_KEY, EMAIL_FROM } = resendEnv();
      const { AUTH_URL } = authEnv();
      // The CLIENT's own gallery URL (`/galleries/[publicSlug]`), not the
      // admin dashboard URL `sendSubmissionNotificationEmail` builds — see
      // src/lib/unlock-notification-email.ts's own comment on why. Built
      // once and reused for every client — it does not vary per recipient.
      const galleryUrl = new URL(`/galleries/${unlockedGallery.publicSlug}`, AUTH_URL).toString();

      const sendResults = await Promise.allSettled(
        clients.map((client) =>
          sendUnlockNotificationEmail({
            apiKey: RESEND_API_KEY,
            from: EMAIL_FROM,
            to: client.email,
            clientName: client.name,
            clientEmail: client.email,
            galleryTitle: unlockedGallery.title,
            galleryUrl,
            reason,
            quota,
          }),
        ),
      );
      failedEmails = clients
        .filter((_, index) => sendResults[index]!.status === "rejected")
        .map((client) => client.email);
    } catch {
      // `resendEnv()`/`authEnv()` itself threw (missing config) before any
      // send was even attempted — every client counts as unreached.
      failedEmails = clients.map((client) => client.email);
    }
  }

  revalidatePath(`/dashboard/galleries/${unlockedGallery.id}`);
  revalidatePath("/dashboard/galleries");

  if (clients.length === 0) {
    return {
      status: "unlocked_email_failed",
      message:
        "Desbloqueamos la selección, pero no encontramos clientes a quién avisar por correo. " +
        "Avisale por otro medio (WhatsApp / llamada).",
    };
  }
  if (failedEmails.length > 0) {
    return {
      status: "unlocked_email_failed",
      message:
        `Desbloqueamos la selección, pero no pudimos avisarle por correo a: ${failedEmails.join(", ")}. ` +
        "Avisale por otro medio (WhatsApp / llamada).",
    };
  }
  return { status: "unlocked" };
}

// ---------------------------------------------------------------------------
// Deliver a gallery (task #27) — selected -> delivered, plus the client's
// email. Closes the delivery chain task #26 started: that task made
// `assets.finalKey`/`isEdited` real and gave the admin workspace a per-asset
// "Falta el final" indicator (a convenience, not a control); this action is
// the control.
// ---------------------------------------------------------------------------

export type DeliverGalleryState = {
  status: "idle" | "error" | "delivered" | "delivered_email_failed";
  message?: string;
};

const deliverGallerySchema = z.object({ galleryId: z.uuid() });

// Same "the check IS the authority, hiding the button is only UX" stance as
// `isPublishable`/`isUnlockable` above. Only a gallery sitting in `selected`
// — a submitted selection the photographer has (presumably) finished editing
// — has anything to deliver: `draft`/`proofing` were never submitted,
// `delivered` is already delivered (this is what makes a double-submit a
// no-op instead of a second email), `archived` is further along than
// delivery makes sense for.
function isDeliverable(status: Gallery["status"]): boolean {
  return status === "selected";
}

// The status a successful delivery LANDS the gallery in — same reasoning as
// `PUBLISH_TARGET_STATUS` above: the active-client pre-flight asks
// `activeClientRuleViolation()` about the destination, and the CAS UPDATE
// writes the same constant.
const DELIVER_TARGET_STATUS = "delivered" as const satisfies Gallery["status"];

/**
 * selected -> delivered. The epic's central rule for this task: **refuse
 * delivery while any selected asset still lacks a final** — half-delivering
 * is worse than not delivering, because the client has no way to tell which
 * of their photos are missing from which are still coming. This is checked
 * HERE, in the action itself, not only by <GalleryWorkspace>'s own
 * "Faltan N de M finales por subir" counter (task #26) — that counter is a
 * convenience for the photographer while they work, not the authority; a
 * crafted request (or a stale page) must be refused exactly the same way a
 * missing click on the button would be. Read fresh, off the database, right
 * before the transition — never trusted from anything the caller supplied.
 *
 * Guarded the same way publishGallery/unlockSelection already are: the
 * UPDATE's own `WHERE status = 'selected'` is the REAL, atomic guard
 * (`isDeliverable` above only fails fast, before ever writing) — a
 * double-click, or two admin tabs, can only ever deliver a given gallery
 * once, and only the winner's `deliveredAt` and email survive. A gallery
 * already `delivered` fails the pre-flight `isDeliverable` check on any
 * later call, so a sequential double-submit never reaches the UPDATE at
 * all — the SAME "the second call short-circuits before the CAS" shape
 * `unlockSelection`'s own test suite documents and guards against being
 * mistaken for proof of the atomic guard.
 *
 * The client notification reuses the exact mechanism `publishGallery` uses —
 * `signIn("gallery-access", ...)` — rather than a bare
 * `/galleries/${publicSlug}` URL (the shape `sendUnlockNotificationEmail`'s
 * own `galleryUrl` uses). That distinction is deliberate, not copy-paste
 * drift: `unlockSelection` fires while the client is presumably still
 * mid-selection, with a magic-link session from the original publish email
 * that is very likely still valid (`GALLERY_ACCESS_MAX_AGE_SECONDS` is the
 * TOKEN's lifetime, but the database SESSION it establishes on click lives
 * far longer). Delivery, by contrast, can land days or weeks after that —
 * the photographer has to actually finish editing every selected photo in
 * between — by which point the client's original session may well have
 * expired. A bare URL into an expired session is not "a working link", it's
 * a login wall; re-running the SAME single-use, session-establishing
 * magic-link flow `publishGallery` already relies on is what actually
 * satisfies this task's own acceptance criterion ("a working link to the
 * gallery"), regardless of how stale the client's last session is.
 *
 * Ordering, deliberately the REVERSE of `publishGallery`'s own "send first,
 * then flip status": here the atomic status UPDATE happens FIRST, and the
 * email is attempted only after it commits — the same ordering
 * `unlockSelection` uses, for the same reason. `publishGallery`'s "send
 * first" ordering exists specifically because THAT transition has no
 * `deliveredAt`-shaped audit stamp and nothing else in the app surfaces a
 * `draft` gallery to anyone; committing the status before confirming the
 * send risks a client-visible `proofing` gallery with no email ever sent,
 * and no photographer-visible signal that anything is wrong. Here, a
 * `delivered` gallery IS what the photographer wanted to happen and is
 * fully visible on `/dashboard/galleries` either way; deferring the email
 * until after the CAS commits is what makes the transition itself
 * idempotent under a genuine race (see the concurrent-delivery test suite)
 * without needing to first read-then-write-then-maybe-revert around a
 * network call whose failure must never roll back a durably-committed
 * delivery.
 */
export async function deliverGallery(
  _prevState: DeliverGalleryState,
  formData: FormData,
): Promise<DeliverGalleryState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page hiding the button once a gallery is no longer `selected`. See
  // this file's own repeated stance on `isPublishable`/`isUnlockable` above
  // and the epic's "every route and action is admin-only" rule.
  await requireAdmin();

  const parsed = deliverGallerySchema.safeParse({ galleryId: formData.get("galleryId") });
  if (!parsed.success) {
    return { status: "error", message: "Galería inválida." };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }
  if (!isDeliverable(gallery.status)) {
    return {
      status: "error",
      message: "Esta galería no tiene una selección enviada para entregar.",
    };
  }

  // THE core rule of this slice, enforced here — not only in the UI. A fresh
  // read, off the database, of every sibling asset: any asset that is
  // SELECTED but has no `finalKey` yet blocks the whole delivery. A narrow
  // race exists between this read and the CAS UPDATE below (an admin could
  // in principle delete a final in one tab between the two) — accepted, not
  // fixed here, the same class of small, undocumented-away race
  // submit-selection's own `empty_selection` check tolerates ahead of ITS
  // CAS UPDATE: admin-only, not a security boundary, and not worth folding
  // this count into the UPDATE's own WHERE as a correlated EXISTS subquery
  // for this slice's acceptance criterion.
  const siblings = await db
    .select({ isSelected: assets.isSelected, finalKey: assets.finalKey })
    .from(assets)
    .where(eq(assets.galleryId, gallery.id));
  const missingFinalsCount = siblings.filter(
    (row) => row.isSelected && row.finalKey === null,
  ).length;
  if (missingFinalsCount > 0) {
    return {
      status: "error",
      message:
        missingFinalsCount === 1
          ? "Falta 1 final por subir antes de poder entregar esta galería."
          : `Faltan ${missingFinalsCount} finales por subir antes de poder entregar esta galería.`,
    };
  }

  // Task #100: the zero-client REFUSAL, and it has to happen HERE — before
  // the UPDATE, not next to the post-delivery read further down. This action
  // already had a `clients.length === 0` branch, but by the time it runs the
  // `selected -> delivered` transition has committed, so it can only pick a
  // MESSAGE for something that already happened. A gallery nobody is
  // attached to cannot be delivered to anybody; delivering it anyway
  // produces a `delivered` gallery no human can open, which is precisely the
  // silent no-op the rule exists to prevent.
  //
  // Same shared rule, same one function, as `publishGallery` above and
  // `removeGalleryClient` below — asked about DELIVER_TARGET_STATUS. (Here
  // the current status, `selected`, would give the same answer; asking about
  // the destination anyway keeps all three call sites saying the same thing,
  // which is what stops the publish case's genuine difference from looking
  // like an anomaly.)
  const preflightClients = await getGalleryClients(gallery.id);
  const activeClientViolation = activeClientRuleViolation({
    targetStatus: DELIVER_TARGET_STATUS,
    activeClientCount: preflightClients.length,
    action: "deliver",
  });
  if (activeClientViolation) {
    return { status: "error", message: activeClientViolation };
  }

  const now = new Date();
  const updated = await db
    .update(galleries)
    .set({ status: DELIVER_TARGET_STATUS, deliveredAt: now })
    .where(and(eq(galleries.id, gallery.id), eq(galleries.status, "selected")))
    .returning();

  if (updated.length === 0) {
    // Lost the race — some other call already moved this gallery out of
    // `selected` between the read above and this UPDATE (a second delivery
    // click, or a concurrent admin tab). Same "the CAS is the only source of
    // truth" stance as unlockSelection's own losing branch: nothing more to
    // do, no partial write happened.
    return {
      status: "error",
      message: "Esta galería ya no tiene una selección enviada — puede que ya se haya entregado.",
    };
  }
  const deliveredGallery = updated[0]!;

  // Task #94: a gallery can have SEVERAL clients now —
  // `deliveredGallery.clientId` is gone entirely (schema.ts), replaced by
  // this join-table read.
  //
  // Read FRESH, deliberately, rather than reusing `preflightClients` from
  // above: the pre-flight ran before the UPDATE and this list decides who
  // actually gets an email, so it must reflect the state after the
  // transition committed, not before it.
  //
  // AN EMPTY LIST HERE IS NOW GENUINELY RARE, and the `clients.length === 0`
  // branch below is what it always was — a REPORT ("we delivered, but found
  // nobody to email"), never the refusal. Task #100 added the actual refusal
  // ABOVE, before the UPDATE, so an empty list at this point means the
  // gallery lost its last active client BETWEEN the pre-flight and this
  // read. Two documented windows lead there, both narrow: the pre-flight/CAS
  // gap here, and the read-then-write race `removeGalleryClient` documents
  // in its own header (two concurrent removals both reading "2 active").
  // Keep the branch — the delivery has durably committed by now and must not
  // be rolled back to tidy up an email nobody can receive; the admin needs
  // to be told so they can reach the client another way.
  const clients = await getGalleryClients(deliveredGallery.id);

  // SEVERAL clients, PARTIAL failure named explicitly — same shape as
  // `publishGallery`'s own send loop above (this reuses the identical
  // `signIn("gallery-access", ...)` mechanism, see this function's own
  // header comment for why), reported via WHICH address(es) failed rather
  // than a single collapsed boolean, same reasoning as `unlockSelection`'s
  // own rewrite.
  let failedEmails: string[] = [];
  if (clients.length > 0) {
    const sendResults = await Promise.allSettled(
      clients.map((client) =>
        signIn("gallery-access", {
          email: client.email,
          redirect: false,
          redirectTo: `/galleries/${deliveredGallery.publicSlug}`,
        }),
      ),
    );

    // Same "an unexpected, non-`AuthError` rejection is a bug/outage, not a
    // partial-send state" stance as `publishGallery` above.
    const unexpected = sendResults.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" && !(result.reason instanceof AuthError),
    );
    if (unexpected) throw unexpected.reason;

    failedEmails = clients
      .filter((_, index) => sendResults[index]!.status === "rejected")
      .map((client) => client.email);
  }

  revalidatePath(`/dashboard/galleries/${deliveredGallery.id}`);
  revalidatePath("/dashboard/galleries");

  if (clients.length === 0) {
    return {
      status: "delivered_email_failed",
      message:
        "Entregamos la galería, pero no encontramos clientes a quién avisar por correo. " +
        "Avisale por otro medio (WhatsApp / llamada).",
    };
  }
  if (failedEmails.length > 0) {
    return {
      status: "delivered_email_failed",
      message:
        `Entregamos la galería, pero no pudimos avisarle por correo a: ${failedEmails.join(", ")}. ` +
        "Avisale por otro medio (WhatsApp / llamada).",
    };
  }
  return { status: "delivered" };
}

// ---------------------------------------------------------------------------
// Attach clients to an EXISTING gallery (task #97) — the product's first
// gallery-editing surface (see this file's own top-of-task framing in the
// kanban body: before this, a gallery's client list was fixed at creation).
//
// THE TRAP this whole action exists to avoid: `gallery_clients` grants
// AUTHORIZATION, not a way IN. The only door into a gallery is the magic
// link `signIn("gallery-access", ...)` sends (the SAME provider
// `publishGallery`/`deliverGallery` above already use — never a second
// door). A client attached after the gallery was published would be
// authorized for a gallery they have no link to and no reason to log in
// for, unless this action sends them one itself.
//
// WHAT GETS SENT, DECIDED PER STATUS — reusing `isGalleryVisibleToClient`
// (src/lib/galleries.ts), the SAME predicate that decides whether a client
// may view `/galleries/[publicSlug]` at all, rather than inventing a second
// status set that could drift from it:
//   - `draft`    — NOTHING is sent. There is nothing to view yet (PLAN.md
//     §2: proof upload starts in draft, before the client even knows the
//     gallery exists) — the eventual `publishGallery` call sends every
//     attached client (including this one) their first link when the
//     gallery actually opens.
//   - `proofing`/`selected`/`delivered` — the SAME `gallery-access` magic
//     link every other client already received. The existing copy
//     (`src/lib/gallery-access-email.ts`) is deliberately generic ("tus
//     fotos ya están listas para ver") — it already does double duty for
//     two materially different real states (proofing: browse and pick;
//     delivered: browse and download) without ever claiming the selection
//     is still open, so reusing it a third time for `selected` (browse
//     only, since #94's rule is that the FIRST submit closes selection for
//     EVERYONE) introduces no new misrepresentation.
//   - `archived` — also nothing (falls out of `isGalleryVisibleToClient`
//     being `false`), matching the same "no defined client behavior for
//     this status" stance `isGalleryVisibleToClient`'s own comment takes.
//
// EMAIL IS SENT TO EVERY REQUESTED ID, UNCONDITIONALLY (never attached, or
// attached-and-removed, or already-active) — not classified case by case.
//
// The honest reason, stated plainly after a review caught this comment
// justifying itself with a scenario the UI forbids: this action cannot tell
// "already active AND already notified" apart from "already active because
// an EARLIER attach half-succeeded" (row written, email failed — the
// `attached_email_failed` branch below commits the membership either way).
// The `gallery_clients` row records no notification state at all, and
// deliberately so: it is a membership table, not a delivery log. Given that
// ambiguity, sending is the safer default of the two, because
// `publishGallery`'s own header comment already established that a
// redundant resend is "mildly redundant, never incorrect" — every magic
// link is single-use — whereas a skipped send leaves a client with
// authorization and no way in, which is the exact trap this whole action
// exists to close.
//
// KNOWN GAP, filed as task #101 ("Resend a gallery-access email to an
// already-attached client"), NOT solved here: there is no resend
// affordance anywhere in the UI, so the "admin retries the failed address"
// path this behavior would most obviously serve is currently UNREACHABLE.
// After a partial failure the action still calls `revalidatePath` below, and
// the detail page recomputes `eligibleClients = allClients − activeClientIds`
// (page.tsx) — the client whose send just failed is now active, so the
// attach picker drops them and the admin cannot select them again. Do not
// cite that retry as the reason for the unconditional send until the
// affordance exists.
export type AttachGalleryClientsState = {
  status: "idle" | "error" | "attached" | "attached_email_failed";
  message?: string;
};

const attachGalleryClientsSchema = z.object({
  galleryId: z.uuid(),
  // An ARRAY for the same reason `createGallery`'s is (task #94: a gallery
  // holds several clients), but the `.min(1)` DELIBERATELY DIVERGES from it
  // since task #100. `createGallery` dropped its lower bound because a
  // clientless gallery is a real, requested thing; "attach nobody to this
  // gallery" is not a thing at all — it is an empty request, and answering it
  // with a cheerful "clientes agregados" would be a silent no-op. Do not
  // "restore consistency" by deleting this.
  clientIds: z.array(z.string().trim().min(1)).min(1, "Elegí al menos un cliente."),
});

export async function attachGalleryClients(
  _prevState: AttachGalleryClientsState,
  formData: FormData,
): Promise<AttachGalleryClientsState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page above it, per src/lib/auth-guards.ts's header comment and the
  // epic's "every route and action is admin-only" rule.
  await requireAdmin();

  const parsed = attachGalleryClientsSchema.safeParse({
    galleryId: formData.get("galleryId"),
    clientIds: formData.getAll("clientIds"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisá los datos del formulario.",
    };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }

  // Deduped defensively before touching the database — same reasoning as
  // createGallery's own dedupe: a native `<select multiple>` cannot post the
  // same option twice, but a crafted request could.
  const clientIds = [...new Set(parsed.data.clientIds)];

  // Resolves name/email for the access email below AND doubles as
  // client-id validation — an id that doesn't match a real `users` row
  // fails this length check instead of ever reaching a write. This is a
  // read-based equivalent of createGallery's own reliance on the
  // `gallery_clients` FK raising `23503` for a bad id: since this action
  // needs every requested id's email regardless (for the access email), the
  // validation comes for free from that same read rather than needing a
  // SEPARATE round trip just to catch a bad id via a constraint violation.
  const requestedUsers = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, clientIds));
  if (requestedUsers.length !== clientIds.length) {
    return { status: "error", message: "Elegí clientes válidos." };
  }

  // Three cases, all handled WITHOUT ever risking a `gallery_clients`
  // composite-PK collision (23505) — read first, then insert only the ids
  // that have no row yet, and UPDATE (clear `removedAt`) only the ones that
  // do. This is a read-then-write, not an atomic upsert — a genuine
  // concurrent double-attach of the SAME id could still race between the
  // read and the write below and raise a 23505 this function has no catch
  // for. Accepted, not closed here: admin-only, single-admin, sequential
  // usage in practice — the same class of narrow, documented race this
  // codebase already tolerates elsewhere (e.g. submit-selection's own
  // pre-flight checks) rather than reaching for `ON CONFLICT DO UPDATE`
  // machinery this slice's acceptance criterion doesn't ask for. What this
  // read-first shape DOES guarantee, unconditionally: `public_slug` is never
  // touched by this action at all, so there is no ambiguous 23505 to
  // mis-catch here in the first place — the exact mistake #94's review
  // caught once already.
  const existingMemberships = await db
    .select({ userId: galleryClients.userId, removedAt: galleryClients.removedAt })
    .from(galleryClients)
    .where(
      and(eq(galleryClients.galleryId, gallery.id), inArray(galleryClients.userId, clientIds)),
    );
  const existingIds = new Set(existingMemberships.map((row) => row.userId));
  const neverAttachedIds = clientIds.filter((id) => !existingIds.has(id));
  const removedIds = existingMemberships
    .filter((row) => row.removedAt !== null)
    .map((row) => row.userId);

  // BOTH writes in ONE transaction, for the same reason `createGallery`
  // above wraps its own pair: a single admin action that half-applies is a
  // state nobody asked for. Attaching three clients where one is brand new
  // and two were previously removed is ONE decision by the admin; a failure
  // between the INSERT and the UPDATE would attach the new client, leave the
  // two removed ones removed, and report neither — and the emails sent below
  // would then invite people who are still locked out. The two statements
  // cannot be merged (one inserts rows, the other clears `removedAt` on rows
  // that already exist), so the transaction is what makes them one unit.
  //
  // This does NOT fight the email-after-write structure: the transaction
  // closes BEFORE any `signIn` call, so no magic link is ever sent from
  // inside an open transaction, and a send failure still leaves the (already
  // committed) attach in place — the same "the state change committed,
  // notification is best-effort" stance `publishGallery`/`deliverGallery`
  // take. What it does NOT close is the read-then-write race described
  // above: the reads happen before this block, so a concurrent attach can
  // still make `neverAttachedIds` stale. Atomicity of the two writes and
  // isolation from a concurrent reader are different problems; only the
  // first one is solved here.
  if (neverAttachedIds.length > 0 || removedIds.length > 0) {
    await db.transaction(async (tx) => {
      if (neverAttachedIds.length > 0) {
        await tx
          .insert(galleryClients)
          .values(neverAttachedIds.map((userId) => ({ galleryId: gallery.id, userId })));
      }
      if (removedIds.length > 0) {
        await tx
          .update(galleryClients)
          .set({ removedAt: null })
          .where(
            and(
              eq(galleryClients.galleryId, gallery.id),
              inArray(galleryClients.userId, removedIds),
            ),
          );
      }
    });
  }

  revalidatePath(`/dashboard/galleries/${gallery.id}`);
  revalidatePath("/dashboard/galleries");

  // `draft`/`archived` — see this action's own header comment for why
  // nothing is sent in either case.
  if (!isGalleryVisibleToClient(gallery.status)) {
    return {
      status: "attached",
      message:
        gallery.status === "draft"
          ? "Cliente agregado. Va a recibir el enlace de acceso cuando publiques la galería."
          : "Cliente agregado.",
    };
  }

  // Reuses the EXACT SAME provider call `publishGallery`/`deliverGallery`
  // already make — never a second door into the gallery (this action's own
  // header comment). Sent to EVERY requested client, not just the newly
  // attached ones — see the header comment above for why.
  const sendResults = await Promise.allSettled(
    requestedUsers.map((user) =>
      signIn("gallery-access", {
        email: user.email,
        redirect: false,
        redirectTo: `/galleries/${gallery.publicSlug}`,
      }),
    ),
  );

  // An unexpected, non-`AuthError` rejection is a genuine bug/outage — same
  // "let it crash rather than silently pretend" stance publishGallery's own
  // send loop takes.
  const unexpected = sendResults.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !(result.reason instanceof AuthError),
  );
  if (unexpected) throw unexpected.reason;

  const failedEmails = requestedUsers
    .filter((_, index) => sendResults[index]!.status === "rejected")
    .map((user) => user.email);
  if (failedEmails.length > 0) {
    return {
      status: "attached_email_failed",
      message:
        `Agregamos al cliente, pero no pudimos enviarle el correo de acceso a: ${failedEmails.join(", ")}. ` +
        "Avisale por otro medio (WhatsApp / llamada).",
    };
  }

  return {
    status: "attached",
    message:
      requestedUsers.length === 1
        ? "Cliente agregado y le mandamos el enlace para entrar a la galería."
        : "Clientes agregados y les mandamos el enlace para entrar a la galería.",
  };
}

// ---------------------------------------------------------------------------
// Resend the gallery-access email to an already-attached client (task #101).
//
// THE GAP THIS CLOSES: `attachGalleryClients` above sends the access email
// unconditionally on attach, but if that send fails the client is already
// ACTIVE by then (the write commits before the email is attempted) — and an
// active client is filtered OUT of the attach picker's `eligibleClients`
// (src/app/dashboard/galleries/[galleryId]/page.tsx). Before this action, the
// only way to give that client a working link was to remove and re-attach
// them, writing a `removed_at` that gets cleared a moment later — a
// soft-delete audit entry for something that never actually happened. See
// `attachGalleryClients`'s own header comment for the fuller account of how
// this gap was discovered (kanban #97's review) and left open on purpose.
//
// DECIDED (owner, 2026-07-30, on kanban #101's task body — do not re-litigate
// these against alternatives the record already rejected):
//
//   1. Resends to ANY active client, unconditionally — never conditioned on
//      whether the LAST send is known to have failed. The real trigger for
//      an admin reaching for this button is "the client says it never
//      arrived", which is not the same event as "the last send failed": mail
//      can be accepted by Resend and still land in spam, get deleted, or go
//      to an address the client stopped checking. A button gated on a
//      recorded failure would be unavailable for the single most common real
//      reason to press it.
//   2. No new column, no migration, nothing about a "last failed send" is
//      recorded ANYWHERE. Falls directly out of (1): an unconditional button
//      needs nothing to condition itself on. `gallery_clients` stays a
//      membership table, not a delivery log — same stance schema.ts and
//      `attachGalleryClients`'s own header take. (Task #74, if it ever
//      lands, is the place for observability of swallowed send failures —
//      not this action.)
//   3. Throttle: reuses `createRateLimiter()` (src/lib/rate-limit.ts) via the
//      dedicated `src/lib/gallery-access-rate-limiters.ts` module — see that
//      module's header for the full reasoning on the limit, the window, the
//      `(galleryId, clientId)` bucket key, and why there is deliberately no
//      per-IP bucket here.
//
// CHECK ORDER, and why it is this order specifically:
//   requireAdmin() -> schema parse -> gallery exists -> visible-to-client ->
//   active membership -> throttle -> signIn.
//
// The visibility check runs BEFORE the throttle, on purpose: a `draft` (or
// `archived`) gallery is refused categorically, every single time, by
// `isGalleryVisibleToClient` — the SAME predicate `attachGalleryClients`
// already reuses, rather than a second status set that could drift from it.
// A resend that ignored gallery status would mail a working magic link for a
// gallery the client cannot even view — the exact "second door into a
// gallery nobody should be able to open yet" trap `attachGalleryClients`'s
// own `draft` branch exists to close. Since that refusal never depends on
// how many times it has already happened, letting it consume throttle budget
// would only let an admin who mis-clicks against a `draft` gallery a few
// times accidentally lock themselves out of a LEGITIMATE resend later in the
// same 15-minute window. `requireAdmin()` plus exactly one admin account
// (PLAN.md §4) means there is no anonymous principal for the throttle to
// protect its budget from in the first place, so nothing is lost by letting
// the categorical, status-only refusal run first and for free.
//
// No `revalidatePath` call anywhere in this action: unlike every action
// above it, this one writes NOTHING to the database (decision 2) — there is
// no cache entry it could possibly have made stale.
// ---------------------------------------------------------------------------

export type ResendGalleryAccessEmailState = {
  status: "idle" | "error" | "resent" | "resend_email_failed" | "throttled";
  message?: string;
};

const resendGalleryAccessEmailSchema = z.object({
  galleryId: z.uuid(),
  clientId: z.string().trim().min(1, "Cliente inválido."),
});

export async function resendGalleryAccessEmail(
  _prevState: ResendGalleryAccessEmailState,
  formData: FormData,
): Promise<ResendGalleryAccessEmailState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page/row hiding the affordance. See this file's repeated stance on
  // every other action above and the epic's "every route and action is
  // admin-only" rule.
  await requireAdmin();

  const parsed = resendGalleryAccessEmailSchema.safeParse({
    galleryId: formData.get("galleryId"),
    clientId: formData.get("clientId"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }

  // Trap A from the DECIDED record: reuse the SAME status predicate
  // `attachGalleryClients` already uses, rather than inventing a second
  // status set that could drift from it. Checked BEFORE the throttle — see
  // this section's own header comment for why that ordering is deliberate.
  if (!isGalleryVisibleToClient(gallery.status)) {
    return {
      status: "error",
      message: "Esta galería todavía no está visible para el cliente.",
    };
  }

  // Resolves the client's own name/email for the email call and the
  // response message below, AND doubles as the "is this client actually an
  // ACTIVE member of THIS gallery" check — a removed or never-attached id
  // simply matches no row here, the same read-based validation
  // `attachGalleryClients` already relies on for its own client ids.
  const [membership] = await db
    .select({ email: users.email, name: users.name })
    .from(galleryClients)
    .innerJoin(users, eq(users.id, galleryClients.userId))
    .where(
      and(
        eq(galleryClients.galleryId, gallery.id),
        eq(galleryClients.userId, parsed.data.clientId),
        isNull(galleryClients.removedAt),
      ),
    )
    .limit(1);
  if (!membership) {
    return {
      status: "error",
      message: "Ese cliente ya no está activo en esta galería.",
    };
  }

  // Bucket key is (galleryId, CLIENT id) — never the acting admin's id. See
  // gallery-access-rate-limiters.ts's own header comment for why: an
  // admin-keyed bucket would pool every client on this gallery into one
  // shared budget, so resending to one client would eat another client's
  // own, unrelated allowance.
  const throttle = galleryAccessResendLimiter.check(
    galleryAccessResendKey(gallery.id, parsed.data.clientId),
  );
  if (!throttle.allowed) {
    return {
      status: "throttled",
      message:
        `Ya le reenviaste el correo a ${membership.email} varias veces en poco tiempo. ` +
        "Esperá unos minutos antes de volver a intentar.",
    };
  }

  // Reuses the EXACT SAME provider call — and therefore the exact same
  // `src/lib/gallery-access-email.ts` copy — every other gallery-access send
  // in this file already makes. Never a second door into the gallery.
  //
  // A plain try/catch, NOT the `Promise.allSettled` fan-out
  // `attachGalleryClients`/`publishGallery`/`deliverGallery` use above: this
  // action resends to exactly ONE recipient by design (it is a per-row
  // affordance on `GalleryClientRow`), so there is no list of results to
  // reconcile.
  try {
    await signIn("gallery-access", {
      email: membership.email,
      redirect: false,
      redirectTo: `/galleries/${gallery.publicSlug}`,
    });
  } catch (error) {
    // Same "an unexpected, non-AuthError failure is a genuine bug/outage —
    // let it crash rather than silently pretend" stance every sibling send
    // in this file already takes.
    if (!(error instanceof AuthError)) throw error;
    return {
      status: "resend_email_failed",
      message: `No pudimos reenviarle el correo a ${membership.email}. Intentá de nuevo en un rato.`,
    };
  }

  return {
    status: "resent",
    message: `Le reenviamos el enlace de acceso a ${membership.email}.`,
  };
}

// ---------------------------------------------------------------------------
// Remove a client from a gallery (task #97) — SOFT delete, per the owner's
// own decision recorded on the kanban task: never a `DELETE`, only
// `removedAt` stamped. A removed row still proves the client was once
// attached (schema.ts's own comment on `galleryClients`); this action only
// ever writes that timestamp, never removes the row.
// ---------------------------------------------------------------------------

export type RemoveGalleryClientState = {
  status: "idle" | "error" | "removed";
  message?: string;
};

const removeGalleryClientSchema = z.object({
  galleryId: z.uuid(),
  clientId: z.string().trim().min(1, "Cliente inválido."),
});

/**
 * Sets `gallery_clients.removedAt` for exactly one (gallery, client) pair.
 *
 * Never touches `assets.selectedBy` — a removed client's picks stay
 * attributed to them, the same "historical fact of who chose what"
 * reasoning task #94 already established for that column (schema.ts's own
 * comment on `selectedBy`). This action has no code path that reads or
 * writes `assets` at all.
 *
 * THE LAST-CLIENT GUARD, conditional on status (owner-decided after this
 * task started): `activeClientRuleViolation()` (src/lib/galleries.ts) answers
 * "would this leave a gallery in THAT status with nobody attached". `draft`
 * would not care — this action is what makes a clientless `draft` gallery
 * reachable from a populated one, and task #100 made it creatable that way
 * from the start. Everything past `draft` does care, because a
 * `proofing`/`selected`/`delivered` gallery nobody can open is a dead end.
 *
 * The `targetStatus` passed is the gallery's CURRENT status, because removal
 * moves the gallery nowhere — unlike `publishGallery`/`deliverGallery`, which
 * pass the status they are transitioning INTO. The count passed is what would
 * be left AFTER this removal, hence the `- 1`.
 *
 * Task #100 made that function the single home of the rule: this action,
 * `publishGallery` and `deliverGallery` all consult it, and the gallery
 * detail page mirrors it for hiding affordances. Grep
 * `activeClientRuleViolation` to see every consumer.
 *
 * Same "the pre-flight check fails fast with a clear message, the UPDATE's
 * own `WHERE` is the real guard" shape as `isPublishable`/`isUnlockable`/
 * `isDeliverable` above: the pre-flight read below only decides WHICH error
 * message to show, and does not by itself close the race between two
 * concurrent removals of the gallery's last two active clients (a narrow
 * window: both could read "2 active" before either commits its own removal).
 * Accepted, not closed with a `SELECT ... FOR UPDATE` lock across every
 * active row — admin-only, single-admin, sequential usage in practice, the
 * same class of small race `submit-selection`'s own pre-flight checks and
 * `deliverGallery`'s own missing-finals read already tolerate for the same
 * reason.
 */
export async function removeGalleryClient(
  _prevState: RemoveGalleryClientState,
  formData: FormData,
): Promise<RemoveGalleryClientState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page hiding the button once removal would violate the invariant.
  // See this file's repeated stance on `isPublishable`/`isUnlockable`/
  // `isDeliverable` above and the epic's "every route and action is
  // admin-only" rule.
  await requireAdmin();

  const parsed = removeGalleryClientSchema.safeParse({
    galleryId: formData.get("galleryId"),
    clientId: formData.get("clientId"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Datos inválidos.",
    };
  }

  const [gallery] = await db
    .select()
    .from(galleries)
    .where(eq(galleries.id, parsed.data.galleryId))
    .limit(1);
  if (!gallery) {
    return { status: "error", message: "La galería no existe." };
  }

  const activeMemberships = await db
    .select({ userId: galleryClients.userId })
    .from(galleryClients)
    .where(and(eq(galleryClients.galleryId, gallery.id), isNull(galleryClients.removedAt)));

  const isActive = activeMemberships.some((row) => row.userId === parsed.data.clientId);
  if (!isActive) {
    // Either never attached, or already removed — a calm, non-alarming
    // result rather than a scary error, same "reflects reality" stance
    // submit-selection's own idempotent-double-submit branch takes.
    return {
      status: "error",
      message: "Ese cliente ya no está activo en esta galería.",
    };
  }

  const activeClientViolation = activeClientRuleViolation({
    targetStatus: gallery.status,
    activeClientCount: activeMemberships.length - 1,
    action: "remove-client",
  });
  if (activeClientViolation) {
    return { status: "error", message: activeClientViolation };
  }

  const now = new Date();
  const updated = await db
    .update(galleryClients)
    .set({ removedAt: now })
    .where(
      and(
        eq(galleryClients.galleryId, gallery.id),
        eq(galleryClients.userId, parsed.data.clientId),
        isNull(galleryClients.removedAt),
      ),
    )
    .returning();

  if (updated.length === 0) {
    // Lost a narrow race — see this function's own header comment on the
    // accepted window between the pre-flight read above and this UPDATE.
    return {
      status: "error",
      message: "Ese cliente ya no está activo en esta galería — puede que ya se haya actualizado.",
    };
  }

  revalidatePath(`/dashboard/galleries/${gallery.id}`);
  revalidatePath("/dashboard/galleries");
  return { status: "removed" };
}
