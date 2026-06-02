import { assertEquals, assertRejects } from "@std/assert";
import { GraphClient, GraphError, permalink } from "../../src/facebook/graph.ts";
import { createFetchMock } from "../helpers/fetch_mock.ts";

const BASE = "https://graph.test";

function client(mock: ReturnType<typeof createFetchMock>) {
  return new GraphClient({ version: "v22.0", fetch: mock.fetch, baseUrl: BASE });
}

Deno.test("listPages maps /me/accounts response", async () => {
  const mock = createFetchMock(() => ({
    json: {
      data: [
        { id: "1176555975533708", name: "Levin Keller", access_token: "pt-1" },
        { id: "102752935221041", name: "CDU Nordstemmen", access_token: "pt-2" },
      ],
    },
  }));
  const pages = await client(mock).listPages("user-token");
  assertEquals(pages.length, 2);
  assertEquals(pages[0], {
    id: "1176555975533708",
    name: "Levin Keller",
    accessToken: "pt-1",
  });
  // Request shape
  assertEquals(mock.requests[0].method, "GET");
  const q = mock.query(0);
  assertEquals(q.get("access_token"), "user-token");
  assertEquals(mock.requests[0].url.startsWith(`${BASE}/v22.0/me/accounts`), true);
});

Deno.test("createPost (published) sends only message + token", async () => {
  const mock = createFetchMock(() => ({ json: { id: "PAGE_POST_1" } }));
  const res = await client(mock).createPost("PAGE", "PT", { message: "hello" });
  assertEquals(res.id, "PAGE_POST_1");
  assertEquals(mock.requests[0].method, "POST");
  assertEquals(mock.requests[0].url, `${BASE}/v22.0/PAGE/feed`);
  const form = mock.form(0);
  assertEquals(form.get("message"), "hello");
  assertEquals(form.get("access_token"), "PT");
  assertEquals(form.get("published"), null);
  assertEquals(form.get("unpublished_content_type"), null);
});

Deno.test("createPost (draft) sets published=false and DRAFT type", async () => {
  const mock = createFetchMock(() => ({ json: { id: "DRAFT_1" } }));
  await client(mock).createPost("PAGE", "PT", { message: "m", draft: true });
  const form = mock.form(0);
  assertEquals(form.get("published"), "false");
  assertEquals(form.get("unpublished_content_type"), "DRAFT");
});

Deno.test("createPost (scheduled) sets scheduled_publish_time", async () => {
  const mock = createFetchMock(() => ({ json: { id: "SCHED_1" } }));
  await client(mock).createPost("PAGE", "PT", {
    message: "later",
    scheduledPublishTime: 1893456000,
  });
  const form = mock.form(0);
  assertEquals(form.get("published"), "false");
  assertEquals(form.get("scheduled_publish_time"), "1893456000");
  assertEquals(form.get("unpublished_content_type"), null);
});

Deno.test("createPost with link and attached media", async () => {
  const mock = createFetchMock(() => ({ json: { id: "P" } }));
  await client(mock).createPost("PAGE", "PT", {
    message: "m",
    link: "https://example.com",
    attachedMedia: ["photo1", "photo2"],
  });
  const form = mock.form(0);
  assertEquals(form.get("link"), "https://example.com");
  assertEquals(
    form.get("attached_media"),
    JSON.stringify([{ media_fbid: "photo1" }, { media_fbid: "photo2" }]),
  );
});

Deno.test("uploadPhoto posts to /photos unpublished", async () => {
  const mock = createFetchMock(() => ({ json: { id: "PHOTO_9" } }));
  const res = await client(mock).uploadPhoto("PAGE", "PT", "https://img/x.jpg");
  assertEquals(res.id, "PHOTO_9");
  assertEquals(mock.requests[0].url, `${BASE}/v22.0/PAGE/photos`);
  const form = mock.form(0);
  assertEquals(form.get("url"), "https://img/x.jpg");
  assertEquals(form.get("published"), "false");
});

Deno.test("publishPost posts is_published=true", async () => {
  const mock = createFetchMock(() => ({ json: { success: true } }));
  const res = await client(mock).publishPost("POST_1", "PT");
  assertEquals(res.success, true);
  assertEquals(mock.requests[0].url, `${BASE}/v22.0/POST_1`);
  assertEquals(mock.form(0).get("is_published"), "true");
});

