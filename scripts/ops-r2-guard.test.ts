// Task #81: a BEST-EFFORT LINT, not a guarantee. It flags an ops script
// under scripts/ if it STATICALLY IMPORTS one of src/lib/r2.ts's five
// write-capable exports (`putObject`, `deleteObject`, `proofKey`,
// `finalKey`, `displayKey`) — under any local name, via a relative path or
// the `@/` tsconfig alias — without also calling scripts/lib/assert-app-
// env.ts's `assertAppEnvIsSet()` in the same file.
//
// Read that as a full description of what this catches, not a summary of
// something stronger. This is a regex over source text trying to prove a
// property of arbitrary code, and that is a game a static text scan does
// not get to fully win — closing one shape a review finds just invites the
// next one. Two review rounds on this exact file found, in order: a call-
// site scan defeated by an aliased import (`import { putObject as go }` +
// calling only `go(...)`); a namespace import that matched the first fix
// only by regex luck; a re-export declared under a new name; the `@/lib/r2`
// tsconfig alias — the one that matters most, since it is idiomatic in this
// codebase (src/lib/r2.ts itself imports `@/lib/env` that way, and task
// #104 made scripts resolve `@/*` at all); a non-canonical relative path
// (`../src/lib/./r2`); a dynamic `import()`; a `require()` call; and
// `.mts`/`.cts` files never even being looked at. The aliased-import,
// namespace, re-export, `@/` alias, and non-canonical-path shapes are
// closed below — several of `importedWriteCapableR2Exports`'s tests are
// direct regression tests for exactly these findings. `.mts`/`.cts` files
// are now scanned too (`isScannableScriptFile` below).
//
// EVERYTHING THIS STILL CANNOT SEE, in one place rather than scattered:
//
//   - A dynamic `import("../src/lib/r2")` or a `require("../src/lib/r2")`
//     call. Both are legal ways to reach the module and both are invisible
//     to a regex over static `import`/`export … from` syntax. The "known
//     limitation, deliberately uncovered" tests below assert `[]` for both
//     ON PURPOSE, so a future attempt to close this has to update the test
//     as well as the code, not just discover the gap again.
//   - A re-export chain that routes through a module living under src/
//     rather than scripts/ (e.g. a future src/lib/ops-helpers.ts
//     re-exporting `putObject`) — this scan only reads files under
//     scripts/. A chain that instead routes through ANOTHER file under
//     scripts/ IS seen (this walks the whole scripts/ tree, not just its
//     top level), just at the wrong file — a loud failure there, not a
//     silent pass.
//   - A script that reaches R2 through its own hand-rolled `Bun.S3Client`
//     instead of src/lib/r2.ts's exports at all — exactly what
//     scripts/check-r2.ts does, deliberately (see its own header comment).
//     It never imports any of the five names, so this lint has no opinion
//     about it either way — exempt by construction, not by an allowlist.
//   - A misspelled `APP_ENV` value. This lint only checks that
//     `assertAppEnvIsSet()` is CALLED, and that function only checks that
//     `APP_ENV` is SET — a typo like `"Production"` or `"prod"` passes both
//     checks and still silently lands under `dev/` (`namespacedKey`
//     requires an exact `"production"` match).
//   - Any import shape not listed above that a determined, or merely
//     unlucky, author finds next. This list is a snapshot of what two
//     review rounds found, not a proof that nothing else exists.
//
// WHAT ACTUALLY PROTECTS A SCRIPT THAT CALLS IT: the runtime throw inside
// `assertAppEnvIsSet()` itself (scripts/lib/assert-app-env.ts). This test is
// a lint that makes forgetting the call more likely to be caught before it
// ships — it is not, and cannot be made into, a proof that it always will
// be. Task #81's card permits falling short of "cannot miss this" as long
// as that is said plainly; this comment is that plain statement, written
// after two rounds of this exact file overclaiming what it enforces.
//
// Deliberately STRUCTURAL where it can be, not an allowlist of exempt
// files: every scannable file anywhere under scripts/ is walked (skipping
// test files). scripts/check-r2.ts needs no special-case entry, per above.
// A future script that imports one of the five falls under the same rule
// automatically. Task #104 found the allowlist shape rot in
// .github/workflows/deploy.yml's release-staging step (a per-file `cp` list
// nobody updated for a new script); this avoids repeating that shape for
// whatever it CAN see, which — per the list above — is less than "every
// script that touches R2."
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative } from "node:path";
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

/** Matches a static `import` or `export … from` declaration's clause and
 * raw module specifier — from ANY module, not just src/lib/r2.ts. The
 * specifier is filtered afterward by `isR2ModuleSpecifier`, so this regex
 * only needs to find declaration shapes, not judge their target. Captures:
 *   - `*` or `* as someName` — a namespace import/re-export, which exposes
 *     every export the module has, write-capable or not, and
 *   - `{ … }` — a named import/re-export clause, possibly spanning several
 *     lines, possibly with `as` aliases and/or a `type` prefix on any
 *     individual specifier.
 * `[^}]*` (rather than `[\s\S]*?`) is deliberately used inside the braces:
 * it cannot itself contain a stray `}` from a LATER unrelated import, so a
 * malformed capture can't accidentally swallow the rest of the file. Does
 * NOT match a dynamic `import(...)` call or a `require(...)` call — neither
 * has this shape, and that is a documented, deliberate gap (see this file's
 * header), not an oversight. */
