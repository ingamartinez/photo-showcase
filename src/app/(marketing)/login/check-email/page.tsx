import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { CHECK_EMAIL_HEADER, CheckEmailNotice } from "@/components/check-email-notice";

export const metadata: Metadata = {
  title: "Revisá tu correo",
  description: "Te enviamos un enlace de acceso.",
  // Same private entrance as /login — never indexed, never followed.
  robots: { index: false, follow: false },
};

// Target of `pages.verifyRequest` in src/auth.ts. The form on /login uses
// `redirect: false` and renders this same notice inline, so nobody reaches this
// page in the normal flow — but Auth.js redirects here for any signin request
// that does not go through the server action (a direct POST to
// /api/auth/signin/resend, for instance), and a configured page that 404s is
// exactly the bug that made /login itself critical.
export default function CheckEmailPage() {
  return (
    <>
      <PageHeader {...CHECK_EMAIL_HEADER} />
      <section className="wrap max-w-[440px] pb-[clamp(64px,10vh,120px)]">
        <CheckEmailNotice />
      </section>
    </>
  );
}
