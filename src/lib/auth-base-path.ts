// The single source of truth for where Auth.js's own API surface lives.
//
// Both `src/auth.ts` (as NextAuth's `basePath` config option) and
// `src/app/api/auth/[...nextauth]/route.ts` (the signin guard hardened by
// task #44) import this constant instead of each writing their own
// "/api/auth" literal, so the two can never silently drift apart.
//
// Deliberately its own tiny module with zero dependencies, rather than an
// export living on `src/auth.ts` itself: `src/auth.ts` imports `next-auth`,
// which — at least at the version pinned here — cannot be imported for real
// inside Vitest (`next-auth/lib/env.js` does a bare `import ... from
// "next/server"`, which Node's ESM resolver rejects with
// `ERR_MODULE_NOT_FOUND`, unlike Next's own bundler which resolves it fine).
// Every existing test that touches `@/auth` therefore fully mocks it — see
// any `vi.mock("@/auth", ...)` in this repo. A constant that route.test.ts
// needs to assert on for real (not through a mock standing in for it) has to
// live somewhere that import chain never reaches.
export const AUTH_BASE_PATH = "/api/auth";
