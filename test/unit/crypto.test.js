import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  decryptSecret, encryptSecret, generateApiKey, hashApiKey, looksLikeApiKey, parseEncryptionKey,
  safeEqual, signTenantWebhook, stableStringify, verifyMetaSignature, verifyTenantWebhook, generateWebhookSecret,
} from "../../src/lib/crypto.js";

const key = randomBytes(32);

test("encryptSecret round-trips and uses a fresh IV each time", () => {
  const a = encryptSecret("EAAG-token", key, "waba_1");
  const b = encryptSecret("EAAG-token", key, "waba_1");
  assert.notEqual(a, b);
  assert.match(a, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(decryptSecret(a, key, "waba_1"), "EAAG-token");
});

test("decryptSecret fails on tampering, wrong key or wrong AAD", () => {
  const c = encryptSecret("secret", key, "waba_1");
  const parts = c.split(".");
  const ct = Buffer.from(parts[3], "base64url");
  ct[0] ^= 1;
  const tampered = [...parts.slice(0, 3), ct.toString("base64url")].join(".");
  assert.throws(() => decryptSecret(tampered, key, "waba_1"));
  assert.throws(() => decryptSecret(c, randomBytes(32), "waba_1"));
  assert.throws(() => decryptSecret(c, key, "waba_2"));
  assert.throws(() => decryptSecret("v2.a.b.c", key), /unsupported/);
  assert.throws(() => decryptSecret(null, key), /unsupported/);
});

test("encryptSecret rejects empty plaintext", () => {
  assert.throws(() => encryptSecret("", key), TypeError);
});

test("parseEncryptionKey requires exactly 32 bytes", () => {
  assert.equal(parseEncryptionKey(key.toString("base64")).length, 32);
  assert.equal(parseEncryptionKey(key.toString("base64url")).length, 32);
  assert.throws(() => parseEncryptionKey(undefined), /not set/);
  assert.throws(() => parseEncryptionKey(randomBytes(16).toString("base64")), /32 bytes/);
});

test("generateApiKey returns a well-formed key whose hash verifies only with the same pepper", () => {
  const { key: k, prefix, hash } = generateApiKey("pepper");
  assert.ok(looksLikeApiKey(k));
  assert.equal(prefix, k.slice(0, 12));
  assert.ok(k.startsWith("wa_live_"));
  assert.equal(hashApiKey(k, "pepper"), hash);
  assert.notEqual(hashApiKey(k, "other"), hash);
  assert.ok(generateApiKey("p", { environment: "test" }).key.startsWith("wa_test_"));
  assert.throws(() => generateApiKey("p", { environment: "prod" }), TypeError);
  assert.throws(() => hashApiKey(k, ""), /PEPPER/);
});

test("looksLikeApiKey rejects malformed values", () => {
  for (const v of [null, "", "wa_live_short", "sk_live_" + "a".repeat(32), "wa_live_" + "a".repeat(31) + "!"]) assert.equal(looksLikeApiKey(v), false);
});

test("verifyMetaSignature accepts the exact body and rejects everything else", () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');
  const sig = "sha256=" + createHmac("sha256", "app-secret").update(body).digest("hex");
  assert.equal(verifyMetaSignature(body, sig, "app-secret"), true);
  assert.equal(verifyMetaSignature(body, sig.toUpperCase().replace("SHA256=", "sha256="), "app-secret"), true);
  assert.equal(verifyMetaSignature(Buffer.from(body.toString() + " "), sig, "app-secret"), false);
  assert.equal(verifyMetaSignature(body, sig, "wrong"), false);
  assert.equal(verifyMetaSignature(body, undefined, "app-secret"), false);
  assert.equal(verifyMetaSignature(body, "sha1=abc", "app-secret"), false);
  assert.equal(verifyMetaSignature(body, "sha256=zz", "app-secret"), false);
  assert.equal(verifyMetaSignature(body, sig, ""), false);
});

test("tenant webhook signatures verify within tolerance only", () => {
  const secret = generateWebhookSecret();
  assert.match(secret, /^whsec_[0-9A-Za-z]{32}$/);
  const header = signTenantWebhook('{"a":1}', secret, 1000);
  assert.equal(verifyTenantWebhook('{"a":1}', header, secret, 1100), true);
  assert.equal(verifyTenantWebhook('{"a":1}', header, secret, 1400), false);
  assert.equal(verifyTenantWebhook('{"a":2}', header, secret, 1000), false);
  assert.equal(verifyTenantWebhook('{"a":1}', header, "whsec_other", 1000), false);
  assert.equal(verifyTenantWebhook('{"a":1}', "garbage", secret, 1000), false);
});

test("safeEqual and stableStringify", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abc", "abd"));
  assert.ok(!safeEqual("abc", "abcd"));
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: null }], u: undefined }), '{"a":[2,{"c":null,"d":1}],"b":1}');
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});
