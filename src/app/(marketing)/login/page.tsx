import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { getLoginErrorMessage } from "./auth-error";

export const metadata: Metadata = {
  title: "Ingresar",
  description: "Acceso privado a tu galería.",
  // Private entrance — never indexed, never followed.
  robots: { index: false, follow: false },
};

// Also the target of Auth.js's `pages.error` redirect (`/login?error=...`,
// see src/auth.ts) — an expired or already-used magic link, or any other
// signin failure, lands back here with an `error` code in the query string
// instead of a raw stack trace.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  const errorCode = Array.isArray(error) ? error[0] : error;

  return <LoginForm authErrorMessage={getLoginErrorMessage(errorCode)} />;
}
