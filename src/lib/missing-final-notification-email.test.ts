import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  missingFinalNotificationEmailHtml,
  missingFinalNotificationEmailText,
  sendMissingFinalNotificationEmail,
} from "./missing-final-notification-email";

const PARAMS = {
  galleryTitle: "Boda Ana y Beto",
  galleryUrl: "https://alejoframes.com/dashboard/galleries/g1",
  missingFilenames: ["IMG_0001.JPG", "IMG_0002.JPG"],
};

describe("missingFinalNotificationEmailHtml / missingFinalNotificationEmailText", () => {
  it("both name the gallery, every missing filename, and the dashboard link", () => {
    for (const render of [missingFinalNotificationEmailHtml, missingFinalNotificationEmailText]) {
      const body = render(PARAMS);
      expect(body).toContain("Boda Ana y Beto");
      expect(body).toContain("IMG_0001.JPG");
      expect(body).toContain("IMG_0002.JPG");
      expect(body).toContain(PARAMS.galleryUrl);
    }
  });

  it("never mentions a raw R2 key or asset id — only the recognizable original filename", () => {
    for (const render of [missingFinalNotificationEmailHtml, missingFinalNotificationEmailText]) {
      expect(render(PARAMS)).not.toMatch(/galleries\/.*\/finals\//);
    }
  });
});

describe("sendMissingFinalNotificationEmail", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to Resend with the admin recipient, subject, and both bodies", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    await sendMissingFinalNotificationEmail({
      apiKey: "re_test_key",
      from: "no-reply@alejoframes.com",
      to: "photographer@example.com",
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
    expect(body.to).toBe("photographer@example.com");
    expect(body.subject).toContain("Boda Ana y Beto");
    expect(body.html).toContain("IMG_0001.JPG");
    expect(body.text).toContain("IMG_0001.JPG");
  });

  it("throws when Resend answers with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendMissingFinalNotificationEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "photographer@example.com",
        ...PARAMS,
      }),
    ).rejects.toThrow(/429/);
  });

  it("throws when the fetch itself rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("network unreachable"));

    await expect(
      sendMissingFinalNotificationEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "photographer@example.com",
        ...PARAMS,
      }),
    ).rejects.toThrow(/network unreachable/);
  });
});

// `notifyAdminOfMissingFinal` is the flow both routes actually call: looks
// up the (single, PLAN.md §4) admin, reads env lazily, and sends. Mocked at
// its own two real boundaries (`@/lib/db`, `@/lib/env`) plus the global
// `fetch` the send function underneath it uses — proving the WIRING, not
// re-proving Resend's own request shape (covered above).
vi.mock("server-only", () => ({}));

let adminRows: { email: string }[] = [];
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => adminRows.slice(0, n),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/env", () => ({
  authEnv: () => ({ AUTH_SECRET: "x".repeat(32), AUTH_URL: "https://alejoframes.com" }),
  resendEnv: () => ({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "no-reply@alejoframes.com" }),
}));

describe("notifyAdminOfMissingFinal", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    adminRows = [{ email: "photographer@example.com" }];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends to the admin's own email, built from the gallery's id and title", async () => {
    const { notifyAdminOfMissingFinal } = await import("./missing-final-notification-email");

    await notifyAdminOfMissingFinal({
      gallery: { id: "g1", title: "Boda Ana y Beto" },
      missingFilenames: ["IMG_0001.JPG"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { to: string; html: string };
    expect(body.to).toBe("photographer@example.com");
    expect(body.html).toContain("https://alejoframes.com/dashboard/galleries/g1");
  });

  it("never throws — and never sends — when no admin user exists", async () => {
    adminRows = [];
    const { notifyAdminOfMissingFinal } = await import("./missing-final-notification-email");

    await expect(
      notifyAdminOfMissingFinal({ gallery: { id: "g1", title: "x" }, missingFilenames: ["a.jpg"] }),
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when Resend itself fails — this always runs on a request that is already erroring", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const { notifyAdminOfMissingFinal } = await import("./missing-final-notification-email");

    await expect(
      notifyAdminOfMissingFinal({ gallery: { id: "g1", title: "x" }, missingFilenames: ["a.jpg"] }),
    ).resolves.toBeUndefined();
  });
});
