"use server";

// Creating a gallery is the one place the epic's central rule lives: the
// chosen package's CURRENT terms are read exactly once, right here, and
// copied into `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`. From
// the moment this insert commits, the gallery owes the `packages` row
// nothing — see schema.ts's comment on those columns and PLAN.md §6.

import { z } from "zod";
import postgres from "postgres";
import { revalidatePath } from "next/cache";
import { and, count, eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { assets, galleries, galleryClients, packages } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { getGalleryClients } from "@/lib/galleries";
import { generateGallerySlug } from "@/lib/slug";
import { authEnv, resendEnv } from "@/lib/env";
import { computeQuota } from "@/lib/quota";
import { sendUnlockNotificationEmail } from "@/lib/unlock-notification-email";

const createGallerySchema = z.object({
  // Fed by a `<select multiple>` picker backed by getClientsForPicker()
  // (src/lib/clients.ts) — a plain presence + shape check here is enough; a
  // value that doesn't actually reference an existing row is caught below,
  // at the insert itself. Task #94: a gallery can now belong to SEVERAL
  // clients, so this is an ARRAY, not a single id — `.min(1)` is the
  // APPLICATION-layer half of "a gallery with zero clients is unreachable by
  // design" (schema.ts's own comment on `galleryClients` explains why the
  // database can't enforce that lower bound by itself).
  clientIds: z.array(z.string().trim().min(1)).min(1, "Elegí al menos un cliente."),
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
    // ONE transaction (task #94): a gallery that committed with zero clients
    // attached would be the exact "unreachable by design" state
    // schema.ts's comment on `galleryClients` says the app relies on the
    // FORM to prevent — a partial failure here (gallery inserted, memberships
    // not) must never leave that state sitting in the database.
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

      await tx
        .insert(galleryClients)
        .values(clientIds.map((clientId) => ({ galleryId: gallery!.id, userId: clientId })));
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
  // is gone entirely (schema.ts), replaced by this join-table read. An
  // empty list is unreachable BY DESIGN (gallery-form.tsx requires at least
  // one at creation, and there is no client-removal path yet to strip the
  // last one afterward) but this action never trusts that invariant
  // blindly, same stance as createGallery's own defense-in-depth checks
  // above.
  const clients = await getGalleryClients(gallery.id);
  if (clients.length === 0) {
    return { status: "error", message: "No encontramos clientes para esta galería." };
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

  try {
    await db.update(galleries).set({ status: "proofing" }).where(eq(galleries.id, gallery.id));
  } catch {
    return {
      status: "error",
      message:
        "Le enviamos el correo al cliente, pero no pudimos actualizar el estado de la galería. " +
        "Volvé a intentar — el cliente puede recibir un segundo correo.",
    };
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
  // on every request — unreachable in practice, same stance as this file's
  // own "unreachable in practice" client/admin lookups above, but the
  // fallback keeps the audit trail from silently losing the actor entirely
  // if it ever did happen.
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

  // Task #94: a gallery can have SEVERAL clients now — `unlockedGallery.
  // clientId` is gone entirely (schema.ts), replaced by this join-table
  // read. An empty list is unreachable BY DESIGN (gallery-form.tsx requires
  // at least one client at creation, and there is no removal path yet), but
  // never trusted blindly, same stance as this file's own
  // `publishGallery`/`createGallery` lookups above.
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
    // Unreachable BY DESIGN (see the lookup above) — treated the same as
    // every client's send failing, since there is nobody to notify either
    // way.
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

  const now = new Date();
  const updated = await db
    .update(galleries)
    .set({ status: "delivered", deliveredAt: now })
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
  // this join-table read. An empty list is unreachable BY DESIGN
  // (gallery-form.tsx requires at least one client at creation, and there is
  // no removal path yet), but never trusted blindly, same stance as this
  // file's own `publishGallery`/`unlockSelection` lookups above.
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
