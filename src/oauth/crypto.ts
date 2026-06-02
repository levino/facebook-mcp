/** Crypto helpers for the OAuth authorization server (PKCE, tokens). */

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically-random URL-safe token (default 256 bits of entropy). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

/** SHA-256 of `input`, base64url-encoded (used for PKCE and token hashing). */
export async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Verifies a PKCE S256 challenge for the given verifier. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const computed = await sha256Base64Url(verifier);
  return timingSafeEqual(computed, challenge);
}

/** Stored form of a bearer token — we never persist the raw token. */
export function tokenHash(token: string): Promise<string> {
  return sha256Base64Url(token);
}
