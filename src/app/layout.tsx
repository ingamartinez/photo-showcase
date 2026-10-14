import type { Metadata } from "next";
import { Archivo, Bodoni_Moda, Sometype_Mono } from "next/font/google";
import "./globals.css";

// True root layout: fonts, the `<html>`/`<body>` shell, and nothing that
// belongs to one product surface but not the other. `SiteHeader`/`SiteFooter`
// used to live here, which meant `/dashboard` inherited the marketing chrome
// by construction — every route under this file shares it, full stop.
//
// The marketing chrome now lives in `(marketing)/layout.tsx` and the
// dashboard chrome in `dashboard/layout.tsx`. Two different nested layouts,
// not two Next.js *root* layouts (which would each need their own `<html>`/
// `<body>` — see Next's "multiple root layouts" pattern): this app is one
// site behind one domain, so duplicating the document shell would only cost
// a second place for the font/meta setup below to drift. `(marketing)` is a
// real Next.js route group — parentheses, no URL segment — because `/`,
// `/about`, `/contact`, `/work*` and `/login*` are otherwise unrelated
// top-level paths that need to share one layout without a common URL prefix.
// `dashboard/` deliberately is NOT a route group: `/dashboard` already IS
// the URL prefix every guarded page lives under, so a plain segment layout
// gives the same shared-layout scoping with no parentheses needed.

// Display face — high-contrast serif with optical sizing. The `font-serif`
// role in globals.css points here.
const display = Bodoni_Moda({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
  display: "swap",
});

// UI workhorse. The `font-sans` role in globals.css points here.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

// Data / measurement / code ONLY — numbers, quota, dimensions. Never a
// decorative "technical" costume (see the mono rule in globals.css).
const sometypeMono = Sometype_Mono({
  variable: "--font-sometype-mono",
  subsets: ["latin"],
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
      className={`${display.variable} ${archivo.variable} ${sometypeMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        {/* Mark JS available before paint so reveal styles apply without a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "document.documentElement.classList.add('js')",
          }}
        />
        {children}
      </body>
    </html>
  );
}
