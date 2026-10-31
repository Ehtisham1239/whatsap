import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOutboundStatus, statusTimestamps } from "../../src/lib/status.js";

test("statuses only move forward", () => {
  assert.equal(nextOutboundStatus("queued", "sent"), "sent");
  assert.equal(nextOutboundStatus("sent", "delivered"), "delivered");
  assert.equal(nextOutboundStatus("sent", "read"), "read");
  assert.equal(nextOutboundStatus("read", "delivered"), null);
  assert.equal(nextOutboundStatus("delivered", "sent"), null);
  assert.equal(nextOutboundStatus("sent", "sent"), null);
});

test("failed applies before delivery and is terminal", () => {
  assert.equal(nextOutboundStatus("queued", "failed"), "failed");
  assert.equal(nextOutboundStatus("sent", "failed"), "failed");
  assert.equal(nextOutboundStatus("delivered", "failed"), null);
  assert.equal(nextOutboundStatus("failed", "delivered"), null);
  assert.equal(nextOutboundStatus("received", "read"), null);
});

test("cancel only applies to unsent messages", () => {
  assert.equal(nextOutboundStatus("scheduled", "cancelled"), "cancelled");
  assert.equal(nextOutboundStatus("queued", "cancelled"), "cancelled");
  assert.equal(nextOutboundStatus("sent", "cancelled"), null);
  assert.equal(nextOutboundStatus("cancelled", "queued"), null);
});

test("unknown statuses are ignored", () => {
  assert.equal(nextOutboundStatus("sent", "warning"), null);
  assert.equal(nextOutboundStatus("bogus", "sent"), null);
});

test("statusTimestamps fills implied timestamps without overwriting", () => {
  const at = new Date("2026-10-31T10:00:00Z");
  assert.deepEqual(statusTimestamps("read", at), { sent_at: at, delivered_at: at, read_at: at });
  const earlier = new Date("2026-10-31T09:00:00Z");
  assert.deepEqual(statusTimestamps("read", at, { sent_at: earlier, delivered_at: earlier }), { read_at: at });
  assert.deepEqual(statusTimestamps("failed", at), { failed_at: at });
  assert.deepEqual(statusTimestamps("queued", at), {});
});
