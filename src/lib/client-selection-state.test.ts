import { describe, expect, it } from "vitest";
import {
  clientLockActions,
  clientSelectionState,
  clientSelectionStateLabel,
  toClientSelectionView,
} from "./client-selection-state";

const T = new Date("2026-10-12T15:00:00Z");

describe("clientSelectionState", () => {
  it("maps the two lock columns onto open / submitted / locked", () => {
    expect(clientSelectionState({ lockedAt: null, submittedAt: null })).toBe("open");
    expect(clientSelectionState({ lockedAt: T, submittedAt: T })).toBe("submitted");
    expect(clientSelectionState({ lockedAt: T, submittedAt: null })).toBe("locked");
  });
});

describe("toClientSelectionView", () => {
  it("formats the submit date in the studio timezone, only for submitted", () => {
    expect(toClientSelectionView({ lockedAt: T, submittedAt: T, pickCount: 2 })).toEqual({
      state: "submitted",
      pickCount: 2,
      submittedOn: "12/10/2026",
    });
    expect(
      toClientSelectionView({ lockedAt: T, submittedAt: null, pickCount: 0 }).submittedOn,
    ).toBeNull();
  });

  it("uses America/Bogota, not UTC, for the calendar day", () => {
    // 02:00 UTC on the 13th is still the 12th at 21:00 in Bogota.
    const late = new Date("2026-10-13T02:00:00Z");
    expect(
      toClientSelectionView({ lockedAt: late, submittedAt: late, pickCount: 1 }).submittedOn,
    ).toBe("12/10/2026");
  });
});

describe("clientSelectionStateLabel", () => {
  it("has the three owner-facing labels", () => {
    expect(clientSelectionStateLabel("open", null)).toBe("Eligiendo");
    expect(clientSelectionStateLabel("submitted", "12/10/2026")).toBe("Envió el 12/10/2026");
    expect(clientSelectionStateLabel("locked", null)).toBe("Bloqueado por vos");
  });
});

describe("clientLockActions", () => {
  it("offers lock only to an open client, unlock only to a locked one", () => {
    expect(clientLockActions({ galleryStatus: "proofing", state: "open", pickCount: 1 })).toEqual({
      canLock: true,
      canUnlock: false,
      canRemovePicks: true,
    });
    expect(
      clientLockActions({ galleryStatus: "selected", state: "submitted", pickCount: 0 }),
    ).toEqual({ canLock: false, canUnlock: true, canRemovePicks: true });
  });

  it("offers nothing outside proofing/selected", () => {
    for (const galleryStatus of ["draft", "delivered", "archived"] as const) {
      expect(clientLockActions({ galleryStatus, state: "open", pickCount: 3 })).toEqual({
        canLock: false,
        canUnlock: false,
        canRemovePicks: false,
      });
    }
  });
});
