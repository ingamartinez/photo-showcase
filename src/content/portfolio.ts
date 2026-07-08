// Portfolio content manifest — the editable source of truth for the public work.
//
// Phase 1 has no admin UI yet, so this file is how you publish: edit it, run
// `bun db:seed`, deploy. In Phase 2 the admin UI will write to the same tables,
// so nothing here is throwaway. Images live in /public/portfolio/{slug}/.
//
// Every item needs real intrinsic width/height so next/image reserves space and
// avoids layout shift. Get them from the exported file (e.g. `sips -g pixelWidth
// -g pixelHeight photo.jpg` on macOS).
//
// NOTE: the current images are web-preview crops from Instagram, placed to build
// out the layout. Swap them for proper high-res exports (model-release cleared)
// when ready — keep the same file names and the site updates on re-seed.

export type PortfolioItemInput = {
  /** File under /public/portfolio/{collection.slug}/ — e.g. "01.jpg". */
  file: string;
  /** Alt text: describe the photo. Required for a11y + SEO. */
  alt: string;
  /** Optional visible caption. */
  title?: string;
  width: number;
  height: number;
  /** Show in the home-page featured selection. */
  featured?: boolean;
};

export type PortfolioCollectionInput = {
  /** URL segment: /work/{slug}. Lowercase, stable. */
  slug: string;
  title: string;
  description?: string;
  /** File name (within this collection's folder) to use as the index cover. */
  cover?: string;
  items: PortfolioItemInput[];
};

export const collections: PortfolioCollectionInput[] = [
  {
    slug: "brujas",
    title: "Brujas",
    description: "Editorial de fantasía en el bosque de Arrayanes.",
    cover: "01.jpg",
    items: [
      {
        file: "01.jpg",
        alt: "Dos cosplayers como brujas en el bosque con un libro antiguo",
        title: "Sanadoras",
        width: 640,
        height: 853,
        featured: true,
      },
      {
        file: "02.jpg",
        alt: "Modelo con vestido blanco translúcido sentada en el bosque al anochecer",
        title: "@sal0rito",
        width: 640,
        height: 853,
      },
      {
        file: "03.jpg",
        alt: "Modelo con vestido blanco translúcido en el bosque, luz cálida",
        title: "@sal0rito",
        width: 640,
        height: 853,
        featured: true,
      },
      {
        file: "04.jpg",
        alt: "Modelo reclinada en un claro soleado del bosque",
        title: "Claro",
        width: 640,
        height: 427,
      },
    ],
  },
  {
    slug: "cosplay",
    title: "Cosplay",
    description: "Retrato de personaje, del set a la convención.",
    cover: "01.jpg",
    items: [
      {
        file: "01.jpg",
        alt: "Cosplay de Supergirl con luz mágica de fondo",
        title: "Supergirl",
        width: 640,
        height: 853,
        featured: true,
      },
      {
        file: "02.jpg",
        alt: "Cosplay de maid con moño de lunares rojos",
        title: "@pinky_pie_.exe",
        width: 640,
        height: 853,
      },
    ],
  },
  {
    slug: "eventos",
    title: "Eventos",
    description: "Cobertura de convenciones y cosplay en vivo.",
    cover: "01.jpg",
    items: [
      {
        file: "01.jpg",
        alt: "Cosplay en convención con abanicos azules",
        title: "@brissitaaaaaa",
        width: 640,
        height: 853,
        featured: true,
      },
      {
        file: "02.jpg",
        alt: "Cosplay con maquillaje teatral y peluche en un evento nocturno",
        title: "@nyejorii",
        width: 640,
        height: 853,
      },
    ],
  },
  {
    slug: "retrato",
    title: "Retrato",
    description: "Retrato natural — luz, presencia y hora dorada.",
    cover: "01.jpg",
    items: [
      {
        file: "01.jpg",
        alt: "Retrato en hora dorada con vestido floral",
        title: "Hora dorada",
        width: 640,
        height: 853,
        featured: true,
      },
    ],
  },
  {
    slug: "boudoir",
    title: "Boudoir",
    description: "Editorial íntimo, luz de autor.",
    cover: "01.jpg",
    items: [
      {
        file: "01.jpg",
        alt: "Retrato editorial con luz roja sobre una roca de noche",
        title: "Luz roja",
        width: 640,
        height: 853,
      },
    ],
  },
];
