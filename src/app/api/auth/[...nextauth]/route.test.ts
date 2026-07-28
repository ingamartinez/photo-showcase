import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// `@/auth`'s handlers hit the real Auth.js pipeline (DB, Resend, cookies) —
// mock the module boundary so these stay fast, deterministic tests of THIS
// route's own routing decision (block signin, delegate everything else),
// not an integration test of NextAuth. The DB/Resend leak this route closes
// is proven separately, at the protocol level, by asserting nothing ever
// reaches these mocks for `/signin*`.
const handlersGetMock = vi.fn();
const handlersPostMock = vi.fn();

vi.mock("@/auth", () => ({
  handlers: {
    GET: (...args: unknown[]) => handlersGetMock(...args),
    POST: (...args: unknown[]) => handlersPostMock(...args),
  },
}));

beforeEach(() => {
  handlersGetMock.mockReset();
  handlersPostMock.mockReset();
  // A fresh Response per call — reusing one instance would make a second
  // `.text()` read throw "Body has already been read", masking a real
  // regression (delegation happening twice) behind an unrelated error.
  handlersGetMock.mockImplementation(async () => new Response("delegated", { status: 200 }));
  handlersPostMock.mockImplementation(async () => new Response("delegated", { status: 200 }));
});

async function readAll(response: Response) {
  return {
    status: response.status,
    location: response.headers.get("location"),
    setCookie: response.headers.getSetCookie(),
    bodyLength: (await response.text()).length,
  };
}

describe("isBuiltinSignin", () => {
  it.each([
    ["/api/auth/signin", true],
    ["/api/auth/signin/resend", true],
    ["/api/auth/signin/google", true],
    ["/api/auth/session", false],
    ["/api/auth/csrf", false],
    ["/api/auth/providers", false],
    ["/api/auth/callback/resend", false],
    ["/api/auth/signout", false],
    ["/api/auth/signing-something-else", false],
  ])("%s -> %s", async (pathname, expected) => {
    const { isBuiltinSignin } = await import("./route");
    expect(isBuiltinSignin(pathname)).toBe(expected);
  });
});

describe("the enumeration oracle at /api/auth/signin/*", () => {
  afterEach(() => {
    vi.resetModules();
  });

  // This is the regression guard: if `isBuiltinSignin`'s check is ever
  // deleted from GET/POST, this request stops being a 404 and instead
  // becomes whatever Auth.js's real signin handler answers with — which is
  // exactly the three-channel leak this route exists to close. Proven by
  // deleting the check locally and re-running this test (see task report).
  //
  // The mock below is address-aware, reproducing the exact leak measured on
  // the live dev server (see route.ts's header comment): known -> 302 to
  // verify-request with a Set-Cookie; unknown -> 302 to ?error=AccessDenied
  // with none. That matters for what this test actually proves: if it were a
  // constant response instead, "known equals unknown" would hold trivially
  // whether or not the guard exists, and the test would pass for the wrong
  // reason even with the oracle wide open (the class of bug #9 round 1
  // shipped). Making the two addresses behave differently at the mock
  // boundary means the byte-identity assertion below only passes because the
  // guard stops the request from ever reaching this handler — remove the
  // guard and it fails on a genuine mismatch, not a masked error.
  it("POST /api/auth/signin/resend never reaches the Auth.js handler, for a known OR an unknown address", async () => {
    const { POST } = await import("./route");

    handlersPostMock.mockImplementation(async (request: NextRequest) => {
      const body = await request.text();
      const email = new URLSearchParams(body).get("email");
      return email === "known@example.com"
        ? new Response(null, {
            status: 302,
            headers: {
              location: "http://localhost:3300/api/auth/verify-request?provider=resend",
              "set-cookie": "authjs.callback-url=http%3A%2F%2Flocalhost%3A3300%2Flogin; Path=/",
            },
          })
        : new Response(null, {
            status: 302,
            headers: { location: "http://localhost:3300/login?error=AccessDenied" },
          });
    });

    const knownResponse = await POST(
      new NextRequest("http://localhost:3300/api/auth/signin/resend", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "known@example.com",
          callbackUrl: "http://localhost:3300/login",
        }),
      }),
    );
    const unknownResponse = await POST(
      new NextRequest("http://localhost:3300/api/auth/signin/resend", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "ghost@example.com",
          callbackUrl: "http://localhost:3300/login",
        }),
      }),
    );
    // Each response body is read exactly once, here, into a value — reading
    // the same Response's body twice throws once it carries a real body.
    const known = await readAll(knownResponse);
    const unknown = await readAll(unknownResponse);

    // Byte-identical at the protocol level: status, Location, every
    // Set-Cookie, and body length — the exact set of channels the live
    // dev-server measurement in the task showed leaking.
    expect(known).toEqual(unknown);
    expect(known).toEqual({
      status: 404,
      location: null,
      setCookie: [],
      bodyLength: 0,
    });

    // The strongest guarantee: the real handler — which is what does the DB
    // lookup, the Resend call, and the cookie assembly — was never invoked
    // for either address. Nothing to normalize because nothing ran.
    expect(handlersPostMock).not.toHaveBeenCalled();
  });

  it("GET /api/auth/signin (the built-in form) is also a 404, not delegated", async () => {
    const { GET } = await import("./route");

    const response = await GET(new NextRequest("http://localhost:3300/api/auth/signin"));

    expect(response.status).toBe(404);
    expect(handlersGetMock).not.toHaveBeenCalled();
  });

  it("does not block /api/auth/callback/*, the magic-link click", async () => {
    const { GET } = await import("./route");

    const response = await GET(
      new NextRequest("http://localhost:3300/api/auth/callback/resend?token=abc&email=a%40b.com"),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("delegated");
    expect(handlersGetMock).toHaveBeenCalledTimes(1);
  });

  it.each(["/api/auth/session", "/api/auth/csrf", "/api/auth/providers"])(
    "delegates GET %s to the real Auth.js handler",
    async (pathname) => {
      const { GET } = await import("./route");

      const response = await GET(new NextRequest(`http://localhost:3300${pathname}`));

      expect(response.status).toBe(200);
      expect(handlersGetMock).toHaveBeenCalledTimes(1);
    },
  );

  // Scoped to signin only — sign-out (task #11) is not this route's concern
  // and must not be caught by a broader "block POST" mistake.
  it("delegates POST /api/auth/signout to the real Auth.js handler", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      new NextRequest("http://localhost:3300/api/auth/signout", { method: "POST" }),
    );

    expect(response.status).toBe(200);
    expect(handlersPostMock).toHaveBeenCalledTimes(1);
  });
});
