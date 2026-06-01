/**
 * Runtime configuration, parsed from environment variables.
 *
 * `loadConfig` is intentionally lenient: it never throws so that the HTTP
 * router can be constructed (and unit-tested) without a fully populated
 * environment. Use {@link assertRuntimeConfig} at process start to fail fast
 * when required secrets are missing.
 */

export type Env = Record<string, string | undefined>;

export interface Config {
  /** Facebook app id. */
  appId: string;
  /** Facebook app secret (used for the server-side token exchange). */
  appSecret: string;
  /** Graph API version, e.g. "v22.0". */
  graphVersion: string;
  /** Space/comma separated OAuth scopes requested during /oauth/start. */
  oauthScope: string;
  /**
   * Public callback URL. When empty it is derived from the request origin so a
   * single deployment works across preview and production hostnames.
   */
  oauthRedirectUri: string;
  /** Bearer token required on the /mcp endpoint. Empty means "no auth". */
  mcpAuthToken: string;
  /** Bunny Database (libSQL) URL. */
  databaseUrl: string;
  /** Bunny Database (libSQL) auth token. */
  databaseAuthToken: string;
  /** Reported via MCP `initialize`. */
  serverName: string;
  serverVersion: string;
}

export const DEFAULT_GRAPH_VERSION = "v22.0";
export const DEFAULT_OAUTH_SCOPE = "pages_manage_posts,pages_read_engagement,pages_show_list";

export function loadConfig(env: Env): Config {
  return {
    appId: env.FACEBOOK_APP_ID ?? "",
    appSecret: env.FACEBOOK_APP_SECRET ?? "",
    graphVersion: env.FACEBOOK_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
    oauthScope: env.FACEBOOK_OAUTH_SCOPE || DEFAULT_OAUTH_SCOPE,
    oauthRedirectUri: env.OAUTH_REDIRECT_URI ?? "",
    mcpAuthToken: env.MCP_AUTH_TOKEN ?? "",
    databaseUrl: env.BUNNY_DATABASE_URL ?? "",
    databaseAuthToken: env.BUNNY_DATABASE_AUTH_TOKEN ?? "",
    serverName: env.MCP_SERVER_NAME || "facebook-mcp",
    serverVersion: env.MCP_SERVER_VERSION || "0.1.0",
  };
}

/** Throws an aggregated error if any secret required at runtime is missing. */
export function assertRuntimeConfig(config: Config): void {
  const missing: string[] = [];
  if (!config.appId) missing.push("FACEBOOK_APP_ID");
  if (!config.appSecret) missing.push("FACEBOOK_APP_SECRET");
  if (!config.databaseUrl) missing.push("BUNNY_DATABASE_URL");
  if (!config.databaseAuthToken) missing.push("BUNNY_DATABASE_AUTH_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

/**
 * Resolves the redirect URI used for the OAuth dance. Prefers the explicitly
 * configured value; otherwise derives `${origin}/oauth/callback` from the
 * incoming request so previews work without extra configuration.
 */
export function resolveRedirectUri(config: Config, requestUrl: string): string {
  if (config.oauthRedirectUri) return config.oauthRedirectUri;
  const origin = new URL(requestUrl).origin;
  return `${origin}/oauth/callback`;
}
