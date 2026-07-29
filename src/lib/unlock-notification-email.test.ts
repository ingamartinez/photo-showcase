import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  unlockNotificationEmailHtml,
  unlockNotificationEmailText,
  sendUnlockNotificationEmail,
} from "./unlock-notification-email";
import { computeQuota } from "@/lib/quota";

const QUOTA = computeQuota(15, { includedPhotosSnapshot: 13, extraPhotoPriceCopSnapshot: 5_000 });

const PARAMS = {
  clientName: "Ana Pérez",
  clientEmail: "ana@example.com",
  galleryTitle: "Boda Ana y Beto",
  galleryUrl: "https://alejoframes.com/galleries/abc123",
  reason: null,
  quota: QUOTA,
};

describe("unlockNotificationEmailHtml / unlockNotificationEmailText", () => {
  it("both name the client, the gallery, the link, and the exact quota numbers", () => {
    for (const render of [unlockNotificationEmailHtml, unlockNotificationEmailText]) {
      const body = render(PARAMS);
      expect(body).toContain("Ana Pérez");
      expect(body).toContain("Boda Ana y Beto");
      expect(body).toContain(PARAMS.galleryUrl);
      expect(body).toContain("13"); // included
      expect(body).toContain("15"); // selected
      expect(body).toContain("2"); // extras
    }
  });

  it("falls back to the email when the client has no name on file", () => {
    const body = unlockNotificationEmailText({ ...PARAMS, clientName: null });
    expect(body).toContain("ana@example.com");
  });

  it("includes the admin's optional reason when present", () => {
    const body = unlockNotificationEmailText({ ...PARAMS, reason: "Hablamos por WhatsApp." });
    expect(body).toContain("Hablamos por WhatsApp.");
  });

  it("omits any reason line when the admin left it blank", () => {
    for (const render of [unlockNotificationEmailHtml, unlockNotificationEmailText]) {
      const body = render({ ...PARAMS, reason: null });
      expect(body).not.toMatch(/Nota de tu fotógrafo/);
    }
  });
});

describe("sendUnlockNotificationEmail", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to Resend with the client recipient, subject, and both bodies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    await sendUnlockNotificationEmail({
      apiKey: "re_test_key",
      from: "no-reply@alejoframes.com",
      to: "ana@example.com",
      ...PARAMS,
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
    expect(body.subject).toContain("Boda Ana y Beto");
    expect(body.html).toContain("Ana Pérez");
    expect(body.text).toContain("Ana Pérez");
  });

  it("throws (a plain Error, not an AuthError) when Resend answers with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendUnlockNotificationEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        ...PARAMS,
      }),
    ).rejects.toThrow(/429/);
  });

  it("throws when the fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("network unreachable"));

    await expect(
      sendUnlockNotificationEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        ...PARAMS,
      }),
    ).rejects.toThrow(/network unreachable/);
  });
});
