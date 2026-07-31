// Task #81: statically enforces that any ops script bringing a write-capable
// src/lib/r2.ts export into scope also calls the shared APP_ENV guard — see
// scripts/lib/assert-app-env.ts's own header for the full "why" this guard
// exists and what it deliberately does NOT do.
//
// This is the "cannot miss it" half of task #81's acceptance criterion.
// scripts/lib/assert-app-env.ts's header comment says a script MUST call
// `assertAppEnvIsSet()`, but a comment is not an enforcement mechanism —
// that is the exact lesson task #78 (branding R2Key) applied one level
// down, to bare-string keys reaching `putObject`/`getPresignedUrl`/
// `deleteObject`. This test applies the same lesson one level up.
//
// REVIEW HISTORY, kept because it explains why this scans IMPORTS and not
// CALL SITES: the first version of this test scanned for a call-site
// pattern like `putObject(`. A review attacked it empirically rather than
// reasoning about it and found that `import { putObject as go } from
// "../src/lib/r2"` followed by calling only `go(...)` defeated the scan
// completely and silently — the file was never even flagged as touching R2,
// let alone missing the guard. A namespace import (`import * as r2 …`
// followed by `r2.putObject(...)`) happened to still match by luck (the
// regex matched the bare substring `putObject(` regardless of the `r2.`
// prefix), which is not something to rely on. This version fixes that by
// keying off what a file IMPORTS OR RE-EXPORTS, under any local name,
// instead of how it is later called — see `importedWriteCapableR2Exports`
// below and its own adversarial tests, which exercise every evasion listed
// above (and a few more) as actual test cases, not as reasoning.
//
// Deliberately STRUCTURAL, not an allowlist of exempt files: every *.ts file
// anywhere under scripts/ (skipping *.test.ts) is scanned. scripts/check-
// r2.ts is exempt for free, with no special-case entry needed: it never
// imports any of the five write-capable names — it builds its own throwaway
// `Bun.S3Client` and calls `.write()`/`.delete()` on THAT directly, plus
// `nonGalleryKey()` (a mint, not a write) — see its own header comment. So
// it never matches "imports a write-capable export" below and this test
// never requires anything of it. Its `_healthcheck/` key is harmless in
// either namespace anyway, which is the substantive reason it doesn't need
// the guard, not an accident of this test's scope.
//
// A future script that DOES import one of the five falls under the same
// rule automatically — nothing here needs updating when scripts/ grows.
// That is deliberately the opposite shape of an allowlist that has to be
// remembered: task #104 found exactly that failure mode in
// .github/workflows/deploy.yml's release-staging step (a per-file `cp`
// allowlist nobody updated for a new script) and the fix there was the same
// principle applied to file PRESENCE — cover the whole directory
// structurally instead of naming files one by one. See that step's own
// comment in deploy.yml.
//
// THE ONE GAP THIS DOES NOT CLOSE, stated precisely rather than implied:
// a re-export chain that routes through a module living under src/ (not
// scripts/) is invisible to this scan, because the scan only reads files
// under scripts/. A re-export chain that instead routes through ANOTHER
// file under scripts/ IS seen — this test walks the whole scripts/ tree,
// not just its top level — though it lands the requirement on the
// (wrong) file that does the re-exporting, not the file that ultimately
// calls the export. That is still a loud, visible test failure pointing at
// a real file, not a silent pass.
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPTS_DIR = join(__dirname);

/** src/lib/r2.ts exports that write, delete, or mint a real (gallery-shaped)
 * key — the ones task #81's card and #78's header both name as the silent-
 * misdirection risk. Deliberately excludes the read-only HEAD/stream trio
 * (`getObjectStream`, `getObjectSize`, `objectExists`) and the two named
 * escape hatches (`nonGalleryKey`, `storedKey`) — see src/lib/r2.ts's own
 * "Task #78 deliberately stops..." comment for why a wrong key reaching
 * those fails loud with no silent side effect, the same reasoning this list
 * inherits rather than re-litigates. */
const WRITE_CAPABLE_R2_EXPORTS = [
  "putObject",
  "deleteObject",
  "proofKey",
  "finalKey",
  "displayKey",
];

/** Matches an `import` or `export … from` declaration whose source is
 * src/lib/r2.ts, relative from anywhere under scripts/ (`../src/lib/r2`,
 * `../../src/lib/r2`, …). Captures either:
 *   - `*` or `* as someName` — a namespace import/re-export, which exposes
 *     every export the module has, write-capable or not, and
 *   - `{ … }` — a named import/re-export clause, possibly spanning several
 *     lines, possibly with `as` aliases and/or a `type` prefix on any
 *     individual specifier.
 * `[^}]*` (rather than `[\s\S]*?`) is deliberately used inside the braces:
 * it cannot itself contain a stray `}` from a LATER unrelated import, so a
 * malformed capture can't accidentally swallow the rest of the file. */
