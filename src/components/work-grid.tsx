import Image from "next/image";
import Link from "next/link";
import type { ItemWithCollection } from "@/lib/portfolio";

export function WorkGrid({ items }: { items: ItemWithCollection[] }) {
  return (
    <div className="work" data-reveal>
      {items.map((item) => (
        <figure key={item.id}>
          <Link href={`/work/${item.collection.slug}`}>
            <Image
              src={item.imageKey}
              alt={item.alt}
              width={item.width}
              height={item.height}
              sizes="(max-width: 560px) 100vw, (max-width: 900px) 50vw, 33vw"
            />
            <figcaption>
              <span className="text-fg">{item.collection.title}</span>
              {item.title && <span className="text-accent"> · {item.title}</span>}
            </figcaption>
          </Link>
        </figure>
      ))}
    </div>
  );
}
