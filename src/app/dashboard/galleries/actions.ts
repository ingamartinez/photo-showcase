"use server";

// Creating a gallery is the one place the epic's central rule lives: the
// chosen package's CURRENT terms are read exactly once, right here, and
// copied into `includedPhotosSnapshot` / `extraPhotoPriceCopSnapshot`. From
// the moment this insert commits, the gallery owes the `packages` row
// nothing — see schema.ts's comment on those columns and PLAN.md §6.

import { z } from "zod";
import postgres from "postgres";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { galleries, packages } from "@/lib/db/schema";
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
