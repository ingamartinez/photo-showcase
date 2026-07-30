import { describe, expect, it } from "vitest";
import type { Session } from "next-auth";
import { canReadFinalDeliverable } from "./final-access";

// The gate two routes share (GET /api/assets/[assetId]/final and GET
// /api/assets/[assetId]/display). Both of those have their own end-to-end
// suites covering ownership, status codes and the HTTP wiring; this file
// owns the PREDICATE itself, exhaustively, one condition at a time — which
// is only possible now that the predicate is one function instead of two
// copies of an `if`.
//
// Pure function, no database and no R2: `Asset`/`Gallery` are structural
// types here, so the fixtures are the four fields the gate actually reads.

type GateAsset = Parameters<typeof canReadFinalDeliverable>[0];
type GateGallery = Parameters<typeof canReadFinalDeliverable>[1];

function asset(overrides: Partial<GateAsset> = {}): GateAsset {
  return {
    isSelected: true,
    isEdited: true,
    finalKey: "galleries/g/finals/a.jpg",
    ...overrides,
  };
}

function gallery(status: string = "delivered"): GateGallery {
  return { status } as GateGallery;
}

function clientSession(): Session {
  return {
    user: { id: "client-a", role: "client", email: "ana@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

function adminSession(): Session {
  return {
    user: { id: "admin-1", role: "admin", email: "photographer@example.com" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}

describe("canReadFinalDeliverable", () => {
  it("allows a client when every condition holds", () => {
    expect(canReadFinalDeliverable(asset(), gallery("delivered"), clientSession())).toBe(true);
  });

  // Each of these is a leg of the gate on its own. Flipped ONE at a time
  // from the fully-unlocked fixture, so a regression that dropped any single
  // condition shows up as exactly one failure naming the condition it lost.
  it("refuses an asset the client never selected, even with a final sitting in R2", () => {
    expect(canReadFinalDeliverable(asset({ isSelected: false }), gallery(), clientSession())).toBe(
      false,
    );
  });

  it("refuses an asset the photographer has not marked edited, even with a finalKey", () => {
    expect(canReadFinalDeliverable(asset({ isEdited: false }), gallery(), clientSession())).toBe(
      false,
    );
  });

  it("refuses an asset with no final object at all", () => {
    expect(canReadFinalDeliverable(asset({ finalKey: null }), gallery(), clientSession())).toBe(
      false,
    );
  });

  // The leg the photographer's leverage rests on, and the one most likely to
  // be loosened by accident: before delivery a client must not reach an
  // unwatermarked pixel of their session, no matter what is already in R2.
  it.each(["draft", "proofing", "selected", "archived"])(
    "refuses a client while the gallery is %s, not delivered",
    (status) => {
      expect(canReadFinalDeliverable(asset(), gallery(status), clientSession())).toBe(false);
    },
  );

  // The admin carve-out, decided in task #26 (inherited from #63's review)
  // and preserved verbatim when this predicate was extracted: the
  // photographer can preview a final they just uploaded before flipping the
  // gallery to `delivered`.
  it("allows an admin before delivery, so the photographer can preview their own upload", () => {
    expect(canReadFinalDeliverable(asset(), gallery("proofing"), adminSession())).toBe(true);
  });

  // ...but the carve-out is scoped to the delivered leg ALONE. An admin still
  // cannot reach a deliverable that does not exist or was never selected —
  // otherwise "admin sees everything" would quietly become "admin bypasses
  // the whole gate", and the display route would inherit that.
  it("does NOT let an admin past the other three conditions", () => {
    expect(canReadFinalDeliverable(asset({ isSelected: false }), gallery(), adminSession())).toBe(
      false,
    );
    expect(canReadFinalDeliverable(asset({ isEdited: false }), gallery(), adminSession())).toBe(
      false,
    );
    expect(canReadFinalDeliverable(asset({ finalKey: null }), gallery(), adminSession())).toBe(
      false,
    );
  });

  // The predicate is a TYPE GUARD, not a plain boolean, so a caller that
  // passes it gets `finalKey` narrowed to `string` and has no reason to
  // re-check it (see the function's own comment for why that matters). This
  // is a compile-time property; the assignment below is the assertion, and
  // it stops compiling the moment the signature stops narrowing.
  it("narrows finalKey to a string for callers that pass the gate", () => {
    const candidate = asset();
    if (canReadFinalDeliverable(candidate, gallery(), clientSession())) {
      const key: string = candidate.finalKey;
      expect(key).toBe("galleries/g/finals/a.jpg");
    } else {
      throw new Error("fixture should have passed the gate");
    }
  });
});
