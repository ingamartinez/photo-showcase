"use server";

// Creating a client is inserting a `users` row with `role = "client"` — see
// schema.ts's header comment for why there is no separate `clients` table.
// There is no invitation email here: the client receives a link only when a
// gallery is published to them (a later task). This action's whole job is to
// get a name + email (+ optional WhatsApp) into `users` safely.

import { z } from "zod";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

const createClientSchema = z.object({
  name: z.string().trim().min(1, "Ingresa un nombre."),
  // Identity IS the email (PLAN.md §4): normalized to lowercase and trimmed
  // BEFORE the format check, not after — `z.email()` on its own rejects
  // " Ana@Example.com " outright (leading/trailing space fails the format
  // regex), which would wrongly bounce a validly-typed address just because
  // the browser autofilled a trailing space. Normalizing first means
  // "Cliente@Ejemplo.com" and " cliente@ejemplo.com " both land on the same
  // row as an existing "cliente@ejemplo.com" instead of quietly creating a
  // second account for the same person.
  // `.normalize("NFKC")` matches Auth.js's own normalization of the email it
  // receives before `signIn`'s callback ever runs (`.normalize("NFKC")
  // .toLowerCase().trim()`, see next-auth's Resend/email provider). Without
  // it, an address typed in a non-NFKC-normal form could be stored one way
  // here and looked up a different way there — the exact "identity is the
  // email" seam this action shares with auth.ts would silently split.
  email: z
    .string()
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .pipe(z.email("Ingresa un correo electrónico válido.")),
  // WhatsApp number — free text, no format enforced (photographer copy/pastes
  // whatever the client gave them). Empty string from the form means "not
  // provided", not a value to store.
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
});

/** What the photographer actually typed, echoed back verbatim. */
export type CreateClientValues = {
  name: string;
  email: string;
  phone: string;
};

export type CreateClientState = {
  status: "idle" | "error" | "created";
  message?: string;
  // Task #50: present ONLY on `status: "error"`. React 19 blanks the
  // uncontrolled fields of a `<form action={fn}>` on every submit, so after a
  // rejected duplicate the photographer would otherwise retype name, email and
  // phone to fix one character. Returning the submitted values here is the
  // documented React 19 way to put them back: src/components/client-form.tsx
  // feeds them into `defaultValue`, which the form reset restores to. See that
  // file's comment for why `defaultValue` (and not controlled state) is what
  // this hangs on.
  //
  // Deliberately the RAW strings, not `parsed.data`: a validation failure has
  // no `parsed.data` at all, and on a duplicate the photographer should see
  // the address as they typed it — showing them a silently trimmed and
  // lowercased version of their own input while telling them it is taken
  // invites the reply "but that is not what I entered".
  values?: CreateClientValues;
};

// `FormData#get` returns `string | File | null`; every field on this form is a
// text input, so anything else is "nothing was submitted" and reads back as an
// empty field rather than the string "null" or "[object File]".
function submittedValues(formData: FormData): CreateClientValues {
  const read = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value : "";
  };

  return { name: read("name"), email: read("email"), phone: read("phone") };
}

// SQLSTATE for a unique-index violation — matches `postgres`'s own error
// shape (PostgresError#code), not an HTTP status.
const UNIQUE_VIOLATION = "23505";

// drizzle-orm 0.45's `PgPreparedQuery.queryWithCache` never lets the driver's
// own error surface directly: its no-cache path is
// `try { return await query() } catch (e) { throw new DrizzleQueryError(queryString, params, e as Error) }`
// — so what `db.insert(...)` actually throws is a `DrizzleQueryError` whose
// `.cause` is the real `postgres.PostgresError`, not the `PostgresError`
// itself. A bare `error instanceof postgres.PostgresError` check here is
// always false in production and the duplicate-email branch below never
// runs — walk the `.cause` chain instead.
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof postgres.PostgresError && e.code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

export async function createClient(
  _prevState: CreateClientState,
  formData: FormData,
): Promise<CreateClientState> {
  // Admin-only surface, checked at the data-access path itself — not only by
  // the page or layout above it, per src/lib/auth-guards.ts's header comment
  // and the epic's "every route and action is admin-only" rule.
  await requireAdmin();

  const parsed = createClientSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    // `FormData#get` returns `null` for a key that was never set (the
    // checkbox-like "absent" case), but the schema's `phone` field is
    // `optional()`, which only accepts `undefined` — without this, an
    // omitted phone field would fail validation with a confusing "expected
    // string, received null" instead of being treated as "not provided".
    phone: formData.get("phone") ?? undefined,
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisa los datos del formulario.",
      values: submittedValues(formData),
    };
  }

  try {
    // `role` is never read from the form — there is no field for it, and it
    // is hardcoded here to "client". The only way a `users` row becomes (or
    // is promoted to) "admin" is scripts/create-admin.ts, run out of band.
    // `parsed.data.email` is already normalized (see the schema above).
    await db.insert(users).values({
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone ?? null,
      role: "client",
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        status: "error",
        message: "Ya existe un cliente con ese correo electrónico.",
        values: submittedValues(formData),
      };
    }
    throw error;
  }

  revalidatePath("/dashboard/clients");
  // No `values` on success, on purpose: the form is meant to come back empty
  // and ready for the next client, which is exactly what React 19's own reset
  // already does.
  return { status: "created" };
}

