import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendResendEmail } from "./email-transport";

class TestWrappedError extends Error {
  cause?: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.cause = cause;
  }
}

describe("sendResendEmail", () => {
  const fetchMock = vi.fn();
  const wrapError = vi.fn(
    (message: string, cause: unknown) => new TestWrappedError(message, cause),
  );

  beforeEach(() => {
    fetchMock.mockReset();
    wrapError.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the exact from/to/subject/html/text payload to the Resend endpoint", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));

    await sendResendEmail(
      {
        apiKey: "re_test_key",
        from: "no-reply@alejoframes.com",
        to: "ana@example.com",
        subject: "Asunto de prueba",
        html: "<p>hola</p>",
        text: "hola",
      },
      wrapError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "no-reply@alejoframes.com",
      to: "ana@example.com",
      subject: "Asunto de prueba",
      html: "<p>hola</p>",
      text: "hola",
    });
    expect(wrapError).not.toHaveBeenCalled();
  });

  // The load-bearing assertion: a non-2xx response must go through the
  // CALLER's own wrapError, not some hardcoded error type, so that each
  // caller can keep throwing the exact type its own downstream code expects
  // (e.g. AuthError for the Auth.js provider callers).
  it("calls wrapError with the status and body, and throws its return value, on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));

    await expect(
      sendResendEmail(
        {
          apiKey: "re_test_key",
          from: "no-reply@alejoframes.com",
          to: "ana@example.com",
          subject: "Asunto",
          html: "<p>hola</p>",
          text: "hola",
        },
        wrapError,
      ),
    ).rejects.toBeInstanceOf(TestWrappedError);

    expect(wrapError).toHaveBeenCalledTimes(1);
    const [message] = wrapError.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/429/);
    expect(message).toMatch(/rate limited/);
  });

  it("calls wrapError with the original error as cause when the fetch itself rejects", async () => {
    const networkError = new TypeError("network unreachable");
    fetchMock.mockRejectedValue(networkError);

    await expect(
      sendResendEmail(
        {
          apiKey: "re_test_key",
          from: "no-reply@alejoframes.com",
          to: "ana@example.com",
          subject: "Asunto",
          html: "<p>hola</p>",
          text: "hola",
        },
        wrapError,
      ),
    ).rejects.toBeInstanceOf(TestWrappedError);

    expect(wrapError).toHaveBeenCalledTimes(1);
    const [message, cause] = wrapError.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/network unreachable/);
    expect(cause).toBe(networkError);
  });
});
