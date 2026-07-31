// NextAuth v5 — passwordless, admin-provisioned identity.
//
// There is no self-registration. The photographer creates a client row; the
// client then proves ownership of that email via a magic link. The signIn
// callback below is what enforces it: an unknown address never receives a link
// at all, so the login form cannot be used to discover or create accounts.

import NextAuth, { type DefaultSession } from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { AUTH_BASE_PATH } from "@/lib/auth-base-path";
import { db } from "@/lib/db";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";
import { authEnv, resendEnv } from "@/lib/env";
import { sendGalleryAccessEmail } from "@/lib/gallery-access-email";
import { sendLoginEmail } from "@/lib/login-email";
import { findUserIdByEmail } from "@/lib/users";

// Task #21: publishing a gallery emails the client a magic link that signs
// them in DIRECTLY — no `/login` detour — straight into their gallery. That
// is a deliberate product choice (friendlier, one click) with an accepted
// tradeoff: forwarding this email hands the recipient access for as long as
// the link is valid. The 15-minute `maxAge` on the "resend" provider below
// is wrong for this use case (a client opens "your photos are ready" hours
// or a day later, not in the next 15 minutes) — this is its OWN, separate
// token lifetime, on its OWN provider instance, so extending it can never
// accidentally loosen the login link above.
//
// 48 hours: long enough that a client who only checks personal email in the
// evening still catches it the next day; short enough that a stale,
// forwarded copy of the email stops being a usable credential within two
// days rather than staying live indefinitely. Single-use is not a separate
// mechanism bolted on top — it comes for free from reusing Auth.js's own
// `verificationTokens` table (see schema.ts's comment: "Auth.js deletes the
// row when it is consumed") via a second Resend provider below, instead of
// a hand-rolled token flow. The first click consumes the token and
// establishes a real database session; a forwarded copy of the SAME link
// stops working after that first click, not merely after 48h — which is
// the meaningfully safer of the two options given the forwarding risk.
export const GALLERY_ACCESS_MAX_AGE_SECONDS = 48 * 60 * 60;

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: "admin" | "client";
    } & Omit<NonNullable<DefaultSession["user"]>, "id">;
  }

  interface User {
    role?: "admin" | "client";
  }
}

// The config is a FUNCTION, not an object, so the environment is read per
// request instead of at import time. This is not a style choice: `next build`
// imports every route module while collecting page data, and CI builds with no
// application environment at all. Reading env at module scope fails the build
// with "Failed to collect page data for /api/auth/[...nextauth]" — the same
// class of build-in-CI failure that broke the Phase 1 deploy.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  // Validated per request: a missing AUTH_SECRET surfaces as a readable error
  // naming the variable, not as an opaque decryption failure at sign-in.
  authEnv();
  const { RESEND_API_KEY, EMAIL_FROM } = resendEnv();

  return {
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),
    // Database sessions, not JWT: revoking a client's access takes effect on the
    // next request instead of whenever their token happens to expire.
    session: { strategy: "database" },
    providers: [
      Resend({
        apiKey: RESEND_API_KEY,
        from: EMAIL_FROM,
        // PLAN.md §4: short-lived links. Auth.js defaults to 24 h, which is far
        // too long for a credential that arrives in an inbox.
        maxAge: 15 * 60,
        // Task #59: the built-in `sendVerificationRequest` (from
        // `@auth/core/providers/resend.js`) throws a PLAIN `Error` on a
        // failed send, which `Auth()` swallows into a redirect instead of
        // rejecting `signIn()`'s caller — `signIn(..., { redirect: false })`
        // then resolves with an ordinary URL STRING, not a rejection — see
        // src/lib/login-email.ts's header comment for the full trace through
        // `@auth/core`. Overriding it with `sendLoginEmail`, which always
        // throws `AuthError`, is what makes `signIn()` actually REJECT on a
        // Resend outage. src/app/(marketing)/login/actions.ts still swallows
        // that `AuthError` into the same neutral "sent" response as an
        // unknown address — intentional, per #9/#43's anti-enumeration
        // guarantee, not a leftover bug — but it now does so because it
        // chose to, having actually observed a rejection, not because a
        // crash was silently downgraded into a fake success by `Auth()`.
        sendVerificationRequest: ({ identifier, url }) =>
          sendLoginEmail({ apiKey: RESEND_API_KEY, from: EMAIL_FROM, to: identifier, url }),
      }),
      // Second, independent Email provider instance for task #21's "your
      // gallery is ready" link — see this file's header comment above for
      // the maxAge/single-use reasoning. Sharing the SAME `apiKey`/`from`
      // (Resend account, verified sender) but a different `id`, `maxAge`,
      // and `sendVerificationRequest` is exactly what a second provider
      // entry is for: it reuses Auth.js's whole email-provider pipeline
      // (token generation, the `signIn` callback's account-enumeration
      // guard below, the generic `/api/auth/callback/:provider` handler,
      // session creation on click) without duplicating any of it.
      Resend({
        id: "gallery-access",
        apiKey: RESEND_API_KEY,
        from: EMAIL_FROM,
        maxAge: GALLERY_ACCESS_MAX_AGE_SECONDS,
        sendVerificationRequest: ({ identifier, url }) =>
          sendGalleryAccessEmail({ apiKey: RESEND_API_KEY, from: EMAIL_FROM, to: identifier, url }),
      }),
    ],
    pages: {
      signIn: "/login",
      verifyRequest: "/login/check-email",
      error: "/login",
    },
    callbacks: {
      // Runs twice per login: once when a link is requested, once when it is
      // clicked. Both require the address to already exist as a user.
      //
      // On the request step this is the account-enumeration guard — refusing
      // here means no email is ever sent to an address we don't know, so the
      // form cannot be used to discover or create accounts. The UI must show
      // the same neutral message either way, or the difference leaks which
      // addresses exist.
      //
      // On the click step it re-checks because the client could have been
      // deleted between requesting the link and following it.
      //
      // Task #51: the lookup itself lives in src/lib/users.ts rather than
      // inline here, because the admin dashboard's `createClient` action is
      // the only thing that ever mints one of these identities and its test
      // suite has to be able to prove that what it just inserted is what this
      // callback will find. It used to prove that against a hand-copied query,
      // which would have stayed green if this line changed. One function, one
      // lookup, both sides.
      async signIn({ user }) {
        const address = user.email;
        if (!address) return false;

        return Boolean(await findUserIdByEmail(address));
      },
      session({ session, user }) {
        session.user.id = user.id;
        session.user.role = user.role ?? "client";
        return session;
      },
    },
    basePath: AUTH_BASE_PATH,
    // The app sits behind Caddy; without this, Auth.js rejects the proxied Host
    // header and every callback URL comes out wrong in production.
    trustHost: true,
  };
});
