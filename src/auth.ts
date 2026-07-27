// NextAuth v5 — passwordless, admin-provisioned identity.
//
// There is no self-registration. The photographer creates a client row; the
// client then proves ownership of that email via a magic link. The signIn
// callback below is what enforces it: an unknown address never receives a link
// at all, so the login form cannot be used to discover or create accounts.

import NextAuth, { type DefaultSession } from "next-auth";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { accounts, sessions, users, verificationTokens } from "@/lib/db/schema";
import { authEnv, resendEnv } from "@/lib/env";

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
      async signIn({ user }) {
        const address = user.email;
        if (!address) return false;

        const [existing] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, address))
          .limit(1);

        return Boolean(existing);
      },
      session({ session, user }) {
        session.user.id = user.id;
        session.user.role = user.role ?? "client";
        return session;
      },
    },
    basePath: "/api/auth",
    // The app sits behind Caddy; without this, Auth.js rejects the proxied Host
    // header and every callback URL comes out wrong in production.
    trustHost: true,
  };
});
