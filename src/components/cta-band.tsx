import Link from "next/link";

export function CtaBand() {
  return (
    <section id="contacto" className="wrap py-[clamp(72px,12vh,140px)] text-center">
      <div data-reveal>
        <span className="label text-accent mb-[22px] block">Agenda 2025 abierta</span>
        <h2 className="font-serif text-[clamp(34px,6vw,76px)] leading-[1.02] font-normal tracking-[-0.015em] text-balance">
          Pongamos tu personaje
          <br />
          frente a la cámara.
        </h2>
        <p className="text-fg-dim mx-auto mt-[22px] max-w-[44ch]">
          Paquetes desde $15.000 COP. Contame tu idea, la fecha y el personaje — armamos la escena
          juntos.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-4">
          <a
            href="https://instagram.com/alejo_frames"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-accent hover:bg-accent-2 inline-flex items-center rounded-sm px-[26px] py-[14px] text-[13px] font-semibold tracking-[0.1em] text-[#14100a] uppercase transition-all duration-300 hover:-translate-y-0.5"
          >
            Escribir por Instagram
          </a>
          <Link
            href="/contact"
            className="border-line-2 text-fg hover:border-accent hover:text-accent-2 inline-flex items-center rounded-sm border px-[26px] py-[14px] text-[13px] tracking-[0.1em] uppercase transition-colors duration-300"
          >
            Ver paquetes
          </Link>
        </div>
      </div>
    </section>
  );
}
