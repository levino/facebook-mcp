import { assertEquals, assertStringIncludes } from "@std/assert";
import { createTools } from "../../src/mcp/tools.ts";
import { GraphClient } from "../../src/facebook/graph.ts";
import { createFetchMock } from "../helpers/fetch_mock.ts";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { ensureSchema, saveUserAndPages } from "../../src/db/tokens.ts";
import type { Db } from "../../src/db/client.ts";

async function setup(responder: Parameters<typeof createFetchMock>[0]) {
  const db = createSqliteTestDb();
  await ensureSchema(db);
  await saveUserAndPages(db, {
    userToken: "user-tok",
    userTokenExpiresAt: null,
    pages: [
      { id: "100", name: "Levin Keller", accessToken: "pt-100" },
      { id: "200", name: "CDU Nordstemmen", accessToken: "pt-200" },
    ],
  });
  const mock = createFetchMock(responder);
  const graph = new GraphClient({ version: "v22.0", fetch: mock.fetch, baseUrl: "https://g.test" });
  const tools = createTools({ graph, db });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { db, mock, tools, get: (n: string) => byName.get(n)! };
}

function run(
  get: (n: string) => { handler: (a: Record<string, unknown>) => Promise<string> },
  name: string,
  args: Record<string, unknown>,
) {
  return get(name).handler(args);
}

Deno.test("createTools exposes the full handbook tool set", async () => {
  const { tools, db } = await setup(() => ({ json: {} }));
  const names = tools.map((t) => t.name).sort();
  assertEquals(names, [
    "create_post",
    "delete_post",
    "edit_post",
    "list_pages",
    "publish_post",
    "repost",
    "upload_image",
  ]);
  (db as unknown as { close(): void }).close();
});

Deno.test("list_pages reports connected pages", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  const text = await run(get, "list_pages", {});
  assertStringIncludes(text, "Levin Keller — 100");
  assertStringIncludes(text, "CDU Nordstemmen — 200");
  (db as unknown as { close(): void }).close();
});

Deno.test("list_pages on empty db prompts for OAuth", async () => {
  const emptyDb = createSqliteTestDb();
  await ensureSchema(emptyDb);
  const mock = createFetchMock(() => ({ json: {} }));
  const graph = new GraphClient({ fetch: mock.fetch });
  const tools = createTools({ graph, db: emptyDb as unknown as Db });
  const text = await tools.find((t) => t.name === "list_pages")!.handler({});
  assertStringIncludes(text, "/oauth/start");
  emptyDb.close();
});

Deno.test("create_post resolves page token and posts a draft", async () => {
  const { get, mock, db } = await setup(() => ({ json: { id: "100_555" } }));
  const text = await run(get, "create_post", {
    page_id: "100",
    message: "Hallo Welt",
    draft: true,
  });
  assertStringIncludes(text, "Created draft 100_555");
  // Uses the stored page token, not the user token.
  assertEquals(mock.form(0).get("access_token"), "pt-100");
  assertEquals(mock.form(0).get("unpublished_content_type"), "DRAFT");
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post uploads images then attaches them", async () => {
  let call = 0;
  const { get, mock, db } = await setup(() => {
    call += 1;
    if (call <= 2) return { json: { id: `photo${call}` } }; // two uploads
    return { json: { id: "100_999" } }; // the feed post
  });
  const text = await run(get, "create_post", {
    page_id: "100",
    message: "with pics",
    image_urls: ["https://img/a.jpg", "https://img/b.jpg"],
  });
  assertStringIncludes(text, "100_999");
  // First two requests are photo uploads.
  assertEquals(mock.requests[0].url, "https://g.test/v22.0/100/photos");
  assertEquals(mock.requests[1].url, "https://g.test/v22.0/100/photos");
  // Final request attaches both photo ids.
  assertEquals(
    mock.form(2).get("attached_media"),
    JSON.stringify([{ media_fbid: "photo1" }, { media_fbid: "photo2" }]),
  );
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post validates that content is provided", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  let message = "";
  try {
    await run(get, "create_post", { page_id: "100" });
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "at least one of");
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post errors clearly for unknown page", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  let message = "";
  try {
    await run(get, "create_post", { page_id: "999", message: "x" });
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "No access token stored for page 999");
  (db as unknown as { close(): void }).close();
});

Deno.test("publish_post calls publish with page token", async () => {
  const { get, mock, db } = await setup(() => ({ json: { success: true } }));
  const text = await run(get, "publish_post", { page_id: "200", post_id: "200_1" });
  assertStringIncludes(text, "Published post 200_1");
  assertEquals(mock.requests[0].url, "https://g.test/v22.0/200_1");
  assertEquals(mock.form(0).get("access_token"), "pt-200");
  (db as unknown as { close(): void }).close();
});

Deno.test("edit_post requires a message argument", async () => {
  const { get, db } = await setup(() => ({ json: { success: true } }));
  let message = "";
  try {
    await run(get, "edit_post", { page_id: "100", post_id: "100_1" });
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "message");
  (db as unknown as { close(): void }).close();
});

Deno.test("delete_post deletes using the page token", async () => {
  const { get, mock, db } = await setup(() => ({ json: { success: true } }));
  await run(get, "delete_post", { page_id: "100", post_id: "100_7" });
  assertEquals(mock.requests[0].method, "DELETE");
  assertEquals(mock.query(0).get("access_token"), "pt-100");
  (db as unknown as { close(): void }).close();
});

Deno.test("repost uses target page token and source permalink", async () => {
  const { get, mock, db } = await setup(() => ({ json: { id: "200_42" } }));
  const text = await run(get, "repost", {
    source_page_id: "100",
    target_page_id: "200",
    post_id: "100_5",
    message: "teilen",
  });
  assertStringIncludes(text, "Reposted to page 200");
  assertEquals(mock.form(0).get("access_token"), "pt-200");
  assertStringIncludes(mock.form(0).get("link") ?? "", "story_fbid=5&id=100");
  (db as unknown as { close(): void }).close();
});

Deno.test("upload_image returns the photo id", async () => {
  const { get, mock, db } = await setup(() => ({ json: { id: "photo-xyz" } }));
  const text = await run(get, "upload_image", {
    page_id: "100",
    image_url: "https://img/x.jpg",
  });
  assertStringIncludes(text, "photo-xyz");
  assertEquals(mock.form(0).get("url"), "https://img/x.jpg");
  (db as unknown as { close(): void }).close();
});
