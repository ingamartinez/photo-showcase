// Seeds the session packages (PLAN.md §3). Idempotent — matches on name, so
// re-running updates prices instead of duplicating rows.
//
//   bun run db:seed:packages
//
// Editing a price here is safe for existing galleries: each gallery froze its
// own terms at creation (galleries.included_photos_snapshot,
// extra_photo_price_cop_snapshot and, since task #205,
// original_photo_price_cop_snapshot), so past clients keep the deal they
// were sold.

import { eq } from "drizzle-orm";
import { db } from "../src/lib/db";
import { packages } from "../src/lib/db/schema";

// `originalPhotoPriceCop` (task #205, owner decision 2026-08-01): 2_000 in
// every package, cheaper than each one's own `extraPhotoPriceCop` (5_000) —
// an original is less work to produce than an edit. Same value as the
// column's own migration default (schema.ts), so a fresh seed and an
// already-migrated production database agree.
const PACKAGES = [
  {
    name: "Básico",
    priceCop: 60_000,
    includedPhotos: 7,
    extraPhotoPriceCop: 5_000,
    originalPhotoPriceCop: 2_000,
    durationLabel: "1 h",
    sortOrder: 0,
  },
  {
    name: "Estándar",
    priceCop: 100_000,
    includedPhotos: 13,
    extraPhotoPriceCop: 5_000,
    originalPhotoPriceCop: 2_000,
    durationLabel: "1.5–2 h",
    sortOrder: 1,
  },
  {
    name: "Premium",
    priceCop: 180_000,
    includedPhotos: 20,
    extraPhotoPriceCop: 5_000,
    originalPhotoPriceCop: 2_000,
    durationLabel: "2–3 h",
    sortOrder: 2,
  },
];

async function main(): Promise<void> {
  for (const pkg of PACKAGES) {
    const [existing] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.name, pkg.name))
      .limit(1);

    if (existing) {
      await db
        .update(packages)
        .set({ ...pkg, active: true })
        .where(eq(packages.id, existing.id));
      console.log(`updated  ${pkg.name}`);
    } else {
      await db.insert(packages).values(pkg);
      console.log(`inserted ${pkg.name}`);
    }
  }
  console.log(`\n${PACKAGES.length} packages seeded.`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
