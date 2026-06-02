/**
 * HTTP router. Maps requests to the website, the MCP OAuth authorization
 * server, the Facebook federation callback, and the authenticated MCP endpoint.
 * Returned as a single `(Request) => Promise<Response>` handler for the Bunny
 * SDK.
 */

import type { Config } from "./config.ts";
import type { GraphClient } from "./facebook/graph.ts";
import type { Db } from "./db/client.ts";
import { createMcpServer, type McpServer } from "./mcp/server.ts";
import { createTools } from "./mcp/tools.ts";
import { error as rpcError, ErrorCode } from "./mcp/jsonrpc.ts";
import {
  authenticate,
  handleAuthorize,
  handleFacebookCallback,
  handleRegister,
  handleRevoke,
  handleToken,
  originOf,
  type ProviderDeps,
  unauthorized,
} from "./oauth/provider.ts";
import { authorizationServerMetadata, protectedResourceMetadata } from "./oauth/metadata.ts";
import {
  handleDashboard,
  handleDisconnect,
  handleHome,
  handleLogin,
  handleLogout,
  handleRevokeClient,
} from "./web/handlers.ts";

export interface RouterDeps {
  config: Config;
  graph: GraphClient;
  db: Db;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Handler = (req: Request) => Response | Promise<Response>;

export function createRouter(deps: RouterDeps): (req: Request) => Promise<Response> {
  const provider: ProviderDeps = { config: deps.config, graph: deps.graph, db: deps.db };
  const tools = createTools({ graph: deps.graph, db: deps.db });
  const mcp = createMcpServer(tools, {
    name: deps.config.serverName,
    version: deps.config.serverVersion,
  });

  // method -> path -> handler
  const routes: Record<string, Record<string, Handler>> = {
    GET: {
      "/": (req) => handleHome(provider, req),
      "/health": () => json({ ok: true, service: deps.config.serverName }),
      "/login": (req) => handleLogin(provider, req),
      "/dashboard": (req) => handleDashboard(provider, req),
      "/oauth/callback": (req) => handleFacebookCallback(provider, req),
      "/authorize": (req) => handleAuthorize(provider, req),
      "/.well-known/oauth-protected-resource": (req) =>
        json(protectedResourceMetadata(originOf(req))),
      "/.well-known/oauth-authorization-server": (req) =>
        json(authorizationServerMetadata(originOf(req))),
    },
    POST: {
      "/register": (req) => handleRegister(provider, req),
      "/token": (req) => handleToken(provider, req),
      "/revoke": (req) => handleRevoke(provider, req),
      "/logout": (req) => handleLogout(provider, req),
      "/revoke-client": (req) => handleRevokeClient(provider, req),
      "/disconnect": (req) => handleDisconnect(provider, req),
    },
  };

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : "/";

    if (path === "/mcp") {
      return await handleMcp(provider, mcp, request);
    }

    const handlerFn = routes[request.method]?.[path];
    if (handlerFn) return await handlerFn(request);

    return json({ error: "Not found" }, 404);
  };
}

async function handleMcp(
  provider: ProviderDeps,
  mcp: McpServer,
  request: Request,
): Promise<Response> {
  const origin = originOf(request);

  // Stateless server: server-initiated SSE (GET) is not supported.
  if (request.method === "GET") {
    return json({ error: "This MCP server is stateless; use POST." }, 405, { allow: "POST" });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { allow: "POST" });
  }

  const auth = await authenticate(provider, request);
  if (!auth) return unauthorized(origin);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, ErrorCode.ParseError, "Parse error"), 400);
  }

  const response = await mcp.handle(payload, { userId: auth.userId });
  if (response === null) {
    // Notification(s) only — acknowledge with 202 and no body.
    return new Response(null, { status: 202 });
  }
  return json(response);
}
