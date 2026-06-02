import { assertEquals, assertNotEquals } from "@std/assert";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { migrate } from "../../src/db/migrations.ts";
import * as store from "../../src/oauth/store.ts";

async function freshDb() {
  const db = createSqliteTestDb();
  await migrate(db);
  return db;
}

Deno.test("registerClient and getClient round-trip", async () => {
  const db = await freshDb();
  const client = await store.registerClient(db, {
    redirectUris: ["https://client.example/cb"],
    clientName: "Claude",
  });
  assertEquals(client.clientId.startsWith("mcp_"), true);
  const loaded = await store.getClient(db, client.clientId);
  assertEquals(loaded?.redirectUris, ["https://client.example/cb"]);
  assertEquals(loaded?.clientName, "Claude");
  db.close();
});

Deno.test("takeLogin returns once then is gone", async () => {
  const db = await freshDb();
  const id = await store.createLogin(db, {
    kind: "mcp",
    clientId: "c1",
    redirectUri: "https://c/cb",
    codeChallenge: "chal",
    scope: null,
    clientState: "xyz",
    resource: null,
  }, 600);
  const first = await store.takeLogin(db, id);
  assertEquals(first?.clientId, "c1");
  assertEquals(first?.clientState, "xyz");
  assertEquals(await store.takeLogin(db, id), null); // consumed
  db.close();
});

Deno.test("takeLogin returns null for an expired login", async () => {
  const db = await freshDb();
  const id = await store.createLogin(db, {
    kind: "web",
    clientId: null,
    redirectUri: null,
    codeChallenge: null,
    scope: null,
    clientState: null,
    resource: null,
  }, -1); // already expired
  assertEquals(await store.takeLogin(db, id), null);
  db.close();
});

Deno.test("takeCode is one-time and binds user + client", async () => {
  const db = await freshDb();
  const code = await store.createCode(db, {
    clientId: "c1",
    userId: "u1",
    redirectUri: "https://c/cb",
    codeChallenge: "chal",
    scope: "mcp",
  }, 300);
  const taken = await store.takeCode(db, code);
  assertEquals(taken?.userId, "u1");
  assertEquals(taken?.clientId, "c1");
  assertEquals(await store.takeCode(db, code), null);
  db.close();
});

Deno.test("access tokens validate by hash and expire", async () => {
  const db = await freshDb();
  const now = 1000;
  await store.storeTokens(db, {
    accessTokenHash: "ah",
    refreshTokenHash: "rh",
    clientId: "c1",
    userId: "u1",
    scope: null,
    expiresAt: now + 100,
    refreshExpiresAt: now + 1000,
  }, now);

  assertEquals((await store.getAccessToken(db, "ah", now + 50))?.userId, "u1");
  assertEquals(await store.getAccessToken(db, "ah", now + 200), null); // expired
  assertEquals(await store.getAccessToken(db, "nope", now + 50), null);
  db.close();
});

Deno.test("takeRefreshToken rotates (one-time)", async () => {
  const db = await freshDb();
  await store.storeTokens(db, {
    accessTokenHash: "ah",
    refreshTokenHash: "rh",
    clientId: "c1",
    userId: "u1",
    scope: null,
    expiresAt: 9_999_999_999,
    refreshExpiresAt: 9_999_999_999,
  });
  const rec = await store.takeRefreshToken(db, "rh");
  assertEquals(rec?.userId, "u1");
  assertEquals(await store.takeRefreshToken(db, "rh"), null);
  db.close();
});

Deno.test("deleteTokensForUserClient revokes only that client's tokens", async () => {
  const db = await freshDb();
  for (const [h, client] of [["a1", "c1"], ["a2", "c2"]] as const) {
    await store.storeTokens(db, {
      accessTokenHash: h,
      refreshTokenHash: null,
      clientId: client,
      userId: "u1",
      scope: null,
      expiresAt: 9999,
      refreshExpiresAt: null,
    });
  }
  await store.deleteTokensForUserClient(db, "u1", "c1");
  assertEquals(await store.getAccessToken(db, "a1", 0), null);
  assertNotEquals(await store.getAccessToken(db, "a2", 0), null);
  db.close();
});

Deno.test("listUserAuthorizations groups tokens by client", async () => {
  const db = await freshDb();
  await store.registerClient(db, { redirectUris: ["https://c/cb"], clientName: "Claude" });
  const client = await store.listUserAuthorizations(db, "u1");
  assertEquals(client.length, 0);

  const c = await store.registerClient(db, {
    redirectUris: ["https://c2/cb"],
    clientName: "Other",
  });
  await store.storeTokens(db, {
    accessTokenHash: "h1",
    refreshTokenHash: null,
    clientId: c.clientId,
    userId: "u1",
    scope: null,
    expiresAt: 9999,
    refreshExpiresAt: null,
  });
  const auths = await store.listUserAuthorizations(db, "u1");
  assertEquals(auths.length, 1);
  assertEquals(auths[0].clientName, "Other");
  assertEquals(auths[0].tokenCount, 1);
  db.close();
});

Deno.test("sessions resolve to a user and can be deleted", async () => {
  const db = await freshDb();
  const sid = await store.createSession(db, "u1", 3600);
  assertEquals(await store.getSessionUser(db, sid), "u1");
  await store.deleteSession(db, sid);
  assertEquals(await store.getSessionUser(db, sid), null);
  db.close();
});

Deno.test("expired sessions do not resolve", async () => {
  const db = await freshDb();
  const sid = await store.createSession(db, "u1", -1);
  assertEquals(await store.getSessionUser(db, sid), null);
  db.close();
});
