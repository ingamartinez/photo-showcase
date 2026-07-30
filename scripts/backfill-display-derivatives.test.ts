// Covers the APP_ENV guard only (task #104 / #81's trap): a maintenance
// script run by hand over SSH inherits no environment from systemd, so
// `namespacedKey()` would silently default to the `dev/` prefix and this
// script would report success while writing nothing production actually
// serves. The rest of `main()` (the DB scan, the R2 read/write loop) is
// exercised end-to-end only on the droplet itself, at the acceptance
// criteria's request — it needs a real Postgres row and a real final in R2,
// neither of which a unit test can fake meaningfully here.
//
// Importing this module is side-effect-free: `main()` at the bottom of
// backfill-display-derivatives.ts is gated on `import.meta.main`, which is
// false for a module reached via `import` rather than run directly by bun.
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertAppEnvIsSet } from "./backfill-display-derivatives";

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
