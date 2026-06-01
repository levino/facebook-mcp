/**
 * OAuth endpoints.
 *
 *   GET /oauth/start    -> 302 redirect to the Facebook login dialog
 *   GET /oauth/callback -> exchanges the code, stores user + page tokens
 *
 * The handlers are pure functions of their dependencies (config, graph client,
 * db) so they can be tested without a live server.
 */

import { type Config, resolveRedirectUri } from "../config.ts";
import type { GraphClient } from "../facebook/graph.ts";
import type { Db } from "../db/client.ts";
import { ensureSchema, saveUserAndPages } from "../db/tokens.ts";

/** Builds the Facebook OAuth dialog URL for the given request. */
export function buildAuthorizeUrl(
  config: Config,
  requestUrl: string,
  state: string,
): string {
  const redirectUri = resolveRedirectUri(config, requestUrl);
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.oauthScope);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface OAuthDeps {
  config: Config;
  graph: GraphClient;
  db: Db;
  /** Injectable for deterministic state in tests. */
  randomState?: () => string;
}

function defaultState(): string {
  return crypto.randomUUID();
}

/** GET /oauth/start */
export function handleOAuthStart(deps: OAuthDeps, request: Request): Response {
  const state = (deps.randomState ?? defaultState)();
  const location = buildAuthorizeUrl(deps.config, request.url, state);
  return new Response(null, {
    status: 302,
    headers: {
      location,
      // Stash the state so the callback can sanity-check it.
      "set-cookie": `fb_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`,
    },
  });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** GET /oauth/callback */
export async function handleOAuthCallback(
  deps: OAuthDeps,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    return htmlResponse(400, `<h1>Authorization failed</h1><p>${escapeHtml(desc)}</p>`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return htmlResponse(400, `<h1>Missing <code>code</code> parameter</h1>`);
  }

  const redirectUri = resolveRedirectUri(deps.config, request.url);
  try {
    const shortLived = await deps.graph.exchangeCodeForToken(
      deps.config.appId,
      deps.config.appSecret,
      redirectUri,
      code,
    );
    const longLived = await deps.graph.exchangeLongLivedToken(
      deps.config.appId,
      deps.config.appSecret,
      shortLived,
    );
    const pages = await deps.graph.listPages(longLived.accessToken);

    await ensureSchema(deps.db);
    await saveUserAndPages(deps.db, {
      userToken: longLived.accessToken,
      userTokenExpiresAt: longLived.expiresIn
        ? Math.floor(Date.now() / 1000) + longLived.expiresIn
        : null,
      pages: pages.map((p) => ({ id: p.id, name: p.name, accessToken: p.accessToken })),
    });

    const items = pages
      .map((p) => `<li>${escapeHtml(p.name)} <code>${escapeHtml(p.id)}</code></li>`)
      .join("");
    return htmlResponse(
      200,
      `<h1>Connected ✅</h1><p>Stored tokens for ${pages.length} page(s):</p><ul>${items}</ul>` +
        `<p>You can close this window and use the MCP server.</p>`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return htmlResponse(502, `<h1>Token exchange failed</h1><p>${escapeHtml(message)}</p>`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
