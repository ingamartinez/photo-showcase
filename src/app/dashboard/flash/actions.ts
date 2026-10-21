"use server";

// Flash galleries (epic #232, slice #233): server actions behind the admin
// dashboard. EVERY action calls `requireAdmin()` FIRST, before it parses or
// touches anything — the page that renders the control is UX, this is the
// authority (src/lib/auth-guards.ts).
//
// A flash gallery shares nothing commercial with `galleries`: no package, no
// snapshots, no status machine, no emails. These actions therefore do not
// touch `galleries`/`assets` at all.

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { flashAssets, flashGalleries, flashGalleryClients, users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";
import { generateGallerySlug } from "@/lib/slug";
import { deleteObject, flashDisplayKey, storedKey } from "@/lib/r2";

export type CreateFlashGalleryState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; flashGalleryId: string };

// Shared by create and edit so the two can never validate differently. NOT
// the `galleries` rules: a flash gallery's date is optional and nullable
// (schema.ts:888). `z.iso.date()` (not a `YYYY-MM-DD` regex) so calendar-
// impossible values like `2026-02-31` fail here instead of reaching Postgres
// and surfacing as an unhandled 500 (task #283, owner-authorized).
const flashTitleField = z
  .string()
  .trim()
  .min(1, "Escribe un título.")
  .max(200, "El título es muy largo.");
const flashSessionDateField = z
  .string()
  .trim()
  .transform((value) => (value === "" ? undefined : value))
  .pipe(z.iso.date("La fecha no es válida.").optional());

const createFlashGallerySchema = z.object({
  title: flashTitleField,
  // `""` (field left blank) collapses to undefined: a gift has no session.
  sessionDate: flashSessionDateField,
});

export async function createFlashGallery(
  _prevState: CreateFlashGalleryState,
  formData: FormData,
): Promise<CreateFlashGalleryState> {
  await requireAdmin();

  const parsed = createFlashGallerySchema.safeParse({
    title: formData.get("title") ?? "",
    sessionDate: formData.get("sessionDate") ?? "",
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisa los datos del formulario.",
    };
  }

  const [created] = await db
    .insert(flashGalleries)
    .values({
      title: parsed.data.title,
      sessionDate: parsed.data.sessionDate ?? null,
      // Unguessable, fresh per gallery — the same generator as galleries.
      publicSlug: generateGallerySlug(),
    })
    .returning({ id: flashGalleries.id });

  revalidatePath("/dashboard/flash");
  return { status: "created", flashGalleryId: created!.id };
}

export type FlashActionResult = { ok: true } | { ok: false; message: string };

const idSchema = z.uuid();

/** Turns the public link on or off. A gallery is private (assigned clients
 * only) until this is switched on; the page that serves the link is slice
 * #234 — this only flips the flag. */
export async function setFlashGalleryPublic(
  flashGalleryId: string,
  isPublic: boolean,
): Promise<FlashActionResult> {
  await requireAdmin();

  if (!idSchema.safeParse(flashGalleryId).success || typeof isPublic !== "boolean") {
    return { ok: false, message: "Galería no válida." };
  }

  const updated = await db
    .update(flashGalleries)
    .set({ isPublic })
    .where(eq(flashGalleries.id, flashGalleryId))
    .returning({ id: flashGalleries.id });
  if (updated.length === 0) {
    return { ok: false, message: "La galería no existe." };
  }

  revalidatePath(`/dashboard/flash/${flashGalleryId}`);
  revalidatePath("/dashboard/flash");
  return { ok: true };
}

export type AttachFlashClientsState = {
  status: "idle" | "error" | "attached";
  message?: string;
};

const attachFlashClientsSchema = z.object({
  flashGalleryId: z.uuid(),
  clientIds: z.array(z.string().trim().min(1)).min(1, "Elige al menos un cliente."),
});

/** Assigns one or more clients to a flash gallery. A previously-removed client
 * is re-attached by clearing `removedAt` on the SAME row (the composite PK
 * makes a second insert impossible) — the model of `attachGalleryClients`. No
 * email is sent: assigned clients simply find the gallery in /galleries. */
