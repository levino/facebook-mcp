/**
 * Thin database abstraction.
 *
 * Production uses Bunny Database (libSQL) through `@libsql/client/web`. The rest
 * of the code only depends on the small {@link Db} interface below, which keeps
 * the storage layer swappable and trivially mockable in tests (see
 * `tests/db/sqlite_adapter.ts` for an in-memory `node:sqlite` implementation).
 */

export interface DbStatement {
  sql: string;
  args?: unknown[];
}

export interface DbResult {
  rows: Record<string, unknown>[];
  rowsAffected: number;
  lastInsertRowid?: bigint;
}

export interface Db {
  execute(stmt: DbStatement): Promise<DbResult>;
  /** Executes the statements in order inside a transaction. */
  batch(stmts: DbStatement[]): Promise<void>;
}

/**
 * Creates a {@link Db} backed by Bunny Database (libSQL) over HTTP. The client
 * is imported lazily so unit tests that never touch the database don't pull in
 * the libSQL dependency.
 */
export function createLibsqlDb(url: string, authToken: string): Db {
  // deno-lint-ignore no-explicit-any
  let clientPromise: Promise<any> | undefined;

  // deno-lint-ignore no-explicit-any
  const getClient = (): Promise<any> => {
    if (!clientPromise) {
      clientPromise = import("@libsql/client/web").then(({ createClient }) =>
        createClient({ url, authToken })
      );
    }
    return clientPromise;
  };

  // deno-lint-ignore no-explicit-any
  const toResult = (rs: any): DbResult => ({
    rows: (rs.rows ?? []).map((row: Record<string, unknown>) => ({ ...row })),
    rowsAffected: Number(rs.rowsAffected ?? 0),
    lastInsertRowid: rs.lastInsertRowid as bigint | undefined,
  });

  return {
    async execute(stmt) {
      const client = await getClient();
      return toResult(await client.execute({ sql: stmt.sql, args: stmt.args ?? [] }));
    },
    async batch(stmts) {
      const client = await getClient();
      await client.batch(
        stmts.map((s) => ({ sql: s.sql, args: s.args ?? [] })),
        "write",
      );
    },
  };
}
