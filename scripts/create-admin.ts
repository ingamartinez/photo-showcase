// Creates or promotes the photographer's admin account.
//
//   bun run create:admin you@example.com "Alejo Martinez"
//
// There is no sign-up flow anywhere in the app — this script is the only way an
// admin comes into existence, and it is deliberately a manual, out-of-band step.
// Promoting an existing row is allowed; demoting is not, to avoid a fat-fingered
// email silently stripping the only admin.

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { users } from "../src/lib/db/schema";

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  const name = process.argv[3]?.trim();

  if (!email || !email.includes("@")) {
    throw new Error('Usage: bun run create:admin <email> ["Full Name"]');
  }

  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    if (existing.role === "admin") {
      console.log(`${email} is already an admin.`);
      return;
    }
    await db.update(users).set({ role: "admin" }).where(eq(users.id, existing.id));
    console.log(`promoted ${email} to admin.`);
    return;
  }

  await db.insert(users).values({ email, name: name ?? null, role: "admin" });
  console.log(`created admin ${email}.`);
  console.log("Sign in at /login — the magic link is the only way in.");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