// ---------------------------------------------------------------------------
// TASK #279 — editing an existing client.
// ---------------------------------------------------------------------------

// `createClientSchema` EXTENDED, not copied (task #279's own trap: "La
// edición tiene que pasar por LA MISMA cadena"): name, email and phone go
// through the very object create uses, so there is no second definition of
// normalization that could drift from it. `.extend()` returns a new object;
// `createClient` keeps using the original untouched.
//
// The one addition is the row selector. `users.id` is a text column, but
// every id in this app is minted by `crypto.randomUUID()` (see schema.ts's
// `$defaultFn`), and it arrives from a hidden input — a value that is not a
// UUID means the form was tampered with, not that someone mistyped it.
const updateClientSchema = createClientSchema.extend({
  userId: z.uuid("Cliente no válido."),
});

export type UpdateClientState = {
  status: "idle" | "error" | "updated";
  message?: string;
  // Same contract as `CreateClientState.values` above — present ONLY on
  // `status: "error"`, the RAW submitted strings. Read that comment (and
  // src/components/client-form.tsx's) for why `defaultValue` + React 19's
  // reset is the mechanism, and why normalization must not leak into the echo.
  values?: CreateClientValues;
};

export async function updateClient(
  _prevState: UpdateClientState,
  formData: FormData,
): Promise<UpdateClientState> {
  // Epic #278's rule: every new action starts with `requireAdmin()` and never
  // relies on the page above it having done so.
  await requireAdmin();

  const parsed = updateClientSchema.safeParse({
    userId: formData.get("userId"),
    name: formData.get("name"),
    email: formData.get("email"),
    // Same `null` -> `undefined` reason as `createClient` above: the schema's
    // `phone` is `optional()`, which accepts `undefined` but not `null`.
    phone: formData.get("phone") ?? undefined,
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0]?.message ?? "Revisa los datos del formulario.",
      values: submittedValues(formData),
    };
  }

  let updated: { id: string }[];
  try {
    updated = await db
      .update(users)
      // Exactly three columns, and `email` is already NFKC/trim/lowercased by
      // the shared schema. `role`, `createdAt`, `emailVerified` and `image`
      // are deliberately absent: this action corrects identity details, it
      // does not re-issue the account. `phone: ?? null` is what lets a blank
      // field CLEAR a stored number — `undefined` would be dropped from the
      // SET clause by drizzle and the old phone would silently survive.
      .set({
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone ?? null,
      })
      // `role = 'client'` in the WHERE, not only `id` (epic #278's rule): a
      // hand-posted admin id can never be edited through this action. Both
      // conditions in ONE statement — no read-then-write window.
      .where(and(eq(users.id, parsed.data.userId), eq(users.role, "client")))
      .returning({ id: users.id });
  } catch (error) {
    // Same detector (and same reason for walking `.cause`) as `createClient`:
    // the email index is the one unique constraint this UPDATE can hit.
    if (isUniqueViolation(error)) {
      return {
        status: "error",
        message: "Ya existe un cliente con ese correo electrónico.",
        values: submittedValues(formData),
      };
    }
    throw error;
  }

  if (updated.length === 0) {
    // A nonexistent id and an admin's id are the same answer on purpose:
    // one message means this action cannot be used to probe which users are
    // admins. Zero rows is never reported as a success (task #279: "nunca un
    // update silencioso de 0 filas").
    return { status: "error", message: "El cliente no existe.", values: submittedValues(formData) };
  }

  // Every surface that renders this client's name/email/phone. The list
  // itself, the two admin pages whose pickers are built from the same rows,
  // and the two galleries surfaces that label a co-client by name-or-email.
  // `revalidatePath(route, "page")` is the documented way to invalidate a
  // dynamic segment without enumerating every slug (Next's own revalidatePath
  // reference). `/flash/[publicSlug]` renders no client identity, so it is
  // not here.
  revalidatePath("/dashboard/clients");
  revalidatePath("/dashboard/galleries");
  revalidatePath("/dashboard/galleries/[galleryId]", "page");
  revalidatePath("/dashboard/flash/[flashId]", "page");
  revalidatePath("/galleries");
  revalidatePath("/galleries/[publicSlug]", "page");

  return { status: "updated" };
}
