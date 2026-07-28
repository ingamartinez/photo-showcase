"use server";

// Creating a gallery is the one place the epic's central rule lives: the
// chosen package's CURRENT terms are read exactly once, right here, and
// copied into `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`. From
// the moment this insert commits, the gallery owes the `packages` row
// nothing — see schema.ts's comment on those columns and PLAN.md §6.

import { z } from "zod";
import postgres from "postgres";
import { revalidatePath } from "next/cache";
import { count, eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { db } from "@/lib/db";
import { assets, galleries, packages, users } from "@/lib/db/schema";
import type { Gallery } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { generateGallerySlug } from "@/lib/slug";

const createGallerySchema = z.object({
  // Both ids come from <select> pickers fed by getClientsForPicker() /
  // getActivePackages() (src/lib/clients.ts, src/lib/packages.ts) — a plain
  // presence + shape check here is enough; a value that doesn't actually
  // reference an existing row is caught below, at the insert itself.
  clientId: z.string().trim().min(1, "Elegí un cliente."),
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
    clientId: formData.get("clientId"),
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

  try {
    await db.insert(galleries).values({
      clientId: parsed.data.clientId,
      packageId: pkg.id,
      title: parsed.data.title,
      sessionDate: parsed.data.sessionDate,
      // Unguessable, generated fresh for every gallery — never derived from
      // the title or a counter (schema.ts's comment on `publicSlug`).
      publicSlug: generateGallerySlug(),
      includedPhotosSnapshot: pkg.includedPhotos,
      extraPhotoPriceCopSnapshot: pkg.extraPhotoPriceCop,
    });
  } catch (error) {
    if (hasPostgresErrorCode(error, FOREIGN_KEY_VIOLATION)) {
      return { status: "error", message: "Elegí un cliente válido." };
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

  const [client] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, gallery.clientId))
    .limit(1);
  if (!client) {
    // Unreachable in practice — `galleries.clientId` is a NOT NULL FK onto
    // `users` — but this action never trusts that a row it just read by id
    // still exists a moment later without checking, same stance as
    // createGallery's own defense-in-depth checks above.
    return { status: "error", message: "No encontramos al cliente de esta galería." };
  }

  try {
    await signIn("gallery-access", {
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
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return {
        status: "error",
        message: "No pudimos enviarle el correo al cliente. Probá de nuevo en un momento.",
      };
    }
    throw error;
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
