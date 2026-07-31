// Task #179. The bug was a MISSING WRITE, so every assertion here is about
// what the store was actually asked to do -- an assertion on a return value
// would have passed against the broken version too.
import { describe, expect, it } from "vitest";
import {
  type FixtureGalleryMembership,
  type FixtureGalleryRow,
  type FixtureGalleryStatus,
  type FixtureGalleryStore,
  ensureFixtureGallery,
} from "./e2e-fixture-gallery";

const PUBLIC_SLUG = "e2e-visual-capture-gallery-a1b2c3d4";
const TITLE = "Sesión de prueba (harness de captura a1b2c3d4)";
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const GALLERY_ID = "22222222-2222-4222-8222-222222222222";

interface RecordingStore extends FixtureGalleryStore {
  readonly statusUpdates: Array<{ galleryId: string; status: FixtureGalleryStatus }>;
  readonly inserts: Array<{ publicSlug: string; title: string; status: FixtureGalleryStatus }>;
  readonly membershipInserts: Array<{ galleryId: string; userId: string }>;
  readonly membershipReactivations: Array<{ galleryId: string; userId: string }>;
}

function makeStore(seed: {
  gallery?: FixtureGalleryRow;
  membership?: FixtureGalleryMembership;
}): RecordingStore {
  const statusUpdates: RecordingStore["statusUpdates"] = [];
  const inserts: RecordingStore["inserts"] = [];
  const membershipInserts: RecordingStore["membershipInserts"] = [];
  const membershipReactivations: RecordingStore["membershipReactivations"] = [];

  return {
    statusUpdates,
    inserts,
    membershipInserts,
    membershipReactivations,
    findGalleryByPublicSlug: async () => seed.gallery,
    insertGallery: async (input) => {
      inserts.push(input);
      return GALLERY_ID;
    },
    updateGalleryStatus: async (galleryId, status) => {
      statusUpdates.push({ galleryId, status });
    },
    findMembership: async () => seed.membership,
    insertMembership: async (galleryId, userId) => {
      membershipInserts.push({ galleryId, userId });
    },
    reactivateMembership: async (galleryId, userId) => {
      membershipReactivations.push({ galleryId, userId });
    },
  };
}

function run(store: FixtureGalleryStore, status: FixtureGalleryStatus = "proofing") {
  return ensureFixtureGallery(store, {
    publicSlug: PUBLIC_SLUG,
    title: TITLE,
    status,
    clientUserId: CLIENT_ID,
  });
}

describe("ensureFixtureGallery", () => {
  describe("the status of a gallery that already exists (#179)", () => {
    it("corrects a gallery left at `selected` back to the requested `proofing` -- THE bug: without this the route renders the LOCKED variant, which still looks like a plausible proofing screen, and #145 attached that screenshot in good faith", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "selected" },
        membership: { removedAt: null },
      });

      await run(store, "proofing");

      expect(store.statusUpdates).toEqual([{ galleryId: GALLERY_ID, status: "proofing" }]);
    });

    it.each<FixtureGalleryStatus>(["draft", "selected", "delivered", "archived"])(
      "corrects a gallery found at %j",
      async (found) => {
        const store = makeStore({
          gallery: { id: GALLERY_ID, status: found },
          membership: { removedAt: null },
        });

        await run(store, "proofing");

        expect(store.statusUpdates).toEqual([{ galleryId: GALLERY_ID, status: "proofing" }]);
      },
    );

    it("leaves an already-correct gallery alone instead of writing for the sake of writing", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "proofing" },
        membership: { removedAt: null },
      });

      await run(store, "proofing");

      expect(store.statusUpdates).toEqual([]);
      expect(store.inserts).toEqual([]);
    });

    it("honors a caller that asks for a status other than proofing -- a slice capturing the LOCKED variant must be able to say so", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "proofing" },
        membership: { removedAt: null },
      });

      await run(store, "selected");

      expect(store.statusUpdates).toEqual([{ galleryId: GALLERY_ID, status: "selected" }]);
    });

    it("returns the existing gallery's id rather than pretending to have created one", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "selected" },
        membership: { removedAt: null },
      });

      await expect(run(store)).resolves.toBe(GALLERY_ID);
      expect(store.inserts).toEqual([]);
    });
  });

  describe("a gallery that does not exist yet", () => {
    it("creates it with the requested status, slug and title", async () => {
      const store = makeStore({});

      await run(store, "proofing");

      expect(store.inserts).toEqual([
        { publicSlug: PUBLIC_SLUG, title: TITLE, status: "proofing" },
      ]);
      expect(store.statusUpdates).toEqual([]);
    });

    it("attaches the fixture client to it", async () => {
      const store = makeStore({});

      await run(store);

      expect(store.membershipInserts).toEqual([{ galleryId: GALLERY_ID, userId: CLIENT_ID }]);
    });
  });

  describe("the fixture client's membership", () => {
    it("re-attaches a membership a previous run removed, instead of inserting a duplicate", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "proofing" },
        membership: { removedAt: new Date("2026-07-30T00:00:00Z") },
      });

      await run(store);

      expect(store.membershipReactivations).toEqual([{ galleryId: GALLERY_ID, userId: CLIENT_ID }]);
      expect(store.membershipInserts).toEqual([]);
    });

    it("touches nothing when the client is already attached", async () => {
      const store = makeStore({
        gallery: { id: GALLERY_ID, status: "proofing" },
        membership: { removedAt: null },
      });

      await run(store);

      expect(store.membershipReactivations).toEqual([]);
      expect(store.membershipInserts).toEqual([]);
    });
  });
});
