import { assertEquals, assertStringIncludes } from "@std/assert";
import { loadConfig } from "../../src/config.ts";
import { GraphClient } from "../../src/facebook/graph.ts";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { createFetchMock } from "../helpers/fetch_mock.ts";
import { migrate } from "../../src/db/migrations.ts";
import { listPages } from "../../src/db/users.ts";
import { randomToken, sha256Base64Url } from "../../src/oauth/crypto.ts";
import {
  authenticate,
  handleAuthorize,
  handleFacebookCallback,
  handleRegister,
  handleRevoke,
  handleToken,
  type ProviderDeps,
  startWebLogin,
} from "../../src/oauth/provider.ts";

const ORIGIN = "https://srv.example";

function facebookResponder() {
  return createFetchMock((req) => {
    if (req.url.includes("/oauth/access_token")) {
      const q = new URL(req.url).searchParams;
      if (q.get("grant_type") === "fb_exchange_token") {
        return { json: { access_token: "long-token", expires_in: 5184000 } };
      }
      return { json: { access_token: "short-token" } };
    }
    if (req.url.includes("/me/accounts")) {
      return {
        json: {
          data: [
            { id: "100", name: "Page A", access_token: "pt-100" },
            { id: "200", name: "Page B", access_token: "pt-200" },
          ],
        },
      };
    }
    if (req.url.match(/\/me(\?|$)/)) {
      return { json: { id: "fbuser1", name: "Alice" } };
    }
    return { status: 404, json: {} };
  });
}

async function setup() {
  const db = createSqliteTestDb();
  await migrate(db);
  const mock = facebookResponder();
  const config = loadConfig({ FACEBOOK_APP_ID: "app", FACEBOOK_APP_SECRET: "secret" });
  const graph = new GraphClient({ version: "v22.0", fetch: mock.fetch });
  const deps: ProviderDeps = { config, graph, db };
  return { db, deps };
}

function req(path: string, init?: RequestInit) {
  return new Request(`${ORIGIN}${path}`, init);
}

Deno.test("handleRegister creates a client", async () => {
  const { deps, db } = await setup();
  const res = await handleRegister(
    deps,
    req("/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://client/cb"], client_name: "Claude" }),
    }),
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.client_id.startsWith("mcp_"), true);
  assertEquals(body.token_endpoint_auth_method, "none");
  db.close();
});

Deno.test("handleRegister rejects missing redirect_uris", async () => {
  const { deps, db } = await setup();
  const res = await handleRegister(
    deps,
    req("/register", { method: "POST", body: JSON.stringify({}) }),
  );
  assertEquals(res.status, 400);
  db.close();
});

Deno.test("handleAuthorize redirects to Facebook with a login state", async () => {
  const { deps, db } = await setup();
  const reg = await (await handleRegister(
    deps,
    req("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["https://client/cb"] }),
    }),
  )).json();

  const challenge = await sha256Base64Url("verifier-123");
  const res = await handleAuthorize(
    deps,
    req(
      `/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${
        encodeURIComponent("https://client/cb")
      }&code_challenge=${challenge}&code_challenge_method=S256&state=cstate`,
    ),
  );
  assertEquals(res.status, 302);
  const loc = new URL(res.headers.get("location")!);
  assertStringIncludes(loc.href, "facebook.com");
  assertEquals(loc.searchParams.get("redirect_uri"), `${ORIGIN}/oauth/callback`);
  // state carries our login id, not the client's state
  assertEquals(loc.searchParams.get("state") !== "cstate", true);
  db.close();
});

Deno.test("handleAuthorize rejects unknown client", async () => {
  const { deps, db } = await setup();
  const res = await handleAuthorize(
    deps,
    req(
      "/authorize?response_type=code&client_id=nope&redirect_uri=https://x/cb&code_challenge=c&code_challenge_method=S256",
    ),
  );
  assertEquals(res.status, 400);
  db.close();
});

Deno.test("handleAuthorize redirects error for missing PKCE", async () => {
  const { deps, db } = await setup();
  const reg = await (await handleRegister(
    deps,
    req("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["https://client/cb"] }),
    }),
  )).json();
  const res = await handleAuthorize(
    deps,
    req(
      `/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${
        encodeURIComponent("https://client/cb")
      }`,
    ),
  );
  assertEquals(res.status, 302);
  const loc = new URL(res.headers.get("location")!);
  assertEquals(loc.origin + loc.pathname, "https://client/cb");
  assertEquals(loc.searchParams.get("error"), "invalid_request");
  db.close();
});

/** Drives the full authorize → facebook → token flow, returns the access token. */
async function fullFlow(deps: ProviderDeps) {
  const verifier = randomToken();
  const challenge = await sha256Base64Url(verifier);
  const reg = await (await handleRegister(
    deps,
    req("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["https://client/cb"], client_name: "Claude" }),
    }),
  )).json();

  const authRes = await handleAuthorize(
    deps,
    req(
      `/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${
        encodeURIComponent("https://client/cb")
      }&code_challenge=${challenge}&code_challenge_method=S256&state=cstate`,
    ),
  );
  const loginId = new URL(authRes.headers.get("location")!).searchParams.get("state")!;

  const cbRes = await handleFacebookCallback(
    deps,
    req(`/oauth/callback?code=FBCODE&state=${loginId}`),
  );
  assertEquals(cbRes.status, 302);
  const clientCb = new URL(cbRes.headers.get("location")!);
  assertEquals(clientCb.origin + clientCb.pathname, "https://client/cb");
  assertEquals(clientCb.searchParams.get("state"), "cstate");
  const code = clientCb.searchParams.get("code")!;

  const tokenRes = await handleToken(
    deps,
    req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://client/cb",
        client_id: reg.client_id,
        code_verifier: verifier,
      }).toString(),
    }),
  );
  return { tokenRes, clientId: reg.client_id, verifier };
}

