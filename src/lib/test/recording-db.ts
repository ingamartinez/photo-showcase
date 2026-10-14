// Test-only helper (never imported by production code): a scripted, RECORDING
// stand-in for the drizzle `db` object.
//
// Unlike the per-file row-filtering doubles elsewhere in this repo, this one
// does not pretend to be a database. Each awaited query pops the next scripted
// result for its operation, and every query is recorded together with its
// WHERE clause rendered to real SQL by drizzle's own dialect — so a test can
// assert "this UPDATE sets removed_at WHERE flash_gallery_id = $1 AND user_id
// = $2" instead of trusting a mock to have matched rows. The cost is that the
// test author scripts the rows a SELECT returns; the benefit is that a write
// aimed at the wrong table, column or row goes red.
import { PgDialect } from "drizzle-orm/pg-core";

export type RecordedCall = {
  op: "select" | "insert" | "update" | "delete";
  table: unknown;
  values?: unknown;
  set?: unknown;
  where?: { sql: string; params: unknown[] };
  /** Each ORDER BY term rendered to SQL, e.g. `"flash_assets"."sort_order" asc`. */
  orderBy?: string[];
};

type Op = RecordedCall["op"];

export function createRecordingDb(scripted: Partial<Record<Op, unknown[][]>> = {}) {
  const calls: RecordedCall[] = [];
  const queues: Record<Op, unknown[][]> = {
    select: [...(scripted.select ?? [])],
    insert: [...(scripted.insert ?? [])],
    update: [...(scripted.update ?? [])],
    delete: [...(scripted.delete ?? [])],
  };
  const dialect = new PgDialect();

  function builder(call: RecordedCall) {
    calls.push(call);
    const result = () => Promise.resolve(queues[call.op].shift() ?? []);
    const chain: Record<string, unknown> = {
      from: (table: unknown) => {
        call.table = table;
        return chain;
      },
      values: (values: unknown) => {
        call.values = values;
        return chain;
      },
      set: (set: unknown) => {
        call.set = set;
        return chain;
      },
      where: (condition: unknown) => {
        const { sql, params } = dialect.sqlToQuery(condition as never);
        call.where = { sql, params };
        return chain;
      },
      limit: () => chain,
      orderBy: (...columns: unknown[]) => {
        call.orderBy = columns.map((c) => dialect.sqlToQuery(c as never).sql);
        return chain;
      },
      returning: () => chain,
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        result().then(resolve, reject),
    };
    return chain;
  }

  const db = {
    select: () => builder({ op: "select", table: undefined }),
    insert: (table: unknown) => builder({ op: "insert", table }),
    update: (table: unknown) => builder({ op: "update", table }),
    delete: (table: unknown) => builder({ op: "delete", table }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };

  return { db, calls, ofOp: (op: Op) => calls.filter((call) => call.op === op) };
}
