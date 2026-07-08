import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = {
  title: "El estudio",
  description:
    "Alejo Frames — fotografía de cosplay, eventos, retrato y boudoir en Medellín. Cada sesión, una escena.",
};

const SERVICES: { title: string; body: string }[] = [
  {
    title: "Cosplay",
    body: "Retrato de personaje en set y locación. Luz y dirección para que el personaje —no el disfraz— sea el protagonista.",
  },
  {
    title: "Eventos",
    body: "Cobertura de convenciones y encuentros. Fotos ágiles en condiciones difíciles, sin perder el clima.",
  },
  {
    title: "Retrato & Boudoir",
    body: "Sesiones íntimas y editoriales. Un espacio seguro, sin apuro, para una imagen que se sienta tuya.",
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHeader
        eyebrow="El estudio"
        title="Fotografía tratada como cine."
        lead="Soy Alejo — fotógrafo en Medellín. Trabajo con cosplayers, modelos y parejas que quieren algo más que una foto: una escena."
      />

      <section className="wrap grid grid-cols-1 items-center gap-[clamp(32px,6vw,80px)] pb-[clamp(72px,12vh,140px)] md:grid-cols-2">
        <div className="relative aspect-[3/4] overflow-hidden rounded-sm" data-reveal>
          <Image
            src="/portfolio/brujas/03.jpg"
            alt="Modelo con vestido translúcido en el bosque, luz cálida"
            fill
            sizes="(max-width: 768px) 100vw, 50vw"
            className="object-cover"
          />
        </div>
        <div data-reveal>
          <p className="text-fg-dim text-[clamp(16px,1.7vw,19px)] leading-[1.7]">
            Creo en la luz intencional y el silencio en el set. Una foto puede documentar; a mí me
            interesa cuando además cuenta algo — una postura, una mirada sostenida, la penumbra
            justa.
          </p>
          <p className="text-fg-dim mt-5 text-[clamp(16px,1.7vw,19px)] leading-[1.7]">
            De ahí nació <em className="text-fg not-italic">Brujas</em>, mi serie editorial en el
            bosque de Arrayanes: sanadoras y sacerdotisas, fantasía tratada con la seriedad de un
            rodaje. Ese es el estándar para cada sesión, sea una convención o un retrato.
          </p>
          <blockquote className="border-accent mt-8 border-l-2 pl-5 font-serif text-[clamp(20px,2.4vw,28px)] leading-snug text-balance italic">
            «Nos llamaron brujas por hablar con los bosques.»
          </blockquote>
        </div>
      </section>

      <section className="border-line bg-bg-2 border-t">
        <div className="wrap py-[clamp(64px,10vh,120px)]">
          <span className="label text-fg-dim mb-12 block">Qué hago</span>
          <div className="grid grid-cols-1 gap-x-[clamp(32px,6vw,80px)] gap-y-12 sm:grid-cols-3">
            {SERVICES.map((s) => (
              <div key={s.title} data-reveal>
                <h2 className="font-serif text-[clamp(22px,2.6vw,32px)] font-normal">{s.title}</h2>
                <p className="text-fg-dim mt-3 leading-[1.65]">{s.body}</p>
              </div>
            ))}
          </div>
          <Link
            href="/contact"
            className="bg-accent hover:bg-accent-2 mt-14 inline-flex items-center rounded-sm px-[26px] py-[14px] text-[13px] font-semibold tracking-[0.1em] text-[#14100a] uppercase transition-all duration-300 hover:-translate-y-0.5"
          >
            Reservar una sesión
          </Link>
        </div>
      </section>
    </>
  );
}
