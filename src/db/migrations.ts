/**
 * Versioned, append-only database migrations.
 *
 * Migrations live here as inline statement lists (not `.sql` files) because the
 * Bunny edge runtime has no filesystem at request time — the schema must travel
 * inside the bundle. Each migration runs at most once; applied ids are tracked
 * in `schema_migrations`. {@link migrate} is idempotent and safe to call on
 * every cold start as well as from `deno task migrate`.
 *
 * Rules:
 *   - Append only. Never edit or reorder an already-released migration; add a
 *     new one with the next number.
 *   - Each statement must be a single SQL statement (libSQL/`node:sqlite`
 *     prepare one statement at a time).
 */

import type { Db } from "./client.ts";

export interface Migration {
  /** Stable, ordered id, e.g. "001_token_store". */
  id: string;
  /** One or more single SQL statements, run in order within a transaction. */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_token_store",
    statements: [
      `CREATE TABLE IF NOT EXISTS fb_tokens (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        name         TEXT,
        access_token TEXT NOT NULL,
        expires_at   INTEGER,
        updated_at   INTEGER NOT NULL
      )`,
    ],
  },
];

const TRACKING_TABLE =
  `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`;

/**
 * Applies any not-yet-applied migrations in order. Returns the ids that were
 * run this call (empty when the database is already up to date).
 */
export async function migrate(db: Db, now?: number): Promise<string[]> {
  await db.execute({ sql: TRACKING_TABLE });
  const { rows } = await db.execute({ sql: "SELECT id FROM schema_migrations" });
  const applied = new Set(rows.map((r) => String(r.id)));
  const ts = now ?? Math.floor(Date.now() / 1000);

  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await db.batch([
      ...m.statements.map((sql) => ({ sql })),
      {
        sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
        args: [m.id, ts],
      },
    ]);
    ran.push(m.id);
  }
  return ran;
}
