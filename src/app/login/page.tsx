import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Ingresar",
  description: "Acceso privado a tu galería.",
  // Private entrance — never indexed, never followed.
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <>
      <PageHeader
        eyebrow="Acceso privado"
        title="Ingresá a tu galería."
        lead="Escribí el correo con el que reservaste la sesión. Te enviamos un enlace de acceso — sin contraseñas."
      />
      <section className="wrap max-w-[440px] pb-[clamp(64px,10vh,120px)]">
        <LoginForm />
      </section>
    </>
  );
}
