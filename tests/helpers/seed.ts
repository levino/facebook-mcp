/** Test helpers for seeding users, pages and OAuth tokens. */

import type { Db } from "../../src/db/client.ts";
import { migrate } from "../../src/db/migrations.ts";
import { type PageInput, saveUserAndPages } from "../../src/db/users.ts";
import { storeTokens } from "../../src/oauth/store.ts";
import { tokenHash } from "../../src/oauth/crypto.ts";

/** Migrates a fresh in-memory db and connects a user with pages. */
export async function seedUser(
  db: Db,
  userId: string,
  pages: PageInput[],
  name: string | null = "Test User",
): Promise<void> {
  await migrate(db);
  await saveUserAndPages(db, {
    userId,
    name,
    userToken: `user-token-${userId}`,
    expiresAt: null,
    pages,
  });
}

/** Issues a valid access token for a user and returns the raw token. */
export async function issueAccessToken(
  db: Db,
  userId: string,
  clientId = "test-client",
): Promise<string> {
  const accessToken = `at_${userId}_${crypto.randomUUID()}`;
  await storeTokens(db, {
    accessTokenHash: await tokenHash(accessToken),
    refreshTokenHash: null,
    clientId,
    userId,
    scope: null,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    refreshExpiresAt: null,
  });
  return accessToken;
}
