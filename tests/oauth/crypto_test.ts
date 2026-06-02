import { assertEquals, assertNotEquals } from "@std/assert";
import {
  randomToken,
  sha256Base64Url,
  timingSafeEqual,
  tokenHash,
  verifyPkceS256,
} from "../../src/oauth/crypto.ts";

Deno.test("randomToken is url-safe and unique", () => {
  const a = randomToken();
  const b = randomToken();
  assertNotEquals(a, b);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(a), true);
});

Deno.test("sha256Base64Url matches a known vector", async () => {
  // SHA-256("abc") base64url (no padding).
  assertEquals(
    await sha256Base64Url("abc"),
    "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
  );
});

Deno.test("verifyPkceS256 accepts the matching verifier and rejects others", async () => {
  const verifier = randomToken();
  const challenge = await sha256Base64Url(verifier);
  assertEquals(await verifyPkceS256(verifier, challenge), true);
  assertEquals(await verifyPkceS256("wrong-verifier", challenge), false);
});

Deno.test("tokenHash is deterministic and differs from the raw token", async () => {
  const token = randomToken();
  assertEquals(await tokenHash(token), await tokenHash(token));
  assertNotEquals(await tokenHash(token), token);
});

Deno.test("timingSafeEqual compares correctly", () => {
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "ab"), false);
});
