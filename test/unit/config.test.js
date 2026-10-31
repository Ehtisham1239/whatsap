import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres",
  ADMIN_TOKEN: "a".repeat(32),
  API_KEY_PEPPER: "p".repeat(32),
  META_APP_SECRET: "s",
  META_VERIFY_TOKEN: "v".repeat(16),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

test("loads a valid configuration with defaults", () => {
  const c = loadConfig(valid);
  assert.equal(c.port, 8080);
  assert.equal(c.graphVersion, "v23.0");
  assert.equal(c.encryptionKey.length, 32);
  assert.equal(c.prices.marketing, 10);
  assert.deepEqual(c.databaseSsl, { rejectUnauthorized: true });
  assert.equal(c.runWorkers, true);
  assert.equal(loadConfig({ ...valid, DATABASE_SSL: "false" }).databaseSsl, false);
});

test("reports every problem at once", () => {
  assert.throws(
    () => loadConfig({ ADMIN_TOKEN: "short", PORT: "70000", DEFAULT_COUNTRY_CODE: "+92", PRICE_MARKETING: "x", META_GRAPH_VERSION: "23" }),
    (e) => ["DATABASE_URL", "ADMIN_TOKEN", "API_KEY_PEPPER", "META_APP_SECRET", "META_VERIFY_TOKEN", "TOKEN_ENCRYPTION_KEY", "PORT", "DEFAULT_COUNTRY_CODE", "PRICE_MARKETING", "META_GRAPH_VERSION"].every((n) => e.message.includes(n)),
  );
});

test("META_API_BASE_URL allows https origins and plain http only for localhost", () => {
  assert.equal(loadConfig(valid).metaBaseUrl, "https://graph.facebook.com");
  assert.equal(loadConfig({ ...valid, META_API_BASE_URL: "http://127.0.0.1:9999" }).metaBaseUrl, "http://127.0.0.1:9999");
  assert.throws(() => loadConfig({ ...valid, META_API_BASE_URL: "http://evil.example" }), /META_API_BASE_URL/);
  assert.throws(() => loadConfig({ ...valid, META_API_BASE_URL: "https://graph.facebook.com/v1" }), /META_API_BASE_URL/);
});