Deno.test("full authorization-code + PKCE flow issues a working token", async () => {
  const { deps, db } = await setup();
  const { tokenRes } = await fullFlow(deps);
  assertEquals(tokenRes.status, 200);
  const body = await tokenRes.json();
  assertEquals(body.token_type, "Bearer");
  assertEquals(typeof body.access_token, "string");
  assertEquals(typeof body.refresh_token, "string");

  // Pages were stored for the federated user.
  assertEquals((await listPages(db, "fbuser1")).map((p) => p.pageId), ["100", "200"]);

  // The access token authenticates as that user.
  const auth = await authenticate(
    deps,
    req("/mcp", { headers: { authorization: `Bearer ${body.access_token}` } }),
  );
  assertEquals(auth?.userId, "fbuser1");
  db.close();
});

Deno.test("token exchange fails with a wrong PKCE verifier", async () => {
  const { deps, db } = await setup();
  const verifier = randomToken();
  const challenge = await sha256Base64Url(verifier);
  const reg = await (await handleRegister(
    deps,
    req("/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["https://client/cb"] }),
    }),
  )).json();
  const authRes = await handleAuthorize(
    deps,
    req(
      `/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${
        encodeURIComponent("https://client/cb")
      }&code_challenge=${challenge}&code_challenge_method=S256`,
    ),
  );
  const loginId = new URL(authRes.headers.get("location")!).searchParams.get("state")!;
  const cbRes = await handleFacebookCallback(
    deps,
    req(`/oauth/callback?code=FBCODE&state=${loginId}`),
  );
  const code = new URL(cbRes.headers.get("location")!).searchParams.get("code")!;

  const tokenRes = await handleToken(
    deps,
    req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://client/cb",
        client_id: reg.client_id,
        code_verifier: "WRONG",
      }).toString(),
    }),
  );
  assertEquals(tokenRes.status, 400);
  assertEquals((await tokenRes.json()).error, "invalid_grant");
  db.close();
});

Deno.test("refresh_token grant rotates and keeps the user", async () => {
  const { deps, db } = await setup();
  const { tokenRes } = await fullFlow(deps);
  const first = await tokenRes.json();

  const refreshRes = await handleToken(
    deps,
    req("/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
      }).toString(),
    }),
  );
  assertEquals(refreshRes.status, 200);
  const second = await refreshRes.json();
  assertEquals(typeof second.access_token, "string");

  // New access token still maps to the same user.
  const auth = await authenticate(
    deps,
    req("/mcp", { headers: { authorization: `Bearer ${second.access_token}` } }),
  );
  assertEquals(auth?.userId, "fbuser1");

  // Old refresh token is now invalid (rotation).
  const reuse = await handleToken(
    deps,
    req("/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: first.refresh_token })
        .toString(),
    }),
  );
  assertEquals((await reuse.json()).error, "invalid_grant");
  db.close();
});

Deno.test("revoke invalidates an access token", async () => {
  const { deps, db } = await setup();
  const { tokenRes } = await fullFlow(deps);
  const { access_token } = await tokenRes.json();

  const revRes = await handleRevoke(
    deps,
    req("/revoke", {
      method: "POST",
      body: new URLSearchParams({ token: access_token }).toString(),
    }),
  );
  assertEquals(revRes.status, 200);

  const auth = await authenticate(
    deps,
    req("/mcp", { headers: { authorization: `Bearer ${access_token}` } }),
  );
  assertEquals(auth, null);
  db.close();
});

Deno.test("expired/invalid login state is rejected at the callback", async () => {
  const { deps, db } = await setup();
  const res = await handleFacebookCallback(
    deps,
    req("/oauth/callback?code=x&state=does-not-exist"),
  );
  assertEquals(res.status, 400);
  db.close();
});

Deno.test("web login federates and sets a session cookie", async () => {
  const { deps, db } = await setup();
  const start = await startWebLogin(deps, req("/login"));
  const loginId = new URL(start.headers.get("location")!).searchParams.get("state")!;

  const cb = await handleFacebookCallback(
    deps,
    req(`/oauth/callback?code=FBCODE&state=${loginId}`),
  );
  assertEquals(cb.status, 302);
  assertEquals(cb.headers.get("location"), "/dashboard");
  assertStringIncludes(cb.headers.get("set-cookie") ?? "", "fbmcp_session=");
  db.close();
});

Deno.test("authenticate returns null without a bearer token", async () => {
  const { deps, db } = await setup();
  assertEquals(await authenticate(deps, req("/mcp")), null);
  db.close();
});
