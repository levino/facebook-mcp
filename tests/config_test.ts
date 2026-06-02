import { assertEquals, assertThrows } from "@std/assert";
import {
  assertRuntimeConfig,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_OAUTH_SCOPE,
  loadConfig,
} from "../src/config.ts";

Deno.test("loadConfig fills defaults for optional values", () => {
  const config = loadConfig({});
  assertEquals(config.graphVersion, DEFAULT_GRAPH_VERSION);
  assertEquals(config.oauthScope, DEFAULT_OAUTH_SCOPE);
  assertEquals(config.serverName, "facebook-mcp");
  assertEquals(config.appId, "");
  // TTL defaults
  assertEquals(config.accessTokenTtlSeconds, 3600);
  assertEquals(config.codeTtlSeconds, 300);
  assertEquals(config.sessionTtlSeconds, 60 * 60 * 24 * 7);
});

Deno.test("loadConfig reads provided values and TTL overrides", () => {
  const config = loadConfig({
    FACEBOOK_APP_ID: "123",
    FACEBOOK_APP_SECRET: "secret",
    FACEBOOK_GRAPH_VERSION: "v21.0",
    FACEBOOK_OAUTH_SCOPE: "pages_show_list",
    BUNNY_DATABASE_URL: "libsql://db",
    BUNNY_DATABASE_AUTH_TOKEN: "dbtok",
    ACCESS_TOKEN_TTL: "120",
  });
  assertEquals(config.appId, "123");
  assertEquals(config.graphVersion, "v21.0");
  assertEquals(config.oauthScope, "pages_show_list");
  assertEquals(config.databaseUrl, "libsql://db");
  assertEquals(config.accessTokenTtlSeconds, 120);
});

Deno.test("loadConfig ignores invalid TTL values", () => {
  const config = loadConfig({ ACCESS_TOKEN_TTL: "not-a-number", CODE_TTL: "-5" });
  assertEquals(config.accessTokenTtlSeconds, 3600);
  assertEquals(config.codeTtlSeconds, 300);
});

Deno.test("assertRuntimeConfig throws listing all missing vars", () => {
  const err = assertThrows(() => assertRuntimeConfig(loadConfig({})));
  const message = (err as Error).message;
  for (
    const v of [
      "FACEBOOK_APP_ID",
      "FACEBOOK_APP_SECRET",
      "BUNNY_DATABASE_URL",
      "BUNNY_DATABASE_AUTH_TOKEN",
    ]
  ) {
    if (!message.includes(v)) throw new Error(`expected message to mention ${v}`);
  }
});

Deno.test("assertRuntimeConfig passes when all required present", () => {
  assertRuntimeConfig(
    loadConfig({
      FACEBOOK_APP_ID: "1",
      FACEBOOK_APP_SECRET: "2",
      BUNNY_DATABASE_URL: "3",
      BUNNY_DATABASE_AUTH_TOKEN: "4",
    }),
  );
});
