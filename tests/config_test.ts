import { assertEquals, assertThrows } from "@std/assert";
import {
  assertRuntimeConfig,
  DEFAULT_GRAPH_VERSION,
  DEFAULT_OAUTH_SCOPE,
  loadConfig,
  resolveRedirectUri,
} from "../src/config.ts";

Deno.test("loadConfig fills defaults for optional values", () => {
  const config = loadConfig({});
  assertEquals(config.graphVersion, DEFAULT_GRAPH_VERSION);
  assertEquals(config.oauthScope, DEFAULT_OAUTH_SCOPE);
  assertEquals(config.serverName, "facebook-mcp");
  assertEquals(config.appId, "");
  assertEquals(config.mcpAuthToken, "");
});

Deno.test("loadConfig reads provided values", () => {
  const config = loadConfig({
    FACEBOOK_APP_ID: "123",
    FACEBOOK_APP_SECRET: "secret",
    FACEBOOK_GRAPH_VERSION: "v21.0",
    FACEBOOK_OAUTH_SCOPE: "pages_show_list",
    OAUTH_REDIRECT_URI: "https://example.com/oauth/callback",
    MCP_AUTH_TOKEN: "tok",
    BUNNY_DATABASE_URL: "libsql://db",
    BUNNY_DATABASE_AUTH_TOKEN: "dbtok",
  });
  assertEquals(config.appId, "123");
  assertEquals(config.graphVersion, "v21.0");
  assertEquals(config.oauthScope, "pages_show_list");
  assertEquals(config.oauthRedirectUri, "https://example.com/oauth/callback");
  assertEquals(config.databaseUrl, "libsql://db");
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

Deno.test("resolveRedirectUri prefers configured value", () => {
  const config = loadConfig({ OAUTH_REDIRECT_URI: "https://fixed.example/cb" });
  assertEquals(
    resolveRedirectUri(config, "https://worker.example/oauth/start"),
    "https://fixed.example/cb",
  );
});

Deno.test("resolveRedirectUri derives from request origin when unset", () => {
  const config = loadConfig({});
  assertEquals(
    resolveRedirectUri(config, "https://worker.example/oauth/start?x=1"),
    "https://worker.example/oauth/callback",
  );
});
