import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained .next/standalone/ bundle the CD pipeline can
  // rsync + run via `bun server.js` — no node_modules install on the droplet.
  output: "standalone",
  experimental: {
    // Enables `forbidden()` from `next/navigation`, which `src/lib/auth-guards.ts`
    // uses to answer a failed role check with a real HTTP 403 — in Server
    // Components, Server Actions, and Route Handlers alike, with no separate
    // per-context error handling. See that file for why this, and not
    // middleware, is the one place every protected surface asks "is this
    // allowed".
    authInterrupts: true,
  },
};

export default nextConfig;
