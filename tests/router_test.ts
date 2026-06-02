import { assertEquals, assertStringIncludes } from "@std/assert";
import { createRouter } from "../src/router.ts";
import { GraphClient } from "../src/facebook/graph.ts";
import { loadConfig } from "../src/config.ts";
import { createFetchMock } from "./helpers/fetch_mock.ts";
import { createSqliteTestDb } from "./helpers/sqlite_db.ts";
import { issueAccessToken, seedUser } from "./helpers/seed.ts";

async function makeRouter() {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", [{ pageId: "100", name: "Levin Keller", accessToken: "pt-100" }]);
  const mock = createFetchMock(() => ({ json: { id: "100_1" } }));
  const config = loadConfig({ FACEBOOK_APP_ID: "app", FACEBOOK_APP_SECRET: "secret" });
  const graph = new GraphClient({ fetch: mock.fetch });
  return { router: createRouter({ config, graph, db }), db, mock };
}

function mcp(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://srv.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

Deno.test("GET / serves the landing page", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://srv.example/"));
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "Login with Facebook");
  db.close();
});

Deno.test("GET /health returns ok", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://srv.example/health"));
  assertEquals(res.status, 200);
  assertEquals((await res.json()).ok, true);
  db.close();
});

Deno.test("protected-resource metadata points to this server", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    new Request("https://srv.example/.well-known/oauth-protected-resource"),
  );
  const body = await res.json();
  assertEquals(body.resource, "https://srv.example/mcp");
  assertEquals(body.authorization_servers, ["https://srv.example"]);
  db.close();
});

Deno.test("authorization-server metadata advertises the endpoints", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    new Request("https://srv.example/.well-known/oauth-authorization-server"),
  );
  const body = await res.json();
  assertEquals(body.authorization_endpoint, "https://srv.example/authorize");
  assertEquals(body.token_endpoint, "https://srv.example/token");
  assertEquals(body.registration_endpoint, "https://srv.example/register");
  assertEquals(body.code_challenge_methods_supported, ["S256"]);
  db.close();
});

Deno.test("POST /mcp without a token is 401 with discovery pointer", async () => {
  const { router, db } = await makeRouter();
  const res = await router(mcp({ jsonrpc: "2.0", id: 1, method: "ping" }));
  assertEquals(res.status, 401);
  assertStringIncludes(
    res.headers.get("www-authenticate") ?? "",
    "/.well-known/oauth-protected-resource",
  );
  db.close();
});

Deno.test("POST /mcp with an invalid token is 401", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    mcp({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" }),
  );
  assertEquals(res.status, 401);
  db.close();
});

Deno.test("POST /mcp with a valid token serves the MCP protocol", async () => {
  const { router, db } = await makeRouter();
  const token = await issueAccessToken(db, "alice");
  const res = await router(
    mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {
      authorization: `Bearer ${token}`,
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.result.serverInfo.name, "facebook-mcp");
  db.close();
});

Deno.test("authenticated tools/call is scoped to the token's user", async () => {
  const { router, db } = await makeRouter();
  const token = await issueAccessToken(db, "alice");
  const res = await router(
    mcp({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_post", arguments: { page_id: "100", message: "hi", draft: true } },
    }, { authorization: `Bearer ${token}` }),
  );
  const body = await res.json();
  assertEquals(body.result.isError, false);
  assertStringIncludes(body.result.content[0].text, "Created draft 100_1");
  db.close();
});

Deno.test("a token for another user cannot touch alice's page", async () => {
  const { router, db } = await makeRouter();
  const bobToken = await issueAccessToken(db, "bob"); // bob has no pages
  const res = await router(
    mcp({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "create_post", arguments: { page_id: "100", message: "x" } },
    }, { authorization: `Bearer ${bobToken}` }),
  );
  const body = await res.json();
  assertEquals(body.result.isError, true);
  assertStringIncludes(body.result.content[0].text, "not connected to your account");
  db.close();
});

Deno.test("POST /mcp notification yields 202", async () => {
  const { router, db } = await makeRouter();
  const token = await issueAccessToken(db, "alice");
  const res = await router(
    mcp({ jsonrpc: "2.0", method: "notifications/initialized" }, {
      authorization: `Bearer ${token}`,
    }),
  );
  assertEquals(res.status, 202);
  db.close();
});

Deno.test("GET /mcp is rejected (stateless, POST only)", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://srv.example/mcp"));
  assertEquals(res.status, 405);
  db.close();
});

Deno.test("GET /authorize for an unknown client is a 400", async () => {
  const { router, db } = await makeRouter();
  const res = await router(
    new Request(
      "https://srv.example/authorize?response_type=code&client_id=nope&redirect_uri=https://x/cb&code_challenge=c&code_challenge_method=S256",
    ),
  );
  assertEquals(res.status, 400);
  db.close();
});

Deno.test("unknown route returns 404", async () => {
  const { router, db } = await makeRouter();
  const res = await router(new Request("https://srv.example/nope"));
  assertEquals(res.status, 404);
  db.close();
});
