import { describe, expect, it } from "vitest";
import { ACCEPTED_FINAL_FORMATS, FINAL_UPLOAD_ACCEPT } from "./final-formats";

describe("ACCEPTED_FINAL_FORMATS", () => {
  it("accepts exactly JPEG and PNG, mapped to their stored extension", () => {
    expect(ACCEPTED_FINAL_FORMATS).toEqual({
      "image/jpeg": "jpg",
      "image/png": "png",
    });
  });
});

describe("FINAL_UPLOAD_ACCEPT", () => {
  // The property that actually closes the drift gap task #220's review
  // caught: this string must be DERIVED from the map above, not a second,
  // independently-maintained literal. MUTATION PROOF: hardcoding
  // `FINAL_UPLOAD_ACCEPT` to a literal `"image/jpeg,image/png"` instead of
  // `Object.keys(ACCEPTED_FINAL_FORMATS).join(",")` would still pass THIS
  // assertion today (the two happen to be equal), which is exactly why the
  // second assertion below pins the DERIVATION itself, not just today's
  // value — it fails the moment the two are computed independently and one
  // is edited without the other.
  it("is exactly the comma-joined keys of ACCEPTED_FINAL_FORMATS", () => {
    expect(FINAL_UPLOAD_ACCEPT).toBe("image/jpeg,image/png");
    expect(FINAL_UPLOAD_ACCEPT).toBe(Object.keys(ACCEPTED_FINAL_FORMATS).join(","));
  });
});
