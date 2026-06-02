# facebook-mcp

A multi-tenant [MCP](https://modelcontextprotocol.io) server that lets **any** user connect their
own Facebook account and manage **their own** Pages (create, schedule, edit, publish, repost, upload
images) from an MCP client like Claude.

It runs as a **Bunny Edge Script** (Deno) backed by **Bunny Database** (libSQL), and includes a
small website with "Login with Facebook", a dashboard, and token revocation. It implements the
design sketched in [`FACEBOOK_MCP_HANDBOOK.md`](./FACEBOOK_MCP_HANDBOOK.md).

## Architecture

```
Browser (humans)                         MCP client (Claude, …)
  │  GET /            landing              │  POST /mcp  (Bearer access token)
  │  GET /login       → Facebook          │
  │  GET /dashboard   pages + revoke      ▼
  ▼                                   OAuth 2.1 (PKCE) discovery + flow:
Bunny Edge Script (src/main.ts → router)  /.well-known/*  /register
  ├── Website (src/web)                    /authorize  /token  /revoke
  ├── MCP OAuth authorization server (src/oauth) ── federated to Facebook
  ├── MCP endpoint /mcp (src/mcp) ── tools, scoped to the authenticated user
  ├── Bunny Database (libSQL) ── users, pages, clients, codes, tokens, sessions
  └── Facebook Graph API v22.0
```

Authentication is **OAuth, not a shared secret**. An MCP client discovers the authorization server,
registers (Dynamic Client Registration), and runs an Authorization Code + PKCE flow. Our
`/authorize` federates to Facebook; once the user logs in we learn their Facebook user id, store
their Pages, and issue an access token bound to that user. Every tool call is scoped to the token's
user, so tenants are isolated.

Everything except `src/main.ts` is dependency-injected and runtime-agnostic, so the whole request
path is unit-tested with an in-memory SQLite database and a mocked `fetch`.

| Path                    | Responsibility                                                      |
| ----------------------- | ------------------------------------------------------------------- |
| `src/db/migrations.ts`  | Versioned schema (users, pages, oauth\_\*, sessions)                |
| `src/db/users.ts`       | Per-user Facebook identity + page store (tenant isolation)          |
| `src/oauth/*`           | OAuth AS: crypto, store, metadata, provider (+ Facebook federation) |
| `src/web/*`             | Landing page and dashboard (HTML + session handlers)                |
| `src/facebook/graph.ts` | Graph API client (injectable `fetch`)                               |
| `src/mcp/*`             | JSON-RPC, tool registry (user-scoped), MCP dispatch                 |
| `src/router.ts`         | HTTP routing                                                        |
| `src/main.ts`           | Wires real deps and serves via the Bunny SDK                        |

## Tools

All tools act only on the authenticated user's own pages.

| Tool           | Arguments                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| `list_pages`   | –                                                                                  |
| `create_post`  | `page_id`, `message?`, `link?`, `draft?`, `scheduled_publish_time?`, `image_urls?` |
| `publish_post` | `page_id`, `post_id`                                                               |
| `edit_post`    | `page_id`, `post_id`, `message`                                                    |
| `delete_post`  | `page_id`, `post_id`                                                               |
| `repost`       | `source_page_id`, `target_page_id`, `post_id`, `message?`                          |
| `upload_image` | `page_id`, `image_url`                                                             |

## Endpoints

| Path                                            | Purpose                                              |
| ----------------------------------------------- | ---------------------------------------------------- |
| `GET /`                                         | Landing page with usage docs and Login with Facebook |
| `GET /login`, `GET /dashboard`, `POST /logout`  | Human session (cookie)                               |
| `POST /revoke-client`, `POST /disconnect`       | Revoke an app / disconnect Facebook                  |
| `GET /.well-known/oauth-protected-resource`     | RFC 9728 resource metadata                           |
| `GET /.well-known/oauth-authorization-server`   | RFC 8414 AS metadata                                 |
| `POST /register`                                | Dynamic Client Registration (RFC 7591)               |
| `GET /authorize`, `POST /token`, `POST /revoke` | OAuth 2.1 (PKCE)                                     |
| `GET /oauth/callback`                           | Facebook federation callback                         |
| `POST /mcp`                                     | MCP Streamable HTTP endpoint (Bearer required)       |

## Development

Requires [Deno](https://deno.com) 2.x (the same runtime as Bunny Edge Scripting).

```bash
deno task test    # full suite (in-memory SQLite + mocked fetch)
deno task check   # type-check
deno task lint    # lint
deno task fmt     # format
deno task build   # bundle to dist/main.js (must stay < 1 MiB)
deno task dev     # run locally on http://127.0.0.1:8080
```

## Deployment (Bunny Edge Scripting)

Deployment uses bunny.net's native GitHub integration (`release-on-bunny.yml`): on push to `main` it
runs `deno task build` and deploys `dist/main.js` via OIDC. No GitHub secrets required.

Configure on the Edge Script (dashboard → environment variables):

| Variable                    | Notes                                     |
| --------------------------- | ----------------------------------------- |
| `FACEBOOK_APP_ID`           | Facebook app id (`1290277286624394`)      |
| `FACEBOOK_APP_SECRET`       | Facebook app secret                       |
| `BUNNY_DATABASE_URL`        | Bunny Database → Access → Generate Tokens |
| `BUNNY_DATABASE_AUTH_TOKEN` | same place                                |

Then:

1. Whitelist `https://<your-host>/oauth/callback` as a valid OAuth redirect URI in the Facebook app
   settings (it is constant and derived automatically).
2. Apply the schema once (the app also migrates lazily on first use):
   ```bash
   BUNNY_DATABASE_URL=… BUNNY_DATABASE_AUTH_TOKEN=… deno task migrate
   ```

There is **no `MCP_AUTH_TOKEN`** — clients authenticate via the OAuth flow.

## Using it

- **Humans:** open `https://<your-host>/`, click _Login with Facebook_, and use the dashboard to see
  connected Pages and revoke app access at any time.
- **MCP clients:** point a Streamable-HTTP MCP client at `https://<your-host>/mcp`. The client
  discovers the OAuth server and opens a Facebook login the first time; no keys to copy.

  ```json
  {
    "mcpServers": {
      "facebook": { "type": "http", "url": "https://<your-host>/mcp" }
    }
  }
  ```

## Hatchery / dev container

`.devcontainer/devcontainer.json` mirrors the
[`levinkeller.de`](https://github.com/levino/levinkeller.de) hatchery setup (Tailscale join via
`HATCHERY_TS_*`) and adds the Deno toolchain, so a hatchery drone can pick up this repo and
immediately run `deno task test` / `deno task
build`.
