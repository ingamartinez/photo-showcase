import { describe, expect, it } from "vitest";
import {
  EMPTY_PERSON_TALLY,
  clientLockActions,
  clientPersonTallyLabel,
  clientSelectionState,
  clientSelectionStateLabel,
  formatAttributionShare,
  toClientSelectionView,
} from "./client-selection-state";

const T = new Date("2026-10-12T15:00:00Z");

describe("clientSelectionState", () => {
  it("maps the lock columns and the pending cart onto open / submitted / locked", () => {
    expect(clientSelectionState({ lockedAt: null, submittedAt: null })).toBe("open");
    expect(clientSelectionState({ lockedAt: T, submittedAt: T })).toBe("submitted");
    expect(clientSelectionState({ lockedAt: T, submittedAt: null })).toBe("locked");
  });

  // Epic #250, decision 10: a submit no longer locks, so `lockedAt` alone
  // cannot answer "did this person finish?". Reading only the lock columns
  // (the pre-#263 rule) reports a sent member as still choosing.
  it("reads a sent, UNLOCKED member with an empty cart as submitted, not open", () => {
    expect(clientSelectionState({ lockedAt: null, submittedAt: T, hasCart: false })).toBe(
      "submitted",
    );
  });

  it("keeps a sent member with something still in the cart as open (decision 13: not settled)", () => {
    expect(clientSelectionState({ lockedAt: null, submittedAt: T, hasCart: true })).toBe("open");
  });

  it("ignores hasCart while the admin lock is set — a locked member is done by definition", () => {
    expect(clientSelectionState({ lockedAt: T, submittedAt: T, hasCart: true })).toBe("submitted");
  });
});

describe("toClientSelectionView", () => {
  const person = { yours: 2, shared: 0, edited: 1, toSend: 0 };

  it("formats the submit date in the studio timezone, only for submitted", () => {
    expect(toClientSelectionView({ lockedAt: T, submittedAt: T, person })).toEqual({
      state: "submitted",
      locked: true,
      sent: true,
      pickCount: 2,
      person,
      submittedOn: "12/10/2026",
    });
    expect(
      toClientSelectionView({ lockedAt: T, submittedAt: null, person: EMPTY_PERSON_TALLY })
        .submittedOn,
    ).toBeNull();
  });

  it("uses America/Bogota, not UTC, for the calendar day", () => {
    // 02:00 UTC on the 13th is still the 12th at 21:00 in Bogota.
    const late = new Date("2026-10-13T02:00:00Z");
    expect(toClientSelectionView({ lockedAt: late, submittedAt: late, person }).submittedOn).toBe(
      "12/10/2026",
    );
  });

  it("counts pickCount as yours + shared + toSend and derives the state from the cart", () => {
    const view = toClientSelectionView({
      lockedAt: null,
      submittedAt: T,
      person: { yours: 1, shared: 2, edited: 0, toSend: 1 },
    });
    expect(view.pickCount).toBe(4);
    expect(view.state).toBe("open");
  });
});

describe("clientSelectionStateLabel", () => {
  it("has the three owner-facing labels, in tuteo", () => {
    expect(clientSelectionStateLabel("open", null)).toBe("Eligiendo");
    expect(clientSelectionStateLabel("submitted", "12/10/2026")).toBe("Envió el 12/10/2026");
    expect(clientSelectionStateLabel("locked", null)).toBe("Bloqueado por ti");
  });
});

describe("clientPersonTallyLabel", () => {
  // Decision 14's four numbers, in the owner-approved wording. "compartidas"
  // is the approved word; "pedidas" stays the label (a su nombre is the
  // tooltip).
  it("renders the four numbers in the approved order and words", () => {
    expect(clientPersonTallyLabel({ yours: 4, shared: 2, edited: 1, toSend: 3 })).toBe(
      "pedidas 4 · compartidas 2 · editadas 1 · por enviar 3",
    );
  });

  it('never says "carrito"', () => {
    expect(clientPersonTallyLabel(EMPTY_PERSON_TALLY)).not.toMatch(/carrito/i);
  });
});

// es-CO's currency format separates "$" from the amount with a non-breaking
// space, so the rendered strings are compared with that normalized to a plain
// space — the copy is what this asserts, not which space character Intl chose.
const plain = (text: string) => text.replace(/\u00a0/g, " ");

describe("formatAttributionShare", () => {
  it("renders one share as included/extras/originals plus the surcharge", () => {
    expect(
      plain(
        formatAttributionShare({
          included: 2,
          extras: 1,
          originals: 0,
          extrasSurchargeCop: 5_000,
          originalsSurchargeCop: 0,
          surchargeCop: 5_000,
        }),
      ),
    ).toBe(plain("2 incluidas · 1 extra · 0 originales · recargo $ 5.000"));
  });

  it("agrees with itself in the singular", () => {
    expect(
      plain(
        formatAttributionShare({
          included: 1,
          extras: 0,
          originals: 1,
          extrasSurchargeCop: 0,
          originalsSurchargeCop: 2_000,
          surchargeCop: 2_000,
        }),
      ),
    ).toBe(plain("1 incluida · 0 extras · 1 original · recargo $ 2.000"));
  });
});

describe("clientLockActions", () => {
  // The two flags mirror the SERVER's own preconditions exactly
  // (`lockGalleryClientSelection` refuses an already-locked member,
  // `unlockGalleryClientSelection` refuses an unlocked one).
  it("offers lock only to an unlocked member, unlock only to a locked one", () => {
    expect(
      clientLockActions({
        galleryStatus: "proofing",
        locked: false,
        sent: false,
        pickCount: 1,
      }),
    ).toEqual({ canLock: true, canUnlock: false, canRemovePicks: true });
    expect(
      clientLockActions({
        galleryStatus: "selected",
        locked: true,
        sent: true,
        pickCount: 0,
      }),
    ).toEqual({ canLock: false, canUnlock: true, canRemovePicks: true });
  });

  // S5's answer to the "Desbloquear for a sent but unlocked member" question:
  // not offered. Their submitted picks are immutable either way, and removing
  // them is a different action.
  it("offers NO unlock to a sent member who was never locked", () => {
    expect(
      clientLockActions({
        galleryStatus: "proofing",
        locked: false,
        sent: true,
        pickCount: 3,
      }),
    ).toEqual({ canLock: true, canUnlock: false, canRemovePicks: true });
  });

  it("offers remove-picks for a lock or a submit even with zero picks", () => {
    expect(
      clientLockActions({
        galleryStatus: "proofing",
        locked: true,
        sent: false,
        pickCount: 0,
      }).canRemovePicks,
    ).toBe(true);
    expect(
      clientLockActions({
        galleryStatus: "proofing",
        locked: false,
        sent: true,
        pickCount: 0,
      }).canRemovePicks,
    ).toBe(true);
  });

  it("offers nothing outside proofing/selected", () => {
    for (const galleryStatus of ["draft", "delivered", "archived"] as const) {
      expect(
        clientLockActions({ galleryStatus, locked: false, sent: false, pickCount: 3 }),
      ).toEqual({ canLock: false, canUnlock: false, canRemovePicks: false });
    }
  });
});
