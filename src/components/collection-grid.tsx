import Image from "next/image";
import Link from "next/link";
import type { CollectionSummary } from "@/lib/portfolio";

function coverMeta(count: number): string {
  if (count <= 1) return "Serie";
  return `${count} fotos`;
}

export function CollectionGrid({ collections }: { collections: CollectionSummary[] }) {
  return (
    <div className="collections" data-reveal>
      {collections.map((c) => (
        <Link key={c.slug} href={`/work/${c.slug}`} className="col-tile">
          {c.coverImageKey && (
            <Image
              src={c.coverImageKey}
              alt={`Colección ${c.title}`}
              fill
              sizes="(max-width: 900px) 50vw, 33vw"
            />
          )}
          <div className="absolute bottom-[18px] left-5 z-[2]">
            <span className="label text-accent">{coverMeta(c.itemCount)}</span>
            <h3 className="font-serif text-[clamp(20px,2.2vw,30px)] font-normal">{c.title}</h3>
          </div>
        </Link>
      ))}
    </div>
  );
}
