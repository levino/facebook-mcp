/**
 * Token store for Facebook access tokens.
 *
 * The OAuth callback persists one "user" token plus one row per managed page
 * (the page access token derived from `/me/accounts`). The MCP tools read page
 * tokens from here so every Graph call is authenticated without re-running
 * OAuth.
 */

import type { Db } from "./client.ts";
import { migrate } from "./migrations.ts";

export type TokenKind = "user" | "page";

export interface StoredToken {
  /** "user" for the user token, otherwise the page id. */
  id: string;
  kind: TokenKind;
  name: string | null;
  accessToken: string;
  /** Unix seconds, or null for non-expiring tokens. */
  expiresAt: number | null;
  /** Unix seconds the row was last written. */
  updatedAt: number;
}

export const USER_TOKEN_ID = "user";

/** Brings the database schema up to date (runs pending migrations). */
export async function ensureSchema(db: Db): Promise<void> {
  await migrate(db);
}

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

/** Inserts or updates a single token row. */
export async function upsertToken(
  db: Db,
  token: Omit<StoredToken, "updatedAt">,
  now?: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO fb_tokens (id, kind, name, access_token, expires_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            name = excluded.name,
            access_token = excluded.access_token,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at`,
    args: [
      token.id,
      token.kind,
      token.name,
      token.accessToken,
      token.expiresAt,
      nowSeconds(now),
    ],
  });
}

/** Replaces the user token and the full set of page tokens atomically. */
export async function saveUserAndPages(
  db: Db,
  params: {
    userToken: string;
    userTokenExpiresAt: number | null;
    pages: { id: string; name: string | null; accessToken: string }[];
  },
  now?: number,
): Promise<void> {
  const ts = nowSeconds(now);
  const stmts = [
    {
      sql: `INSERT INTO fb_tokens (id, kind, name, access_token, expires_at, updated_at)
            VALUES (?, 'user', NULL, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              access_token = excluded.access_token,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at`,
      args: [USER_TOKEN_ID, params.userToken, params.userTokenExpiresAt, ts],
    },
    ...params.pages.map((p) => ({
      sql: `INSERT INTO fb_tokens (id, kind, name, access_token, expires_at, updated_at)
            VALUES (?, 'page', ?, ?, NULL, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              access_token = excluded.access_token,
              updated_at = excluded.updated_at`,
      args: [p.id, p.name, p.accessToken, ts],
    })),
  ];
  await db.batch(stmts);
}

function rowToToken(row: Record<string, unknown>): StoredToken {
  return {
    id: String(row.id),
    kind: row.kind as TokenKind,
    name: row.name === null || row.name === undefined ? null : String(row.name),
    accessToken: String(row.access_token),
    expiresAt: row.expires_at === null || row.expires_at === undefined
      ? null
      : Number(row.expires_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function getToken(db: Db, id: string): Promise<StoredToken | null> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM fb_tokens WHERE id = ? LIMIT 1",
    args: [id],
  });
  return rows.length > 0 ? rowToToken(rows[0]) : null;
}

export async function getUserToken(db: Db): Promise<StoredToken | null> {
  return await getToken(db, USER_TOKEN_ID);
}

/** Returns the page access token, or throws a clear error if not connected. */
export async function getPageToken(db: Db, pageId: string): Promise<string> {
  const token = await getToken(db, pageId);
  if (!token || token.kind !== "page") {
    throw new Error(
      `No access token stored for page ${pageId}. Run the OAuth flow at /oauth/start and make sure the page is managed by the connected account.`,
    );
  }
  return token.accessToken;
}

export async function listPageTokens(db: Db): Promise<StoredToken[]> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM fb_tokens WHERE kind = 'page' ORDER BY name",
  });
  return rows.map(rowToToken);
}
