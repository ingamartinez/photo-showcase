import Link from "next/link";

const COLUMNS: { heading: string; links: { href: string; label: string; external?: boolean }[] }[] =
  [
    {
      heading: "Explorar",
      links: [
        { href: "/#work", label: "Trabajo" },
        { href: "/#colecciones", label: "Colecciones" },
        { href: "/about", label: "El estudio" },
      ],
    },
    {
      heading: "Servicios",
      links: [
        { href: "/work/cosplay", label: "Cosplay" },
        { href: "/work/eventos", label: "Eventos" },
        { href: "/work/boudoir", label: "Retrato · Boudoir" },
      ],
    },
    {
      heading: "Contacto",
      links: [
        { href: "https://instagram.com/alejo_frames", label: "@alejo_frames", external: true },
        { href: "/contact", label: "Reservar sesión" },
      ],
    },
  ];

export function SiteFooter() {
  return (
    <footer className="border-line mt-auto border-t pt-16 pb-10">
      <div className="wrap">
        <div className="flex flex-wrap items-start justify-between gap-10">
          <div>
            <Link href="/" className="font-serif text-[28px]">
              <span className="font-normal">Alejo</span> <span className="text-accent">Frames</span>
            </Link>
            <p className="text-fg-dim mt-3.5 max-w-[30ch] text-sm">
              Fotografía de cosplay, eventos y retrato. Medellín, Colombia.
            </p>
          </div>
          <div className="flex flex-wrap gap-[clamp(40px,8vw,96px)]">
            {COLUMNS.map((col) => (
              <div key={col.heading}>
                <h4 className="label text-fg-mute mb-4">{col.heading}</h4>
                {col.links.map((link) =>
                  link.external ? (
                    <a
                      key={link.label}
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-fg-dim hover:text-accent-2 block py-[5px] text-sm transition-colors"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      key={link.label}
                      href={link.href}
                      className="text-fg-dim hover:text-accent-2 block py-[5px] text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="border-line text-fg-mute mt-14 flex flex-wrap justify-between gap-4 border-t pt-[22px] font-mono text-[11px] tracking-[0.06em]">
          <span>© 2025 Alejo Frames — Medellín</span>
          <span>Cosplay · Event · Photography</span>
        </div>
      </div>
    </footer>
  );
}
