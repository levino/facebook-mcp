/**
 * Minimal Facebook Graph API client covering the operations described in
 * FACEBOOK_MCP_HANDBOOK.md. The `fetch` implementation is injectable so the
 * client can be exercised without network access in tests.
 */

export interface GraphClientOptions {
  version?: string;
  fetch?: typeof fetch;
  /** Override for tests; defaults to https://graph.facebook.com */
  baseUrl?: string;
}

export interface Page {
  id: string;
  name: string;
  accessToken: string;
}

export interface CreatePostParams {
  message?: string;
  link?: string;
  /** When true, creates a Business Suite draft (published=false + DRAFT). */
  draft?: boolean;
  /** Unix seconds; schedules the post (must be >= 10 min in the future). */
  scheduledPublishTime?: number;
  /** Photo ids (from {@link GraphClient.uploadPhoto}) to attach. */
  attachedMedia?: string[];
}

/** Error thrown when the Graph API returns an `error` envelope. */
export class GraphError extends Error {
  readonly type?: string;
  readonly code?: number;
  readonly fbtraceId?: string;
  constructor(
    message: string,
    details: { type?: string; code?: number; fbtraceId?: string } = {},
  ) {
    super(message);
    this.name = "GraphError";
    this.type = details.type;
    this.code = details.code;
    this.fbtraceId = details.fbtraceId;
  }
}

const DEFAULT_BASE_URL = "https://graph.facebook.com";

export class GraphClient {
  private readonly version: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: GraphClientOptions = {}) {
    this.version = opts.version ?? "v22.0";
    this.fetchImpl = opts.fetch ?? fetch;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  private url(path: string): string {
    const clean = path.replace(/^\//, "");
    return `${this.baseUrl}/${this.version}/${clean}`;
  }

  // deno-lint-ignore no-explicit-any
  private async parse(res: Response): Promise<any> {
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new GraphError(
        `Graph API returned non-JSON response (status ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    // deno-lint-ignore no-explicit-any
    const err = (json as any)?.error;
    if (err) {
      throw new GraphError(err.message ?? "Unknown Graph API error", {
        type: err.type,
        code: err.code,
        fbtraceId: err.fbtrace_id,
      });
    }
    if (!res.ok) {
      throw new GraphError(`Graph API request failed with status ${res.status}`);
    }
    return json;
  }

  /** GET request with query params. */
  // deno-lint-ignore no-explicit-any
  private async get(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.url(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), { method: "GET" });
    return await this.parse(res);
  }

  /** POST request with a form-urlencoded body. */
  // deno-lint-ignore no-explicit-any
  private async post(path: string, params: Record<string, string>): Promise<any> {
    const body = new URLSearchParams(params);
    const res = await this.fetchImpl(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await this.parse(res);
  }

  // deno-lint-ignore no-explicit-any
  private async delete(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.url(path));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), { method: "DELETE" });
    return await this.parse(res);
  }

  /** Lists the pages managed by the holder of `userToken`, with page tokens. */
  async listPages(userToken: string): Promise<Page[]> {
    const json = await this.get("me/accounts", {
      access_token: userToken,
      fields: "id,name,access_token",
    });
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((p: { id: string; name: string; access_token: string }) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
    }));
  }

  /** Exchanges a short-lived user token for a long-lived (~60 day) one. */
  async exchangeLongLivedToken(
    appId: string,
    appSecret: string,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number | null }> {
    const json = await this.get("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    });
    return {
      accessToken: json.access_token,
      expiresIn: typeof json.expires_in === "number" ? json.expires_in : null,
    };
  }

  /** Exchanges an OAuth `code` for a (short-lived) user access token. */
  async exchangeCodeForToken(
    appId: string,
    appSecret: string,
    redirectUri: string,
    code: string,
  ): Promise<string> {
    const json = await this.get("oauth/access_token", {
      client_id: appId,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
    });
    return json.access_token;
  }

  /** Creates a post (published, draft, or scheduled) on a page. */
  async createPost(
    pageId: string,
    pageToken: string,
    params: CreatePostParams,
  ): Promise<{ id: string }> {
    const form: Record<string, string> = { access_token: pageToken };
    if (params.message !== undefined) form.message = params.message;
    if (params.link !== undefined) form.link = params.link;
    if (params.attachedMedia && params.attachedMedia.length > 0) {
      form.attached_media = JSON.stringify(
        params.attachedMedia.map((id) => ({ media_fbid: id })),
      );
    }
    if (params.draft) {
      // Business Suite draft: published=false alone yields an invisible dark
      // post, the DRAFT type is what makes it show up under Entwürfe.
      form.published = "false";
      form.unpublished_content_type = "DRAFT";
    } else if (params.scheduledPublishTime !== undefined) {
      form.published = "false";
      form.scheduled_publish_time = String(params.scheduledPublishTime);
    }
    const json = await this.post(`${pageId}/feed`, form);
    return { id: json.id };
  }

  /** Uploads a remote image as an unpublished photo, returning its id. */
  async uploadPhoto(
    pageId: string,
    pageToken: string,
    imageUrl: string,
  ): Promise<{ id: string }> {
    const json = await this.post(`${pageId}/photos`, {
      url: imageUrl,
      published: "false",
      access_token: pageToken,
    });
    return { id: json.id };
  }

  /** Publishes a previously created draft/unpublished post. */
  async publishPost(postId: string, pageToken: string): Promise<{ success: boolean }> {
    const json = await this.post(postId, {
      is_published: "true",
      access_token: pageToken,
    });
    return { success: json.success ?? true };
  }

  /** Edits the message of an existing post. */
  async editPost(
    postId: string,
    pageToken: string,
    message: string,
  ): Promise<{ success: boolean }> {
    const json = await this.post(postId, { message, access_token: pageToken });
    return { success: json.success ?? true };
  }

  async deletePost(postId: string, pageToken: string): Promise<{ success: boolean }> {
    const json = await this.delete(postId, { access_token: pageToken });
    return { success: json.success ?? true };
  }

  /**
   * Reposts an existing post onto another page by sharing its permalink.
   * The permalink is built from the source post and page ids.
   */
  async repost(
    targetPageId: string,
    targetPageToken: string,
    sourcePageId: string,
    sourcePostId: string,
    message?: string,
  ): Promise<{ id: string }> {
    const link = permalink(sourcePageId, sourcePostId);
    const form: Record<string, string> = { link, access_token: targetPageToken };
    if (message !== undefined) form.message = message;
    const json = await this.post(`${targetPageId}/feed`, form);
    return { id: json.id };
  }
}

/** Builds the public permalink for a page post. */
export function permalink(pageId: string, postId: string): string {
  // Graph returns post ids as "{pageId}_{storyId}"; the permalink wants the
  // story id portion.
  const storyId = postId.includes("_") ? postId.split("_")[1] : postId;
  return `https://www.facebook.com/permalink.php?story_fbid=${storyId}&id=${pageId}`;
}
