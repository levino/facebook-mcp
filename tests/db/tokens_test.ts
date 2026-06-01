import { assertEquals, assertRejects } from "@std/assert";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import {
  ensureSchema,
  getPageToken,
  getToken,
  getUserToken,
  listPageTokens,
  saveUserAndPages,
  upsertToken,
  USER_TOKEN_ID,
} from "../../src/db/tokens.ts";

async function freshDb() {
  const db = createSqliteTestDb();
  await ensureSchema(db);
  return db;
}

Deno.test("ensureSchema is idempotent", async () => {
  const db = await freshDb();
  await ensureSchema(db); // second call must not throw
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='fb_tokens'",
  });
  assertEquals(rows.length, 1);
  db.close();
});

Deno.test("upsertToken inserts then updates the same id", async () => {
  const db = await freshDb();
  await upsertToken(db, {
    id: "page1",
    kind: "page",
    name: "Page One",
    accessToken: "tok-a",
    expiresAt: null,
  }, 1000);
  let token = await getToken(db, "page1");
  assertEquals(token?.accessToken, "tok-a");
  assertEquals(token?.updatedAt, 1000);

  await upsertToken(db, {
    id: "page1",
    kind: "page",
    name: "Page One Renamed",
    accessToken: "tok-b",
    expiresAt: 2000,
  }, 1500);
  token = await getToken(db, "page1");
  assertEquals(token?.accessToken, "tok-b");
  assertEquals(token?.name, "Page One Renamed");
  assertEquals(token?.expiresAt, 2000);
  assertEquals(token?.updatedAt, 1500);

  // Still a single row.
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS c FROM fb_tokens" });
  assertEquals(Number(rows[0].c), 1);
  db.close();
});

Deno.test("saveUserAndPages stores user token and all pages", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userToken: "user-tok",
    userTokenExpiresAt: 9999,
    pages: [
      { id: "100", name: "Levin Keller", accessToken: "page-100" },
      { id: "200", name: "CDU Nordstemmen", accessToken: "page-200" },
    ],
  }, 5000);

  const user = await getUserToken(db);
  assertEquals(user?.id, USER_TOKEN_ID);
  assertEquals(user?.kind, "user");
  assertEquals(user?.accessToken, "user-tok");
  assertEquals(user?.expiresAt, 9999);

  assertEquals(await getPageToken(db, "100"), "page-100");
  assertEquals(await getPageToken(db, "200"), "page-200");

  const pages = await listPageTokens(db);
  assertEquals(pages.length, 2);
  // Ordered by name: CDU before Levin.
  assertEquals(pages[0].name, "CDU Nordstemmen");
  assertEquals(pages[1].name, "Levin Keller");
  db.close();
});

Deno.test("saveUserAndPages re-run refreshes tokens without duplicating", async () => {
  const db = await freshDb();
  const once = {
    userToken: "u1",
    userTokenExpiresAt: null,
    pages: [{ id: "100", name: "Page", accessToken: "p1" }],
  };
  await saveUserAndPages(db, once, 1);
  await saveUserAndPages(db, {
    ...once,
    userToken: "u2",
    pages: [{ id: "100", name: "Page New", accessToken: "p2" }],
  }, 2);

  assertEquals((await getUserToken(db))?.accessToken, "u2");
  assertEquals(await getPageToken(db, "100"), "p2");
  const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS c FROM fb_tokens" });
  assertEquals(Number(rows[0].c), 2); // user + one page
  db.close();
});

Deno.test("getPageToken throws a helpful error for unknown page", async () => {
  const db = await freshDb();
  await assertRejects(
    () => getPageToken(db, "does-not-exist"),
    Error,
    "No access token stored for page does-not-exist",
  );
  db.close();
});

Deno.test("getPageToken rejects when id refers to the user token", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userToken: "u",
    userTokenExpiresAt: null,
    pages: [],
  });
  await assertRejects(() => getPageToken(db, USER_TOKEN_ID), Error);
  db.close();
});

Deno.test("getToken returns null for missing id", async () => {
  const db = await freshDb();
  assertEquals(await getToken(db, "nope"), null);
  db.close();
});
