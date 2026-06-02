/**
 * Entry point for the Bunny Edge Script.
 *
 * Wires the real dependencies (env config, Bunny Database, global fetch) into
 * the router and serves it via the Bunny Edge Scripting SDK. All logic lives in
 * the imported modules so this file stays trivial and free of test concerns.
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { assertRuntimeConfig, type Env, loadConfig } from "./config.ts";
import { createLibsqlDb } from "./db/client.ts";
import { GraphClient } from "./facebook/graph.ts";
import { createRouter } from "./router.ts";

function readEnv(): Env {
  // Bunny Edge Scripting (Deno) exposes Deno.env; node:process is also
  // supported. Fall back gracefully so the bundle runs in either.
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  if (g.Deno?.env?.toObject) return g.Deno.env.toObject();
  if (g.process?.env) return g.process.env as Env;
  return {};
}

const config = loadConfig(readEnv());
assertRuntimeConfig(config);

const router = createRouter({
  config,
  graph: new GraphClient({ version: config.graphVersion }),
  db: createLibsqlDb(config.databaseUrl, config.databaseAuthToken),
});

BunnySDK.net.http.serve(async (request: Request): Promise<Response> => {
  try {
    return await router(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Unhandled error:", message);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});
