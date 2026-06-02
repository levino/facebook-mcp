/**
 * Server-rendered HTML for the public website and the user dashboard.
 * Plain template strings (no framework / build step) so it bundles small and
 * runs on the edge. Minimal inline CSS keeps it presentable.
 */

import type { FbPage } from "../db/users.ts";
import type { ClientAuthorization } from "../oauth/store.ts";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(
    /"/g,
    "&quot;",
  );
}

const STYLE = `
:root { color-scheme: light dark; --fg:#1a1a1a; --muted:#666; --bg:#fff; --card:#f6f6f7;
  --border:#e3e3e6; --accent:#1877f2; --danger:#d33; }
@media (prefers-color-scheme: dark){ :root{ --fg:#eee; --muted:#9aa; --bg:#16181c;
  --card:#1f2228; --border:#2c3038; } }
* { box-sizing:border-box; }
body { font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg);
  background:var(--bg); max-width:46rem; margin:0 auto; padding:2.5rem 1.25rem 4rem; line-height:1.55; }
h1 { font-size:1.7rem; margin:0 0 .25rem; } h2 { font-size:1.2rem; margin:2rem 0 .5rem; }
p { color:var(--fg); } .muted { color:var(--muted); }
a { color:var(--accent); }
.card { background:var(--card); border:1px solid var(--border); border-radius:12px;
  padding:1rem 1.25rem; margin:.75rem 0; }
.btn { display:inline-block; border:0; border-radius:8px; padding:.6rem 1.1rem; font-size:1rem;
  cursor:pointer; text-decoration:none; }
.btn-fb { background:var(--accent); color:#fff; }
.btn-ghost { background:transparent; color:var(--fg); border:1px solid var(--border); }
.btn-danger { background:transparent; color:var(--danger); border:1px solid var(--danger); }
.row { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }
code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:1rem;
  overflow:auto; font-size:.85rem; }
ul { padding-left:1.1rem; } li { margin:.15rem 0; }
.topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:1.5rem; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function mcpClientSnippet(origin: string): string {
  return JSON.stringify(
    { mcpServers: { facebook: { type: "http", url: `${origin}/mcp` } } },
    null,
    2,
  );
}

/** Public landing page. */
export function landingPage(origin: string): string {
  return layout(
    "Facebook MCP",
    `<div class="topbar"><strong>Facebook&nbsp;MCP</strong>
       <a class="btn btn-fb" href="/login">Login with Facebook</a></div>

     <h1>Manage your Facebook Pages from your AI assistant</h1>
     <p class="muted">An MCP server that lets you create, schedule, edit, and publish
       posts on the Facebook Pages you manage — directly from any
       <a href="https://modelcontextprotocol.io">MCP</a> client like Claude.</p>

     <h2>How it works</h2>
     <ul>
       <li><strong>Log in with Facebook</strong> to connect the Pages you administer.</li>
       <li>Add this server to your MCP client. It authenticates you via Facebook —
         no API keys to copy around.</li>
       <li>Ask your assistant to draft, schedule, or publish posts on your Pages.</li>
     </ul>

     <h2>Add it to your MCP client</h2>
     <p>Point a Streamable-HTTP MCP client at the URL below. Your client will open a
       Facebook login the first time and handle the rest automatically.</p>
     <pre><code>${esc(`${origin}/mcp`)}</code></pre>
     <p class="muted">Example client config:</p>
     <pre><code>${esc(mcpClientSnippet(origin))}</code></pre>

     <h2>Your data &amp; control</h2>
     <ul>
       <li>We store only the access tokens needed to act on your Pages.</li>
       <li>You can review connected apps and <strong>revoke access at any time</strong>
         from your dashboard.</li>
       <li><a href="/login">Log in</a> to manage or disconnect.</li>
     </ul>

     <p style="margin-top:2rem"><a class="btn btn-fb" href="/login">Login with Facebook</a></p>`,
  );
}

/** Authenticated dashboard. */
export function dashboardPage(params: {
  origin: string;
  userName: string | null;
  userId: string;
  pages: FbPage[];
  authorizations: ClientAuthorization[];
}): string {
  const { origin, userName, userId, pages, authorizations } = params;

  const pagesHtml = pages.length === 0
    ? `<p class="muted">No Pages found. Make sure your Facebook account administers at
        least one Page, then <a href="/login">reconnect</a>.</p>`
    : `<ul>${
      pages.map((p) =>
        `<li>${esc(p.name ?? "(unnamed)")} <span class="muted">— ${esc(p.pageId)}</span></li>`
      ).join("")
    }</ul>`;

  const authHtml = authorizations.length === 0
    ? `<p class="muted">No MCP clients are currently authorized.</p>`
    : authorizations.map((a) =>
      `<div class="card"><div class="row">
         <div><strong>${esc(a.clientName ?? a.clientId)}</strong>
           <div class="muted">${a.tokenCount} active token(s)</div></div>
         <form method="post" action="/revoke-client">
           <input type="hidden" name="client_id" value="${esc(a.clientId)}">
           <button class="btn btn-danger" type="submit">Revoke</button>
         </form>
       </div></div>`
    ).join("");

  return layout(
    "Dashboard — Facebook MCP",
    `<div class="topbar">
       <div><strong>Facebook&nbsp;MCP</strong>
         <span class="muted"> · ${esc(userName ?? userId)}</span></div>
       <form method="post" action="/logout"><button class="btn btn-ghost">Log out</button></form>
     </div>

     <h1>Your dashboard</h1>

     <h2>Connected Pages</h2>
     ${pagesHtml}
     <p><a class="btn btn-ghost" href="/login">Refresh from Facebook</a></p>

     <h2>Connect your MCP client</h2>
     <p>Use this URL in your MCP client:</p>
     <pre><code>${esc(`${origin}/mcp`)}</code></pre>

     <h2>Authorized MCP clients</h2>
     <p class="muted">Apps you have granted access to act on your Pages. Revoke any you
       no longer use — this invalidates their tokens immediately.</p>
     ${authHtml}

     <h2 style="color:var(--danger)">Danger zone</h2>
     <div class="card"><div class="row">
       <div><strong>Disconnect Facebook</strong>
         <div class="muted">Removes your stored Page tokens and revokes all MCP client access.</div></div>
       <form method="post" action="/disconnect"
         onsubmit="return confirm('Disconnect Facebook and revoke all access?')">
         <button class="btn btn-danger" type="submit">Disconnect</button>
       </form>
     </div></div>`,
  );
}

export function simplePage(title: string, heading: string, bodyHtml: string): string {
  return layout(title, `<h1>${esc(heading)}</h1>${bodyHtml}`);
}
