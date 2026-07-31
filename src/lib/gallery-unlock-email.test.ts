import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "next-auth";
import {
  galleryUnlockEmailHtml,
  galleryUnlockEmailText,
  sendGalleryUnlockEmail,
} from "./gallery-unlock-email";

// The real "next-auth" package's root index eagerly imports `./lib/env.js`
// (which imports `next/server`) and `./lib/actions.js` at module scope —
// pulling just `AuthError` off it fails to resolve under Vitest. Mocked
// wholesale, same fix as gallery-access-email.test.ts's own identical mock:
// `instanceof AuthError` still holds because both this file and
// gallery-unlock-email.ts import the SAME mocked class.
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

const URL_UNDER_TEST =
  "http://localhost:3300/api/auth/callback/gallery-unlock?token=abc&email=ana%40example.com";

describe("galleryUnlockEmailHtml / galleryUnlockEmailText", () => {
  it("both embed the magic-link URL", () => {
    expect(galleryUnlockEmailHtml(URL_UNDER_TEST)).toContain(URL_UNDER_TEST);
    expect(galleryUnlockEmailText(URL_UNDER_TEST)).toContain(URL_UNDER_TEST);
  });

  it("both mention the 48-hour window, so the copy never drifts from the token's real maxAge", () => {
    expect(galleryUnlockEmailHtml(URL_UNDER_TEST)).toMatch(/48 horas/);
    expect(galleryUnlockEmailText(URL_UNDER_TEST)).toMatch(/48 horas/);
  });

  // Task #85's own added acceptance criterion: distinguishable from
  // gallery-access by subject alone — asserted directly on
  // `sendGalleryUnlockEmail`'s subject below, but the body copy itself must
  // also never claim the "come and choose" framing gallery-access uses.
  it("never repeats gallery-access's own wording", () => {
    expect(galleryUnlockEmailText(URL_UNDER_TEST)).not.toMatch(/ya están listas para ver/);
  });
});

describe("sendGalleryUnlockEmail", () => {
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

    await sendGalleryUnlockEmail({
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
    // The added acceptance criterion, pinned down at the subject string
    // level: this must differ from gallery-access-email.ts's
    // "Tus fotos ya están listas" and from gallery-delivery-email.ts's
    // "Tus fotos editadas ya están listas para descargar".
    expect(body.subject).toBe("Podés volver a editar tu selección");
    expect(body.html).toContain(URL_UNDER_TEST);
    expect(body.text).toContain(URL_UNDER_TEST);
  });

  it("throws an AuthError (not a plain Error) when Resend answers with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendGalleryUnlockEmail({
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
      sendGalleryUnlockEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        url: URL_UNDER_TEST,
      }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
