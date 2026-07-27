import { describe, expect, it } from "vitest";
import { Auth, raw, skipCSRFCheck } from "@auth/core";
import Resend from "@auth/core/providers/resend";
import type { Adapter } from "@auth/core/adapters";
import { callbackUrlCookieName } from "./auth-cookies";

describe("callbackUrlCookieName", () => {
  it("uses the bare name over http (local dev)", () => {
    expect(callbackUrlCookieName("http://localhost:3300")).toBe("authjs.callback-url");
  });

  it("uses the __Secure- prefix over https (production)", () => {
    expect(callbackUrlCookieName("https://alejoframes.com")).toBe("__Secure-authjs.callback-url");
  });
});

// Guard against the Set-Cookie enumeration channel reopening.
//
// The unit tests for the action mock `@/auth`, so they can never observe what
// Auth.js actually puts on the wire — which is exactly why this leak shipped
// past the first review. These tests drive the REAL `@auth/core` `Auth()` with a
// fake adapter, the same way `next-auth`'s server-side `signIn()` does, and pin
// two facts the fix depends on:
//
//   1. A refused address produces NO cookies at all (it throws), while an
//      accepted one produces cookies. That asymmetry is the channel.
//   2. The complete set of cookie names an accepted address produces is exactly
//      the one name `clearAuthCallbackUrlCookie()` normalizes.
//
// If a future Auth.js version renames that cookie, or starts emitting a second
// one on the accepted path, (2) fails here instead of silently leaking again.
const KNOWN = "known@example.com";

function fakeAdapter(): Adapter {
  const notNeeded = () => {
    throw new Error("not reached in a signin request");
  };
  return {
    createUser: notNeeded,
    getUser: notNeeded,
    getUserByEmail: async (email) =>
      email === KNOWN ? { id: "user-1", email, emailVerified: null } : null,
    getUserByAccount: notNeeded,
    updateUser: notNeeded,
    linkAccount: notNeeded,
    createSession: notNeeded,
    getSessionAndUser: notNeeded,
    updateSession: notNeeded,
    deleteSession: notNeeded,
    createVerificationToken: async (token) => token,
    useVerificationToken: notNeeded,
  };
}

/** Mirrors what `next-auth`'s `signIn()` sends for `signIn("resend", …)`. */
async function requestLink(origin: string, email: string) {
  const config = {
    adapter: fakeAdapter(),
    secret: "test-secret-at-least-32-characters-long",
    basePath: "/api/auth",
    trustHost: true,
    providers: [
      Resend({
        apiKey: "re_test",
        from: "hola@alejoframes.com",
        // No network in a unit test; the real one is exercised end to end.
        sendVerificationRequest: async () => {},
      }),
    ],
    callbacks: {
      // The same shape as the enumeration guard in src/auth.ts: an address that
      // is not already a user is refused, so no link is ever sent.
      signIn: async ({ user }: { user: { email?: string | null } }) => user.email === KNOWN,
    },
  };

  const request = new Request(`${origin}/api/auth/signin/resend`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, callbackUrl: `${origin}/login` }),
  });

  return await Auth(request, {
    ...(config as unknown as Parameters<typeof Auth>[1]),
    raw,
    skipCSRFCheck,
  });
}

describe("Auth.js Set-Cookie enumeration channel", () => {
  it("emits cookies for a known address but throws — emitting none — for an unknown one", async () => {
    const accepted = (await requestLink("https://alejoframes.com", KNOWN)) as {
      cookies: { name: string }[];
    };

    expect(accepted.cookies.length).toBeGreaterThan(0);
    await expect(requestLink("https://alejoframes.com", "ghost@example.com")).rejects.toThrow(
      /AccessDenied/,
    );
  });

  it.each([["http://localhost:3300"], ["https://alejoframes.com"]])(
    "emits only the cookie we normalize, for origin %s",
    async (origin) => {
      const accepted = (await requestLink(origin, KNOWN)) as { cookies: { name: string }[] };

      // Every cookie the accepted path emits must be one the action clears on
      // BOTH paths. A new name here means a new leak.
      expect(accepted.cookies.map((cookie) => cookie.name)).toEqual([
        callbackUrlCookieName(origin),
      ]);
    },
  );
});