export async function attachFlashClients(
  _prevState: AttachFlashClientsState,
  formData: FormData,
): Promise<AttachFlashClientsState> {
  await requireAdmin();

  const parsed = attachFlashClientsSchema.safeParse({
    flashGalleryId: formData.get("flashGalleryId"),
    clientIds: formData.getAll("clientIds"),
  });
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisa los datos del formulario.",
    };
  }
  const { flashGalleryId } = parsed.data;

  const [flashGallery] = await db
    .select({ id: flashGalleries.id })
    .from(flashGalleries)
    .where(eq(flashGalleries.id, flashGalleryId))
    .limit(1);
  if (!flashGallery) {
    return { status: "error", message: "La galería no existe." };
  }

  const clientIds = [...new Set(parsed.data.clientIds)];

  // Only real CLIENT accounts: a crafted request must not be able to attach an
  // admin id (or a made-up one) as a viewer.
  const requestedUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, clientIds), eq(users.role, "client")));
  if (requestedUsers.length !== clientIds.length) {
    return { status: "error", message: "Elige clientes válidos." };
  }

  const existing = await db
    .select({ userId: flashGalleryClients.userId, removedAt: flashGalleryClients.removedAt })
    .from(flashGalleryClients)
    .where(
      and(
        eq(flashGalleryClients.flashGalleryId, flashGalleryId),
        inArray(flashGalleryClients.userId, clientIds),
      ),
    );
  const existingIds = new Set(existing.map((row) => row.userId));
  const neverAttachedIds = clientIds.filter((id) => !existingIds.has(id));
  const removedIds = existing.filter((row) => row.removedAt !== null).map((row) => row.userId);

  if (neverAttachedIds.length > 0 || removedIds.length > 0) {
    await db.transaction(async (tx) => {
      if (neverAttachedIds.length > 0) {
        await tx
          .insert(flashGalleryClients)
          .values(neverAttachedIds.map((userId) => ({ flashGalleryId, userId })));
      }
      if (removedIds.length > 0) {
        await tx
          .update(flashGalleryClients)
          .set({ removedAt: null })
          .where(
            and(
              eq(flashGalleryClients.flashGalleryId, flashGalleryId),
              inArray(flashGalleryClients.userId, removedIds),
            ),
          );
      }
    });
  }

  revalidatePath(`/dashboard/flash/${flashGalleryId}`);
  revalidatePath("/dashboard/flash");
  return { status: "attached", message: "Cliente agregado." };
}

/** Soft-removes a client: stamps `removedAt`, never deletes the row. */
export async function removeFlashClient(
  flashGalleryId: string,
  userId: string,
): Promise<FlashActionResult> {
  await requireAdmin();

  if (!idSchema.safeParse(flashGalleryId).success || typeof userId !== "string" || userId === "") {
    return { ok: false, message: "Datos no válidos." };
  }

  await db
    .update(flashGalleryClients)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(flashGalleryClients.flashGalleryId, flashGalleryId),
        eq(flashGalleryClients.userId, userId),
      ),
    );

  revalidatePath(`/dashboard/flash/${flashGalleryId}`);
  revalidatePath("/dashboard/flash");
  return { ok: true };
}

/** Deletes one photo: the row first, then its R2 objects best-effort — a leaked
 * object costs storage, a row pointing at nothing is a broken image. */
export async function deleteFlashAsset(assetId: string): Promise<FlashActionResult> {
  await requireAdmin();

  if (!idSchema.safeParse(assetId).success) {
    return { ok: false, message: "Foto no válida." };
  }

  const [asset] = await db
    .select({
      id: flashAssets.id,
      flashGalleryId: flashAssets.flashGalleryId,
      finalKey: flashAssets.finalKey,
    })
    .from(flashAssets)
    .where(eq(flashAssets.id, assetId))
    .limit(1);
  if (!asset) {
    return { ok: false, message: "La foto no existe." };
  }

  await db.delete(flashAssets).where(eq(flashAssets.id, asset.id));

  await deleteObject(storedKey(asset.finalKey)).catch(() => {});
  await deleteObject(flashDisplayKey(asset.flashGalleryId, asset.id)).catch(() => {});

  revalidatePath(`/dashboard/flash/${asset.flashGalleryId}`);
  revalidatePath("/dashboard/flash");
  return { ok: true };
}

/** Deletes a whole flash gallery and every R2 object it owns. The rows go
 * first (assets and memberships cascade), the objects after. */
export async function deleteFlashGallery(flashGalleryId: string): Promise<FlashActionResult> {
  await requireAdmin();

  if (!idSchema.safeParse(flashGalleryId).success) {
    return { ok: false, message: "Galería no válida." };
  }

  const photos = await db
    .select({ id: flashAssets.id, finalKey: flashAssets.finalKey })
    .from(flashAssets)
    .where(eq(flashAssets.flashGalleryId, flashGalleryId));

  const deleted = await db
    .delete(flashGalleries)
    .where(eq(flashGalleries.id, flashGalleryId))
    .returning({ id: flashGalleries.id });
  if (deleted.length === 0) {
    return { ok: false, message: "La galería no existe." };
  }

  for (const photo of photos) {
    await deleteObject(storedKey(photo.finalKey)).catch(() => {});
    await deleteObject(flashDisplayKey(flashGalleryId, photo.id)).catch(() => {});
  }

  revalidatePath("/dashboard/flash");
  return { ok: true };
}
