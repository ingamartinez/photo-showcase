// The tuteo guard (Q8, task #262). The client UI must never drift back to
// voseo: "Toca", "puedes", "escríbele", "Tú". This reads the shipped client
// files (not the tests, not `design/`) and fails on the voseo forms. Comments
// are stripped first so the historical discussion in a header comment cannot
// trip a rule about COPY.
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

// Voseo imperatives/pronouns that must not reach the client. "escribile" (no
// accent) is the voseo form; the tuteo form is "escríbele".
const VOSEO = /\b(podés|tocá|escribile|enviás|querés|tenés|Vos)\b/;

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
