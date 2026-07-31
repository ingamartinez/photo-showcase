// Seeding logic for the capture harness's fixture gallery (task #179),
// expressed against a tiny store interface instead of against Drizzle
// directly.
//
// WHY THE INDIRECTION. The bug being fixed is a MISSING WRITE: the previous
// version set `status` only on INSERT and left an existing row alone, so once
// any run submitted the fixture selection the gallery stayed `selected`
// forever and `/galleries/[publicSlug]` quietly rendered the LOCKED variant --
// which still looks like a perfectly plausible proofing screen to anyone who
// does not know the two apart. #145 attached exactly that screenshot in good
// faith. A missing write is only provable by a test that watches the writes,
// and `bun run test` has no database (CI has none either, and this harness is
// local-only on purpose). Splitting the decision from the SQL is what makes
// the decision testable; `e2e/global-setup.ts` supplies the Drizzle-backed
// implementation of `FixtureGalleryStore` and is the only untested part left,
// which is four one-line queries.
//
// Related, and deliberately NOT solved here: the fixture gallery slug is now
// derived per worktree (see `e2e-worktree.ts`), so a sibling lane submitting
// its own selection can no longer move the status out from under this run in
// the first place. This function fixes the OTHER half -- a run correcting its
// OWN gallery, left in whatever state its own previous run ended in.

/** Mirrors `galleryStatus` in `src/lib/db/schema.ts`. */
export type FixtureGalleryStatus = "draft" | "proofing" | "selected" | "delivered" | "archived";

export interface FixtureGalleryRow {
  id: string;
  status: FixtureGalleryStatus;
}

export interface FixtureGalleryMembership {
  removedAt: Date | null;
}

/**
 * The four writes and two reads this seeding needs. Kept this narrow on
 * purpose: a wider port would tempt an implementation to smuggle behaviour
 * into the adapter, where nothing tests it.
 */
export interface FixtureGalleryStore {
  findGalleryByPublicSlug(publicSlug: string): Promise<FixtureGalleryRow | undefined>;
  insertGallery(input: {
    publicSlug: string;
    title: string;
    status: FixtureGalleryStatus;
  }): Promise<string>;
  updateGalleryStatus(galleryId: string, status: FixtureGalleryStatus): Promise<void>;
  findMembership(galleryId: string, userId: string): Promise<FixtureGalleryMembership | undefined>;
  insertMembership(galleryId: string, userId: string): Promise<void>;
  reactivateMembership(galleryId: string, userId: string): Promise<void>;
}

export interface EnsureFixtureGalleryInput {
  publicSlug: string;
  title: string;
  /**
   * The status the CALLER needs to see, every time, whether or not the row
   * already existed. There is no default: a caller that does not say which
   * variant of `/galleries/[publicSlug]` it means to screenshot is exactly the
   * caller this task exists to stop.
   */
  status: FixtureGalleryStatus;
  clientUserId: string;
}

/**
 * Leaves the fixture gallery in the requested state and attached to the
 * fixture client, whether or not it existed before. Returns its id.
 */
export async function ensureFixtureGallery(
  store: FixtureGalleryStore,
  input: EnsureFixtureGalleryInput,
): Promise<string> {
  const { publicSlug, title, status, clientUserId } = input;

  const existing = await store.findGalleryByPublicSlug(publicSlug);
  let galleryId: string;

  if (!existing) {
    galleryId = await store.insertGallery({ publicSlug, title, status });
  } else {
    galleryId = existing.id;
    // THE #179 FIX. The `!==` is not an optimization dressed as a guard: a
    // no-op UPDATE would be harmless, but skipping it keeps the seeding
    // honest about having changed something, and the test below asserts both
    // branches so nobody can "simplify" this into the original bug.
    if (existing.status !== status) {
      await store.updateGalleryStatus(galleryId, status);
    }
  }

  const membership = await store.findMembership(galleryId, clientUserId);
  if (!membership) {
    await store.insertMembership(galleryId, clientUserId);
  } else if (membership.removedAt !== null) {
    // Re-attach a membership a previous run (or a stray manual edit) removed
    // -- see schema.ts's own comment on `removedAt`: re-attaching UPDATEs the
    // same composite-PK row back to NULL rather than inserting a second one.
    await store.reactivateMembership(galleryId, clientUserId);
  }

  return galleryId;
}
