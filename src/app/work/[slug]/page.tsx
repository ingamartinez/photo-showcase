import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { CollectionGallery } from "@/components/collection-gallery";
import { getCollectionBySlug } from "@/lib/portfolio";

// Rendered per-request on the droplet against its local Postgres. The build
// runs in CI (no prod DB), so prerendering would bake CI's empty DB into the
// pages — dynamic rendering keeps content live and lets a re-seed publish
// without a redeploy.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const collection = await getCollectionBySlug(slug);
  if (!collection) return { title: "Colección no encontrada" };
  return {
    title: collection.title,
    description: collection.description ?? undefined,
  };
}

export default async function CollectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const collection = await getCollectionBySlug(slug);
  if (!collection) notFound();

  return (
    <>
      <PageHeader
        eyebrow="Colección"
        title={collection.title}
        lead={collection.description ?? undefined}
      />
      <section className="wrap pb-[clamp(72px,12vh,140px)]">
        <Link
          href="/work"
          className="label text-fg-dim hover:text-accent-2 mb-10 inline-block transition-colors"
        >
          ← Todas las colecciones
        </Link>
        <CollectionGallery items={collection.items} />
      </section>
    </>
  );
}
