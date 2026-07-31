// Task #51, the other half of the seam.
//
// src/app/dashboard/clients/actions.test.ts proves that a client created in
// the dashboard is findable by `findUserIdByEmail`. That is only worth
// anything if the `signIn` callback in src/auth.ts is what actually decides
// access, and if it decides it with THAT function rather than a query of its
// own. This suite pins the second half: it captures the config factory
// `NextAuth()` is handed and invokes the real callback.
//
// Everything auth.ts imports for its side effects (the adapter, the two
// Resend provider instances, the email senders, the environment) is stubbed,
// because none of it participates in the decision under test — the callback's
// entire body is "no address means no", otherwise defer to the shared lookup.
import { beforeEach, describe, expect, it, vi } from "vitest";

type SignInCallback = (params: { user: { email?: string | null } }) => Promise<boolean>;

type CapturedConfig = {
  callbacks?: { signIn?: SignInCallback };
};

// `vi.hoisted` rather than a plain `const`: the `next-auth` mock factory below
// closes over `captured` and `findUserIdByEmailMock`, and unlike the lazily-read
// values in actions.test.ts these are reached the moment `@/auth` is imported,
// which a hoisted factory can outrun.
const mocks = vi.hoisted(() => ({
  captured: {} as { configFactory?: () => CapturedConfig },
  findUserIdByEmail: vi.fn<(email: string) => Promise<string | undefined>>(),
}));

vi.mock("next-auth", () => ({
  // auth.ts destructures `{ handlers, auth, signIn, signOut }` off the result,
  // so this has to be shaped like NextAuth's return value even though nothing
  // here uses those exports.
  default: (configFactory: () => CapturedConfig) => {
    mocks.captured.configFactory = configFactory;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  AuthError: class AuthError extends Error {},
}));

vi.mock("next-auth/providers/resend", () => ({
  default: (options: Record<string, unknown>) => ({ id: "resend", ...options }),
}));

vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: () => ({}) }));

// A `db` that refuses to be queried, on purpose. auth.ts still needs the
// import (the Drizzle adapter takes it), but the whole point of task #51 is
// that the `signIn` callback no longer reaches for the `users` table itself.
// Re-inlining that query here — the exact regression this file guards — then
// fails with a sentence saying so, instead of a bare
// "db.select is not a function".
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      throw new Error(
        "auth.ts's signIn callback must not query users directly — it delegates to findUserIdByEmail (task #51)",
      );
    },
  },
  pubsub: { listen: vi.fn(), notify: vi.fn() },
}));

vi.mock("@/lib/env", () => ({
  authEnv: () => ({ AUTH_SECRET: "x".repeat(32), AUTH_URL: "https://example.com" }),
  resendEnv: () => ({ RESEND_API_KEY: "re_test", EMAIL_FROM: "studio@example.com" }),
}));

vi.mock("@/lib/login-email", () => ({ sendLoginEmail: vi.fn() }));
vi.mock("@/lib/gallery-access-email", () => ({ sendGalleryAccessEmail: vi.fn() }));
vi.mock("@/lib/gallery-unlock-email", () => ({ sendGalleryUnlockEmail: vi.fn() }));
vi.mock("@/lib/gallery-delivery-email", () => ({ sendGalleryDeliveryEmail: vi.fn() }));

vi.mock("@/lib/users", () => ({
  findUserIdByEmail: (email: string) => mocks.findUserIdByEmail(email),
}));

async function loadSignInCallback(): Promise<SignInCallback> {
  await import("@/auth");
  const factory = mocks.captured.configFactory;
  if (!factory) throw new Error("NextAuth() was never called with a config factory");
  const signIn = factory().callbacks?.signIn;
  if (!signIn) throw new Error("auth.ts's config exposes no signIn callback");
  return signIn;
}

beforeEach(() => {
  mocks.findUserIdByEmail.mockReset();
});

describe("auth.ts signIn callback", () => {
  // The account-enumeration guard AND the "a client the photographer just
  // created can get in" guarantee are the same branch: it lets the address
  // through exactly when the shared lookup finds a row.
  it("allows an address the shared lookup finds, asking it for that exact address", async () => {
    mocks.findUserIdByEmail.mockResolvedValue("user-1");
    const signIn = await loadSignInCallback();

    await expect(signIn({ user: { email: "gala@example.com" } })).resolves.toBe(true);
    // The assertion that makes this a seam test rather than a smoke test:
    // re-inlining the query in auth.ts (task #51's regression) leaves this
    // mock untouched and fails here.
    expect(mocks.findUserIdByEmail).toHaveBeenCalledWith("gala@example.com");
  });

  it("refuses an address the shared lookup does not find", async () => {
    mocks.findUserIdByEmail.mockResolvedValue(undefined);
    const signIn = await loadSignInCallback();

    await expect(signIn({ user: { email: "nobody@example.com" } })).resolves.toBe(false);
  });

  it("refuses a user with no email at all, without querying", async () => {
    const signIn = await loadSignInCallback();

    await expect(signIn({ user: { email: null } })).resolves.toBe(false);
    expect(mocks.findUserIdByEmail).not.toHaveBeenCalled();
  });
});
