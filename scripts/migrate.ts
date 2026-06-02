/**
 * Applies the database schema to the configured Bunny Database.
 *
 *   BUNNY_DATABASE_URL=... BUNNY_DATABASE_AUTH_TOKEN=... deno task migrate
 */

import { loadConfig } from "../src/config.ts";
import { createLibsqlDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrations.ts";

const config = loadConfig(Deno.env.toObject());
if (!config.databaseUrl || !config.databaseAuthToken) {
  console.error("BUNNY_DATABASE_URL and BUNNY_DATABASE_AUTH_TOKEN must be set.");
  Deno.exit(1);
}

const db = createLibsqlDb(config.databaseUrl, config.databaseAuthToken);
const ran = await migrate(db);
if (ran.length === 0) {
  console.log("Database already up to date:", config.databaseUrl);
} else {
  console.log(`Applied ${ran.length} migration(s) to ${config.databaseUrl}:`);
  for (const id of ran) console.log("  -", id);
}
