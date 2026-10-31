import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCursor, encodeCursor } from "../../src/http/cursor.js";
import { createRateLimiter } from "../../src/http/rate-limit.js";
import { createRouter } from "../../src/http/router.js";

test("router matches params, reports allowed methods, and decodes", () => {
  const r = createRouter();
  const h = () => {};
  r.get("/v1/messages/:id", h);
  r.post("/v1/messages/:id/cancel", h);
  assert.deepEqual(r.match("GET", "/v1/messages/msg_1").params, { id: "msg_1" });
  assert.deepEqual(r.match("GET", "/v1/messages/a%20b/").params, { id: "a b" });
  assert.deepEqual(r.match("DELETE", "/v1/messages/x"), { allowed: ["GET"] });
  assert.equal(r.match("GET", "/v1/messages/x/y"), null);
});

test("rate limiter allows a burst then refills", () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: () => t });
  assert.ok(rl.take("a").ok);
  assert.ok(rl.take("a").ok);
  const denied = rl.take("a");
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSeconds, 1);
  assert.ok(rl.take("b").ok, "keys are independent");
  t = 1000;
  assert.ok(rl.take("a").ok);
});

test("rate limiter evicts the oldest key when full", () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSecond: 0.001, now: () => 0, maxKeys: 2 });
  rl.take("a");
  rl.take("b");
  rl.take("c");
  assert.ok(rl.take("a").ok, "a was evicted and starts fresh");
});

test("cursors round-trip and reject garbage", () => {
  const row = { created_at: new Date("2026-10-31T10:00:00Z"), id: "msg_abc" };
  assert.deepEqual(decodeCursor(encodeCursor(row)), row);
  assert.equal(decodeCursor(null), null);
  assert.equal(decodeCursor("@@"), undefined);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ c: "x", i: "msg_1" })).toString("base64url")), undefined);
  assert.equal(decodeCursor(Buffer.from(JSON.stringify({ c: row.created_at, i: "drop table" })).toString("base64url")), undefined);
  assert.equal(encodeCursor(null), null);
});
