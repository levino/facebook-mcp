/**
 * Persistence for the MCP OAuth authorization server and the dashboard
 * sessions. All state lives in libSQL so the edge script stays stateless and
 * horizontally scalable across POPs. Raw tokens are never stored — only their
 * SHA-256 hashes.
 */

import type { Db } from "./../db/client.ts";
import { randomToken } from "./crypto.ts";

function nowSeconds(now?: number): number {
  return now ?? Math.floor(Date.now() / 1000);
}

// --- Clients (Dynamic Client Registration) ---

export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
  createdAt: number;
}

export async function registerClient(
  db: Db,
  params: { redirectUris: string[]; clientName: string | null },
  now?: number,
): Promise<OAuthClient> {
  const client: OAuthClient = {
    clientId: `mcp_${randomToken(16)}`,
    redirectUris: params.redirectUris,
    clientName: params.clientName,
    createdAt: nowSeconds(now),
  };
  await db.execute({
    sql: `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [
      client.clientId,
      JSON.stringify(client.redirectUris),
      client.clientName,
      client.createdAt,
    ],
  });
  return client;
}

export async function getClient(db: Db, clientId: string): Promise<OAuthClient | null> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM oauth_clients WHERE client_id = ? LIMIT 1",
    args: [clientId],
  });
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    clientId: String(row.client_id),
    redirectUris: JSON.parse(String(row.redirect_uris)),
    clientName: row.client_name == null ? null : String(row.client_name),
    createdAt: Number(row.created_at),
  };
}

// --- Pending federation logins ---

export type LoginKind = "mcp" | "web";

export interface PendingLogin {
  loginId: string;
  kind: LoginKind;
  clientId: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  scope: string | null;
  clientState: string | null;
  resource: string | null;
  expiresAt: number;
}

/** Creates a pending login, returning its generated id (used as FB `state`). */
export async function createLogin(
  db: Db,
  params: Omit<PendingLogin, "loginId" | "expiresAt">,
  ttlSeconds: number,
  now?: number,
): Promise<string> {
  const loginId = randomToken();
  await db.execute({
    sql: `INSERT INTO oauth_logins
            (login_id, kind, client_id, redirect_uri, code_challenge, scope, client_state, resource, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      loginId,
      params.kind,
      params.clientId,
      params.redirectUri,
      params.codeChallenge,
      params.scope,
      params.clientState,
      params.resource,
      nowSeconds(now) + ttlSeconds,
    ],
  });
  return loginId;
}

/** Fetches and deletes a pending login (one-time), null if missing/expired. */
export async function takeLogin(
  db: Db,
  loginId: string,
  now?: number,
): Promise<PendingLogin | null> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM oauth_logins WHERE login_id = ? LIMIT 1",
    args: [loginId],
  });
  await db.execute({ sql: "DELETE FROM oauth_logins WHERE login_id = ?", args: [loginId] });
  if (rows.length === 0) return null;
  const row = rows[0];
  const login: PendingLogin = {
    loginId: String(row.login_id),
    kind: row.kind as LoginKind,
    clientId: row.client_id == null ? null : String(row.client_id),
    redirectUri: row.redirect_uri == null ? null : String(row.redirect_uri),
    codeChallenge: row.code_challenge == null ? null : String(row.code_challenge),
    scope: row.scope == null ? null : String(row.scope),
    clientState: row.client_state == null ? null : String(row.client_state),
    resource: row.resource == null ? null : String(row.resource),
    expiresAt: Number(row.expires_at),
  };
  if (login.expiresAt < nowSeconds(now)) return null;
  return login;
}

// --- Authorization codes ---

export interface AuthCode {
  code: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string | null;
  expiresAt: number;
}

