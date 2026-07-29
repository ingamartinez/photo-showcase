import { describe, expect, it } from "vitest";
import { getLoginErrorMessage } from "./auth-error";

describe("getLoginErrorMessage", () => {
  it("returns null when there is no error code", () => {
    expect(getLoginErrorMessage(undefined)).toBeNull();
  });

  it("returns null for an empty error code", () => {
    expect(getLoginErrorMessage("")).toBeNull();
  });

  it("special-cases Verification with an expired/used-link message", () => {
    expect(getLoginErrorMessage("Verification")).toBe(
      "Este enlace ya venció o ya se usó. Pedí uno nuevo abajo.",
    );
  });

  it("collapses every other known Auth.js code into one generic message", () => {
    const generic = "No pudimos verificar el enlace. Pedí uno nuevo abajo.";

    expect(getLoginErrorMessage("AccessDenied")).toBe(generic);
    expect(getLoginErrorMessage("Configuration")).toBe(generic);
    expect(getLoginErrorMessage("Default")).toBe(generic);
  });

  it("never leaks a distinct message for an unrecognized code", () => {
    // Regression guard: a future Auth.js version adding a new error code must
    // still fall through to the generic message rather than throwing or
    // rendering `undefined`.
    expect(getLoginErrorMessage("SomeFutureCode")).toBe(
      "No pudimos verificar el enlace. Pedí uno nuevo abajo.",
    );
  });
});
