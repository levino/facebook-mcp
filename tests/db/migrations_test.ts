import { assertEquals } from "@std/assert";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { migrate, MIGRATIONS } from "../../src/db/migrations.ts";

Deno.test("migrate applies all migrations on a fresh database", async () => {
  const db = createSqliteTestDb();
  const ran = await migrate(db);
  assertEquals(ran, MIGRATIONS.map((m) => m.id));

  // Tracking table records each applied migration.
  const { rows } = await db.execute({
    sql: "SELECT id FROM schema_migrations ORDER BY id",
  });
  assertEquals(rows.map((r) => String(r.id)), MIGRATIONS.map((m) => m.id));
  db.close();
});

Deno.test("migrate is idempotent — second run applies nothing", async () => {
  const db = createSqliteTestDb();
  await migrate(db);
  const second = await migrate(db);
  assertEquals(second, []);
  db.close();
});

Deno.test("migrate only runs pending migrations", async () => {
  const db = createSqliteTestDb();
  // Pretend 001 was already applied.
  await db.execute({
    sql: "CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  });
  await db.execute({
    sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
    args: ["001_token_store", 1],
  });
  const ran = await migrate(db);
  assertEquals(ran.includes("001_token_store"), false);
  db.close();
});

Deno.test("migrations create all expected tables", async () => {
  const db = createSqliteTestDb();
  await migrate(db);
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
  });
  const tables = rows.map((r) => String(r.name));
  for (
    const t of [
      "fb_users",
      "fb_pages",
      "oauth_clients",
      "oauth_logins",
      "oauth_codes",
      "oauth_tokens",
      "web_sessions",
    ]
  ) {
    assertEquals(tables.includes(t), true, `missing table ${t}`);
  }
  db.close();
});

Deno.test("migration ids are unique and ordered", () => {
  const ids = MIGRATIONS.map((m) => m.id);
  assertEquals(new Set(ids).size, ids.length);
  assertEquals([...ids].sort(), ids);
});