const R2_MODULE_IMPORT_RE =
  /(?:import|export)\s+(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s*["'](?:\.\.\/)+src\/lib\/r2["'];?/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The write-capable src/lib/r2.ts export names a file's import/re-export
 * declarations bring into scope — regardless of local alias, namespace
 * indirection, or whether the binding is ever actually called. See this
 * file's header for exactly what this can and cannot see. Exported for its
 * own adversarial unit tests below; not used outside this file. */
export function importedWriteCapableR2Exports(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const found = new Set<string>();

  for (const match of source.matchAll(R2_MODULE_IMPORT_RE)) {
    const clause = match[1].trim();

    if (clause.startsWith("*")) {
      // `import * as x from "…/r2"` or `export * from "…/r2"` — either
      // exposes every export the module has, so every write-capable name is
      // reachable through it regardless of what it's later called.
      for (const name of WRITE_CAPABLE_R2_EXPORTS) found.add(name);
      continue;
    }

    const inner = clause.slice(1, -1); // strip the enclosing { }
    for (const rawSpecifier of inner.split(",")) {
      const specifier = rawSpecifier.trim();
      if (!specifier) continue;
      // "putObject", "putObject as go", "type R2Key" -- the ORIGINAL
      // exported name is always the first identifier, whatever local alias
      // (if any) follows "as". Keying off THIS, rather than off any later
      // call site, is what makes the alias evasion this test's header
      // documents impossible: detection no longer cares what the binding is
      // later called, only what was named in the import/re-export itself.
      const nameMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(specifier);
      if (nameMatch && WRITE_CAPABLE_R2_EXPORTS.includes(nameMatch[1])) {
        found.add(nameMatch[1]);
      }
    }
  }

  return [...found];
}

describe("importedWriteCapableR2Exports", () => {
  // Every case below is run as an actual assertion against a synthetic
  // source string, not reasoned about — task #81's review found the
  // previous (call-site) version broken by attacking it this way, and asked
  // for the replacement to be proven the same way rather than argued about.

  it("detects a plain named import, called under its own name", () => {
    const source = `
      import { putObject } from "../src/lib/r2";
      async function main() { await putObject(x, y, z); }
    `;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
  });

  it("detects an ALIASED named import, called only under the alias — the exact evasion the review found", () => {
    const source = `
      import { putObject as go } from "../src/lib/r2";
      async function main() { await go(x, y, z); }
    `;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
  });

  it("detects a namespace import, called as a property access", () => {
    const source = `
      import * as r2 from "../src/lib/r2";
      async function main() { await r2.putObject(x, y, z); }
    `;
    expect(importedWriteCapableR2Exports(source)).toEqual(WRITE_CAPABLE_R2_EXPORTS);
  });

  it("detects a bare namespace import with NO call at all — exposure, not use, is what matters", () => {
    const source = `import * as r2 from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(WRITE_CAPABLE_R2_EXPORTS);
  });

  it("detects a re-export under a new name declared in an intermediate file", () => {
    const source = `export { putObject as writeIt } from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
  });

  it("detects a wholesale re-export", () => {
    const source = `export * from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(WRITE_CAPABLE_R2_EXPORTS);
  });

  it("detects an import that is never called at all -- an unused import is a false positive, deliberately the safe direction", () => {
    const source = `import { finalKey } from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["finalKey"]);
  });

  it("detects a multi-line named import clause", () => {
    const source = `
      import {
        displayKey,
        getObjectStream,
        objectExists,
        putObject,
      } from "../src/lib/r2";
    `;
    expect(importedWriteCapableR2Exports(source).sort()).toEqual(["displayKey", "putObject"]);
  });

  it("detects a write-capable name mixed with a non-write-capable one in the same clause", () => {
    const source = `import { objectExists, finalKey as writeFinal } from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["finalKey"]);
  });

  it("ignores a file that never imports from src/lib/r2 at all", () => {
    const source = `import { db } from "../src/lib/db";`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });

  it("ignores an import of only non-write-capable r2.ts exports", () => {
    const source = `import { nonGalleryKey, objectExists, getObjectStream, getObjectSize, storedKey } from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });

  it("ignores a bare mention of the name in a line comment, not inside a real import", () => {
    const source = `// putObject is mentioned here, not imported: import { putObject } from "../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });

  it("ignores a bare mention of the name in a block comment", () => {
    const source = `/* import { putObject } from "../src/lib/r2"; -- just an example in prose */`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });

  it("resolves a deeper relative path the same way (../../src/lib/r2)", () => {
    const source = `import { proofKey } from "../../src/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["proofKey"]);
  });
});

function collectScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("ops scripts that import a write-capable R2 export assert APP_ENV first", () => {
  const files = collectScriptFiles(SCRIPTS_DIR);

  // Guards the guard: if this ever comes back empty (e.g. every script
  // moved somewhere this walk doesn't reach), the loop below silently
  // iterates zero times and the whole describe block would pass for the
  // wrong reason -- no scripts checked, not "all scripts checked and
  // compliant".
  it("found at least one script file under scripts/ to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const label = relative(SCRIPTS_DIR, file);

    it(`${label}: calls assertAppEnvIsSet() if it imports a write-capable r2.ts export`, () => {
      const rawSource = readFileSync(file, "utf8");
      const triggeredBy = importedWriteCapableR2Exports(rawSource);
      if (triggeredBy.length === 0) return; // never imports a write-capable export -- nothing to guard.

      const callsGuard = /\bassertAppEnvIsSet\s*\(/.test(stripComments(rawSource));
      expect(
        callsGuard,
        `scripts/${label} imports ${triggeredBy.join(", ")} (write-capable src/lib/r2.ts export(s)) ` +
          `but never calls assertAppEnvIsSet() -- see scripts/lib/assert-app-env.ts (task #81). ` +
          `Running this by hand over SSH, or via deploy.yml's sudo -n -u photoshowcase step (both ` +
          `outside the systemd unit that loads release.env), would silently write into the dev/ ` +
          `namespace and report success while production stays untouched.`,
      ).toBe(true);
    });
  }
});
