// Server-only environment contract.
//
// Validation is LAZY and per-group on purpose: the public portfolio must keep
// building and running with none of these set. A group is validated the first
// time something actually needs it, then cached — so a missing variable fails
// loudly at the feature that needs it, not at import time across the app.
//
// Never import this from a client component: it would leak secrets into the
// browser bundle.

import { z } from "zod";

const r2Schema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
});

const resendSchema = z.object({
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.email(),
});

const authSchema = z.object({
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 chars"),
  AUTH_URL: z.url(),
});

function parse<T extends z.ZodType>(group: string, schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Missing or invalid ${group} environment variables:\n${details}\n` +
        `See .env.example for the full contract.`,
    );
  }
  return result.data;
}

function once<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}

/** R2 credentials plus the derived S3-compatible endpoint. */
export const r2Env = once(() => {
  const env = parse("R2", r2Schema);
  return {
    ...env,
    R2_ENDPOINT: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  };
});

/** Resend credentials for transactional email. */
export const resendEnv = once(() => parse("Resend", resendSchema));

/** NextAuth secret and public origin. */
export const authEnv = once(() => parse("Auth", authSchema));
