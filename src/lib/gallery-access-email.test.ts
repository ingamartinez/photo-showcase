import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import {
  galleryAccessEmailHtml,
  galleryAccessEmailText,
  sendGalleryAccessEmail,
} from "./gallery-access-email";

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) and `./lib/actions.js` at module scope —
// pulling just `AuthError` off it fails to resolve under Vitest. Mocked
// wholesale, same fix as src/app/(marketing)/login/actions.test.ts and
// src/app/dashboard/galleries/actions.publish.test.ts: `instanceof
// AuthError` still holds because both this file and gallery-access-email.ts
// import the SAME mocked class.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

const URL_UNDER_TEST =
  "http://localhost:3300/api/auth/callback/gallery-access?token=abc&email=ana%40example.com";

describe("galleryAccessEmailHtml / galleryAccessEmailText", () => {
  it("both embed the magic-link URL", () => {
    expect(galleryAccessEmailHtml(URL_UNDER_TEST)).toContain(URL_UNDER_TEST);
    expect(galleryAccessEmailText(URL_UNDER_TEST)).toContain(URL_UNDER_TEST);
  });

  it("both mention the 48-hour window, so the copy never drifts from the token's real maxAge", () => {
    expect(galleryAccessEmailHtml(URL_UNDER_TEST)).toMatch(/48 horas/);
    expect(galleryAccessEmailText(URL_UNDER_TEST)).toMatch(/48 horas/);
  });
});

describe("sendGalleryAccessEmail", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to Resend with the recipient, subject, and both email bodies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    await sendGalleryAccessEmail({
      apiKey: "re_test_key",
      from: "no-reply@alejoframes.com",
      to: "ana@example.com",
      url: URL_UNDER_TEST,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe("no-reply@alejoframes.com");
    expect(body.to).toBe("ana@example.com");
    expect(body.subject).toBe("Tus fotos ya están listas");
    expect(body.html).toContain(URL_UNDER_TEST);
    expect(body.text).toContain(URL_UNDER_TEST);
  });

  // The load-bearing assertion for this whole file: see this function's own
  // header comment in gallery-access-email.ts for why the type matters, not
  // just whether it throws.
  it("throws an AuthError (not a plain Error) when Resend answers with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendGalleryAccessEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        url: URL_UNDER_TEST,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("throws an AuthError (not a plain Error) when the fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("network unreachable"));

    await expect(
      sendGalleryAccessEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        url: URL_UNDER_TEST,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
