# facebook-mcp

An [MCP](https://modelcontextprotocol.io) server that exposes Facebook Page operations (create /
publish / edit / delete / repost / upload image) as tools, implemented as a **Bunny Edge Script**
(Deno) and backed by **Bunny Database** (libSQL) for token storage.

It implements the design sketched in [`FACEBOOK_MCP_HANDBOOK.md`](./FACEBOOK_MCP_HANDBOOK.md),
targeting [bunny.net Edge Scripting](https://bunny.net/edge-scripting/) instead of the Cloudflare
Worker originally drafted there.

## Architecture

```
MCP client (Claude, …)
    │  Streamable HTTP (JSON-RPC 2.0)  POST /mcp   (Bearer auth)
    ▼
Bunny Edge Script  (src/main.ts → router)
    ├── POST /mcp            MCP endpoint (tools)
    ├── GET  /oauth/start    redirect to Facebook login
    ├── GET  /oauth/callback exchange code, store tokens
    └── GET  /health
    │
    ├── Bunny Database (libSQL)  ── page & user access tokens
    └── Facebook Graph API v22.0 ── page operations
```

Everything except `src/main.ts` is plain, dependency-injected TypeScript with no Bunny/Deno-runtime
coupling, so the whole request path is unit-tested with an in-memory SQLite database and a mocked
`fetch`.

| Path                    | Responsibility                                          |
| ----------------------- | ------------------------------------------------------- |
| `src/config.ts`         | Parse + validate environment configuration              |
| `src/db/client.ts`      | `Db` interface + Bunny Database (libSQL) implementation |
| `src/db/tokens.ts`      | Token schema and store                                  |
| `src/facebook/graph.ts` | Graph API client (injectable `fetch`)                   |
| `src/oauth/handlers.ts` | OAuth start / callback                                  |
| `src/mcp/*`             | JSON-RPC types, tool registry, MCP dispatch             |
| `src/router.ts`         | HTTP routing + bearer auth                              |
| `src/main.ts`           | Wires real deps and serves via the Bunny SDK            |

## Tools

| Tool           | Arguments                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| `list_pages`   | –                                                                                  |
| `create_post`  | `page_id`, `message?`, `link?`, `draft?`, `scheduled_publish_time?`, `image_urls?` |
| `publish_post` | `page_id`, `post_id`                                                               |
| `edit_post`    | `page_id`, `post_id`, `message`                                                    |
| `delete_post`  | `page_id`, `post_id`                                                               |
| `repost`       | `source_page_id`, `target_page_id`, `post_id`, `message?`                          |
| `upload_image` | `page_id`, `image_url`                                                             |

## Development

Requires [Deno](https://deno.com) 2.x (the same runtime as Bunny Edge Scripting).

```bash
deno task test       # run the test suite (71 tests, in-memory SQLite + mocked fetch)
deno task check      # type-check
deno task lint       # lint
deno task fmt        # format
deno task build      # bundle to dist/main.js (must stay < 1 MiB)
deno task dev        # run locally on http://127.0.0.1:8080
```

Copy `.env.example` to `.env` and fill it in for local runs.

## Deployment (Bunny Edge Scripting)

Deployment uses bunny.net's **native GitHub integration**: bunny watches `main` and, on every push,
runs the configured build command and deploys the resulting entry file. There is no deploy workflow
in this repo and no GitHub secrets are required.

1. In the bunny.net dashboard, connect this repository to the Edge Script and set:
   - **Install command:** _(none — Deno resolves imports during build)_
   - **Build command:** `deno task build`
   - **Entry file:** `dist/main.js`
2. Create a **Bunny Database** and, under _Access → Generate Tokens_, create credentials. Note the
   database URL and auth token.
3. Set these as environment variables on the Edge Script:

   | Variable                    | Notes                                                                         |
   | --------------------------- | ----------------------------------------------------------------------------- |
   | `FACEBOOK_APP_ID`           | Facebook app id (`1290277286624394`)                                          |
   | `FACEBOOK_APP_SECRET`       | Facebook app secret                                                           |
   | `OAUTH_REDIRECT_URI`        | `https://<your-script-host>/oauth/callback` (also whitelist it in the FB app) |
   | `MCP_AUTH_TOKEN`            | Bearer token required on `/mcp` (strongly recommended)                        |
   | `BUNNY_DATABASE_URL`        | from step 2                                                                   |
   | `BUNNY_DATABASE_AUTH_TOKEN` | from step 2                                                                   |

4. Apply the database schema once (the OAuth callback also creates it lazily):

   ```bash
   BUNNY_DATABASE_URL=… BUNNY_DATABASE_AUTH_TOKEN=… deno task migrate
   ```

> CI (`.github/workflows/checks.yml`) runs fmt/lint/type-check/test/build on pushes and PRs.
> Bundling is also part of the build that bunny runs, so a green `checks` run means the artifact
> bunny deploys will build too.

## Connecting a Facebook account

Visit `https://<your-script-host>/oauth/start` in a browser, log in as a Facebook user who is an
admin of the target pages and a registered tester of the app (the app is in Development Mode — see
the handbook). The callback exchanges the code for a long-lived token, derives the per-page access
tokens from `/me/accounts`, and stores them in Bunny Database. Tools then resolve page tokens from
there.

## Using from an MCP client

Point a Streamable-HTTP MCP client at `https://<your-script-host>/mcp` with an
`Authorization: Bearer <MCP_AUTH_TOKEN>` header. Example `.mcp.json`:

```json
{
  "mcpServers": {
    "facebook": {
      "type": "http",
      "url": "https://<your-script-host>/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

## Hatchery / dev container

`.devcontainer/devcontainer.json` mirrors the
[`levinkeller.de`](https://github.com/levino/levinkeller.de) hatchery setup (Tailscale join via
`HATCHERY_TS_*`) and adds the Deno toolchain, so a hatchery drone can pick up this repo and
immediately run `deno task test` / `deno task build`. Deployment goes through bunny.net's native
GitHub integration, so no cluster access is required to ship.
