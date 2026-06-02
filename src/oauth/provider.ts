/**
 * MCP OAuth 2.1 authorization server, federated to Facebook.
 *
 * Flow:
 *   1. MCP client registers (DCR) at /register.
 *   2. Client sends the user to /authorize (PKCE). We stash the request and
 *      redirect the browser to Facebook login.
 *   3. Facebook redirects back to /oauth/callback. We exchange the code, learn
 *      the Facebook user id, store their pages, and mint our own one-time
 *      authorization code bound to that user.
 *   4. Client exchanges the code at /token for an access/refresh token bound to
 *      the user. Tokens are presented as Bearer on /mcp.
 *
 * The same Facebook hop also powers the human dashboard login (kind = "web").
 */

import type { Config } from "../config.ts";
import type { GraphClient } from "../facebook/graph.ts";
import type { Db } from "../db/client.ts";
import { saveUserAndPages } from "../db/users.ts";
import * as store from "./store.ts";
import { randomToken, tokenHash, verifyPkceS256 } from "./crypto.ts";
import { protectedResourceMetadata } from "./metadata.ts";

export interface ProviderDeps {
  config: Config;
  graph: GraphClient;
  db: Db;
}

export function originOf(request: Request): string {
  return new URL(request.url).origin;
}

function facebookRedirectUri(origin: string): string {
  return `${origin}/oauth/callback`;
}

function facebookAuthUrl(config: Config, origin: string, state: string): string {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", facebookRedirectUri(origin));
  url.searchParams.set("scope", config.oauthScope);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

function htmlError(status: number, message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Error</title>` +
      `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Something went wrong</h1><p>${escapeHtml(message)}</p>` +
      `<p><a href="/">Back to start</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(
    /"/g,
    "&quot;",
  );
}

// --- Dynamic Client Registration (RFC 7591) ---

export async function handleRegister(deps: ProviderDeps, request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "Body must be JSON");
  }
  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) || redirectUris.length === 0 ||
    redirectUris.some((u) => typeof u !== "string")
  ) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be a non-empty array of strings");
  }
  const clientName = typeof body.client_name === "string" ? body.client_name : null;
  const client = await store.registerClient(deps.db, {
    redirectUris: redirectUris as string[],
    clientName,
  });
  return json({
    client_id: client.clientId,
    client_id_issued_at: client.createdAt,
    redirect_uris: client.redirectUris,
    client_name: client.clientName ?? undefined,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
}

// --- Authorization endpoint (MCP client flow) ---

export async function handleAuthorize(deps: ProviderDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = url.searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";

  const client = clientId ? await store.getClient(deps.db, clientId) : null;
  if (!client) {
    return htmlError(400, "Unknown client_id. The MCP client must register first.");
  }
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return htmlError(400, "Invalid redirect_uri for this client.");
  }

  // From here errors can be reported back to the client per OAuth.
  const clientState = q.get("state");
  const fail = (error: string, description: string) => {
    const loc = new URL(redirectUri);
    loc.searchParams.set("error", error);
    loc.searchParams.set("error_description", description);
    if (clientState) loc.searchParams.set("state", clientState);
    return redirect(loc.toString());
  };

  if (q.get("response_type") !== "code") {
    return fail("unsupported_response_type", "Only response_type=code is supported");
  }
  const codeChallenge = q.get("code_challenge");
  if (!codeChallenge) {
    return fail("invalid_request", "PKCE code_challenge is required");
  }
  if ((q.get("code_challenge_method") ?? "plain") !== "S256") {
    return fail("invalid_request", "Only code_challenge_method=S256 is supported");
  }

  const loginId = await store.createLogin(deps.db, {
    kind: "mcp",
    clientId,
    redirectUri,
    codeChallenge,
    scope: q.get("scope"),
    clientState,
    resource: q.get("resource"),
  }, deps.config.loginTtlSeconds);

  return redirect(facebookAuthUrl(deps.config, originOf(request), loginId));
}

/** Starts the human dashboard login (also federated to Facebook). */
export async function startWebLogin(deps: ProviderDeps, request: Request): Promise<Response> {
  const loginId = await store.createLogin(deps.db, {
    kind: "web",
    clientId: null,
    redirectUri: null,
    codeChallenge: null,
    scope: null,
    clientState: null,
    resource: null,
  }, deps.config.loginTtlSeconds);
  return redirect(facebookAuthUrl(deps.config, originOf(request), loginId));
}

// --- Facebook callback (federation) for both kinds ---

