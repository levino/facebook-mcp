import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildAuthorizeUrl,
  handleOAuthCallback,
  handleOAuthStart,
} from "../../src/oauth/handlers.ts";
import { GraphClient } from "../../src/facebook/graph.ts";
import { loadConfig } from "../../src/config.ts";
import { createFetchMock } from "../helpers/fetch_mock.ts";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { getPageToken, getUserToken } from "../../src/db/tokens.ts";

const baseConfig = loadConfig({
  FACEBOOK_APP_ID: "1290277286624394",
  FACEBOOK_APP_SECRET: "app-secret",
  FACEBOOK_GRAPH_VERSION: "v22.0",
});

Deno.test("buildAuthorizeUrl includes all OAuth params", () => {
  const url = new URL(
    buildAuthorizeUrl(baseConfig, "https://worker.example/oauth/start", "state-123"),
  );
  assertEquals(url.origin + url.pathname, "https://www.facebook.com/v22.0/dialog/oauth");
  assertEquals(url.searchParams.get("client_id"), "1290277286624394");
  assertEquals(url.searchParams.get("redirect_uri"), "https://worker.example/oauth/callback");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("state"), "state-123");
  assertStringIncludes(url.searchParams.get("scope") ?? "", "pages_manage_posts");
});

Deno.test("handleOAuthStart redirects with state cookie", () => {
  const db = createSqliteTestDb();
  const graph = new GraphClient();
  const res = handleOAuthStart(
    { config: baseConfig, graph, db, randomState: () => "fixed-state" },
    new Request("https://worker.example/oauth/start"),
  );
  assertEquals(res.status, 302);
  const location = res.headers.get("location")!;
  assertStringIncludes(location, "state=fixed-state");
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "fb_oauth_state=fixed-state");
  db.close();
});

Deno.test("handleOAuthCallback exchanges code and stores tokens", async () => {
  const db = createSqliteTestDb();
  const mock = createFetchMock((req) => {
    if (req.url.includes("/oauth/access_token")) {
      const q = new URL(req.url).searchParams;
      if (q.get("grant_type") === "fb_exchange_token") {
        return { json: { access_token: "long-lived", expires_in: 5184000 } };
      }
      return { json: { access_token: "short-lived" } };
    }
    if (req.url.includes("/me/accounts")) {
      return {
        json: {
          data: [
            { id: "1176555975533708", name: "Levin Keller", access_token: "pt-1" },
            { id: "102752935221041", name: "CDU Nordstemmen", access_token: "pt-2" },
          ],
        },
      };
    }
    return { status: 404, json: {} };
  });
  const graph = new GraphClient({ version: "v22.0", fetch: mock.fetch });

  const res = await handleOAuthCallback(
    { config: baseConfig, graph, db },
    new Request("https://worker.example/oauth/callback?code=THE_CODE&state=s"),
  );
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "Connected");
  assertStringIncludes(html, "Levin Keller");

  assertEquals((await getUserToken(db))?.accessToken, "long-lived");
  assertEquals(await getPageToken(db, "1176555975533708"), "pt-1");
  assertEquals(await getPageToken(db, "102752935221041"), "pt-2");
  db.close();
});

Deno.test("handleOAuthCallback returns 400 when code missing", async () => {
  const db = createSqliteTestDb();
  const graph = new GraphClient();
  const res = await handleOAuthCallback(
    { config: baseConfig, graph, db },
    new Request("https://worker.example/oauth/callback"),
  );
  assertEquals(res.status, 400);
  assertStringIncludes(await res.text(), "Missing");
  db.close();
});

Deno.test("handleOAuthCallback surfaces provider error param", async () => {
  const db = createSqliteTestDb();
  const graph = new GraphClient();
  const res = await handleOAuthCallback(
    { config: baseConfig, graph, db },
    new Request(
      "https://worker.example/oauth/callback?error=access_denied&error_description=User+denied",
    ),
  );
  assertEquals(res.status, 400);
  assertStringIncludes(await res.text(), "User denied");
  db.close();
});

Deno.test("handleOAuthCallback returns 502 on token exchange failure", async () => {
  const db = createSqliteTestDb();
  const mock = createFetchMock(() => ({
    status: 400,
    json: { error: { message: "bad code", type: "OAuthException", code: 100 } },
  }));
  const graph = new GraphClient({ fetch: mock.fetch });
  const res = await handleOAuthCallback(
    { config: baseConfig, graph, db },
    new Request("https://worker.example/oauth/callback?code=bad"),
  );
  assertEquals(res.status, 502);
  assertStringIncludes(await res.text(), "bad code");
  db.close();
});
