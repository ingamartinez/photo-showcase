import { Hero } from "@/components/hero";
import { SectionHead } from "@/components/section-head";
import { CollectionGrid } from "@/components/collection-grid";
import { WorkGrid } from "@/components/work-grid";
import { EthosStrip } from "@/components/ethos-strip";
import { CtaBand } from "@/components/cta-band";
import { getCollections, getFeaturedItems } from "@/lib/portfolio";

export default async function Home() {
  const [collections, featured] = await Promise.all([getCollections(), getFeaturedItems(8)]);

  return (
    <>
      <Hero />

      <section id="colecciones" className="wrap py-[clamp(72px,12vh,140px)]">
        <div data-reveal>
          <SectionHead
            kicker="Por temática"
            title="Colecciones"
            linkHref="/work"
            linkLabel="Ver todas"
          />
        </div>
        <CollectionGrid collections={collections} />
      </section>

      <section id="work" className="wrap py-[clamp(72px,12vh,140px)]">
        <div data-reveal>
          <SectionHead
            kicker="Selección"
            title="Trabajo reciente"
            linkHref="/work"
            linkLabel="Portafolio completo"
          />
        </div>
        <WorkGrid items={featured} />
      </section>

      <EthosStrip />
      <CtaBand />
    </>
  );
}
