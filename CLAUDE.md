# Claude Code Configuration

Guidelines for working on `facebook-mcp` with Claude Code.

## Overview

Multi-tenant MCP server: any user connects their own Facebook account and manages their own Pages.
Runs as a **Bunny Edge Script** (Deno) with state in **Bunny Database** (libSQL). MCP clients
authenticate via a built-in **OAuth 2.1 (PKCE) authorization server federated to Facebook** — there
is no shared secret. A small website (`src/web`) provides Login with Facebook, a dashboard, and
token revocation. Design background lives in `FACEBOOK_MCP_HANDBOOK.md`; architecture in
`README.md`.

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
- **Tenant isolation** is enforced in the data layer: every tool resolves page tokens via
  `getPageToken(db, ctx.userId, pageId)`, which throws if the user does not own the page. New tools
  must be user-scoped the same way; never look up a page without the `userId`.
- **Schema changes** go through `src/db/migrations.ts` as a new appended migration (never edit a
  released one). Raw OAuth tokens are never stored — only their SHA-256 hashes.
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
