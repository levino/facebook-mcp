/**
 * MCP tool registry. Each tool validates its own arguments and dispatches to
 * the Graph client, resolving page access tokens from the database scoped to
 * the authenticated user (`ctx.userId`) — that scoping is what isolates tenants.
 *
 * Tools mirror the sketch in FACEBOOK_MCP_HANDBOOK.md section 8.
 */

import type { GraphClient } from "../facebook/graph.ts";
import { permalink } from "../facebook/graph.ts";
import type { Db } from "../db/client.ts";
import { getPageToken, listPages } from "../db/users.ts";

// deno-lint-ignore no-explicit-any
export type JsonObject = Record<string, any>;

/** Per-request context: the authenticated Facebook user id. */
export interface ToolContext {
  userId: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Returns a human-readable text result, or throws on failure. */
  handler(args: JsonObject, ctx: ToolContext): Promise<string>;
}

export interface ToolDeps {
  graph: GraphClient;
  db: Db;
}

/** Validation error surfaced to the client as a tool error (not a crash). */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function requireString(args: JsonObject, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolInputError(`Missing or invalid required string argument: ${key}`);
  }
  return v;
}

function optionalString(args: JsonObject, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ToolInputError(`Argument ${key} must be a string`);
  return v;
}

function optionalStringArray(args: JsonObject, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ToolInputError(`Argument ${key} must be an array of strings`);
  }
  return v;
}

export function createTools(deps: ToolDeps): Tool[] {
  const { graph, db } = deps;

  return [
    {
      name: "list_pages",
      description:
        "List the Facebook pages connected to your account, with their ids. Connect pages via the website (Login with Facebook) if empty.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async handler(_args, ctx) {
        const pages = await listPages(db, ctx.userId);
        if (pages.length === 0) {
          return "No pages connected to your account. Visit the website and log in with Facebook to connect your pages.";
        }
        return pages.map((p) => `- ${p.name ?? "(unnamed)"} — ${p.pageId}`).join("\n");
      },
    },
    {
      name: "create_post",
      description:
        "Create a post on one of your pages. Use draft=true for a Business Suite draft, or scheduled_publish_time (unix seconds, >=10 min ahead) to schedule. image_urls are uploaded and attached.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "Target page id" },
          message: { type: "string", description: "Post text" },
          link: { type: "string", description: "Optional URL to attach a preview" },
          draft: { type: "boolean", description: "Create as a Business Suite draft" },
          scheduled_publish_time: {
            type: "integer",
            description: "Unix seconds in the future to schedule publication",
          },
          image_urls: {
            type: "array",
            items: { type: "string" },
            description: "Remote image URLs to upload and attach",
          },
        },
        required: ["page_id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const pageId = requireString(args, "page_id");
        const message = optionalString(args, "message");
        const link = optionalString(args, "link");
        const imageUrls = optionalStringArray(args, "image_urls");
        const draft = args.draft === true;
        let scheduled: number | undefined;
        if (args.scheduled_publish_time !== undefined && args.scheduled_publish_time !== null) {
          if (typeof args.scheduled_publish_time !== "number") {
            throw new ToolInputError("scheduled_publish_time must be a unix timestamp (number)");
          }
          scheduled = args.scheduled_publish_time;
        }
        if (!message && !link && !(imageUrls && imageUrls.length)) {
          throw new ToolInputError("Provide at least one of: message, link, image_urls");
        }
        const token = await getPageToken(db, ctx.userId, pageId);

        let attachedMedia: string[] | undefined;
        if (imageUrls && imageUrls.length > 0) {
          attachedMedia = [];
          for (const imageUrl of imageUrls) {
            const photo = await graph.uploadPhoto(pageId, token, imageUrl);
            attachedMedia.push(photo.id);
          }
        }

        const post = await graph.createPost(pageId, token, {
          message,
          link,
          draft,
          scheduledPublishTime: scheduled,
          attachedMedia,
        });
        const kind = draft ? "draft" : scheduled ? "scheduled post" : "post";
        return `Created ${kind} ${post.id} on page ${pageId}.\n${permalink(pageId, post.id)}`;
      },
    },
    {
      name: "publish_post",
      description: "Publish a previously created draft or unpublished post.",
      inputSchema: {
        type: "object",
        properties: { page_id: { type: "string" }, post_id: { type: "string" } },
        required: ["page_id", "post_id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const pageId = requireString(args, "page_id");
        const postId = requireString(args, "post_id");
        const token = await getPageToken(db, ctx.userId, pageId);
        await graph.publishPost(postId, token);
        return `Published post ${postId}.`;
      },
    },
    {
      name: "edit_post",
      description: "Edit the message of an existing post.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string" },
          post_id: { type: "string" },
          message: { type: "string" },
        },
        required: ["page_id", "post_id", "message"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const pageId = requireString(args, "page_id");
        const postId = requireString(args, "post_id");
        const message = requireString(args, "message");
        const token = await getPageToken(db, ctx.userId, pageId);
        await graph.editPost(postId, token, message);
        return `Updated post ${postId}.`;
      },
    },
    {
      name: "delete_post",
      description: "Delete a post.",
      inputSchema: {
        type: "object",
        properties: { page_id: { type: "string" }, post_id: { type: "string" } },
        required: ["page_id", "post_id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const pageId = requireString(args, "page_id");
        const postId = requireString(args, "post_id");
        const token = await getPageToken(db, ctx.userId, pageId);
        await graph.deletePost(postId, token);
        return `Deleted post ${postId}.`;
      },
    },
    {
      name: "repost",
      description: "Share an existing post from one of your pages onto another of your pages.",
      inputSchema: {
        type: "object",
        properties: {
          source_page_id: { type: "string" },
          target_page_id: { type: "string" },
          post_id: { type: "string", description: "Post id on the source page" },
          message: { type: "string", description: "Optional commentary on the repost" },
        },
        required: ["source_page_id", "target_page_id", "post_id"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const sourcePageId = requireString(args, "source_page_id");
        const targetPageId = requireString(args, "target_page_id");
        const postId = requireString(args, "post_id");
        const message = optionalString(args, "message");
        // Resolving both tokens enforces that the user owns both pages.
        await getPageToken(db, ctx.userId, sourcePageId);
        const targetToken = await getPageToken(db, ctx.userId, targetPageId);
        const post = await graph.repost(targetPageId, targetToken, sourcePageId, postId, message);
        return `Reposted to page ${targetPageId} as ${post.id}.`;
      },
    },
    {
      name: "upload_image",
      description:
        "Upload a remote image to one of your pages as an unpublished photo and return its photo id (for use as attached media).",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string" },
          image_url: { type: "string", description: "Publicly reachable image URL" },
        },
        required: ["page_id", "image_url"],
        additionalProperties: false,
      },
      async handler(args, ctx) {
        const pageId = requireString(args, "page_id");
        const imageUrl = requireString(args, "image_url");
        const token = await getPageToken(db, ctx.userId, pageId);
        const photo = await graph.uploadPhoto(pageId, token, imageUrl);
        return `Uploaded photo ${photo.id} to page ${pageId}.`;
      },
    },
  ];
}
