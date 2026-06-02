/**
 * OAuth 2.0 discovery documents for the MCP authorization flow
 * (RFC 8414 authorization-server metadata, RFC 9728 protected-resource
 * metadata). MCP clients read these to learn how to authenticate.
 */

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/`,
  };
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

/** The canonical resource identifier this server protects. */
export function resourceId(origin: string): string {
  return `${origin}/mcp`;
}
