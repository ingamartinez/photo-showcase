import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "Reservar",
  description:
    "Reservá una sesión de fotografía en Medellín — cosplay, eventos, retrato y boudoir. Paquetes y contacto directo.",
};

const PACKAGES: {
  name: string;
  price: string;
  duration: string;
  edits: string;
}[] = [
  { name: "Básico", price: "$60.000", duration: "1 hora", edits: "7 fotos editadas" },
  { name: "Estándar", price: "$100.000", duration: "1.5 – 2 horas", edits: "13 fotos editadas" },
  { name: "Premium", price: "$180.000", duration: "2 – 3 horas", edits: "20 fotos editadas" },
];

export default function ContactPage() {
  return (
    <>
      <PageHeader
        eyebrow="Reservar"
        title="Armemos la escena."
        lead="Contame tu idea, la fecha tentativa y el personaje o concepto. Respondo rápido por Instagram — desde ahí coordinamos todo."
      />

      <section className="wrap grid grid-cols-1 gap-[clamp(40px,7vw,96px)] pb-[clamp(64px,10vh,120px)] md:grid-cols-[1fr_1.1fr]">
        {/* Contact methods */}
        <div className="flex flex-col gap-4" data-reveal>
          <a
            href="https://instagram.com/alejo_frames"
            target="_blank"
            rel="noopener noreferrer"
            className="group border-line-2 hover:border-accent flex items-center justify-between rounded-sm border p-6 transition-colors"
          >
            <div>
              <span className="label text-fg-mute">Instagram — respuesta rápida</span>
              <p className="mt-1 font-serif text-2xl">@alejo_frames</p>
            </div>
            <span className="text-fg-dim group-hover:text-accent-2 transition-colors">→</span>
          </a>

          <div className="border-line rounded-sm border p-6">
            <span className="label text-fg-mute">Ubicación</span>
            <p className="mt-1 font-serif text-2xl">Medellín, Colombia</p>
            <p className="text-fg-dim mt-2 text-sm">
              Sesiones en estudio, locación y cobertura de convenciones.
            </p>
          </div>
        </div>

        {/* Packages */}
        <div data-reveal>
          <span className="label text-accent mb-6 block">Paquetes de sesión</span>
          <div className="divide-line border-line flex flex-col divide-y border-y">
            {PACKAGES.map((p) => (
              <div key={p.name} className="flex items-baseline justify-between gap-4 py-5">
                <div>
                  <h2 className="font-serif text-2xl font-normal">{p.name}</h2>
                  <p className="text-fg-dim mt-1 text-sm">
                    {p.duration} · {p.edits}
                  </p>
                </div>
                <span className="text-fg font-mono text-lg tracking-tight tabular-nums">
                  {p.price}
                  <span className="text-fg-mute ml-1 text-xs">COP</span>
                </span>
              </div>
            ))}
          </div>
          <p className="text-fg-dim mt-5 text-sm leading-relaxed">
            Foto extra editada: $5.000 COP. Los valores son referenciales — el paquete final depende
            del concepto, la locación y el número de personajes. Escribime y lo ajustamos.
          </p>
        </div>
      </section>
    </>
  );
}
