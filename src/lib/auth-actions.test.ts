import { beforeEach, describe, expect, it, vi } from "vitest";

// `@/auth`'s `signOut()` hits the real Auth.js pipeline (DB session delete +
// cookie clearing) — mock the module boundary so this stays a fast,
// deterministic test of what THIS action asks Auth.js to do, not an
// integration test of NextAuth's own, already-established sign-out behavior.
const signOutMock = vi.fn();

vi.mock("@/auth", () => ({
  signOut: (...args: unknown[]) => signOutMock(...args),
}));

import { signOutAction } from "./auth-actions";

beforeEach(() => {
  signOutMock.mockReset();
});

describe("signOutAction", () => {
  // This is the whole contract: delegate to the real `signOut()` and do
  // nothing else. For the database session strategy, `signOut()` deletes the
  // session row through the Drizzle adapter before it clears any cookie —
  // that row deletion, not a cookie write, is what makes the client's
  // existing session id stop resolving to anything. Asserting the call
  // happened (rather than, say, asserting some cookie was cleared by THIS
  // action) is what proves the action relies on that real, database-backed
  // invalidation instead of re-implementing a weaker, cookie-only version of
  // it.
  it("calls the real signOut() with an explicit redirect destination", async () => {
    signOutMock.mockResolvedValue(undefined);

    await signOutAction();

    expect(signOutMock).toHaveBeenCalledTimes(1);
    expect(signOutMock).toHaveBeenCalledWith({ redirectTo: "/" });
  });

  // Guards against the same implicit-redirect trap flagged for `signIn()` in
  // `src/app/login/actions.ts` (task #11's note): leaving `redirectTo`
  // unset falls back to Auth.js reading the `Referer` header, which is not a
  // destination this action controls or can reason about.
  it("never calls signOut() without an explicit redirectTo", async () => {
    signOutMock.mockResolvedValue(undefined);

    await signOutAction();

    const [options] = signOutMock.mock.calls[0] as [{ redirectTo?: string }];
    expect(options.redirectTo).toBeTruthy();
  });

  it("propagates a failure from signOut() instead of swallowing it", async () => {
    signOutMock.mockRejectedValue(new Error("database unavailable"));

    await expect(signOutAction()).rejects.toThrow("database unavailable");
  });
});