export async function handleFacebookCallback(
  deps: ProviderDeps,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const desc = url.searchParams.get("error_description") ?? providerError;
    return htmlError(400, `Facebook authorization failed: ${desc}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlError(400, "Missing code or state.");
  }

  const login = await store.takeLogin(deps.db, state);
  if (!login) {
    return htmlError(400, "This login link has expired. Please start again.");
  }

  let userId: string;
  try {
    const origin = originOf(request);
    const shortLived = await deps.graph.exchangeCodeForToken(
      deps.config.appId,
      deps.config.appSecret,
      facebookRedirectUri(origin),
      code,
    );
    const longLived = await deps.graph.exchangeLongLivedToken(
      deps.config.appId,
      deps.config.appSecret,
      shortLived,
    );
    const me = await deps.graph.getMe(longLived.accessToken);
    const pages = await deps.graph.listPages(longLived.accessToken);
    userId = me.id;
    await saveUserAndPages(deps.db, {
      userId: me.id,
      name: me.name,
      userToken: longLived.accessToken,
      expiresAt: longLived.expiresIn ? Math.floor(Date.now() / 1000) + longLived.expiresIn : null,
      pages: pages.map((p) => ({ pageId: p.id, name: p.name, accessToken: p.accessToken })),
    });
  } catch (err) {
    return htmlError(
      502,
      `Token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (login.kind === "web") {
    const sessionId = await store.createSession(deps.db, userId, deps.config.sessionTtlSeconds);
    return redirect("/dashboard", {
      "set-cookie": sessionCookie(sessionId, deps.config.sessionTtlSeconds),
    });
  }

  // MCP client flow: mint an authorization code and bounce back to the client.
  const authCode = await store.createCode(deps.db, {
    clientId: login.clientId!,
    userId,
    redirectUri: login.redirectUri!,
    codeChallenge: login.codeChallenge!,
    scope: login.scope,
  }, deps.config.codeTtlSeconds);

  const loc = new URL(login.redirectUri!);
  loc.searchParams.set("code", authCode);
  if (login.clientState) loc.searchParams.set("state", login.clientState);
  return redirect(loc.toString());
}

// --- Token endpoint ---

export async function handleToken(deps: ProviderDeps, request: Request): Promise<Response> {
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return oauthError("invalid_request", "Body must be form-encoded");
  }
  const grantType = form.get("grant_type");

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = form.get("redirect_uri") ?? "";
    const clientId = form.get("client_id") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    if (!code || !redirectUri || !clientId || !verifier) {
      return oauthError(
        "invalid_request",
        "Missing code, redirect_uri, client_id or code_verifier",
      );
    }
    const authCode = await store.takeCode(deps.db, code);
    if (!authCode) return oauthError("invalid_grant", "Authorization code is invalid or expired");
    if (authCode.clientId !== clientId) return oauthError("invalid_grant", "client_id mismatch");
    if (authCode.redirectUri !== redirectUri) {
      return oauthError("invalid_grant", "redirect_uri mismatch");
    }
    if (!(await verifyPkceS256(verifier, authCode.codeChallenge))) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }
    return await issueTokens(deps, {
      clientId: authCode.clientId,
      userId: authCode.userId,
      scope: authCode.scope,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token") ?? "";
    if (!refreshToken) return oauthError("invalid_request", "Missing refresh_token");
    const rec = await store.takeRefreshToken(deps.db, await tokenHash(refreshToken));
    if (!rec) return oauthError("invalid_grant", "Refresh token is invalid or expired");
    return await issueTokens(deps, {
      clientId: rec.clientId,
      userId: rec.userId,
      scope: rec.scope,
    });
  }

  return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
}

async function issueTokens(
  deps: ProviderDeps,
  params: { clientId: string; userId: string; scope: string | null },
): Promise<Response> {
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await store.storeTokens(deps.db, {
    accessTokenHash: await tokenHash(accessToken),
    refreshTokenHash: await tokenHash(refreshToken),
    clientId: params.clientId,
    userId: params.userId,
    scope: params.scope,
    expiresAt: now + deps.config.accessTokenTtlSeconds,
    refreshExpiresAt: now + deps.config.refreshTokenTtlSeconds,
  });
  return json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: deps.config.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: params.scope ?? undefined,
  });
}

// --- Token revocation (RFC 7009) ---

export async function handleRevoke(deps: ProviderDeps, request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const token = form.get("token");
  if (token) await store.deleteTokenByHash(deps.db, await tokenHash(token));
  // RFC 7009: respond 200 regardless of whether the token existed.
  return new Response(null, { status: 200 });
}

// --- Bearer authentication for /mcp ---

export interface AuthResult {
  userId: string;
}

export async function authenticate(
  deps: ProviderDeps,
  request: Request,
): Promise<AuthResult | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const rec = await store.getAccessToken(deps.db, await tokenHash(match[1]));
  return rec ? { userId: rec.userId } : null;
}

/** 401 with the RFC 9728 pointer so clients can discover how to authenticate. */
export function unauthorized(origin: string): Response {
  return json({ error: "unauthorized" }, 401, {
    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}

export { protectedResourceMetadata };

function sessionCookie(sessionId: string, ttlSeconds: number): string {
  return `fbmcp_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

export const COOKIE_NAME = "fbmcp_session";

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
