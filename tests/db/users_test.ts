import { assertEquals, assertRejects } from "@std/assert";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { migrate } from "../../src/db/migrations.ts";
import {
  deleteUser,
  getPageToken,
  getUser,
  listPages,
  saveUserAndPages,
} from "../../src/db/users.ts";

async function freshDb() {
  const db = createSqliteTestDb();
  await migrate(db);
  return db;
}

Deno.test("saveUserAndPages stores a user and their pages", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userId: "u1",
    name: "Alice",
    userToken: "ut1",
    expiresAt: 9999,
    pages: [
      { pageId: "100", name: "Page A", accessToken: "pt-100" },
      { pageId: "200", name: "Page B", accessToken: "pt-200" },
    ],
  }, 5000);

  const user = await getUser(db, "u1");
  assertEquals(user?.name, "Alice");
  assertEquals(user?.userToken, "ut1");
  assertEquals(user?.expiresAt, 9999);

  assertEquals(await getPageToken(db, "u1", "100"), "pt-100");
  assertEquals((await listPages(db, "u1")).length, 2);
  db.close();
});

Deno.test("saveUserAndPages replaces the page set (removes stale pages)", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userId: "u1",
    name: "Alice",
    userToken: "ut1",
    expiresAt: null,
    pages: [{ pageId: "100", name: "A", accessToken: "p1" }],
  });
  await saveUserAndPages(db, {
    userId: "u1",
    name: "Alice",
    userToken: "ut2",
    expiresAt: null,
    pages: [{ pageId: "200", name: "B", accessToken: "p2" }],
  });
  const pages = await listPages(db, "u1");
  assertEquals(pages.map((p) => p.pageId), ["200"]);
  await assertRejects(() => getPageToken(db, "u1", "100"));
  db.close();
});

Deno.test("tenant isolation: a user cannot access another user's page", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userId: "alice",
    name: "Alice",
    userToken: "a",
    expiresAt: null,
    pages: [{ pageId: "100", name: "Alice Page", accessToken: "alice-pt" }],
  });
  await saveUserAndPages(db, {
    userId: "bob",
    name: "Bob",
    userToken: "b",
    expiresAt: null,
    pages: [{ pageId: "200", name: "Bob Page", accessToken: "bob-pt" }],
  });

  // Bob owns 200, not 100 — even though 100 exists for Alice.
  assertEquals(await getPageToken(db, "bob", "200"), "bob-pt");
  await assertRejects(
    () => getPageToken(db, "bob", "100"),
    Error,
    "not connected to your account",
  );
  // Alice only sees her own pages.
  assertEquals((await listPages(db, "alice")).map((p) => p.pageId), ["100"]);
  db.close();
});

Deno.test("deleteUser removes the user and their pages", async () => {
  const db = await freshDb();
  await saveUserAndPages(db, {
    userId: "u1",
    name: "A",
    userToken: "t",
    expiresAt: null,
    pages: [{ pageId: "100", name: "A", accessToken: "p" }],
  });
  await deleteUser(db, "u1");
  assertEquals(await getUser(db, "u1"), null);
  assertEquals((await listPages(db, "u1")).length, 0);
  db.close();
});

Deno.test("getPageToken throws a helpful error for an unconnected page", async () => {
  const db = await freshDb();
  await assertRejects(
    () => getPageToken(db, "nobody", "999"),
    Error,
    "not connected to your account",
  );
  db.close();
});
