import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadConfig } from "../../src/config.ts";
import { GraphClient } from "../../src/facebook/graph.ts";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { seedUser } from "../helpers/seed.ts";
import type { ProviderDeps } from "../../src/oauth/provider.ts";
import * as store from "../../src/oauth/store.ts";
import { getUser } from "../../src/db/users.ts";
import {
  handleDashboard,
  handleDisconnect,
  handleHome,
  handleLogin,
  handleLogout,
  handleRevokeClient,
} from "../../src/web/handlers.ts";

const ORIGIN = "https://srv.example";

function makeDeps(db: ReturnType<typeof createSqliteTestDb>): ProviderDeps {
  return {
    config: loadConfig({ FACEBOOK_APP_ID: "app", FACEBOOK_APP_SECRET: "secret" }),
    graph: new GraphClient(),
    db,
  };
}

function req(path: string, init?: RequestInit) {
  return new Request(`${ORIGIN}${path}`, init);
}

Deno.test("home page renders with a login call to action", async () => {
  const db = createSqliteTestDb();
  const res = await handleHome(makeDeps(db), req("/"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const body = await res.text();
  assertStringIncludes(body, "Login with Facebook");
  assertStringIncludes(body, `${ORIGIN}/mcp`);
  db.close();
});

Deno.test("login redirects to Facebook", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "x", []); // just to migrate
  const res = await handleLogin(makeDeps(db), req("/login"));
  assertEquals(res.status, 302);
  assertStringIncludes(res.headers.get("location") ?? "", "facebook.com");
  db.close();
});

Deno.test("dashboard without a session redirects to login", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "x", []);
  const res = await handleDashboard(makeDeps(db), req("/dashboard"));
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/login");
  db.close();
});

Deno.test("dashboard with a session shows pages and authorizations", async () => {
  const db = createSqliteTestDb();
  await seedUser(
    db,
    "alice",
    [{ pageId: "100", name: "Levin Keller", accessToken: "pt" }],
    "Alice",
  );
  const client = await store.registerClient(db, {
    redirectUris: ["https://c/cb"],
    clientName: "Claude",
  });
  await store.storeTokens(db, {
    accessTokenHash: "h1",
    refreshTokenHash: null,
    clientId: client.clientId,
    userId: "alice",
    scope: null,
    expiresAt: 9_999_999_999,
    refreshExpiresAt: null,
  });
  const sid = await store.createSession(db, "alice", 3600);

  const res = await handleDashboard(
    makeDeps(db),
    req("/dashboard", { headers: { cookie: `fbmcp_session=${sid}` } }),
  );
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Alice");
  assertStringIncludes(body, "Levin Keller");
  assertStringIncludes(body, "Claude");
  db.close();
});

Deno.test("logout clears the session cookie", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", []);
  const sid = await store.createSession(db, "alice", 3600);
  const res = await handleLogout(
    makeDeps(db),
    req("/logout", { method: "POST", headers: { cookie: `fbmcp_session=${sid}` } }),
  );
  assertEquals(res.status, 302);
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "Max-Age=0");
  assertEquals(await store.getSessionUser(db, sid), null);
  db.close();
});

Deno.test("revoke-client removes that client's tokens", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", []);
  await store.storeTokens(db, {
    accessTokenHash: "h1",
    refreshTokenHash: null,
    clientId: "c1",
    userId: "alice",
    scope: null,
    expiresAt: 9_999_999_999,
    refreshExpiresAt: null,
  });
  const sid = await store.createSession(db, "alice", 3600);
  const res = await handleRevokeClient(
    makeDeps(db),
    req("/revoke-client", {
      method: "POST",
      headers: { cookie: `fbmcp_session=${sid}` },
      body: new URLSearchParams({ client_id: "c1" }).toString(),
    }),
  );
  assertEquals(res.status, 302);
  assertEquals(await store.getAccessToken(db, "h1", 0), null);
  db.close();
});

Deno.test("disconnect removes the user and clears the session", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", [{ pageId: "100", name: "P", accessToken: "pt" }]);
  const sid = await store.createSession(db, "alice", 3600);
  const res = await handleDisconnect(
    makeDeps(db),
    req("/disconnect", { method: "POST", headers: { cookie: `fbmcp_session=${sid}` } }),
  );
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/");
  assertEquals(await getUser(db, "alice"), null);
  assertEquals(await store.getSessionUser(db, sid), null);
  db.close();
});

Deno.test("revoke-client without a session redirects to login", async () => {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", []);
  const res = await handleRevokeClient(
    makeDeps(db),
    req("/revoke-client", { method: "POST", body: "client_id=c1" }),
  );
  assertEquals(res.headers.get("location"), "/login");
  db.close();
});
