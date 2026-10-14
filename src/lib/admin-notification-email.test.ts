import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  submissionNotificationEmailHtml,
  submissionNotificationEmailText,
  sendSubmissionNotificationEmail,
} from "./admin-notification-email";
import { computeQuota } from "@/lib/quota";

// Task #205 — 0 originals: nothing writes `assets.selectionKind` to anything
// but `edited` yet (task #206).
const QUOTA = computeQuota(15, 0, {
  includedPhotosSnapshot: 13,
  extraPhotoPriceCopSnapshot: 5_000,
  extraPhotoPriceTiersSnapshot: null,
  originalPhotoPriceCopSnapshot: 2_000,
});

const PARAMS = {
  clientName: "Ana Pérez",
  clientEmail: "ana@example.com",
  galleryTitle: "Boda Ana y Beto",
  galleryUrl: "https://alejoframes.com/dashboard/galleries/g1",
  quota: QUOTA,
};

describe("submissionNotificationEmailHtml / submissionNotificationEmailText", () => {
  it("both name the client, the gallery, and the exact quota numbers", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      const body = render(PARAMS);
      expect(body).toContain("Ana Pérez");
      expect(body).toContain("ana@example.com");
      expect(body).toContain("Boda Ana y Beto");
      expect(body).toContain("13"); // included
      expect(body).toContain("15"); // selected
      expect(body).toContain("2"); // extras
      expect(body).toContain(PARAMS.galleryUrl);
    }
  });

  it("both state extras are settled outside the app — the app never charges money", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      expect(render(PARAMS)).toMatch(/fuera de la app/);
    }
  });

  it("falls back to the email when the client has no name on file", () => {
    const body = submissionNotificationEmailText({ ...PARAMS, clientName: null });
    expect(body).toContain("ana@example.com");
  });
});

describe("sendSubmissionNotificationEmail", () => {
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

    await sendSubmissionNotificationEmail({
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
    expect(body.html).toContain("Ana Pérez");
    expect(body.text).toContain("Ana Pérez");
  });

  it("throws when Resend answers with a non-2xx status", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendSubmissionNotificationEmail({
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
      sendSubmissionNotificationEmail({
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "photographer@example.com",
        ...PARAMS,
      }),
    ).rejects.toThrow(/network unreachable/);
  });
});

describe("submission email — volume tiers (task #231)", () => {
  // 13 included + 3 extras on the scale: every extra pays the 3-4 tier's 13.000.
  const TIERED_QUOTA = computeQuota(16, 0, {
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 15_000,
    extraPhotoPriceTiersSnapshot: [
      { minExtras: 1, priceCop: 15_000 },
      { minExtras: 3, priceCop: 13_000 },
    ],
    originalPhotoPriceCopSnapshot: 2_000,
  });

  it("states the reached tier's unit price, never the flat snapshot, in both bodies", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      const body = render({ ...PARAMS, quota: TIERED_QUOTA }).replace(/\s+/g, " ");
      expect(body).toContain("Extras: 3 × $ 13.000 = $ 39.000");
      expect(body).not.toContain("$ 15.000");
    }
  });

  it("a flat-price gallery's email line is unchanged", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      expect(render(PARAMS).replace(/\s+/g, " ")).toContain("Extras: 2 × $ 5.000 = $ 10.000");
    }
  });
});

describe("submission email — originals alongside tiered extras", () => {
  // 13 included, 16 edited -> 3 extras at the 3+ tier (13.000 = 39.000),
  // plus 2 originals at 2.000 = 4.000. Total 43.000.
  const MIXED = computeQuota(16, 2, {
    includedPhotosSnapshot: 13,
    extraPhotoPriceCopSnapshot: 15_000,
    extraPhotoPriceTiersSnapshot: [
      { minExtras: 1, priceCop: 15_000 },
      { minExtras: 3, priceCop: 13_000 },
    ],
    originalPhotoPriceCopSnapshot: 2_000,
  });

  it("keeps the extras line to extras only and adds the originals line and the total", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      const body = render({ ...PARAMS, quota: MIXED }).replace(/\s+/g, " ");
      expect(body).toContain("Extras: 3 × $ 13.000 = $ 39.000");
      expect(body).not.toContain("= $ 43.000</li>");
      expect(body).not.toMatch(/Extras: 3 × \$ 13\.000 = \$ 43\.000/);
      expect(body).toContain("Originales: 2 × $ 2.000 = $ 4.000");
      expect(body).toContain("Total: $ 43.000");
    }
  });

  it("a gallery without originals gets no originals or total line", () => {
    for (const render of [submissionNotificationEmailHtml, submissionNotificationEmailText]) {
      const body = render(PARAMS);
      expect(body).not.toContain("Originales");
      expect(body).not.toContain("Total:");
    }
  });
});
