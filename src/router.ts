/**
 * HTTP router. Maps incoming requests to the MCP endpoint, the OAuth handlers
 * and a health check. Returned as a single `(Request) => Promise<Response>`
 * handler so it can be passed straight to `BunnySDK.net.http.serve`.
 */

import type { Config } from "./config.ts";
import type { GraphClient } from "./facebook/graph.ts";
import type { Db } from "./db/client.ts";
import { handleOAuthCallback, handleOAuthStart } from "./oauth/handlers.ts";
import { createMcpServer } from "./mcp/server.ts";
import { createTools } from "./mcp/tools.ts";
import { error as rpcError, ErrorCode } from "./mcp/jsonrpc.ts";

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

/** Constant-time-ish bearer check (length-guarded equality). */
function authorized(config: Config, request: Request): boolean {
  if (!config.mcpAuthToken) return true; // auth disabled
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.mcpAuthToken}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < header.length; i++) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

export function createRouter(deps: RouterDeps): (req: Request) => Promise<Response> {
  const tools = createTools({ graph: deps.graph, db: deps.db });
  const mcp = createMcpServer(tools, {
    name: deps.config.serverName,
    version: deps.config.serverVersion,
  });
  const oauthDeps = { config: deps.config, graph: deps.graph, db: deps.db };

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && (path === "/health" || path === "/")) {
      return json({ ok: true, service: deps.config.serverName });
    }

    if (path === "/oauth/start" && request.method === "GET") {
      return handleOAuthStart(oauthDeps, request);
    }

    if (path === "/oauth/callback" && request.method === "GET") {
      return await handleOAuthCallback(oauthDeps, request);
    }

    if (path === "/mcp") {
      return await handleMcp(deps.config, mcp, request);
    }

    return json({ error: "Not found" }, 404);
  };
}

async function handleMcp(
  config: Config,
  mcp: ReturnType<typeof createMcpServer>,
  request: Request,
): Promise<Response> {
  // The Streamable HTTP transport uses GET for server-initiated SSE streams.
  // This server is stateless and only answers POST requests.
  if (request.method === "GET") {
    return json({ error: "This MCP server is stateless; use POST." }, 405, {
      allow: "POST",
    });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { allow: "POST" });
  }
  if (!authorized(config, request)) {
    return json({ error: "Unauthorized" }, 401, {
      "www-authenticate": "Bearer",
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json(rpcError(null, ErrorCode.ParseError, "Parse error"), 400);
  }

  const response = await mcp.handle(payload);
  if (response === null) {
    // Notification(s) only — acknowledge with 202 and no body.
    return new Response(null, { status: 202 });
  }
  return json(response);
}
