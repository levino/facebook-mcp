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
  /** Stable, ordered id, e.g. "001_init". */
  id: string;
  /** One or more single SQL statements, run in order within a transaction. */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: "001_init",
    statements: [
      // --- Facebook identities (one row per connected Facebook user) ---
      `CREATE TABLE IF NOT EXISTS fb_users (
        user_id      TEXT PRIMARY KEY,
        name         TEXT,
        user_token   TEXT NOT NULL,
        expires_at   INTEGER,
        updated_at   INTEGER NOT NULL
      )`,
      // Pages belong to a user; page access tokens are derived from /me/accounts.
      `CREATE TABLE IF NOT EXISTS fb_pages (
        user_id      TEXT NOT NULL,
        page_id      TEXT NOT NULL,
        name         TEXT,
        access_token TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (user_id, page_id)
      )`,

      // --- MCP OAuth authorization server ---
      // Dynamically registered MCP clients (public clients, PKCE).
      `CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id     TEXT PRIMARY KEY,
        redirect_uris TEXT NOT NULL,
        client_name   TEXT,
        created_at    INTEGER NOT NULL
      )`,
      // Pending logins carry the request across the Facebook federation hop
      // (kind = 'mcp' for client authorize flows, 'web' for the dashboard login).
      `CREATE TABLE IF NOT EXISTS oauth_logins (
        login_id       TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        client_id      TEXT,
        redirect_uri   TEXT,
        code_challenge TEXT,
        scope          TEXT,
        client_state   TEXT,
        resource       TEXT,
        expires_at     INTEGER NOT NULL
      )`,
      // One-time authorization codes bound to a user + client + PKCE challenge.
      `CREATE TABLE IF NOT EXISTS oauth_codes (
        code           TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL,
        user_id        TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope          TEXT,
        expires_at     INTEGER NOT NULL
      )`,
      // Issued access/refresh tokens (stored as hashes), bound to a user.
      `CREATE TABLE IF NOT EXISTS oauth_tokens (
        access_token_hash  TEXT PRIMARY KEY,
        refresh_token_hash TEXT,
        client_id          TEXT NOT NULL,
        user_id            TEXT NOT NULL,
        scope              TEXT,
        expires_at         INTEGER NOT NULL,
        refresh_expires_at INTEGER,
        created_at         INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh
        ON oauth_tokens (refresh_token_hash)`,
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user
        ON oauth_tokens (user_id)`,

      // --- Human dashboard sessions ---
      `CREATE TABLE IF NOT EXISTS web_sessions (
        session_id TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
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
