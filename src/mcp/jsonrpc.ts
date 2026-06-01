/** Minimal JSON-RPC 2.0 types and helpers for the MCP endpoint. */

export const JSONRPC_VERSION = "2.0";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  // deno-lint-ignore no-explicit-any
  params?: any;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  // deno-lint-ignore no-explicit-any
  result: any;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  // deno-lint-ignore no-explicit-any
  data?: any;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Standard JSON-RPC / MCP error codes. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

// deno-lint-ignore no-explicit-any
export function success(id: JsonRpcId, result: any): JsonRpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function error(
  id: JsonRpcId,
  code: number,
  message: string,
  // deno-lint-ignore no-explicit-any
  data?: any,
): JsonRpcError {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } };
}

/** A request without an `id` is a notification (no response expected). */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

// deno-lint-ignore no-explicit-any
export function isJsonRpcRequest(value: any): value is JsonRpcRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    value.jsonrpc === JSONRPC_VERSION &&
    typeof value.method === "string"
  );
}
