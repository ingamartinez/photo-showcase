import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { CollectionGrid } from "@/components/collection-grid";
import { getCollections } from "@/lib/portfolio";

export const metadata: Metadata = {
  title: "Trabajo",
  description:
    "Colecciones de fotografía: cosplay, eventos, retrato, boudoir y editorial de fantasía en Medellín.",
};

export default async function WorkIndex() {
  const collections = await getCollections();

  return (
    <>
      <PageHeader
        eyebrow="Portafolio"
        title="El trabajo, por temática"
        lead="Cada colección es un mundo distinto — del bosque de Arrayanes a la convención. Elegí una para entrar."
      />
      <section className="wrap pb-[clamp(72px,12vh,140px)]">
        <CollectionGrid collections={collections} />
      </section>
    </>
  );
}
