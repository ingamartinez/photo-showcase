// Covers the APP_ENV guard itself (task #81) — see assert-app-env.ts's own
// header for the full "why". This function has no side effects beyond
// reading `process.env.APP_ENV` and throwing, so a plain unit test is
// sufficient; it is exercised end-to-end for real only by whichever ops
// script calls it, against a real SSH session and a real release dir.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAppEnvIsSet } from "./assert-app-env";

describe("assertAppEnvIsSet", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws when APP_ENV is entirely unset — the exact shape of a script run by hand over SSH", () => {
    vi.stubEnv("APP_ENV", undefined);
    expect(() => assertAppEnvIsSet()).toThrow(/APP_ENV is not set/);
  });

  it("throws when APP_ENV is the empty string, not just when the key is absent", () => {
    vi.stubEnv("APP_ENV", "");
    expect(() => assertAppEnvIsSet()).toThrow(/APP_ENV is not set/);
  });

  it("does not throw when APP_ENV is production", () => {
    vi.stubEnv("APP_ENV", "production");
    expect(() => assertAppEnvIsSet()).not.toThrow();
  });

  it("does not throw for a non-production value — the refusal is about being UNSET, not about which environment was chosen", () => {
    vi.stubEnv("APP_ENV", "development");
    expect(() => assertAppEnvIsSet()).not.toThrow();
  });
});
