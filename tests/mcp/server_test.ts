import { assertEquals } from "@std/assert";
import { createMcpServer, PROTOCOL_VERSION } from "../../src/mcp/server.ts";
import type { Tool } from "../../src/mcp/tools.ts";
import type { JsonRpcError, JsonRpcSuccess } from "../../src/mcp/jsonrpc.ts";

function makeServer(extra: Tool[] = []) {
  const tools: Tool[] = [
    {
      name: "echo",
      description: "echoes",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      handler: (args) => Promise.resolve(String(args.text ?? "")),
    },
    {
      name: "boom",
      description: "throws",
      inputSchema: { type: "object" },
      handler: () => Promise.reject(new Error("kaboom")),
    },
    ...extra,
  ];
  return createMcpServer(tools, { name: "test-server", version: "9.9.9" });
}

Deno.test("initialize returns server info and capabilities", async () => {
  const server = makeServer();
  const res = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {} },
  }) as JsonRpcSuccess;
  assertEquals(res.id, 1);
  assertEquals(res.result.protocolVersion, "2025-06-18");
  assertEquals(res.result.serverInfo, { name: "test-server", version: "9.9.9" });
  assertEquals(res.result.capabilities.tools !== undefined, true);
});

Deno.test("initialize falls back to latest protocol for unknown version", async () => {
  const server = makeServer();
  const res = await server.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "1999-01-01" },
  }) as JsonRpcSuccess;
  assertEquals(res.result.protocolVersion, PROTOCOL_VERSION);
});

Deno.test("ping returns empty result", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: "p",
    method: "ping",
  }) as JsonRpcSuccess;
  assertEquals(res.result, {});
});

Deno.test("tools/list returns registered tools", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }) as JsonRpcSuccess;
  const names = res.result.tools.map((t: { name: string }) => t.name);
  assertEquals(names, ["echo", "boom"]);
  assertEquals(res.result.tools[0].inputSchema.type, "object");
});

Deno.test("tools/call returns text content", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hi" } },
  }) as JsonRpcSuccess;
  assertEquals(res.result.isError, false);
  assertEquals(res.result.content, [{ type: "text", text: "hi" }]);
});

Deno.test("tools/call wraps thrown errors as isError result", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "boom", arguments: {} },
  }) as JsonRpcSuccess;
  assertEquals(res.result.isError, true);
  assertEquals(res.result.content[0].text, "Error: kaboom");
});

Deno.test("tools/call with unknown tool is an InvalidParams error", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "nope" },
  }) as JsonRpcError;
  assertEquals(res.error.code, -32602);
});

Deno.test("unknown method returns MethodNotFound", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    id: 6,
    method: "does/notexist",
  }) as JsonRpcError;
  assertEquals(res.error.code, -32601);
});

Deno.test("notifications produce no response", async () => {
  const res = await makeServer().handle({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assertEquals(res, null);
});

Deno.test("invalid JSON-RPC shape returns InvalidRequest", async () => {
  const res = await makeServer().handle({ foo: "bar" }) as JsonRpcError;
  assertEquals(res.error.code, -32600);
});

Deno.test("batch returns responses for requests, drops notifications", async () => {
  const res = await makeServer().handle([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]) as JsonRpcSuccess[];
  assertEquals(Array.isArray(res), true);
  assertEquals(res.length, 2);
  assertEquals(res[0].id, 1);
  assertEquals(res[1].id, 2);
});

Deno.test("batch with only notifications returns null", async () => {
  const res = await makeServer().handle([
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  assertEquals(res, null);
});

Deno.test("empty batch is InvalidRequest", async () => {
  const res = await makeServer().handle([]) as JsonRpcError;
  assertEquals(res.error.code, -32600);
});
