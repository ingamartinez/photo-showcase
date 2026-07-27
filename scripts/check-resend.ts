// Resend connectivity check — run after adding the API key and verifying the
// sending domain:
//   bun run check:resend                 # key + domain verification status
//   bun run check:resend you@example.com # also sends a real test email
//
// Magic-link auth is only as reliable as email delivery: if the domain is not
// verified, logins silently never arrive. This check makes that state visible
// before it becomes a client-facing bug.
//
// Plain fetch against the Resend REST API — no SDK dependency needed here.

import { resendEnv } from "../src/lib/env";

const API = "https://api.resend.com";

type Domain = { name: string; status: string };

async function resendFetch<T>(path: string, apiKey: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String((body as { message: unknown }).message)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

// Best-effort: a correctly scoped production key has "Sending access" only and
// cannot list domains. That restriction is desirable, so this check reports the
// domain status when the key allows it and stays quiet when it does not — the
// send below is the real proof either way.
async function reportDomainStatus(apiKey: string, senderDomain: string): Promise<void> {
  let domains: Domain[];
  try {
    ({ data: domains } = await resendFetch<{ data: Domain[] }>("/domains", apiKey));
  } catch {
    console.log("domain   skipped  (send-only key cannot list domains — expected)");
    return;
  }

  const domain = domains.find((d) => d.name === senderDomain);
  if (!domain) {
    throw new Error(
      `Domain "${senderDomain}" is not registered in Resend. ` +
        `Add it under Domains, then load the DNS records in Cloudflare (proxy OFF).`,
    );
  }
  if (domain.status !== "verified") {
    throw new Error(
      `Domain "${senderDomain}" status is "${domain.status}", expected "verified". ` +
        `Check the SPF/DKIM/MX records in Cloudflare — they must be DNS only, not proxied.`,
    );
  }
  console.log(`domain   ok  (${senderDomain} verified)`);
}

async function main(): Promise<void> {
  const env = resendEnv();
  const recipient = process.argv[2];

  console.log(`from:     ${env.EMAIL_FROM}`);

  await reportDomainStatus(env.RESEND_API_KEY, env.EMAIL_FROM.split("@")[1]);

  if (!recipient) {
    console.log(
      "\nNothing was actually sent. Delivery is the only meaningful check here:\n" +
        "  bun run check:resend you@example.com",
    );
    return;
  }

  const { id } = await resendFetch<{ id: string }>("/emails", env.RESEND_API_KEY, {
    method: "POST",
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: recipient,
      subject: "Alejo Frames — Resend test",
      text: "If you are reading this, transactional email works. Nothing else to do.",
    }),
  });
  console.log(`send     ok  (id ${id} -> ${recipient})`);

  console.log("\nResend is correctly configured.");
}

main().catch((error: unknown) => {
  console.error(`\nResend check FAILED\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
