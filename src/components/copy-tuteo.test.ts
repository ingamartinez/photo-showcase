// The tuteo guard (Q8, task #262; the ADMIN half is task #263). The UI must
// never drift back to voseo: "Toca", "puedes", "escríbele", "Tú", "Avisale",
// "agregá", "seleccioná", "entregás", "Esperá", "Intentá". This reads the
// shipped files (not the tests, not `design/`) and fails on the voseo forms.
// Comments are stripped first so the historical discussion in a header comment
// cannot trip a rule about COPY.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CLIENT_FILES = [
  "src/components/proof-grid.tsx",
  "src/components/proof-tile.tsx",
  "src/components/proof-lightbox.tsx",
  "src/components/selection-tray.tsx",
  "src/components/submit-selection-panel.tsx",
  "src/components/client-preview-banner.tsx",
  "src/components/acting-client-select.tsx",
  "src/components/use-shared-selection.ts",
  "src/lib/selection-snapshot.ts",
  "src/app/galleries/[publicSlug]/page.tsx",
];

// Epic #250 (task #263) — the DASHBOARD is user-facing Spanish too, and it had
// drifted to voseo in seven places ("Avisale") plus five more in the slices
// this one touches. Same rule, same regex; these are the files that render the
// admin's copy. `routes`/`api` are deliberately absent: they are JSON, not UI.
const ADMIN_FILES = [
  "src/lib/client-selection-state.ts",
  "src/lib/galleries.ts",
  "src/components/gallery-client-selection.tsx",
  "src/components/selected-photos-list.tsx",
  "src/components/rolling-delivery-control.tsx",
  "src/app/dashboard/galleries/[galleryId]/page.tsx",
  "src/app/dashboard/galleries/actions.ts",
];

// Voseo imperatives/pronouns that must not reach the client. "escribile" (no
// accent) is the voseo form; the tuteo form is "escríbele".
//
// UNICODE-AWARE BOUNDARIES, NOT `\b`, AND CASE-INSENSITIVE. Both matter and
// both were review findings (task #262, finding 2):
//   - `\b` without the `u` flag is an ASCII boundary, so a trailing `\b`
//     after `tocá` (which ends in a non-word character) can never match a
//     following space or punctuation. The `tocá` alternative was dead code.
//   - a case-sensitive list misses exactly the strings most likely to drift
//     back in: the mock's own sentence-initial "Tocá una foto…"
//     (client.html:714) and "¿Enviás estas 3?" (:844).
const VOSEO =
  /(?<!\p{L})(podés|tocá|escribile|enviás|querés|tenés|vos|sacala|arrepentís|elegí|mirá|avisale|agregá|seleccioná|copiala|considerá|entregás|esperá|intentá)(?!\p{L})/iu;

/** Removes `//` line comments and `/* … *\/` block comments, leaving string
 * literals untouched enough for this purpose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("client copy is tuteo, never voseo", () => {
  it.each(CLIENT_FILES)("%s", (file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    const match = source.match(VOSEO);
    expect(match?.[0] ?? null).toBeNull();
  });

  // A guard that cannot fail on its headline case is not a guard. These
  // self-tests pin the ABILITY to fail, independently of the shipped copy —
  // if a future edit weakens `VOSEO` again (an ASCII `\b`, a dropped `i`
  // flag), this goes RED even while every client file is clean.
  it("is able to fail: it matches the mock's own voseo sentences, in any case", () => {
    expect("Tocá una foto para verla grande".match(VOSEO)?.[0]).toBe("Tocá");
    expect("¿Enviás estas 3?".match(VOSEO)?.[0]).toBe("Enviás");
    expect("Podés sacarla cuando quieras".match(VOSEO)?.[0]).toBe("Podés");
    expect("escribile a tu fotógrafo".match(VOSEO)?.[0]).toBe("escribile");
    expect("si te arrepentís, sacala".match(VOSEO)?.[0]).toBe("arrepentís");
    expect("Vos eliges".match(VOSEO)?.[0]).toBe("Vos");

    // The admin forms task #263 converted (each was really in the dashboard
    // before that slice: "Avisale" in seven server actions, "agregá" in the
    // active-client rule, "seleccioná … copiala" in the copy-error message,
    // "Considerá" in the archive-size warning, "entregás" in the rolling
    // control).
    expect("Avisale por otro medio".match(VOSEO)?.[0]).toBe("Avisale");
    expect("agregá otro cliente".match(VOSEO)?.[0]).toBe("agregá");
    expect("seleccioná la lista y copiala a mano".match(VOSEO)?.[0]).toBe("seleccioná");
    expect("copiala a mano".match(VOSEO)?.[0]).toBe("copiala");
    expect("Considerá exports más livianos".match(VOSEO)?.[0]).toBe("Considerá");
    expect("cuando entregás toda la galería".match(VOSEO)?.[0]).toBe("entregás");
    // The two forms that survived the first round of this guard (task #263,
    // finding W3): the resend throttle said "Esperá unos minutos…" and the
    // send-failure said "Intentá de nuevo en un rato.", both in `actions.ts`,
    // a file this guard already listed — so the guard was green on copy it
    // did not actually protect.
    expect("Esperá unos minutos antes de volver a intentar".match(VOSEO)?.[0]).toBe("Esperá");
    expect("Intentá de nuevo en un rato".match(VOSEO)?.[0]).toBe("Intentá");

    // And it does not fire on the tuteo forms it exists to protect.
    expect("Toca una foto para verla grande".match(VOSEO)).toBeNull();
    expect("puedes sacarla".match(VOSEO)).toBeNull();
    expect("escríbele a tu fotógrafo".match(VOSEO)).toBeNull();
    expect("Avísale por otro medio".match(VOSEO)).toBeNull();
    expect("agrega otro cliente".match(VOSEO)).toBeNull();
    expect("selecciona la lista y cópiala a mano".match(VOSEO)).toBeNull();
    expect("Considera exports más livianos".match(VOSEO)).toBeNull();
    expect("cuando entregas toda la galería".match(VOSEO)).toBeNull();
    expect("Espera unos minutos antes de volver a intentar".match(VOSEO)).toBeNull();
    expect("Intenta de nuevo en un rato".match(VOSEO)).toBeNull();
    // Regional "acá" is not voseo.
    expect("las que elijan van a aparecer acá".match(VOSEO)).toBeNull();
  });

  it.each(ADMIN_FILES)("admin: %s", (file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    expect(source.match(VOSEO)?.[0] ?? null).toBeNull();
  });

  it("keeps the approved tuteo strings in place", () => {
    const snapshot = readFileSync("src/lib/selection-snapshot.ts", "utf8");
    expect(snapshot).toContain('return "Tú";');

    const lede = readFileSync("src/components/proof-grid.tsx", "utf8");
    expect(lede).toContain("Toca una foto para verla grande");
    expect(lede).toContain("Cada persona elige las suyas");

    const panel = readFileSync("src/components/submit-selection-panel.tsx", "utf8");
    expect(panel).toContain("Lo que envíes ya no lo puedes sacar tú");
    expect(panel).toContain("escríbele a tu fotógrafo");
  });
});
