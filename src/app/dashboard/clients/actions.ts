"use server";

// Creating a client is inserting a `users` row with `role = "client"` — see
// schema.ts's header comment for why there is no separate `clients` table.
// There is no invitation email here: the client receives a link only when a
// gallery is published to them (a later task). This action's whole job is to
// get a name + email (+ optional WhatsApp) into `users` safely.

import { z } from "zod";
import postgres from "postgres";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth-guards";

const createClientSchema = z.object({
  name: z.string().trim().min(1, "Ingresá un nombre."),
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
    .pipe(z.email("Ingresá un correo electrónico válido.")),
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
      message: parsed.error.issues[0]?.message ?? "Revisá los datos del formulario.",
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