export async function createCode(
  db: Db,
  params: {
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string | null;
  },
  ttlSeconds: number,
  now?: number,
): Promise<string> {
  const code = randomToken();
  await db.execute({
    sql:
      `INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      code,
      params.clientId,
      params.userId,
      params.redirectUri,
      params.codeChallenge,
      params.scope,
      nowSeconds(now) + ttlSeconds,
    ],
  });
  return code;
}

/** Fetches and deletes an authorization code (one-time), null if missing/expired. */
export async function takeCode(db: Db, code: string, now?: number): Promise<AuthCode | null> {
  const { rows } = await db.execute({
    sql: "SELECT * FROM oauth_codes WHERE code = ? LIMIT 1",
    args: [code],
  });
  await db.execute({ sql: "DELETE FROM oauth_codes WHERE code = ?", args: [code] });
  if (rows.length === 0) return null;
  const row = rows[0];
  const authCode: AuthCode = {
    code: String(row.code),
    clientId: String(row.client_id),
    userId: String(row.user_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    scope: row.scope == null ? null : String(row.scope),
    expiresAt: Number(row.expires_at),
  };
  if (authCode.expiresAt < nowSeconds(now)) return null;
  return authCode;
}

// --- Access / refresh tokens ---

export interface TokenRecord {
  userId: string;
  clientId: string;
  scope: string | null;
  expiresAt: number;
}

export async function storeTokens(
  db: Db,
  params: {
    accessTokenHash: string;
    refreshTokenHash: string | null;
    clientId: string;
    userId: string;
    scope: string | null;
    expiresAt: number;
    refreshExpiresAt: number | null;
  },
  now?: number,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO oauth_tokens
            (access_token_hash, refresh_token_hash, client_id, user_id, scope, expires_at, refresh_expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      params.accessTokenHash,
      params.refreshTokenHash,
      params.clientId,
      params.userId,
      params.scope,
      params.expiresAt,
      params.refreshExpiresAt,
      nowSeconds(now),
    ],
  });
}

/** Resolves a valid access token hash to its record, or null if invalid/expired. */
export async function getAccessToken(
  db: Db,
  accessTokenHash: string,
  now?: number,
): Promise<TokenRecord | null> {
  const { rows } = await db.execute({
    sql:
      "SELECT client_id, user_id, scope, expires_at FROM oauth_tokens WHERE access_token_hash = ? LIMIT 1",
    args: [accessTokenHash],
  });
  if (rows.length === 0) return null;
  const row = rows[0];
  const expiresAt = Number(row.expires_at);
  if (expiresAt < nowSeconds(now)) return null;
  return {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    scope: row.scope == null ? null : String(row.scope),
    expiresAt,
  };
}

/** Fetches and deletes a refresh token (rotation), null if invalid/expired. */
export async function takeRefreshToken(
  db: Db,
  refreshTokenHash: string,
  now?: number,
): Promise<TokenRecord | null> {
  const { rows } = await db.execute({
    sql:
      "SELECT client_id, user_id, scope, refresh_expires_at FROM oauth_tokens WHERE refresh_token_hash = ? LIMIT 1",
    args: [refreshTokenHash],
  });
  if (rows.length === 0) return null;
  await db.execute({
    sql: "DELETE FROM oauth_tokens WHERE refresh_token_hash = ?",
    args: [refreshTokenHash],
  });
  const row = rows[0];
  const refreshExpiresAt = row.refresh_expires_at == null ? null : Number(row.refresh_expires_at);
  if (refreshExpiresAt != null && refreshExpiresAt < nowSeconds(now)) return null;
  return {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    scope: row.scope == null ? null : String(row.scope),
    expiresAt: refreshExpiresAt ?? 0,
  };
}

/** Deletes a token by either its access or refresh hash (RFC 7009 revoke). */
export async function deleteTokenByHash(db: Db, hash: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM oauth_tokens WHERE access_token_hash = ? OR refresh_token_hash = ?",
    args: [hash, hash],
  });
}

/** Revokes every token a user has issued (used on disconnect). */
export async function deleteTokensForUser(db: Db, userId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM oauth_tokens WHERE user_id = ?", args: [userId] });
}

/** Revokes all tokens a user granted to one client. */
export async function deleteTokensForUserClient(
  db: Db,
  userId: string,
  clientId: string,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?",
    args: [userId, clientId],
  });
}

export interface ClientAuthorization {
  clientId: string;
  clientName: string | null;
  tokenCount: number;
  lastCreatedAt: number;
}

/** Lists the MCP clients a user has authorized, for the dashboard. */
export async function listUserAuthorizations(
  db: Db,
  userId: string,
): Promise<ClientAuthorization[]> {
  const { rows } = await db.execute({
    sql: `SELECT t.client_id AS client_id, c.client_name AS client_name,
                 COUNT(*) AS token_count, MAX(t.created_at) AS last_created_at
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.user_id = ?
          GROUP BY t.client_id
          ORDER BY last_created_at DESC`,
    args: [userId],
  });
  return rows.map((row) => ({
    clientId: String(row.client_id),
    clientName: row.client_name == null ? null : String(row.client_name),
    tokenCount: Number(row.token_count),
    lastCreatedAt: Number(row.last_created_at),
  }));
}

// --- Dashboard sessions ---

export async function createSession(
  db: Db,
  userId: string,
  ttlSeconds: number,
  now?: number,
): Promise<string> {
  const sessionId = randomToken();
  const ts = nowSeconds(now);
  await db.execute({
    sql: `INSERT INTO web_sessions (session_id, user_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)`,
    args: [sessionId, userId, ts + ttlSeconds, ts],
  });
  return sessionId;
}

export async function getSessionUser(
  db: Db,
  sessionId: string,
  now?: number,
): Promise<string | null> {
  const { rows } = await db.execute({
    sql: "SELECT user_id, expires_at FROM web_sessions WHERE session_id = ? LIMIT 1",
    args: [sessionId],
  });
  if (rows.length === 0) return null;
  if (Number(rows[0].expires_at) < nowSeconds(now)) return null;
  return String(rows[0].user_id);
}

export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM web_sessions WHERE session_id = ?", args: [sessionId] });
}

export async function deleteSessionsForUser(db: Db, userId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM web_sessions WHERE user_id = ?", args: [userId] });
}
