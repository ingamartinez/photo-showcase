import { Hero } from "@/components/hero";
import { SectionHead } from "@/components/section-head";
import { CollectionGrid } from "@/components/collection-grid";
import { WorkGrid } from "@/components/work-grid";
import { EthosStrip } from "@/components/ethos-strip";
import { CtaBand } from "@/components/cta-band";
import { getCollections, getFeaturedItems } from "@/lib/portfolio";

// Rendered per-request on the droplet against its local Postgres (the build
// runs in CI without the prod DB). See work/[slug]/page.tsx.
export const dynamic = "force-dynamic";

export default async function Home() {
  const [collections, featured] = await Promise.all([getCollections(), getFeaturedItems(8)]);

  return (
    <>
      <Hero />

      <section id="colecciones" className="wrap py-[clamp(72px,12vh,140px)]">
        <SectionHead title="Colecciones" linkHref="/work" linkLabel="Ver todas" />
        <CollectionGrid collections={collections} />
      </section>

      <section id="work" className="wrap py-[clamp(72px,12vh,140px)]">
        <SectionHead title="Trabajo reciente" linkHref="/work" linkLabel="Portafolio completo" />
        <WorkGrid items={featured} />
      </section>

      <EthosStrip />
      <CtaBand />
    </>
  );
}
