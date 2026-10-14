// One step of a gallery's frozen extra-photo volume scale (task #231): from
// `minExtras` extras upward, EVERY extra costs `priceCop`. Mirrors
// `ExtraPriceTier` in src/lib/extra-price-tiers.ts.
import "server-only";

import type { ExtraPriceTier } from "@/lib/extra-price-tiers";
import { builder } from "../builder";

export const ExtraPriceTierType = builder.objectRef<ExtraPriceTier>("ExtraPriceTier").implement({
  fields: (t) => ({
    minExtras: t.exposeInt("minExtras"),
    priceCop: t.exposeInt("priceCop"),
  }),
});
