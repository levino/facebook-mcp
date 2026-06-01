/**
 * Bundles the edge script into a single minified ESM file for deployment.
 *
 * Bunny Edge Scripting requires a single uploaded file with no filesystem
 * access, so all dependencies are bundled and Node built-ins are left external
 * (imported via the `node:` protocol at runtime).
 *
 *   deno task build   ->  dist/main.js
 */

import * as esbuild from "esbuild";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@^0.11.1";
import { builtinModules } from "node:module";
import { resolve, toFileUrl } from "jsr:@std/path@^1.0.0";

const outfile = "dist/main.js";
const configPath = resolve("deno.json");

const result = await esbuild.build({
  // The Deno loader resolves the deno.json import map plus npm:/jsr: specifiers
  // exactly like the runtime does, so the bundle matches local behaviour.
  // Cast bridges the loader's pinned esbuild types and ours (same shape).
  plugins: denoPlugins({ configPath }) as unknown as esbuild.Plugin[],
  entryPoints: [toFileUrl(resolve("src/main.ts")).href],
  outfile,
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "deno2",
  minify: true,
  keepNames: false,
  legalComments: "none",
  // Node built-ins are provided by the Deno runtime on the edge.
  external: [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  metafile: true,
  logLevel: "info",
});

const bytes = result.metafile
  ? Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
  : 0;
const kib = (bytes / 1024).toFixed(1);
console.log(`Bundled ${outfile} (${kib} KiB)`);
if (bytes > 1024 * 1024) {
  console.error("Bundle exceeds the 1 MiB Edge Scripting limit!");
  esbuild.stop();
  Deno.exit(1);
}

esbuild.stop();
