import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { RevealInit } from "@/components/reveal-init";

// Body / UI face.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

// Small-caps captions, eyebrows, technical labels.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Editorial display face — high-contrast serif with optical sizing.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://alejoframes.com"),
  title: {
    default: "Alejo Frames — Fotografía de cosplay, eventos y retrato · Medellín",
    template: "%s · Alejo Frames",
  },
  description:
    "Fotografía de cosplay, eventos y retrato con alma de cine. Editorial de fantasía, cobertura de convenciones y retrato en Medellín, Colombia.",
  openGraph: {
    title: "Alejo Frames — Fotografía con alma de cine",
    description: "Cosplay, eventos y retrato en Medellín. Cada sesión, una escena.",
    locale: "es_CO",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        {/* Mark JS available before paint so reveal styles apply without a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js')",
          }}
        />
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
        <RevealInit />
      </body>
    </html>
  );
}
