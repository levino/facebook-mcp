/**
 * Human-facing website handlers: landing page, Facebook login for the
 * dashboard, the dashboard itself, and the revoke/disconnect actions.
 *
 * Authentication here is a cookie session (`fbmcp_session`), distinct from the
 * MCP OAuth tokens used by machine clients — but both are established by the
 * same Facebook login.
 */

import type { ProviderDeps } from "../oauth/provider.ts";
import { clearedSessionCookie, COOKIE_NAME, originOf, startWebLogin } from "../oauth/provider.ts";
import * as store from "../oauth/store.ts";
import { deleteUser, getUser, listPages } from "../db/users.ts";
import { dashboardPage, landingPage } from "./pages.ts";

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

async function currentUser(deps: ProviderDeps, request: Request): Promise<string | null> {
  const sessionId = readCookie(request, COOKIE_NAME);
  if (!sessionId) return null;
  return await store.getSessionUser(deps.db, sessionId);
}

/** GET / */
export function handleHome(_deps: ProviderDeps, request: Request): Response {
  return html(landingPage(originOf(request)));
}

/** GET /login → start the Facebook federation for a human session. */
export function handleLogin(deps: ProviderDeps, request: Request): Promise<Response> {
  return startWebLogin(deps, request);
}

/** GET /dashboard */
export async function handleDashboard(deps: ProviderDeps, request: Request): Promise<Response> {
  const userId = await currentUser(deps, request);
  if (!userId) return redirect("/login");

  const [user, pages, authorizations] = await Promise.all([
    getUser(deps.db, userId),
    listPages(deps.db, userId),
    store.listUserAuthorizations(deps.db, userId),
  ]);
  if (!user) return redirect("/login");

  return html(dashboardPage({
    origin: originOf(request),
    userName: user.name,
    userId,
    pages,
    authorizations,
  }));
}

/** POST /logout */
export async function handleLogout(deps: ProviderDeps, request: Request): Promise<Response> {
  const sessionId = readCookie(request, COOKIE_NAME);
  if (sessionId) await store.deleteSession(deps.db, sessionId);
  return redirect("/", { "set-cookie": clearedSessionCookie() });
}

/** POST /revoke-client → revoke all tokens a user granted to one MCP client. */
export async function handleRevokeClient(deps: ProviderDeps, request: Request): Promise<Response> {
  const userId = await currentUser(deps, request);
  if (!userId) return redirect("/login");
  const form = new URLSearchParams(await request.text());
  const clientId = form.get("client_id");
  if (clientId) await store.deleteTokensForUserClient(deps.db, userId, clientId);
  return redirect("/dashboard");
}

/** POST /disconnect → remove the user's Pages and revoke all access. */
export async function handleDisconnect(deps: ProviderDeps, request: Request): Promise<Response> {
  const userId = await currentUser(deps, request);
  if (!userId) return redirect("/login");
  await Promise.all([
    deleteUser(deps.db, userId),
    store.deleteTokensForUser(deps.db, userId),
    store.deleteSessionsForUser(deps.db, userId),
  ]);
  return redirect("/", { "set-cookie": clearedSessionCookie() });
}
