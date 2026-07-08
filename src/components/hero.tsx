import Image from "next/image";
import Link from "next/link";

export function Hero() {
  return (
    <section className="relative flex min-h-[100svh] items-end">
      <div className="absolute inset-0 z-0">
        <Image
          src="/portfolio/brujas/hero.jpg"
          alt="Dos modelos vestidas de blanco en un bosque al anochecer — serie Brujas"
          fill
          priority
          sizes="100vw"
          className="object-cover [object-position:center_35%]"
        />
        <div className="hero-scrim absolute inset-0" />
      </div>

      <div className="wrap relative z-10 w-full pb-[clamp(48px,9vh,104px)]">
        <span className="label text-accent mb-6 block">Cosplay · Eventos · Retrato — Medellín</span>
        <h1 className="max-w-[15ch] font-serif text-[clamp(44px,8vw,108px)] leading-[0.98] font-normal tracking-[-0.015em] text-balance">
          Fotografía con <em className="text-accent-2">alma de cine</em>.
        </h1>
        <p className="text-fg-dim mt-7 max-w-[46ch] text-[clamp(15px,1.6vw,18px)] leading-relaxed">
          Retrato de personaje, editorial y cobertura de eventos. Cada sesión es una escena: luz
          intencional, dirección y silencio para que el personaje respire.
        </p>
        <div className="mt-9 flex flex-wrap gap-4">
          <Link
            href="/#work"
            className="bg-accent hover:bg-accent-2 inline-flex items-center rounded-sm px-[26px] py-[14px] text-[13px] font-semibold tracking-[0.1em] text-[#14100a] uppercase transition-all duration-300 hover:-translate-y-0.5"
          >
            Ver el trabajo
          </Link>
          <Link
            href="/contact"
            className="border-line-2 text-fg hover:border-accent hover:text-accent-2 inline-flex items-center rounded-sm border px-[26px] py-[14px] text-[13px] tracking-[0.1em] uppercase transition-colors duration-300"
          >
            Reservar sesión
          </Link>
        </div>
      </div>
    </section>
  );
}
