import { assertEquals, assertStringIncludes } from "@std/assert";
import { createTools, type ToolContext } from "../../src/mcp/tools.ts";
import { GraphClient } from "../../src/facebook/graph.ts";
import { createFetchMock } from "../helpers/fetch_mock.ts";
import { createSqliteTestDb } from "../helpers/sqlite_db.ts";
import { seedUser } from "../helpers/seed.ts";

const CTX: ToolContext = { userId: "alice" };

async function setup(responder: Parameters<typeof createFetchMock>[0]) {
  const db = createSqliteTestDb();
  await seedUser(db, "alice", [
    { pageId: "100", name: "Levin Keller", accessToken: "pt-100" },
    { pageId: "200", name: "CDU Nordstemmen", accessToken: "pt-200" },
  ]);
  const mock = createFetchMock(responder);
  const graph = new GraphClient({ version: "v22.0", fetch: mock.fetch, baseUrl: "https://g.test" });
  const tools = createTools({ graph, db });
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { db, mock, tools, get: (n: string) => byName.get(n)! };
}

function run(
  get: (n: string) => { handler: (a: Record<string, unknown>, c: ToolContext) => Promise<string> },
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = CTX,
) {
  return get(name).handler(args, ctx);
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

Deno.test("list_pages reports only the calling user's pages", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  const text = await run(get, "list_pages", {});
  assertStringIncludes(text, "Levin Keller — 100");
  assertStringIncludes(text, "CDU Nordstemmen — 200");
  (db as unknown as { close(): void }).close();
});

Deno.test("list_pages for a user with no pages prompts to connect", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  const text = await run(get, "list_pages", {}, { userId: "stranger" });
  assertStringIncludes(text, "log in with Facebook");
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post uses the user's stored page token (draft)", async () => {
  const { get, mock, db } = await setup(() => ({ json: { id: "100_555" } }));
  const text = await run(get, "create_post", { page_id: "100", message: "Hallo", draft: true });
  assertStringIncludes(text, "Created draft 100_555");
  assertEquals(mock.form(0).get("access_token"), "pt-100");
  assertEquals(mock.form(0).get("unpublished_content_type"), "DRAFT");
  (db as unknown as { close(): void }).close();
});

Deno.test("tenant isolation: a user cannot post to a page they don't own", async () => {
  const { get, db } = await setup(() => ({ json: {} }));
  let message = "";
  try {
    // 'bob' has no pages seeded.
    await run(get, "create_post", { page_id: "100", message: "x" }, { userId: "bob" });
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "not connected to your account");
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post uploads images then attaches them", async () => {
  let call = 0;
  const { get, mock, db } = await setup(() => {
    call += 1;
    if (call <= 2) return { json: { id: `photo${call}` } };
    return { json: { id: "100_999" } };
  });
  const text = await run(get, "create_post", {
    page_id: "100",
    message: "pics",
    image_urls: ["https://img/a.jpg", "https://img/b.jpg"],
  });
  assertStringIncludes(text, "100_999");
  assertEquals(mock.requests[0].url, "https://g.test/v22.0/100/photos");
  assertEquals(
    mock.form(2).get("attached_media"),
    JSON.stringify([{ media_fbid: "photo1" }, { media_fbid: "photo2" }]),
  );
  (db as unknown as { close(): void }).close();
});

Deno.test("create_post requires some content", async () => {
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

Deno.test("publish_post uses the user's page token", async () => {
  const { get, mock, db } = await setup(() => ({ json: { success: true } }));
  const text = await run(get, "publish_post", { page_id: "200", post_id: "200_1" });
  assertStringIncludes(text, "Published post 200_1");
  assertEquals(mock.form(0).get("access_token"), "pt-200");
  (db as unknown as { close(): void }).close();
});

Deno.test("edit_post requires a message", async () => {
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

Deno.test("delete_post deletes via the user's page token", async () => {
  const { get, mock, db } = await setup(() => ({ json: { success: true } }));
  await run(get, "delete_post", { page_id: "100", post_id: "100_7" });
  assertEquals(mock.requests[0].method, "DELETE");
  assertEquals(mock.query(0).get("access_token"), "pt-100");
  (db as unknown as { close(): void }).close();
});

Deno.test("repost requires the user to own both pages", async () => {
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
  const text = await run(get, "upload_image", { page_id: "100", image_url: "https://img/x.jpg" });
  assertStringIncludes(text, "photo-xyz");
  assertEquals(mock.form(0).get("url"), "https://img/x.jpg");
  (db as unknown as { close(): void }).close();
});
