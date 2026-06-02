/**
 * Multi-tenant store for Facebook identities and their pages.
 *
 * Each connected Facebook user gets a row in `fb_users` plus one row per managed
 * page in `fb_pages`. Everything is keyed by the Facebook `user_id`, so tool
 * calls are strictly scoped to the authenticated user's own pages.
 */

import type { Db } from "./client.ts";

export interface FbUser {
  userId: string;
  name: string | null;
  userToken: string;
  /** Unix seconds, or null for non-expiring tokens. */
  expiresAt: number | null;
  updatedAt: number;
}

export interface FbPage {
  userId: string;
  pageId: string;
  name: string | null;
  accessToken: string;
  updatedAt: number;
}

export interface PageInput {
  pageId: string;
  name: string | null;
  accessToken: string;
}

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

/**
 * Upserts a user and replaces their full page set in one transaction. Pages
 * absent from `pages` are removed, so the stored set always mirrors what the
 * user currently grants.
 */
export async function saveUserAndPages(
  db: Db,
  params: {
    userId: string;
    name: string | null;
    userToken: string;
    expiresAt: number | null;
    pages: PageInput[];
  },
  now?: number,
): Promise<void> {
  const ts = nowSeconds(now);
  await db.batch([
    {
      sql: `INSERT INTO fb_users (user_id, name, user_token, expires_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              name = excluded.name,
              user_token = excluded.user_token,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at`,
      args: [params.userId, params.name, params.userToken, params.expiresAt, ts],
    },
    { sql: "DELETE FROM fb_pages WHERE user_id = ?", args: [params.userId] },
    ...params.pages.map((p) => ({
      sql: `INSERT INTO fb_pages (user_id, page_id, name, access_token, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [params.userId, p.pageId, p.name, p.accessToken, ts],
    })),
  ]);
}

function rowToUser(row: Record<string, unknown>): FbUser {
  return {
    userId: String(row.user_id),
    name: row.name == null ? null : String(row.name),
    userToken: String(row.user_token),
    expiresAt: row.expires_at == null ? null : Number(row.expires_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToPage(row: Record<string, unknown>): FbPage {
  return {
    userId: String(row.user_id),
    pageId: String(row.page_id),
    name: row.name == null ? null : String(row.name),
    accessToken: String(row.access_token),
    updatedAt: Number(row.updated_at),
  };
}

export async function getUser(db: Db, userId: string): Promise<FbUser | null> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM fb_users WHERE user_id = ? LIMIT 1",
    args: [userId],
  });
  return rows.length > 0 ? rowToUser(rows[0]) : null;
}

export async function listPages(db: Db, userId: string): Promise<FbPage[]> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM fb_pages WHERE user_id = ? ORDER BY name",
    args: [userId],
  });
  return rows.map(rowToPage);
}

/**
 * Returns the access token for a page owned by `userId`, or throws if the page
 * is not connected to that user — which is also what enforces tenant isolation.
 */
export async function getPageToken(db: Db, userId: string, pageId: string): Promise<string> {
  const { rows } = await db.execute({
    sql: "SELECT access_token FROM fb_pages WHERE user_id = ? AND page_id = ? LIMIT 1",
    args: [userId, pageId],
  });
  if (rows.length === 0) {
    throw new Error(
      `Page ${pageId} is not connected to your account. Connect it via the website (Login with Facebook) and make sure you are an admin of the page.`,
    );
  }
  return String(rows[0].access_token);
}

/** Fully disconnects a user: removes their identity and all their pages. */
export async function deleteUser(db: Db, userId: string): Promise<void> {
  await db.batch([
    { sql: "DELETE FROM fb_pages WHERE user_id = ?", args: [userId] },
    { sql: "DELETE FROM fb_users WHERE user_id = ?", args: [userId] },
  ]);
}
