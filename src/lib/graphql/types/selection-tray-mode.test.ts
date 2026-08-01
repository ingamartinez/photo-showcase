// Task #204 — the wire<->Postgres conversion at the one seam that needs it
// (`/galleries/[publicSlug]/page.tsx`). Review finding: this function was
// entirely untested, and neutering its body (forced to always return
// `"flat"`) left the rest of this repo's suite green — nothing exercised the
// `"BY_PERSON"` direction directly. See page.chrome.test.tsx's own
// end-to-end test for the same seam proven through the REAL GraphQL
// resolver; this file proves the function in isolation, both directions.
import { describe, expect, it } from "vitest";
import { selectionTrayModeFromWire } from "./selection-tray-mode";

describe("selectionTrayModeFromWire", () => {
  it("converts the flat wire name to the Postgres value", () => {
    expect(selectionTrayModeFromWire("FLAT")).toBe("flat");
  });

  it("converts the by-person wire name to the Postgres value", () => {
    expect(selectionTrayModeFromWire("BY_PERSON")).toBe("by-person");
  });

  // Review finding #3: a silent fallback to "flat" for anything else would
  // be indistinguishable from the feature being off. The two-member union
  // makes this unreachable at the type level in normal use, so this reaches
  // it the only way a test can: bypassing the type check to simulate a
  // drifted wire value (a third mode added to the enum without this
  // function being updated).
  it("throws rather than silently falling back for an unknown wire value", () => {
    expect(() => selectionTrayModeFromWire("SOMETHING_ELSE" as "FLAT" | "BY_PERSON")).toThrow(
      /unknown wire value/,
    );
  });
});
