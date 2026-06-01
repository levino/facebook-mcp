/**
 * Test-only {@link Db} implementation backed by an in-memory `node:sqlite`
 * database (available in both Deno and Node 22). Gives the token-store tests
 * real SQL semantics — upserts, transactions, constraints — without any native
 * libSQL bindings or network access.
 */

import { DatabaseSync } from "node:sqlite";
import type { Db, DbResult, DbStatement } from "../../src/db/client.ts";

function isQuery(sql: string): boolean {
  return /^\s*(select|pragma|with)\b/i.test(sql);
}

// node:sqlite only accepts null | number | bigint | string | Uint8Array.
function normalizeArg(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

export function createSqliteTestDb(): Db & { raw: DatabaseSync; close(): void } {
  const raw = new DatabaseSync(":memory:");

  function run(stmt: DbStatement): DbResult {
    const args = (stmt.args ?? []).map(normalizeArg);
    const prepared = raw.prepare(stmt.sql);
    if (isQuery(stmt.sql)) {
      const rows = prepared.all(...(args as never[])) as Record<string, unknown>[];
      return { rows, rowsAffected: 0 };
    }
    const info = prepared.run(...(args as never[]));
    return {
      rows: [],
      rowsAffected: Number(info.changes),
      lastInsertRowid: BigInt(info.lastInsertRowid),
    };
  }

  return {
    raw,
    execute(stmt) {
      return Promise.resolve(run(stmt));
    },
    batch(stmts) {
      raw.exec("BEGIN");
      try {
        for (const s of stmts) run(s);
        raw.exec("COMMIT");
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
      return Promise.resolve();
    },
    close() {
      raw.close();
    },
  };
}
