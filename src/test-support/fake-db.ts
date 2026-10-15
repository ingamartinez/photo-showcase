// A small, genuinely-behaving in-memory double for `@/lib/db`, shared by the
// suites that exercise per-client selection locks (epic #239). Unlike the
// per-file doubles older suites carry, this one understands exactly what those
// code paths need and nothing more: `eq()`, `isNull()` and `and()` conditions,
// `select().from().where()` (+ `.limit()` / `.for("update")`), `update().set()
// .where()` (+ `.returning()`), and `transaction()`.
//
// It filters FOR REAL off the compiled drizzle condition, so a query that
// drops a `removedAt IS NULL` or a `status = ...` guard returns different rows
// here — which is the whole point of mutation-testing against it. Anything it
// cannot interpret THROWS instead of silently matching everything.
//
// What it does NOT model, stated plainly: row locks and isolation (so the
// concurrency guarantee of `settleGalleryLockStatus` is argued in its own
// header comment and in the CAS tests, not proven by interleaving), and
// rollback (a transaction body that throws keeps its writes).
type Row = Record<string, unknown>;
type Table = Record<string, unknown>;

type Leaf =
  { dbColumnName: string; op: "eq"; value: unknown } | { dbColumnName: string; op: "isNull" };

function parseLeaf(node: unknown): Leaf | undefined {
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!chunks) return undefined;
  let dbColumnName: string | undefined;
  let value: unknown;
  let hasValue = false;
  let isNullText = false;
  for (const chunk of chunks) {
    if (chunk && typeof chunk === "object") {
      if ("name" in chunk && "table" in chunk) dbColumnName = (chunk as { name: string }).name;
      if ("value" in chunk && "encoder" in chunk) {
        value = (chunk as { value: unknown }).value;
        hasValue = true;
      }
      const text = (chunk as { value?: unknown }).value;
      if (Array.isArray(text) && text.join("").includes("is null")) isNullText = true;
    }
  }
  if (!dbColumnName) return undefined;
  if (isNullText) return { dbColumnName, op: "isNull" };
  if (hasValue) return { dbColumnName, op: "eq", value };
  return undefined;
}

function leaves(node: unknown): Leaf[] {
  const leaf = parseLeaf(node);
  if (leaf) return [leaf];
  const chunks = (node as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks.flatMap((chunk) => leaves(chunk));
}

function jsKeyFor(table: Table, dbColumnName: string): string {
  const found = Object.entries(table).find(
    ([, col]) => col && typeof col === "object" && (col as { name?: string }).name === dbColumnName,
  );
  if (!found) throw new Error(`fake db: no column named ${dbColumnName} on this table`);
  return found[0];
}

function matches(row: Row, table: Table, condition: unknown): boolean {
  const parsed = leaves(condition);
  if (parsed.length === 0) {
    throw new Error("fake db: not a supported eq()/isNull()/and(...) condition");
  }
  return parsed.every((leaf) => {
    const value = row[jsKeyFor(table, leaf.dbColumnName)];
    return leaf.op === "isNull" ? value == null : value === leaf.value;
  });
}

function project(row: Row, table: Table, columns: Record<string, unknown> | undefined): Row {
  if (!columns) return { ...row };
  const out: Row = {};
  for (const [alias, column] of Object.entries(columns)) {
    out[alias] = row[jsKeyFor(table, (column as { name: string }).name)];
  }
  return out;
}

export type FakeDb = {
  select: (columns?: Record<string, unknown>) => unknown;
  update: (table: unknown) => unknown;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
  /** Test-only handle on the backing rows, keyed by the table object. */
  __tables: Map<unknown, Row[]>;
  /** Every `for("update")` row lock requested, in order — lets a suite assert
   * the gallery row was locked before anything else in a transaction. */
  __log: string[];
};

export function createFakeDb(tables: unknown[]): FakeDb {
  const store = new Map<unknown, Row[]>(tables.map((table) => [table, []]));
  const log: string[] = [];

  function rowsFor(table: unknown): Row[] {
    const rows = store.get(table);
    if (!rows) throw new Error("fake db: unsupported table");
    return rows;
  }

  const db: FakeDb = {
    select: (columns) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const found = rowsFor(table)
            .filter((row) => matches(row, table as Table, condition))
            .map((row) => project(row, table as Table, columns));
          const promise = Promise.resolve(found) as Promise<Row[]> & {
            limit: (n: number) => Promise<Row[]>;
            for: (mode: string) => Promise<Row[]>;
          };
          promise.limit = async (n) => found.slice(0, n);
          promise.for = async (mode) => {
            log.push(`for:${mode}`);
            return found;
          };
          return promise;
        },
      }),
    }),
    update: (table) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => {
          const hit = rowsFor(table).filter((row) => matches(row, table as Table, condition));
          for (const row of hit) Object.assign(row, patch);
          log.push(`update:${hit.length}`);
          const promise = Promise.resolve(hit.map((row) => ({ ...row }))) as Promise<Row[]> & {
            returning: (columns?: Record<string, unknown>) => Promise<Row[]>;
          };
          promise.returning = async (columns) =>
            hit.map((row) => project(row, table as Table, columns));
          return promise;
        },
      }),
    }),
    transaction: async (fn) => fn(db),
    __tables: store,
    __log: log,
  };
  return db;
}
