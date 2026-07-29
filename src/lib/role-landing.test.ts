import { describe, expect, it } from "vitest";
import { landingPathForRole } from "./role-landing";

// This is the ONE place the admin-vs-client landing rule is expressed —
// `(marketing)/login/redirect/page.tsx` and `(marketing)/layout.tsx` both
// call this function rather than each re-deriving the mapping. Covering it
// directly means a regression here fails one focused test instead of being
// re-discovered independently at each call site.
describe("landingPathForRole", () => {
  it("sends an admin to /dashboard", () => {
    expect(landingPathForRole("admin")).toBe("/dashboard");
  });

  it("sends a client to /galleries", () => {
    expect(landingPathForRole("client")).toBe("/galleries");
  });
});