const IMPORT_OR_REEXPORT_RE =
  /(?:import|export)\s+(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s+from\s*["']([^"']+)["'];?/g;

/** True if `specifier` — the raw, unresolved text between the quotes of an
 * `import`/`export … from` declaration — refers to src/lib/r2.ts, whether
 * written as the `@/` tsconfig alias or as a relative path. Relative paths
 * are normalized first (`node:path`'s POSIX join, since module specifiers
 * always use forward slashes regardless of host OS) so a non-canonical but
 * valid form like `../src/lib/./r2` or `../foo/../src/lib/r2` still
 * resolves to the same canonical `src/lib/r2` this checks against. */
function isR2ModuleSpecifier(specifier: string): boolean {
  if (specifier === "@/lib/r2") return true;
  const normalized = posix.normalize(specifier);
  return /^(\.\.\/)+src\/lib\/r2$/.test(normalized);
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** The write-capable src/lib/r2.ts export names a file's STATIC
 * import/re-export declarations bring into scope — regardless of local
 * alias, namespace indirection, `@/` alias vs. relative path, or whether
 * the binding is ever actually called. Does NOT see a dynamic `import()` or
 * a `require()` call — see this file's header for the full, precise list of
 * what this can and cannot see. Exported for its own tests below; not used
 * outside this file. */
export function importedWriteCapableR2Exports(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const found = new Set<string>();

  for (const match of source.matchAll(IMPORT_OR_REEXPORT_RE)) {
    const [, clause, specifier] = match;
    if (!isR2ModuleSpecifier(specifier)) continue;

    const trimmedClause = clause.trim();
    if (trimmedClause.startsWith("*")) {
      // `import * as x from "…/r2"` or `export * from "…/r2"` — either
      // exposes every export the module has, so every write-capable name is
      // reachable through it regardless of what it's later called.
      for (const name of WRITE_CAPABLE_R2_EXPORTS) found.add(name);
      continue;
    }

    const inner = trimmedClause.slice(1, -1); // strip the enclosing { }
    for (const rawSpecifier of inner.split(",")) {
      const namedSpecifier = rawSpecifier.trim();
      if (!namedSpecifier) continue;
      // "putObject", "putObject as go", "type R2Key" -- the ORIGINAL
      // exported name is always the first identifier, whatever local alias
      // (if any) follows "as". Keying off THIS, rather than off any later
      // call site, is what makes the alias evasion this file's header
      // documents impossible: detection no longer cares what the binding is
      // later called, only what was named in the import/re-export itself.
      const nameMatch = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(namedSpecifier);
      if (nameMatch && WRITE_CAPABLE_R2_EXPORTS.includes(nameMatch[1])) {
        found.add(nameMatch[1]);
      }
    }
  }

  return [...found];
}

describe("importedWriteCapableR2Exports", () => {
  // Every case below is run as an actual assertion against a synthetic
  // source string, not reasoned about — both review rounds on this file
  // found real holes by attacking it this way, and asked for the fix to be
  // proven the same way rather than argued about.

  it("detects a plain named import, called under its own name", () => {
    const source = `
      import { putObject } from "../src/lib/r2";
      async function main() { await putObject(x, y, z); }
    `;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
  });

  it("detects an ALIASED named import, called only under the alias — round 1's evasion", () => {
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

  it("detects the @/ tsconfig path alias — round 2's most likely accidental miss, not an adversarial one", () => {
    const source = `import { putObject } from "@/lib/r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
  });

  it("detects a non-canonical relative path with a redundant ./ segment", () => {
    const source = `import { putObject } from "../src/lib/./r2";`;
    expect(importedWriteCapableR2Exports(source)).toEqual(["putObject"]);
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

  // --- Known limitations, deliberately uncovered — see this file's header
  // "EVERYTHING THIS STILL CANNOT SEE". These assert the CURRENT (missing)
  // behavior on purpose: if someone later teaches the scanner to see one of
  // these, this exact test must be rewritten to expect a hit, not deleted
  // silently — that keeps the header comment honest instead of stale.

  it("KNOWN LIMITATION, deliberately uncovered: a dynamic import() is invisible to this static scan", () => {
    const source = `const { putObject } = await import("../src/lib/r2");`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });

  it("KNOWN LIMITATION, deliberately uncovered: a require() call is invisible to this static scan", () => {
    const source = `const r2 = require("../src/lib/r2");`;
    expect(importedWriteCapableR2Exports(source)).toEqual([]);
  });
});

/** `.ts`/`.mts`/`.cts` files are the shapes `bun run scripts/foo.ext`
 * actually executes; a test file in any of those three extensions is
 * excluded the same way. Extracted so its own inclusion/exclusion behavior
 * is independently testable below, rather than only implied by whatever
 * happens to live under scripts/ today. */
export function isScannableScriptFile(name: string): boolean {
  return /\.(ts|mts|cts)$/.test(name) && !/\.test\.(ts|mts|cts)$/.test(name);
}

describe("isScannableScriptFile", () => {
  it("includes a plain .ts file", () => {
    expect(isScannableScriptFile("backfill-display-derivatives.ts")).toBe(true);
  });

  it("includes a .mts file — bun run scripts/foo.mts is a real, executable ops-script shape", () => {
    expect(isScannableScriptFile("foo.mts")).toBe(true);
  });

  it("includes a .cts file", () => {
    expect(isScannableScriptFile("foo.cts")).toBe(true);
  });

  it("excludes a .test.ts file", () => {
    expect(isScannableScriptFile("assert-app-env.test.ts")).toBe(false);
  });

  it("excludes a .test.mts file", () => {
    expect(isScannableScriptFile("foo.test.mts")).toBe(false);
  });

  it("excludes a non-TypeScript file", () => {
    expect(isScannableScriptFile("README.md")).toBe(false);
  });
});

function collectScriptFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectScriptFiles(fullPath));
    } else if (entry.isFile() && isScannableScriptFile(entry.name)) {
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
