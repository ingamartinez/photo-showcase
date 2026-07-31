// Task #81: statically enforces that any ops script calling a write-capable
// src/lib/r2.ts export also calls the shared APP_ENV guard first — see
// scripts/lib/assert-app-env.ts's own header for the full "why" this guard
// exists and what it deliberately does NOT do.
//
// This is the "cannot miss it" half of task #81's acceptance criterion.
// scripts/lib/assert-app-env.ts's header comment says a script MUST call
// `assertAppEnvIsSet()`, but a comment is not an enforcement mechanism —
// that is the exact lesson task #78 (branding R2Key) applied one level down,
// to bare-string keys reaching `putObject`/`getPresignedUrl`/`deleteObject`.
// This test applies the same lesson one level up, to the process-level gap
// #78 explicitly does NOT close (see its own header's "What this does NOT
// do"): forgetting the `assertAppEnvIsSet()` call fails `bun run test` — and
// therefore CI — instead of waiting for a reviewer to notice, or worse, for
// a production write to silently land in `dev/`.
//
// Deliberately STRUCTURAL, not an allowlist of exempt files: it scans every
// *.ts file directly under scripts/ (skipping *.test.ts and scripts/lib/,
// the guard's own home — nothing there calls the five names below on
// itself) for a CALL SITE of any of the five write-capable r2.ts exports
// (`putObject`, `deleteObject`, `proofKey`, `finalKey`, `displayKey`) and
// requires `assertAppEnvIsSet(` to appear in the same file if so.
//
// scripts/check-r2.ts is exempt for free, with no special-case entry needed:
// it never calls any of those five — it builds its own throwaway
// `Bun.S3Client` and calls `.write()`/`.delete()` on THAT directly, plus
// `nonGalleryKey()` (a mint, not a write) — see its own header comment. So
// it never matches the "calls a write-capable export" step below and this
// test never touches it. Its `_healthcheck/` key is harmless in either
// namespace anyway, which is the substantive reason it doesn't need the
// guard, not an accident of this test's scope.
//
// A future script that DOES call one of the five falls under the same rule
// automatically — nothing here needs updating when scripts/ grows. That is
// deliberately the opposite shape of an allowlist that has to be
// remembered: task #104 found exactly that failure mode in
// .github/workflows/deploy.yml's release-staging step (a per-file `cp`
// allowlist nobody updated for a new script) and the fix there was the same
// principle applied to file PRESENCE — cover the whole directory
// structurally instead of naming files one by one. See that step's own
// comment in deploy.yml.
//
// Comments are stripped from each file before scanning, so a file's OWN doc
// comments about these five names (this file's, or assert-app-env.ts's, or
// backfill-display-derivatives.ts's own explanatory comments) never trip the
// check by mentioning them in prose rather than calling them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function scannableScriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => entry.name)
    .sort();
}

describe("ops scripts that write or mint a real R2 key assert APP_ENV first", () => {
  const files = scannableScriptFiles();

  // Guards the guard: if this ever comes back empty (e.g. a future refactor
  // moves every script under scripts/lib/), the loop below silently iterates
  // zero times and the whole describe block would pass for the wrong
  // reason — no scripts checked, not "all scripts checked and compliant".
  it("found at least one script file directly under scripts/ to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: calls assertAppEnvIsSet() if it calls a write-capable r2.ts export`, () => {
      const source = stripComments(readFileSync(join(SCRIPTS_DIR, file), "utf8"));
      const triggeredBy = WRITE_CAPABLE_R2_EXPORTS.filter((name) =>
        new RegExp(`\\b${name}\\s*\\(`).test(source),
      );
      if (triggeredBy.length === 0) return; // never calls a write-capable export -- nothing to guard.

      const callsGuard = /\bassertAppEnvIsSet\s*\(/.test(source);
      expect(
        callsGuard,
        `scripts/${file} calls ${triggeredBy.join(", ")} (write-capable src/lib/r2.ts export(s)) ` +
          `but never calls assertAppEnvIsSet() -- see scripts/lib/assert-app-env.ts (task #81). ` +
          `Running this by hand over SSH, or via deploy.yml's sudo -n -u photoshowcase step (both ` +
          `outside the systemd unit that loads release.env), would silently write into the dev/ ` +
          `namespace and report success while production stays untouched.`,
      ).toBe(true);
    });
  }
});
