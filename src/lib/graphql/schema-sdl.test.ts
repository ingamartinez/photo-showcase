// THE STALENESS GUARD for `schema.graphql` — task #32's other half.
//
// #32's card settled that codegen output is COMMITTED, not generated in CI, so
// that `bun run typecheck` catches a drifted query in a fresh clone with no
// codegen step run first. That decision buys real safety and costs exactly one
// thing: a regeneration step a human has to remember. This file is what makes
// forgetting it a named failure in the ordinary `bun run test` run, rather than
// a silent hole.
//
// WHAT GOES WRONG WITHOUT IT, concretely, because "the committed file is stale"
// sounds harmless: `schema.graphql` is the schema codegen reads. If it lags the
// Pothos schema, codegen keeps typing documents against the OLDER schema —
// happily, with no warning. A field renamed in src/lib/graphql/types/** would
// then still type-check at every call site under its old name, which is the
// exact class of failure #32's second acceptance criterion exists to make
// impossible. The guard has to compare against the LIVE schema
// (`getSchema()`), not against the snapshot, or it would be asking the
// snapshot whether it agrees with itself.
//
// Comparison is byte-for-byte against the same `buildSchemaArtifact()` the
// emitter script uses (see ./schema-artifact.ts on why that is one function and
// not two), so a header edit, a lost trailing newline, or a reordered type all
// fail here too — not only a renamed field.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// Statically imported, unlike ./schema below: ./schema-artifact deliberately
// reaches nothing marked `server-only` and nothing that talks to a database.
import { buildSchemaArtifact, SCHEMA_ARTIFACT_RELATIVE_PATH } from "./schema-artifact";

// Same reason as every other node-environment suite that reaches into
// src/lib/graphql/**: `server-only` is not an installed package. See
// vitest.config.ts.
vi.mock("server-only", () => ({}));

// The resolvers are never invoked here — only the schema's SHAPE is read — but
// importing ./schema.ts pulls in ./types/query.ts, which imports the real
// `@/lib/galleries` and `@/lib/gallery-access`. Mocked so this suite opens no
// database connection of its own, matching ./schema.test.ts.
vi.mock("@/lib/gallery-access", () => ({ isGalleryOwner: vi.fn() }));
vi.mock("@/lib/galleries", () => ({
  getGalleryDetail: vi.fn(),
  getGalleryDetailBySlug: vi.fn(),
  getGalleriesForClient: vi.fn(),
  isGalleryVisibleToClient: vi.fn(),
}));

describe("the committed schema.graphql snapshot", () => {
  it("is byte-identical to what `bun run codegen` would write for the live Pothos schema", async () => {
    const { getSchema } = await import("./schema");

    // `process.cwd()` is the repo root under Vitest (its config lives there),
    // which is also where `bun run codegen` writes.
    const committed = readFileSync(join(process.cwd(), SCHEMA_ARTIFACT_RELATIVE_PATH), "utf8");

    expect(
      committed,
      "schema.graphql is stale — run `bun run codegen` and commit the result. " +
        "Until you do, src/lib/graphql/generated/** is typed against an older " +
        "schema than the one this app actually serves, and `bun run typecheck` " +
        "cannot see a query that drifted.",
    ).toBe(buildSchemaArtifact(getSchema()));
  });

  // Guards the guard. The assertion above compares two strings; if the file
  // read came back empty (a bad path, a truncated write) it would still be a
  // string comparison, just a meaningless one — and it would fail for a reason
  // nobody could act on. This makes "the snapshot exists and has a schema in
  // it" its own named check.
  it("is a real SDL document, not an empty or header-only file", () => {
    const committed = readFileSync(join(process.cwd(), SCHEMA_ARTIFACT_RELATIVE_PATH), "utf8");

    expect(committed).toContain("type Query {");
    expect(committed.split("\n").length).toBeGreaterThan(20);
  });
});
