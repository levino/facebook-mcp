import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRouter } from "../src/router.ts";
import { GraphClient } from "../src/facebook/graph.ts";
import { loadConfig } from "../src/config.ts";
import { createFetchMock } from "./helpers/fetch_mock.ts";
import { createSqliteTestDb } from "./helpers/sqlite_db.ts";
import { ensureSchema, saveUserAndPages } from "../src/db/tokens.ts";

async function makeRouter(opts: { authToken?: string } = {}) {
  const db = createSqliteTestDb();
  await ensureSchema(db);
  await saveUserAndPages(db, {
    userToken: "u",
    userTokenExpiresAt: null,
    pages: [{ id: "100", name: "Levin Keller", accessToken: "pt-100" }],
  });
  const mock = createFetchMock(() => ({ json: { id: "100_1" } }));
  const config = loadConfig({
    FACEBOOK_APP_ID: "app",
    FACEBOOK_APP_SECRET: "secret",
    MCP_AUTH_TOKEN: opts.authToken ?? "",
  });
  const graph = new GraphClient({ fetch: mock.fetch });
  return { router: createRouter({ config, graph, db }), db, mock };
}

function mcpRequest(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("GET /health returns ok", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://worker.example/health"));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  db.close();
});

Deno.test("unknown route returns 404", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://worker.example/nope"));
  assertEquals(res.status, 404);
  db.close();
});

Deno.test("GET /oauth/start redirects to Facebook", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://worker.example/oauth/start"));
  assertEquals(res.status, 302);
  assertStringIncludes(res.headers.get("location") ?? "", "facebook.com");
  db.close();
});

Deno.test("POST /mcp initialize works without auth when token unset", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.id, 1);
  assertEquals(body.result.serverInfo.name, "facebook-mcp");
  db.close();
});

Deno.test("POST /mcp tools/list returns the tools", async () => {
  const { router, db } = await makeRouter();
  const res = await router(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const body = await res.json();
  assertEquals(body.result.tools.length, 7);
  db.close();
});

Deno.test("POST /mcp notification yields 202 with no body", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  assertEquals(res.status, 202);
  assertEquals(await res.text(), "");
  db.close();
});

Deno.test("POST /mcp with invalid JSON returns parse error", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, -32700);
  db.close();
});

Deno.test("GET /mcp is rejected (stateless, POST only)", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://worker.example/mcp"));
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "POST");
  db.close();
});

Deno.test("auth: missing bearer token is rejected", async () => {
  const { router, db } = await makeRouter({ authToken: "s3cret" });
  const res = await router(mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("www-authenticate"), "Bearer");
  db.close();
});

Deno.test("auth: wrong bearer token is rejected", async () => {
  const { router, db } = await makeRouter({ authToken: "s3cret" });
  const res = await router(
    mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" }),
  );
  assertEquals(res.status, 401);
  db.close();
});

Deno.test("auth: correct bearer token is accepted", async () => {
  const { router, db } = await makeRouter({ authToken: "s3cret" });
  const res = await router(
    mcpRequest(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { authorization: "Bearer s3cret" },
    ),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).result, {});
  db.close();
});

Deno.test("end-to-end: tools/call create_post via /mcp", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    mcpRequest({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "create_post", arguments: { page_id: "100", message: "hi", draft: true } },
    }),
  );
  const body = await res.json();
  assertEquals(body.result.isError, false);
  assertStringIncludes(body.result.content[0].text, "Created draft 100_1");
  db.close();
});