Deno.test("editPost updates message", async () => {
  const mock = createFetchMock(() => ({ json: { success: true } }));
  await client(mock).editPost("POST_1", "PT", "new text");
  assertEquals(mock.form(0).get("message"), "new text");
});

Deno.test("deletePost issues DELETE with token in query", async () => {
  const mock = createFetchMock(() => ({ json: { success: true } }));
  const res = await client(mock).deletePost("POST_1", "PT");
  assertEquals(res.success, true);
  assertEquals(mock.requests[0].method, "DELETE");
  assertEquals(mock.query(0).get("access_token"), "PT");
});

Deno.test("repost shares a permalink to the target page", async () => {
  const mock = createFetchMock(() => ({ json: { id: "REPOST_1" } }));
  await client(mock).repost("TARGET", "TT", "SOURCE", "SOURCE_999", "look at this");
  assertEquals(mock.requests[0].url, `${BASE}/v22.0/TARGET/feed`);
  const form = mock.form(0);
  assertEquals(form.get("message"), "look at this");
  assertEquals(
    form.get("link"),
    "https://www.facebook.com/permalink.php?story_fbid=999&id=SOURCE",
  );
  assertEquals(form.get("access_token"), "TT");
});

Deno.test("getMe returns the user id and name", async () => {
  const mock = createFetchMock(() => ({ json: { id: "fbuser1", name: "Alice" } }));
  const me = await client(mock).getMe("user-token");
  assertEquals(me, { id: "fbuser1", name: "Alice" });
  const q = mock.query(0);
  assertEquals(q.get("access_token"), "user-token");
  assertEquals(q.get("fields"), "id,name");
});

Deno.test("exchangeLongLivedToken parses token and expiry", async () => {
  const mock = createFetchMock(() => ({
    json: { access_token: "long-tok", expires_in: 5184000 },
  }));
  const res = await client(mock).exchangeLongLivedToken("app", "secret", "short");
  assertEquals(res.accessToken, "long-tok");
  assertEquals(res.expiresIn, 5184000);
  const q = mock.query(0);
  assertEquals(q.get("grant_type"), "fb_exchange_token");
  assertEquals(q.get("fb_exchange_token"), "short");
});

Deno.test("exchangeCodeForToken sends redirect_uri and code", async () => {
  const mock = createFetchMock(() => ({ json: { access_token: "user-tok" } }));
  const token = await client(mock).exchangeCodeForToken(
    "app",
    "secret",
    "https://cb",
    "the-code",
  );
  assertEquals(token, "user-tok");
  const q = mock.query(0);
  assertEquals(q.get("redirect_uri"), "https://cb");
  assertEquals(q.get("code"), "the-code");
});

Deno.test("Graph error envelope becomes GraphError", async () => {
  const mock = createFetchMock(() => ({
    status: 400,
    json: {
      error: {
        message: "Invalid OAuth access token.",
        type: "OAuthException",
        code: 190,
        fbtrace_id: "ABC123",
      },
    },
  }));
  const err = await assertRejects(
    () => client(mock).createPost("PAGE", "bad", { message: "x" }),
    GraphError,
    "Invalid OAuth access token.",
  );
  assertEquals((err as GraphError).code, 190);
  assertEquals((err as GraphError).type, "OAuthException");
  assertEquals((err as GraphError).fbtraceId, "ABC123");
});

Deno.test("non-JSON response throws a GraphError", async () => {
  const mock = createFetchMock(() => ({ status: 500, text: "<html>oops</html>" }));
  await assertRejects(
    () => client(mock).listPages("t"),
    GraphError,
    "non-JSON",
  );
});

Deno.test("permalink extracts story id from composite post id", () => {
  assertEquals(
    permalink("PAGE", "PAGE_12345"),
    "https://www.facebook.com/permalink.php?story_fbid=12345&id=PAGE",
  );
  assertEquals(
    permalink("PAGE", "67890"),
    "https://www.facebook.com/permalink.php?story_fbid=67890&id=PAGE",
  );
});
