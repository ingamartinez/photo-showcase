// A small, genuinely-behaving in-memory double for `@/lib/db`, shared by the
// suites that exercise per-client selection locks (epic #239) and the new
// `asset_picks` write paths (epic #250). Unlike the per-file doubles older
// suites carry, this one understands exactly what those code paths need and
// nothing more: `eq()`, `isNull()` and `and()` conditions,
// `select().from().where()` (+ `.limit()` / `.for("update")`),
// `update().set().where()` (+ `.returning()`), `insert().values()` (+
// `.onConflictDoNothing()` and `.returning()`), `delete().where()` (+
// `.returning()`), and `transaction()`.
//
// It filters FOR REAL off the compiled drizzle condition, so a query that
// drops a `removedAt IS NULL` or a `status = ...` guard returns different rows
// here — which is the whole point of mutation-testing against it. Anything it
// cannot interpret THROWS instead of silently matching everything.
//
// What it does NOT model, stated plainly: row locks and isolation (so the
// concurrency guarantee of `settleGalleryLockStatus` is argued in its own
// header comment and in the CAS tests, not proven by interleaving), FKs,
// cascades, locks and isolation, and rollback. ROLLBACK IS NOT MODELLED: a
// transaction body that throws keeps every insert, update and delete it made
// (a suite can assert the response, never the absence of writes). Statement
// atomicity of a SINGLE insert IS modelled: a batch that hits a duplicate
// without a conflict clause writes nothing.
import { is, SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";

type Row = Record<string, unknown>;
type Table = Record<string, unknown>;

type Leaf =
  { dbColumnName: string; op: "eq"; value: unknown } | { dbColumnName: string; op: "isNull" };

const isColumn = (chunk: unknown): chunk is { name: string } =>
  !!chunk && typeof chunk === "object" && "name" in chunk && "table" in chunk;
const isParam = (chunk: unknown): chunk is { value: unknown } =>
  !!chunk && typeof chunk === "object" && "value" in chunk && "encoder" in chunk;
const hasChunks = (chunk: unknown): chunk is { queryChunks: unknown[] } =>
  !!chunk && typeof chunk === "object" && "queryChunks" in chunk;

/** The SQL text of a node made ONLY of string chunks (`" and "`, `"("`, ...),
 * or `null` when it carries a column, a parameter or anything else. */
function textOf(node: unknown): string | null {
  if (isColumn(node) || isParam(node)) return null;
  if (hasChunks(node)) {
    const parts = node.queryChunks.map(textOf);
    return parts.some((part) => part === null) ? null : parts.join("");
  }
  const value = (node as { value?: unknown } | null)?.value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("");
  return null;
}

function unsupported(detail: string): never {
  throw new Error(
    `fake db: unsupported condition (${detail}). Supported: eq(column, value), ` +
      "isNull(column), and(...) of those. Extend src/test-support/fake-db.ts deliberately " +
      "rather than letting a query be mis-modelled.",
  );
}

/** Parses ONE leaf — a node with a column among its immediate chunks — and
 * accepts exactly `col = <param>` and `col is null`. Everything else (`<>`,
 * `is not null`, `in (...)`, `col = col`, `<`, a lone column...) throws. */
function parseLeaf(chunks: unknown[]): Leaf {
  const parts = chunks.filter((chunk) => textOf(chunk) !== "");
  const [column, op, operand, ...rest] = parts;
  if (!isColumn(column) || rest.length > 0) unsupported("leaf shape");
  const opText = textOf(op)?.trim();
  if (opText === "is null" && operand === undefined) {
    return { dbColumnName: column.name, op: "isNull" };
  }
  if (opText === "=" && isParam(operand)) {
    return { dbColumnName: column.name, op: "eq", value: operand.value };
  }
  return unsupported(`operator ${JSON.stringify(opText ?? null)}`);
}

const COMPOSITE_TEXT = new Set(["", "(", ")", " and "]);

function leaves(node: unknown): Leaf[] {
  if (!hasChunks(node)) unsupported("not a drizzle condition");
  if (node.queryChunks.some(isColumn)) return [parseLeaf(node.queryChunks)];
  const out: Leaf[] = [];
  for (const chunk of node.queryChunks) {
    const text = textOf(chunk);
    if (text !== null) {
      if (!COMPOSITE_TEXT.has(text)) unsupported(`connective ${JSON.stringify(text)}`);
    } else if (hasChunks(chunk)) {
      out.push(...leaves(chunk));
    } else {
      unsupported("bare operand outside a leaf");
    }
  }
  return out;
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
  if (parsed.length === 0) unsupported("empty condition");
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

type PgTableLike = Parameters<typeof getTableConfig>[0];

function tableConfig(table: Table) {
  return getTableConfig(table as unknown as PgTableLike);
}

/** PK column JS keys, in declaration order: composite `primaryKey()` first,
 * then a column-level `.primary()`. */
function primaryKeyJsKeys(table: Table): string[] {
  const config = tableConfig(table);
  const keys: string[] = [];
  for (const pk of config.primaryKeys) {
    for (const column of pk.columns) keys.push(jsKeyFor(table, column.name));
  }
  if (keys.length === 0) {
    for (const column of config.columns) {
      if (column.primary) keys.push(jsKeyFor(table, column.name));
    }
  }
  return keys;
}

/** Never silently mis-model a uniqueness Postgres would enforce: ANY unique
 * index/constraint/column whose column set is not a superset of the PK throws.
 * That rejects `galleries` (unique `public_slug`) and `users` (unique
 * `email`), and accepts `asset_picks` (PK only), `assets` (unique
 * `(id, gallery_id)`, a superset of its PK `id`) and `gallery_clients`. */
function assertUniquesModelled(table: Table): void {
  const config = tableConfig(table);
  const pk = new Set(primaryKeyJsKeys(table));
  const uniques: { dbCols: string[]; jsCols: string[] }[] = [];
  for (const index of config.indexes) {
    if (index.config.unique) {
      const dbCols = index.config.columns.map((column) => (column as { name: string }).name);
      uniques.push({ dbCols, jsCols: dbCols.map((name) => jsKeyFor(table, name)) });
    }
  }
  for (const unique of config.uniqueConstraints) {
    const dbCols = unique.columns.map((column) => (column as { name: string }).name);
    uniques.push({ dbCols, jsCols: dbCols.map((name) => jsKeyFor(table, name)) });
  }
  for (const column of config.columns) {
    if (column.isUnique) {
      uniques.push({ dbCols: [column.name], jsCols: [jsKeyFor(table, column.name)] });
    }
  }
  for (const unique of uniques) {
    const superset = [...pk].every((key) => unique.jsCols.includes(key));
    if (!superset) {
      throw new Error(
        `fake db: ${config.name} has unique (${unique.dbCols.join(", ")}) the fake does not enforce`,
      );
    }
  }
}

function normaliseInsertRow(table: Table, row: Row): Row {
  const config = tableConfig(table);
  const jsKeys = new Set(config.columns.map((column) => jsKeyFor(table, column.name)));
  for (const key of Object.keys(row)) {
    if (!jsKeys.has(key)) throw new Error(`fake db: unknown column "${key}"`);
  }
  const out: Row = {};
  for (const column of config.columns) {
    const jsKey = jsKeyFor(table, column.name);
    const hasValue = Object.prototype.hasOwnProperty.call(row, jsKey) && row[jsKey] !== undefined;
    if (hasValue) {
      const value = row[jsKey];
      if (value === null && column.notNull) {
        throw new Error(`fake db: null value in column ${column.name} violates not-null`);
      }
      out[jsKey] = value;
      continue;
    }
    const defaultFn = (column as { defaultFn?: () => unknown }).defaultFn;
    if (typeof defaultFn === "function") {
      out[jsKey] = defaultFn();
    } else if (column.hasDefault && !is(column.default, SQL)) {
      out[jsKey] = column.default;
    } else if (column.hasDefault && is(column.default, SQL)) {
      throw new Error(
        `fake db: column ${column.name} has a SQL default the fake cannot evaluate; pass it explicitly`,
      );
    } else if (column.notNull) {
      throw new Error(`fake db: null value in column ${column.name} violates not-null`);
    } else {
      out[jsKey] = null;
    }
  }
  return out;
}

type ConflictConfig = { target?: unknown; [key: string]: unknown };

/** Only the exact PK target is modelled. Any `where`/`targetWhere`/`set`, a
 * non-PK target, or a PK-less table throws SYNCHRONOUSLY. */
function assertConflictTarget(table: Table, config: ConflictConfig | undefined): void {
  const reject = (): never => {
    throw new Error("fake db: onConflictDoNothing only models the primary-key target");
  };
  if (config === undefined) return;
  for (const key of Object.keys(config)) {
    if (key !== "target") reject();
  }
  if (config.target === undefined) return;
  const pkNames = primaryKeyJsKeys(table).map((jsKey) => {
    const column = tableConfig(table).columns.find((c) => jsKeyFor(table, c.name) === jsKey);
    return column!.name;
  });
  if (pkNames.length === 0) reject();
  const target = config.target;
  const columns = Array.isArray(target) ? target : [target];
  const targetNames = columns.map((column) => (column as { name?: string } | null)?.name);
  if (targetNames.some((name) => name === undefined)) reject();
  const sortedTarget = [...(targetNames as string[])].sort();
  const sortedPk = [...pkNames].sort();
  if (
    sortedTarget.length !== sortedPk.length ||
    sortedTarget.some((name, i) => name !== sortedPk[i])
  ) {
    reject();
  }
}

type InsertStatement = {
  onConflictDoNothing: (config?: ConflictConfig) => InsertStatement;
  onConflictDoUpdate: () => never;
  returning: (columns?: Record<string, unknown>) => Promise<Row[]>;
  then: (onF?: (rows: Row[]) => unknown, onR?: (error: unknown) => unknown) => Promise<unknown>;
};

export type FakeDb = {
  select: (columns?: Record<string, unknown>) => unknown;
  update: (table: unknown) => unknown;
  insert: (table: unknown) => unknown;
  delete: (table: unknown) => unknown;
  transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
  /** Test-only handle on the backing rows, keyed by the table object. */
  __tables: Map<unknown, Row[]>;
  /** Every select (`select`), row lock (`for:update`, replacing its select),
   * write (`update:<n>`), insert (`insert:<accepted>`) and delete
   * (`delete:<n>`), in order — lets a suite assert the gallery row was locked
   * before anything else in a transaction. */
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
          // Every select is logged, so a suite can prove ORDER (e.g. that a
          // row lock precedes any other read). A `.for(mode)` call — made
          // synchronously, right after `where` — turns this very entry into
          // `for:<mode>`, so a locking select logs once, as the lock.
          const logIndex = log.push("select") - 1;
          const promise = Promise.resolve(found) as Promise<Row[]> & {
            limit: (n: number) => Promise<Row[]>;
            for: (mode: string) => Promise<Row[]>;
          };
          promise.limit = async (n) => found.slice(0, n);
          promise.for = async (mode) => {
            log[logIndex] = `for:${mode}`;
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
    insert: (table) => {
      // Eager, so an unregistered table throws here exactly like `select`.
      rowsFor(table);
      const t = table as Table;
      return {
        values: (input: Row | Row[]) => {
          const batch = Array.isArray(input) ? input : [input];
          if (batch.length === 0) {
            throw new Error("values() must be called with at least one value");
          }
          let conflictMode: "none" | "nothing" = "none";
          let runPromise: Promise<Row[]> | null = null;

          const run = (): Promise<Row[]> => {
            if (!runPromise) {
              runPromise = Promise.resolve().then(async () => {
                assertUniquesModelled(t);
                const pkKeys = primaryKeyJsKeys(t);
                const existing = rowsFor(table);
                const accepted: Row[] = [];
                for (const raw of batch) {
                  const row = normaliseInsertRow(t, raw);
                  const conflict = [...existing, ...accepted].some((candidate) =>
                    pkKeys.every((key) => candidate[key] === row[key]),
                  );
                  if (conflict) {
                    if (conflictMode === "nothing") continue;
                    throw new Error(
                      `fake db: duplicate key value violates primary key (${pkKeys.join(", ")})`,
                    );
                  }
                  accepted.push(row);
                }
                for (const row of accepted) existing.push(row);
                log.push(`insert:${accepted.length}`);
                return accepted;
              });
            }
            return runPromise;
          };

          const statement: InsertStatement = {
            onConflictDoNothing: (config) => {
              assertConflictTarget(t, config);
              conflictMode = "nothing";
              return statement;
            },
            onConflictDoUpdate: () => {
              throw new Error("fake db: onConflictDoUpdate is not modelled");
            },
            returning: (columns) =>
              run().then((rows) => rows.map((row) => project(row, t, columns))),
            then: (onfulfilled, onrejected) =>
              run().then(
                () => (onfulfilled ? onfulfilled([]) : ([] as Row[])),
                (error) => (onrejected ? onrejected(error) : Promise.reject(error)),
              ),
          };
          return statement;
        },
      };
    },
    delete: (table) => {
      // Eager, so an unregistered table throws here exactly like `select`.
      const rows = rowsFor(table);
      const t = table as Table;
      return {
        where: (condition: unknown) => {
          const hit = rows.filter((row) => matches(row, t, condition));
          for (const row of hit) {
            const index = rows.indexOf(row);
            if (index >= 0) rows.splice(index, 1);
          }
          log.push(`delete:${hit.length}`);
          const promise = Promise.resolve([]) as unknown as Promise<Row[]> & {
            returning: (columns?: Record<string, unknown>) => Promise<Row[]>;
          };
          promise.returning = async (columns) => hit.map((row) => project(row, t, columns));
          return promise;
        },
        then: (
          onfulfilled: ((value: Row[]) => unknown) | null,
          onrejected: ((reason: unknown) => unknown) | null,
        ) =>
          Promise.reject(new Error("fake db: delete() without where() is not modelled")).then(
            onfulfilled,
            onrejected,
          ),
      };
    },
    transaction: async (fn) => fn(db),
    __tables: store,
    __log: log,
  };
  return db;
}
