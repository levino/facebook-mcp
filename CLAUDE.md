# Claude Code Configuration

Guidelines for working on `facebook-mcp` with Claude Code.

## Overview

MCP server exposing Facebook Page operations as tools. Runs as a **Bunny Edge Script** (Deno
runtime) with token storage in **Bunny Database** (libSQL). Design background lives in
`FACEBOOK_MCP_HANDBOOK.md`; the running architecture is documented in `README.md`.

## Toolchain

- **Runtime/dev:** Deno 2.x (matches the Bunny edge runtime). No `package.json`.
- **Imports:** declared in `deno.json` (`npm:` / `jsr:` specifiers).
- **Bundling:** esbuild + `@luca/esbuild-deno-loader` → single `dist/main.js` (must stay < 1 MiB;
  Bunny only accepts one bundled file with no filesystem access).

## Commands

```bash
deno task test    # full suite (must pass before committing)
deno task check   # type-check src + scripts
deno task lint    # deno lint
deno task fmt     # format (run before committing)
deno task build   # bundle to dist/main.js and assert the size budget
deno task dev     # serve locally on :8080
```

## Conventions

- **Keep `src/main.ts` trivial.** It is the only file allowed to import `@bunny.net/edgescript-sdk`
  or read the environment. Everything else takes its dependencies (config, `Db`, `GraphClient`,
  `fetch`) as parameters so it stays unit-testable without the edge runtime.
- **Tests live in `tests/`** and use real in-memory SQLite (`node:sqlite`, via
  `tests/helpers/sqlite_db.ts`) and a mocked `fetch` (`tests/helpers/fetch_mock.ts`) — no network,
  no native libSQL bindings. Add tests alongside any behaviour change.
- **Tool errors** are returned to the model as `tools/call` results with `isError: true`, not as
  JSON-RPC protocol errors. Only protocol-level problems (unknown method, bad request) use error
  responses.
- **Secrets** never go in the repo. Local dev reads `.env` (gitignored); production reads Edge
  Script environment variables.
- Use English for magic GitHub keywords in commits/PRs (`closes`, `fixes`), even when writing German
  prose.

## Before committing

```bash
deno task fmt && deno task lint && deno task check && deno task test && deno task build
```
