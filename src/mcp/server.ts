/**
 * Stateless MCP server over Streamable HTTP (JSON responses).
 *
 * Implements the subset of the MCP protocol needed to expose tools:
 *   - initialize
 *   - notifications/initialized (and other notifications: ignored)
 *   - ping
 *   - tools/list
 *   - tools/call
 *
 * The server is transport-agnostic: {@link handleRpcMessage} takes a parsed
 * JSON-RPC payload (single or batch) and returns the response payload, or
 * `null` when the input contained only notifications.
 */

import {
  error,
  ErrorCode,
  isJsonRpcRequest,
  isNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  success,
} from "./jsonrpc.ts";
import type { Tool } from "./tools.ts";

/** Latest protocol version we implement; we echo the client's if compatible. */
export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export interface ServerInfo {
  name: string;
  version: string;
}

export interface McpServer {
  /** Returns the response payload, or null if nothing to respond with. */
  handle(payload: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null>;
}

export function createMcpServer(tools: Tool[], info: ServerInfo): McpServer {
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    switch (req.method) {
      case "initialize": {
        const requested = req.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
          ? requested
          : PROTOCOL_VERSION;
        return success(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
        });
      }
      case "ping":
        return success(id, {});
      case "tools/list":
        return success(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = req.params?.name;
        const tool = typeof name === "string" ? toolsByName.get(name) : undefined;
        if (!tool) {
          return error(id, ErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await tool.handler(args);
          return success(id, { content: [{ type: "text", text }], isError: false });
        } catch (err) {
          // Tool failures are returned as a result with isError=true so the
          // model can read and react to the message (per the MCP spec).
          const message = err instanceof Error ? err.message : String(err);
          return success(id, {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
          });
        }
      }
      default:
        return error(id, ErrorCode.MethodNotFound, `Method not found: ${req.method}`);
    }
  }

  async function handleOne(value: unknown): Promise<JsonRpcResponse | null> {
    if (!isJsonRpcRequest(value)) {
      return error(null, ErrorCode.InvalidRequest, "Invalid JSON-RPC request");
    }
    if (isNotification(value)) {
      // Notifications (initialized, cancelled, ...) get no response.
      return null;
    }
    return await handleRequest(value);
  }

  return {
    async handle(payload) {
      if (Array.isArray(payload)) {
        if (payload.length === 0) {
          return error(null, ErrorCode.InvalidRequest, "Empty batch");
        }
        const responses: JsonRpcResponse[] = [];
        for (const item of payload) {
          const res = await handleOne(item);
          if (res) responses.push(res);
        }
        return responses.length > 0 ? responses : null;
      }
      return await handleOne(payload);
    },
  };
}
